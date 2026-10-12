/**
 * cloud.ts — MinerU cloud client (mineru.net precise-parsing API, /api/v4).
 *
 * Protocol (per the official docs at https://mineru.net/apiManage/docs):
 *   - Local file:  POST /api/v4/file-urls/batch  {files:[{name,...}], model_version, ...}
 *                  → {data:{batch_id, file_urls:[...]}}; then PUT the raw bytes to
 *                  each file_url WITHOUT Content-Type and WITHOUT Authorization
 *                  (the pre-signed URL carries its own auth). The server
 *                  auto-submits the parse task once the upload lands.
 *   - Poll:        GET /api/v4/extract-results/batch/{batch_id}
 *                  data.extract_result[] entries: state waiting-file|pending|
 *                  running|converting|done|failed; done carries full_zip_url.
 *   - Result:      GET full_zip_url (no auth) → zip containing full.md,
 *                  layout.json (= middle.json), *_content_list.json.
 *   - Envelope:    HTTP 200 + {code, msg, trace_id, data}; code !== 0 is a
 *                  business failure (A0202/A0211 = bad/expired token).
 *
 * The class implements {@link MinerUBackend}, so the tools layer treats it
 * exactly like the self-hosted client. Tool-level `task_id` is the v4
 * `batch_id` (single-file submissions map 1:1).
 */

import { readFile, writeFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { inflateRawSync } from 'node:zlib'
import {
  MinerUError,
  type HealthResponse,
  type MinerUBackend,
  type ParseParams,
  type TaskStatus,
  type TaskStatusResponse,
  type TaskSubmitResponse,
  type TaskResultResponse,
} from './client.js'

/** v4 task states → tool-level TaskStatus. */
const STATE_MAP: Record<string, TaskStatus> = {
  'waiting-file': 'pending',
  pending: 'pending',
  running: 'processing',
  converting: 'processing',
  done: 'completed',
  failed: 'failed',
}

/** v4 model versions supported by the precise-parsing API. */
export type CloudModelVersion = 'pipeline' | 'vlm'

export interface MinerUCloudClientOptions {
  baseURL: string
  /** Env-var / credential-ref name the token resolves from (error messages). */
  apiKeyEnv: string
  modelVersion: CloudModelVersion
  timeoutMs: number
  apiKeyResolver: () => Promise<string | undefined>
}

/** One extract_result entry from GET /extract-results/batch/{batch_id}. */
interface CloudBatchEntry {
  file_name?: string
  state?: string
  err_msg?: string
  full_zip_url?: string
  data_id?: string
  extract_progress?: {
    extracted_pages?: number
    total_pages?: number
    start_time?: string
  }
}

interface CloudEnvelope<T = unknown> {
  code?: number
  msg?: string
  trace_id?: string
  data?: T
}

// ---------------------------------------------------------------------------
// Zero-dependency zip reader (stored + deflate entries, central-directory
// based). MinerU result zips use these two methods only.
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string
  compressedSize: number
  uncompressedSize: number
  method: number
  dataOffset: number
}

/** Parse a zip buffer's central directory into entry descriptors. */
export function readZipEntries(buffer: Buffer): ZipEntry[] {
  // Locate EOCD (End Of Central Directory) record from the tail.
  const minEocdOffset = Math.max(0, buffer.length - 0xffff - 22)
  let eocd = -1
  for (let i = buffer.length - 22; i >= minEocdOffset; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new MinerUError('zip: end of central directory not found', 0, null)

  const entryCount = buffer.readUInt16LE(eocd + 10)
  let ptr = buffer.readUInt32LE(eocd + 16) // central directory offset
  const entries: ZipEntry[] = []
  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) {
      throw new MinerUError('zip: corrupt central directory entry', 0, null)
    }
    const method = buffer.readUInt16LE(ptr + 10)
    const compressedSize = buffer.readUInt32LE(ptr + 20)
    const uncompressedSize = buffer.readUInt32LE(ptr + 24)
    const nameLen = buffer.readUInt16LE(ptr + 28)
    const extraLen = buffer.readUInt16LE(ptr + 30)
    const commentLen = buffer.readUInt16LE(ptr + 32)
    const localHeaderOffset = buffer.readUInt32LE(ptr + 42)
    const name = buffer.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8')
    entries.push({ name, compressedSize, uncompressedSize, method, dataOffset: localHeaderOffset })
    ptr += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Extract one entry's bytes (stored or deflate). */
export function unzipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const p = entry.dataOffset
  if (buffer.readUInt32LE(p) !== 0x04034b50) {
    throw new MinerUError(`zip: corrupt local header for ${entry.name}`, 0, null)
  }
  const nameLen = buffer.readUInt16LE(p + 26)
  const extraLen = buffer.readUInt16LE(p + 28)
  const start = p + 30 + nameLen + extraLen
  const raw = buffer.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return Buffer.from(raw)
  if (entry.method === 8) {
    const out = inflateRawSync(raw)
    if (out.length !== entry.uncompressedSize) {
      throw new MinerUError(`zip: size mismatch for ${entry.name}`, 0, null)
    }
    return out
  }
  throw new MinerUError(`zip: unsupported compression method ${entry.method} for ${entry.name}`, 0, null)
}

