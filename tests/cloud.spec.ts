/**
 * Cloud-mode spec: MinerUCloudClient against the mineru.net /api/v4
 * precise-parsing protocol (mocked fetch), plus the zero-dependency zip
 * reader. Local-mode client behavior stays covered by tools.spec.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deflateRawSync } from 'node:zlib'

import {
  MinerUCloudClient,
  readZipEntries,
  unzipEntry,
  toPageRanges,
} from '../src/cloud.js'
import { MinerUError } from '../src/client.js'

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeClient(overrides: Partial<ConstructorParameters<typeof MinerUCloudClient>[0]> = {}): MinerUCloudClient {
  return new MinerUCloudClient({
    baseURL: 'https://mineru.net',
    apiKeyEnv: 'MINERU_CLOUD_API_KEY',
    modelVersion: 'vlm',
    timeoutMs: 5000,
    apiKeyResolver: async () => 'test-token',
    ...overrides,
  })
}

const signal = new AbortController().signal

// ---------------------------------------------------------------------------
// zip reader
// ---------------------------------------------------------------------------

/** Build a minimal zip with one stored and one deflate entry. */
function buildTestZip(): { buffer: Buffer; mdText: string; clText: string } {
  const mdText = '# Hello MinerU\n\ndeflate content\n'.repeat(20)
  const clText = JSON.stringify([{ type: 'text', text: 'hi' }])
  const mdRaw = Buffer.from(mdText, 'utf8')
  const clRaw = Buffer.from(clText, 'utf8')
  const mdDeflated = deflateRawSync(mdRaw)

  const files = [
    { name: 'full.md', method: 8, data: mdDeflated, raw: mdRaw },
    { name: 'layout.json', method: 0, data: Buffer.from('{"pages":[]}', 'utf8'), raw: Buffer.from('{"pages":[]}', 'utf8') },
    { name: 'xxx_content_list.json', method: 0, data: clRaw, raw: clRaw },
  ]

  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  const crc32 = (buf: Buffer): number => {
    let c = ~0
    for (const byte of buf) {
      c ^= byte
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return ~c >>> 0
  }
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(f.method, 8)
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0, 12) // date
    local.writeUInt32LE(crc32(f.raw), 14)
    local.writeUInt32LE(f.data.length, 18)
    local.writeUInt32LE(f.raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, f.data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(f.method, 10)
    cd.writeUInt32LE(crc32(f.raw), 16)
    cd.writeUInt32LE(f.data.length, 20)
    cd.writeUInt32LE(f.raw.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)

    offset += local.length + nameBuf.length + f.data.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return { buffer: Buffer.concat([...chunks, centralBuf, eocd]), mdText, clText }
}

describe('zip reader', () => {
  it('extracts stored and deflate entries', () => {
    const { buffer, mdText, clText } = buildTestZip()
    const entries = readZipEntries(buffer)
    expect(entries.map(e => e.name).sort()).toEqual(['full.md', 'layout.json', 'xxx_content_list.json'])
    const md = entries.find(e => e.name === 'full.md')!
    expect(unzipEntry(buffer, md).toString('utf8')).toBe(mdText)
    const cl = entries.find(e => e.name === 'xxx_content_list.json')!
    expect(unzipEntry(buffer, cl).toString('utf8')).toBe(clText)
  })

  it('rejects a non-zip buffer', () => {
    expect(() => readZipEntries(Buffer.from('not a zip'))).toThrow(MinerUError)
  })
})

describe('toPageRanges', () => {
  it('maps 0-based ids to 1-based v4 ranges', () => {
    expect(toPageRanges(0, 9)).toBe('1-10')
    expect(toPageRanges(1, 4)).toBe('2-5')
  })

  it('omits the end for the 99999 sentinel and omits everything for full range', () => {
    expect(toPageRanges(0, 99999)).toBeUndefined()
    expect(toPageRanges(2, 99999)).toBe('3-')
  })

  it('defaults to all pages', () => {
    expect(toPageRanges()).toBeUndefined()
  })
})

describe('MinerUCloudClient', () => {
  it('submitTask: requests upload URL, PUTs raw bytes without auth/content-type headers', async () => {
    const filePath = join(tmpdir(), 'dsh-mineru-test-doc.pdf')
    await writeFile(filePath, Buffer.from('%PDF-fake-bytes'))

    mockFetch.mockResolvedValueOnce(jsonRes({
      code: 0, msg: 'ok', trace_id: 't1',
      data: { batch_id: 'batch-1', file_urls: ['https://oss.example.com/pre-signed?sig=abc'] },
    }))
    mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }))

    const client = makeClient()
    const submit = await client.submitTask(filePath, {
      backend: 'pipeline', // ignored in cloud mode
      parse_method: 'ocr',
      lang_list: ['ch'],
      formula_enable: true,
      table_enable: false,
      return_md: true,
      start_page_id: 0,
      end_page_id: 9,
    }, signal)

    // 1st call: apply for the upload URL
    const apply = mockFetch.mock.calls[0]
    expect(apply[0]).toBe('https://mineru.net/api/v4/file-urls/batch')
    expect(apply[1].method).toBe('POST')
    expect(apply[1].headers['authorization']).toBe('Bearer test-token')
    const body = JSON.parse(apply[1].body)
    expect(body.model_version).toBe('vlm')
    expect(body.is_ocr).toBe(true)
    expect(body.language).toBe('ch')
    expect(body.enable_table).toBe(false)
    expect(body.page_ranges).toBe('1-10')
    expect(body.files).toEqual([{ name: 'dsh-mineru-test-doc.pdf' }])

    // 2nd call: PUT raw bytes with no headers object at all (no auth, no content-type)
    const put = mockFetch.mock.calls[1]
    expect(put[0]).toBe('https://oss.example.com/pre-signed?sig=abc')
    expect(put[1].method).toBe('PUT')
    expect(put[1].headers === undefined || put[1].headers['authorization'] === undefined).toBe(true)

    expect(submit.task_id).toBe('batch-1')
    expect(submit.status).toBe('pending')
    expect(submit.backend).toBe('cloud-vlm')
  })

  it('getTaskStatus: maps v4 states and surfaces progress', async () => {
    mockFetch.mockResolvedValueOnce(jsonRes({
      code: 0, msg: 'ok',
      data: {
        batch_id: 'b1',
        extract_result: [{
          file_name: 'demo.pdf',
          state: 'running',
          extract_progress: { extracted_pages: 3, total_pages: 10 },
        }],
      },
    }))
    const status = await makeClient().getTaskStatus('b1', signal)
    expect(status.status).toBe('processing')
    expect((status as unknown as Record<string, number>).extracted_pages).toBe(3)
    expect((status as unknown as Record<string, number>).total_pages).toBe(10)

    mockFetch.mockResolvedValueOnce(jsonRes({
      code: 0, msg: 'ok',
      data: { batch_id: 'b1', extract_result: [{ file_name: 'demo.pdf', state: 'waiting-file' }] },
    }))
    expect((await makeClient().getTaskStatus('b1', signal)).status).toBe('pending')

    mockFetch.mockResolvedValueOnce(jsonRes({
      code: 0, msg: 'ok',
      data: { batch_id: 'b1', extract_result: [{ file_name: 'demo.pdf', state: 'done', full_zip_url: 'https://cdn/x.zip' }] },
    }))
    expect((await makeClient().getTaskStatus('b1', signal)).status).toBe('completed')

    mockFetch.mockResolvedValueOnce(jsonRes({
      code: 0, msg: 'ok',
      data: { batch_id: 'b1', extract_result: [{ file_name: 'demo.pdf', state: 'failed', err_msg: 'bad file' }] },
    }))
    const failed = await makeClient().getTaskStatus('b1', signal)
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('bad file')
  })

  it('getTaskResult: downloads the zip and normalizes md/content_list/middle_json', async () => {
    const { buffer, mdText } = buildTestZip()
    mockFetch.mockResolvedValueOnce(jsonRes({
      code: 0, msg: 'ok',
      data: {
        batch_id: 'b1',
        extract_result: [{ file_name: 'demo.pdf', state: 'done', full_zip_url: 'https://cdn-mineru.example.com/b1.zip' }],
      },
    }))
    mockFetch.mockResolvedValueOnce(new Response(buffer, { status: 200 }))

    const result = await makeClient().getTaskResult('b1', signal)
    expect(result.backend).toBe('cloud-vlm')
    expect(result.version).toBe('api-v4')
    const first = result.results['demo']
    expect(first?.md_content).toBe(mdText)
    expect(first?.content_list).toContain('"type":"text"')
    expect(first?.middle_json).toBeDefined()
  })

  it('surfaces envelope errors with code/msg and token hints', async () => {
    mockFetch.mockResolvedValueOnce(jsonRes({
      code: 'A0202', msg: 'Token 错误', trace_id: 't9',
      data: {},
    }))
    await expect(makeClient().health(signal)).rejects.toThrow(/A0202.*token/i)
  })

  it('throws a readable error when the token is missing', async () => {
    const client = makeClient({ apiKeyResolver: async () => undefined })
    await expect(client.health(signal)).rejects.toThrow(/MINERU_CLOUD_API_KEY/)
  })

  it('health: treats code -60012 (task not found) as healthy', async () => {
    mockFetch.mockResolvedValueOnce(jsonRes({
      code: -60012, msg: '找不到任务',
      data: {},
    }))
    const h = await makeClient().health(signal)
    expect(h.status).toBe('healthy')
    expect(h.version).toBe('api-v4')
  })

  it('rejects results whose state is not done', async () => {
    mockFetch.mockResolvedValueOnce(jsonRes({
      code: 0, msg: 'ok',
      data: { batch_id: 'b1', extract_result: [{ file_name: 'demo.pdf', state: 'running' }] },
    }))
    await expect(makeClient().getTaskResult('b1', signal)).rejects.toThrow(/state is "running"/)
  })
})