/** Case-insensitive entry lookup ignoring directory prefixes (any-dir/full.md). */
function findEntry(entries: ZipEntry[], suffix: string): ZipEntry | undefined {
  const lower = suffix.toLowerCase()
  return entries.find(e => {
    const n = e.name.toLowerCase()
    return n === lower || n.endsWith('/' + lower)
  })
}

// ---------------------------------------------------------------------------
// Parameter mapping (tool-level ParseParams → v4 JSON fields)
// ---------------------------------------------------------------------------

/**
 * Translate start_page_id/end_page_id (0-based, inclusive, 99999 sentinel)
 * into the v4 1-based `page_ranges` string, or undefined for "all pages".
 */
export function toPageRanges(startPageId?: number, endPageId?: number): string | undefined {
  const start = (startPageId ?? 0) + 1
  const end = endPageId !== undefined && endPageId < 99999 ? String(endPageId + 1) : ''
  const range = `${start}-${end}`
  // "1-" means every page: omit the parameter entirely.
  if (start === 1 && end === '') return undefined
  return range
}

/** Build the shared (non-files) portion of a v4 request body. */
function toCloudBody(params: ParseParams, modelVersion: CloudModelVersion): Record<string, unknown> {
  const body: Record<string, unknown> = { model_version: modelVersion }
  if (params.parse_method === 'ocr') body.is_ocr = true
  if (params.formula_enable !== undefined) body.enable_formula = params.formula_enable
  if (params.table_enable !== undefined) body.enable_table = params.table_enable
  if (params.lang_list !== undefined && params.lang_list.length > 0) body.language = params.lang_list[0]
  const pageRanges = toPageRanges(params.start_page_id, params.end_page_id)
  if (pageRanges !== undefined) body.page_ranges = pageRanges
  return body
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class MinerUCloudClient implements MinerUBackend {
  private readonly baseURL: string
  private readonly apiKeyEnv: string
  private readonly modelVersion: CloudModelVersion
  private readonly timeoutMs: number
  private readonly apiKeyResolver: () => Promise<string | undefined>

  constructor(opts: MinerUCloudClientOptions) {
    this.baseURL = opts.baseURL.replace(/\/+$/, '')
    this.apiKeyEnv = opts.apiKeyEnv
    this.modelVersion = opts.modelVersion
    this.timeoutMs = opts.timeoutMs
    this.apiKeyResolver = opts.apiKeyResolver
  }

  private async resolveToken(): Promise<string> {
    const token = await this.apiKeyResolver()
    if (!token || token.length === 0) {
      throw new MinerUError(
        `MinerU cloud API token not found. Set it in the environment variable "${this.apiKeyEnv}" (or the credentials ref the field points to). Create a token on the mineru.net API management page.`,
        401,
        null,
      )
    }
    return token
  }

  /** JSON request with envelope validation. */
  private async request<T>(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
    parentSignal: AbortSignal,
  ): Promise<T> {
    parentSignal.throwIfAborted()
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)
    const onParentAbort = () => controller.abort()
    parentSignal.addEventListener('abort', onParentAbort, { once: true })

    try {
      const token = await this.resolveToken()
      parentSignal.throwIfAborted()
      const response = await fetch(`${this.baseURL}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      })
      const status = response.status
      let payload: CloudEnvelope | null = null
      try {
        payload = await response.json() as CloudEnvelope
      } catch {
        payload = null
      }
      if (status !== 200 || payload === null || payload.code !== 0) {
        const code: number | string = payload?.code ?? status
        const msg = payload?.msg ?? `HTTP ${status}`
        const hint = String(code) === 'A0202' || String(code) === 'A0211'
          ? ` (${code}: check the API token on the mineru.net API management page)`
          : ''
        throw new MinerUError(
          `MinerU cloud ${method} ${path} failed: code=${code} msg=${JSON.stringify(msg)} trace_id=${payload?.trace_id ?? '?'}${hint}`,
          status,
          payload,
        )
      }
      return (payload.data ?? {}) as T
    } finally {
      clearTimeout(timeoutId)
      parentSignal.removeEventListener('abort', onParentAbort)
    }
  }

  /** Probe reachability + token validity without creating any task. */
  async health(signal: AbortSignal): Promise<HealthResponse> {
    try {
      // -60012 ("task not found") proves the service is reachable AND the
      // token passed auth; A0202/A0211 surface as readable errors instead.
      await this.request('GET', '/api/v4/extract/task/dsh-mineru-probe', undefined, signal)
      return { status: 'healthy', version: 'api-v4' } as HealthResponse
    } catch (err) {
      if (err instanceof MinerUError) {
        if (typeof err.body === 'object' && err.body !== null && (err.body as CloudEnvelope).code === -60012) {
          return { status: 'healthy', version: 'api-v4' } as HealthResponse
        }
        if (err.status === 401 || err.message.includes('A0202') || err.message.includes('A0211')) {
          throw new MinerUError(`MinerU cloud API token rejected: ${err.message}`, err.status, err.body)
        }
        if (err.status >= 500) {
          return { status: 'unhealthy', version: 'api-v4' } as HealthResponse
        }
      }
      throw err
    }
  }

  async submitTask(filePath: string, params: ParseParams, signal: AbortSignal): Promise<TaskSubmitResponse> {
    const fileName = basename(filePath)
    const body = toCloudBody(params, this.modelVersion)
    const data = await this.request<{ batch_id?: string; file_urls?: string[] }>(
      'POST',
      '/api/v4/file-urls/batch',
      { ...body, files: [{ name: fileName }] },
      signal,
    )
    if (!data.batch_id || !data.file_urls || data.file_urls.length < 1) {
      throw new MinerUError(
        `MinerU cloud submit: missing batch_id/file_urls in response`,
        502,
        data,
      )
    }

    // PUT raw bytes to the pre-signed URL: NO Content-Type, NO Authorization.
    signal.throwIfAborted()
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)
    const onParentAbort = () => controller.abort()
    signal.addEventListener('abort', onParentAbort, { once: true })
    try {
      const buffer = await readFile(filePath)
      signal.throwIfAborted()
      const put = await fetch(data.file_urls[0], {
        method: 'PUT',
        body: new Uint8Array(buffer),
        signal: controller.signal,
        redirect: 'error',
      })
      if (put.status < 200 || put.status >= 300) {
        let text = ''
        try {
          text = (await put.text()).slice(0, 500)
        } catch {
          // ignore body read failure
        }
        throw new MinerUError(
          `MinerU cloud upload PUT failed with HTTP ${put.status}${text ? `: ${text}` : ''}`,
          put.status,
          text || null,
        )
      }
    } finally {
      clearTimeout(timeoutId)
      signal.removeEventListener('abort', onParentAbort)
    }

    return {
      task_id: data.batch_id,
      status: 'pending',
      backend: `cloud-${this.modelVersion}`,
      file_names: [fileName.replace(/\.[^.]+$/, '')],
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      error: null,
      status_url: `${this.baseURL}/api/v4/extract-results/batch/${data.batch_id}`,
      result_url: `${this.baseURL}/api/v4/extract-results/batch/${data.batch_id}`,
      queued_ahead: 0,
      message: 'uploaded; the server auto-submits the parse task',
    }
  }

  async getTaskStatus(taskId: string, signal: AbortSignal): Promise<TaskStatusResponse> {
    const data = await this.request<{ batch_id?: string; extract_result?: CloudBatchEntry[] }>(
      'GET',
      `/api/v4/extract-results/batch/${encodeURIComponent(taskId)}`,
      undefined,
      signal,
    )
    const entry = data.extract_result?.[0]
    const state = entry?.state ?? 'pending'
    const mapped = STATE_MAP[state] ?? 'pending'
    const out: TaskStatusResponse = {
      task_id: taskId,
      status: mapped,
      backend: `cloud-${this.modelVersion}`,
      file_names: entry?.file_name !== undefined ? [entry.file_name.replace(/\.[^.]+$/, '')] : [],
      created_at: null,
      started_at: entry?.extract_progress?.start_time ?? null,
      completed_at: mapped === 'completed' || mapped === 'failed' ? new Date().toISOString() : null,
      error: mapped === 'failed' ? (entry?.err_msg || 'task failed') : null,
      status_url: `${this.baseURL}/api/v4/extract-results/batch/${taskId}`,
      result_url: `${this.baseURL}/api/v4/extract-results/batch/${taskId}`,
    }
    if (entry?.extract_progress?.extracted_pages !== undefined) {
      ;(out as unknown as Record<string, unknown>).extracted_pages = entry.extract_progress.extracted_pages
    }
    if (entry?.extract_progress?.total_pages !== undefined) {
      ;(out as unknown as Record<string, unknown>).total_pages = entry.extract_progress.total_pages
    }
    return out
  }

  async getTaskResult(taskId: string, signal: AbortSignal): Promise<TaskResultResponse> {
    const data = await this.request<{ batch_id?: string; extract_result?: CloudBatchEntry[] }>(
      'GET',
      `/api/v4/extract-results/batch/${encodeURIComponent(taskId)}`,
      undefined,
      signal,
    )
    const entry = data.extract_result?.[0]
    if (entry === undefined) {
      throw new MinerUError(`MinerU cloud result: empty extract_result for batch ${taskId}`, 502, data)
    }
    if (entry.state !== 'done') {
      throw new MinerUError(
        `MinerU cloud result: batch ${taskId} state is "${entry.state}" (expected done)${entry.err_msg ? `: ${entry.err_msg}` : ''}`,
        409,
        data,
      )
    }
    if (!entry.full_zip_url) {
      throw new MinerUError(`MinerU cloud result: done but no full_zip_url for batch ${taskId}`, 502, data)
    }

    // Download the result zip (public CDN URL; no auth header).
    signal.throwIfAborted()
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)
    const onParentAbort = () => controller.abort()
    signal.addEventListener('abort', onParentAbort, { once: true })
    let zipBuffer: Buffer
    try {
      signal.throwIfAborted()
      const res = await fetch(entry.full_zip_url, { signal: controller.signal, redirect: 'follow' })
      if (res.status !== 200) {
        throw new MinerUError(`MinerU cloud result zip download failed: HTTP ${res.status}`, res.status, null)
      }
      zipBuffer = Buffer.from(await res.arrayBuffer())
    } finally {
      clearTimeout(timeoutId)
      signal.removeEventListener('abort', onParentAbort)
    }

    // Persist the raw zip for inspection, then extract markdown + extras.
    const zipPath = `${tmpdir()}/mineru-cloud-${taskId}.zip`
    await writeFile(zipPath, zipBuffer)

    const entries = readZipEntries(zipBuffer)
    const stem = (entry.file_name ?? 'result').replace(/\.[^.]+$/, '')
    const fileResult: Record<string, unknown> = {}

    const mdEntry = findEntry(entries, 'full.md')
    if (mdEntry !== undefined) fileResult.md_content = unzipEntry(zipBuffer, mdEntry).toString('utf8')

    const clEntry = entries.find(e => /_content_list\.json$/i.test(e.name))
    if (clEntry !== undefined) fileResult.content_list = unzipEntry(zipBuffer, clEntry).toString('utf8')

    const layoutEntry = findEntry(entries, 'layout.json')
    if (layoutEntry !== undefined) fileResult.middle_json = unzipEntry(zipBuffer, layoutEntry).toString('utf8')

    return {
      backend: `cloud-${this.modelVersion}`,
      version: 'api-v4',
      results: { [stem]: fileResult },
    }
  }
}
