import z from "@deepseek-ai/schemastery";
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { inflateRawSync } from "node:zlib";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { API_PATH } from "@deepseek-ai/dsh-client-connection";
//#region src/client.ts
/**
* client.ts — MinerU HTTP client.
*
* Minimal fetch-based client for the MinerU FastAPI server (v3.4.4, protocol v2).
* Endpoints: GET /health, POST /tasks, GET /tasks/{id}, GET /tasks/{id}/result.
*
* Auth is optional: MinerU's open-source server has no built-in auth. When an
* API key is resolved (via the credential store or env var), it is sent as
* `Authorization: Bearer <key>`. Credential-bearing requests reject redirects.
*/
var MinerUError = class extends Error {
	status;
	body;
	constructor(message, status, body) {
		super(message);
		this.status = status;
		this.body = body;
		this.name = "MinerUError";
	}
};
const MIME_BY_EXT = {
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".bmp": "image/bmp",
	".tiff": "image/tiff",
	".tif": "image/tiff",
	".webp": "image/webp",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};
function mimeTypeForExt(ext) {
	return MIME_BY_EXT[ext.toLowerCase()] ?? "application/octet-stream";
}
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			const err = /* @__PURE__ */ new Error("Aborted");
			err.name = "AbortError";
			reject(err);
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			const err = /* @__PURE__ */ new Error("Aborted");
			err.name = "AbortError";
			reject(err);
		}, { once: true });
	});
}
async function buildFormData(filePath, params) {
	const buffer = await readFile(filePath);
	const fileName = basename(filePath);
	const mime = mimeTypeForExt(extname(fileName));
	const blob = new Blob([buffer], { type: mime });
	const form = new FormData();
	form.append("files", blob, fileName);
	const appendBool = (key, val) => {
		if (val !== void 0) form.append(key, String(val));
	};
	const appendStr = (key, val) => {
		if (val !== void 0) form.append(key, val);
	};
	const appendInt = (key, val) => {
		if (val !== void 0) form.append(key, String(val));
	};
	appendStr("backend", params.backend);
	appendStr("parse_method", params.parse_method);
	appendStr("effort", params.effort);
	appendStr("server_url", params.server_url);
	appendBool("formula_enable", params.formula_enable);
	appendBool("table_enable", params.table_enable);
	appendBool("image_analysis", params.image_analysis);
	appendBool("return_md", params.return_md);
	appendBool("return_middle_json", params.return_middle_json);
	appendBool("return_model_output", params.return_model_output);
	appendBool("return_content_list", params.return_content_list);
	appendBool("return_images", params.return_images);
	appendBool("response_format_zip", params.response_format_zip);
	appendBool("return_original_file", params.return_original_file);
	appendInt("start_page_id", params.start_page_id);
	appendInt("end_page_id", params.end_page_id);
	if (params.lang_list !== void 0) for (const lang of params.lang_list) form.append("lang_list", lang);
	return form;
}
var MinerUClient = class {
	baseURL;
	timeoutMs;
	apiKeyResolver;
	constructor(opts) {
		this.baseURL = opts.baseURL.replace(/\/+$/, "");
		this.timeoutMs = opts.timeoutMs;
		this.apiKeyResolver = opts.apiKeyResolver;
	}
	async health(signal) {
		return this.request("GET", "/health", void 0, signal, [200]);
	}
	async submitTask(filePath, params, signal) {
		const form = await buildFormData(filePath, params);
		return this.request("POST", "/tasks", form, signal, [202]);
	}
	async getTaskStatus(taskId, signal) {
		return this.request("GET", `/tasks/${encodeURIComponent(taskId)}`, void 0, signal, [200]);
	}
	async getTaskResult(taskId, signal) {
		return this.request("GET", `/tasks/${encodeURIComponent(taskId)}/result`, void 0, signal, [200]);
	}
	async request(method, path, body, parentSignal, acceptedStatuses) {
		parentSignal.throwIfAborted();
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
		const onParentAbort = () => controller.abort();
		parentSignal.addEventListener("abort", onParentAbort, { once: true });
		try {
			const apiKey = this.apiKeyResolver ? await this.apiKeyResolver() : void 0;
			parentSignal.throwIfAborted();
			const headers = {};
			if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
			const response = await fetch(`${this.baseURL}${path}`, {
				method,
				headers,
				body,
				signal: controller.signal,
				redirect: apiKey ? "error" : "follow"
			});
			const status = response.status;
			if (!acceptedStatuses.includes(status)) {
				let errorBody;
				try {
					errorBody = await response.json();
				} catch {
					try {
						errorBody = await response.text();
					} catch {
						errorBody = null;
					}
				}
				throw new MinerUError(`MinerU ${method} ${path} returned ${status}`, status, errorBody);
			}
			const contentType = response.headers.get("content-type") ?? "";
			if (!contentType.includes("application/json")) throw new MinerUError(`MinerU ${method} ${path} returned non-JSON content-type: ${contentType}`, status, null);
			return await response.json();
		} finally {
			clearTimeout(timeoutId);
			parentSignal.removeEventListener("abort", onParentAbort);
		}
	}
};
async function pollUntilDone(client, taskId, opts) {
	const deadline = Date.now() + opts.timeoutMs;
	for (;;) {
		opts.signal.throwIfAborted();
		const status = await client.getTaskStatus(taskId, opts.signal);
		if (status.status === "completed" || status.status === "failed") return status;
		if (Date.now() >= deadline) throw new MinerUError(`Polling timed out after ${opts.timeoutMs}ms for task ${taskId}`, 408, status);
		await sleep(opts.intervalMs, opts.signal);
	}
}
//#endregion
//#region src/cloud.ts
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
/** v4 task states → tool-level TaskStatus. */
const STATE_MAP = {
	"waiting-file": "pending",
	pending: "pending",
	running: "processing",
	converting: "processing",
	done: "completed",
	failed: "failed"
};
/** Parse a zip buffer's central directory into entry descriptors. */
function readZipEntries(buffer) {
	const minEocdOffset = Math.max(0, buffer.length - 65535 - 22);
	let eocd = -1;
	for (let i = buffer.length - 22; i >= minEocdOffset; i--) if (buffer.readUInt32LE(i) === 101010256) {
		eocd = i;
		break;
	}
	if (eocd < 0) throw new MinerUError("zip: end of central directory not found", 0, null);
	const entryCount = buffer.readUInt16LE(eocd + 10);
	let ptr = buffer.readUInt32LE(eocd + 16);
	const entries = [];
	for (let i = 0; i < entryCount; i++) {
		if (buffer.readUInt32LE(ptr) !== 33639248) throw new MinerUError("zip: corrupt central directory entry", 0, null);
		const method = buffer.readUInt16LE(ptr + 10);
		const compressedSize = buffer.readUInt32LE(ptr + 20);
		const uncompressedSize = buffer.readUInt32LE(ptr + 24);
		const nameLen = buffer.readUInt16LE(ptr + 28);
		const extraLen = buffer.readUInt16LE(ptr + 30);
		const commentLen = buffer.readUInt16LE(ptr + 32);
		const localHeaderOffset = buffer.readUInt32LE(ptr + 42);
		const name = buffer.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");
		entries.push({
			name,
			compressedSize,
			uncompressedSize,
			method,
			dataOffset: localHeaderOffset
		});
		ptr += 46 + nameLen + extraLen + commentLen;
	}
	return entries;
}
/** Extract one entry's bytes (stored or deflate). */
function unzipEntry(buffer, entry) {
	const p = entry.dataOffset;
	if (buffer.readUInt32LE(p) !== 67324752) throw new MinerUError(`zip: corrupt local header for ${entry.name}`, 0, null);
	const nameLen = buffer.readUInt16LE(p + 26);
	const extraLen = buffer.readUInt16LE(p + 28);
	const start = p + 30 + nameLen + extraLen;
	const raw = buffer.subarray(start, start + entry.compressedSize);
	if (entry.method === 0) return Buffer.from(raw);
	if (entry.method === 8) {
		const out = inflateRawSync(raw);
		if (out.length !== entry.uncompressedSize) throw new MinerUError(`zip: size mismatch for ${entry.name}`, 0, null);
		return out;
	}
	throw new MinerUError(`zip: unsupported compression method ${entry.method} for ${entry.name}`, 0, null);
}
/** Case-insensitive entry lookup ignoring directory prefixes (any-dir/full.md). */
function findEntry(entries, suffix) {
	const lower = suffix.toLowerCase();
	return entries.find((e) => {
		const n = e.name.toLowerCase();
		return n === lower || n.endsWith("/" + lower);
	});
}
/**
* Translate start_page_id/end_page_id (0-based, inclusive, 99999 sentinel)
* into the v4 1-based `page_ranges` string, or undefined for "all pages".
*/
function toPageRanges(startPageId, endPageId) {
	const start = (startPageId ?? 0) + 1;
	const end = endPageId !== void 0 && endPageId < 99999 ? String(endPageId + 1) : "";
	const range = `${start}-${end}`;
	if (start === 1 && end === "") return void 0;
	return range;
}
/** Build the shared (non-files) portion of a v4 request body. */
function toCloudBody(params, modelVersion) {
	const body = { model_version: modelVersion };
	if (params.parse_method === "ocr") body.is_ocr = true;
	if (params.formula_enable !== void 0) body.enable_formula = params.formula_enable;
	if (params.table_enable !== void 0) body.enable_table = params.table_enable;
	if (params.lang_list !== void 0 && params.lang_list.length > 0) body.language = params.lang_list[0];
	const pageRanges = toPageRanges(params.start_page_id, params.end_page_id);
	if (pageRanges !== void 0) body.page_ranges = pageRanges;
	return body;
}
var MinerUCloudClient = class {
	baseURL;
	apiKeyEnv;
	modelVersion;
	timeoutMs;
	apiKeyResolver;
	constructor(opts) {
		this.baseURL = opts.baseURL.replace(/\/+$/, "");
		this.apiKeyEnv = opts.apiKeyEnv;
		this.modelVersion = opts.modelVersion;
		this.timeoutMs = opts.timeoutMs;
		this.apiKeyResolver = opts.apiKeyResolver;
	}
	async resolveToken() {
		const token = await this.apiKeyResolver();
		if (!token || token.length === 0) throw new MinerUError(`MinerU cloud API token not found. Set it in the environment variable "${this.apiKeyEnv}" (or the credentials ref the field points to). Create a token on the mineru.net API management page.`, 401, null);
		return token;
	}
	/** JSON request with envelope validation. */
	async request(method, path, body, parentSignal) {
		parentSignal.throwIfAborted();
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
		const onParentAbort = () => controller.abort();
		parentSignal.addEventListener("abort", onParentAbort, { once: true });
		try {
			const token = await this.resolveToken();
			parentSignal.throwIfAborted();
			const response = await fetch(`${this.baseURL}${path}`, {
				method,
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`
				},
				body: body === void 0 ? void 0 : JSON.stringify(body),
				signal: controller.signal,
				redirect: "error"
			});
			const status = response.status;
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			if (status !== 200 || payload === null || payload.code !== 0) {
				const code = payload?.code ?? status;
				const msg = payload?.msg ?? `HTTP ${status}`;
				const hint = String(code) === "A0202" || String(code) === "A0211" ? ` (${code}: check the API token on the mineru.net API management page)` : "";
				throw new MinerUError(`MinerU cloud ${method} ${path} failed: code=${code} msg=${JSON.stringify(msg)} trace_id=${payload?.trace_id ?? "?"}${hint}`, status, payload);
			}
			return payload.data ?? {};
		} finally {
			clearTimeout(timeoutId);
			parentSignal.removeEventListener("abort", onParentAbort);
		}
	}
	/** Probe reachability + token validity without creating any task. */
	async health(signal) {
		try {
			await this.request("GET", "/api/v4/extract/task/dsh-mineru-probe", void 0, signal);
			return {
				status: "healthy",
				version: "api-v4"
			};
		} catch (err) {
			if (err instanceof MinerUError) {
				if (typeof err.body === "object" && err.body !== null && err.body.code === -60012) return {
					status: "healthy",
					version: "api-v4"
				};
				if (err.status === 401 || err.message.includes("A0202") || err.message.includes("A0211")) throw new MinerUError(`MinerU cloud API token rejected: ${err.message}`, err.status, err.body);
				if (err.status >= 500) return {
					status: "unhealthy",
					version: "api-v4"
				};
			}
			throw err;
		}
	}
	async submitTask(filePath, params, signal) {
		const fileName = basename(filePath);
		const body = toCloudBody(params, this.modelVersion);
		const data = await this.request("POST", "/api/v4/file-urls/batch", {
			...body,
			files: [{ name: fileName }]
		}, signal);
		if (!data.batch_id || !data.file_urls || data.file_urls.length < 1) throw new MinerUError(`MinerU cloud submit: missing batch_id/file_urls in response`, 502, data);
		signal.throwIfAborted();
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
		const onParentAbort = () => controller.abort();
		signal.addEventListener("abort", onParentAbort, { once: true });
		try {
			const buffer = await readFile(filePath);
			signal.throwIfAborted();
			const put = await fetch(data.file_urls[0], {
				method: "PUT",
				body: new Uint8Array(buffer),
				signal: controller.signal,
				redirect: "error"
			});
			if (put.status < 200 || put.status >= 300) {
				let text = "";
				try {
					text = (await put.text()).slice(0, 500);
				} catch {}
				throw new MinerUError(`MinerU cloud upload PUT failed with HTTP ${put.status}${text ? `: ${text}` : ""}`, put.status, text || null);
			}
		} finally {
			clearTimeout(timeoutId);
			signal.removeEventListener("abort", onParentAbort);
		}
		return {
			task_id: data.batch_id,
			status: "pending",
			backend: `cloud-${this.modelVersion}`,
			file_names: [fileName.replace(/\.[^.]+$/, "")],
			created_at: (/* @__PURE__ */ new Date()).toISOString(),
			started_at: null,
			completed_at: null,
			error: null,
			status_url: `${this.baseURL}/api/v4/extract-results/batch/${data.batch_id}`,
			result_url: `${this.baseURL}/api/v4/extract-results/batch/${data.batch_id}`,
			queued_ahead: 0,
			message: "uploaded; the server auto-submits the parse task"
		};
	}
	async getTaskStatus(taskId, signal) {
		const entry = (await this.request("GET", `/api/v4/extract-results/batch/${encodeURIComponent(taskId)}`, void 0, signal)).extract_result?.[0];
		const state = entry?.state ?? "pending";
		const mapped = STATE_MAP[state] ?? "pending";
		const out = {
			task_id: taskId,
			status: mapped,
			backend: `cloud-${this.modelVersion}`,
			file_names: entry?.file_name !== void 0 ? [entry.file_name.replace(/\.[^.]+$/, "")] : [],
			created_at: null,
			started_at: entry?.extract_progress?.start_time ?? null,
			completed_at: mapped === "completed" || mapped === "failed" ? (/* @__PURE__ */ new Date()).toISOString() : null,
			error: mapped === "failed" ? entry?.err_msg || "task failed" : null,
			status_url: `${this.baseURL}/api/v4/extract-results/batch/${taskId}`,
			result_url: `${this.baseURL}/api/v4/extract-results/batch/${taskId}`
		};
		if (entry?.extract_progress?.extracted_pages !== void 0) out.extracted_pages = entry.extract_progress.extracted_pages;
		if (entry?.extract_progress?.total_pages !== void 0) out.total_pages = entry.extract_progress.total_pages;
		return out;
	}
	async getTaskResult(taskId, signal) {
		const data = await this.request("GET", `/api/v4/extract-results/batch/${encodeURIComponent(taskId)}`, void 0, signal);
		const entry = data.extract_result?.[0];
		if (entry === void 0) throw new MinerUError(`MinerU cloud result: empty extract_result for batch ${taskId}`, 502, data);
		if (entry.state !== "done") throw new MinerUError(`MinerU cloud result: batch ${taskId} state is "${entry.state}" (expected done)${entry.err_msg ? `: ${entry.err_msg}` : ""}`, 409, data);
		if (!entry.full_zip_url) throw new MinerUError(`MinerU cloud result: done but no full_zip_url for batch ${taskId}`, 502, data);
		signal.throwIfAborted();
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
		const onParentAbort = () => controller.abort();
		signal.addEventListener("abort", onParentAbort, { once: true });
		let zipBuffer;
		try {
			signal.throwIfAborted();
			const res = await fetch(entry.full_zip_url, {
				signal: controller.signal,
				redirect: "follow"
			});
			if (res.status !== 200) throw new MinerUError(`MinerU cloud result zip download failed: HTTP ${res.status}`, res.status, null);
			zipBuffer = Buffer.from(await res.arrayBuffer());
		} finally {
			clearTimeout(timeoutId);
			signal.removeEventListener("abort", onParentAbort);
		}
		const zipPath = `${tmpdir()}/mineru-cloud-${taskId}.zip`;
		await writeFile(zipPath, zipBuffer);
		const entries = readZipEntries(zipBuffer);
		const stem = (entry.file_name ?? "result").replace(/\.[^.]+$/, "");
		const fileResult = {};
		const mdEntry = findEntry(entries, "full.md");
		if (mdEntry !== void 0) fileResult.md_content = unzipEntry(zipBuffer, mdEntry).toString("utf8");
		const clEntry = entries.find((e) => /_content_list\.json$/i.test(e.name));
		if (clEntry !== void 0) fileResult.content_list = unzipEntry(zipBuffer, clEntry).toString("utf8");
		const layoutEntry = findEntry(entries, "layout.json");
		if (layoutEntry !== void 0) fileResult.middle_json = unzipEntry(zipBuffer, layoutEntry).toString("utf8");
		return {
			backend: `cloud-${this.modelVersion}`,
			version: "api-v4",
			results: { [stem]: fileResult }
		};
	}
};
//#endregion
//#region src/tools.ts
/**
* tools.ts — 5 model-facing MinerU tools.
*
* Tools:
*   mineru_health             — GET /health (capacity preflight)
*   mineru_submit_parse_job   — POST /tasks (async submit, returns task_id)
*   mineru_get_parse_status   — GET /tasks/{id} (poll status)
*   mineru_get_parse_result   — GET /tasks/{id}/result (fetch completed result)
*   mineru_parse_document     — high-level folded flow: submit → poll → result
*
* Conventions (per plugin-development-guide.md §3):
*   C4 — execute returns a canonical JSON value; render is a separate pure projection.
*   C6 — exec.signal is honored at every await point.
*   C10 — no UI-specific formats in the canonical value.
*/
const MINERU_BACKENDS = [
	"pipeline",
	"vlm-engine",
	"hybrid-engine",
	"vlm-http-client",
	"hybrid-http-client"
];
const MINERU_PARSE_METHODS = [
	"auto",
	"txt",
	"ocr"
];
function textRender(fn) {
	return (_args, value) => [{
		type: "text",
		text: fn(value)
	}];
}
function toParseParams(args, config) {
	return {
		backend: args.backend ?? config.defaultBackend,
		parse_method: args.parse_method ?? config.defaultParseMethod,
		lang_list: args.lang_list ?? [config.defaultLang],
		formula_enable: args.formula_enable ?? true,
		table_enable: args.table_enable ?? true,
		return_md: true,
		return_middle_json: args.return_middle_json ?? false,
		return_content_list: args.return_content_list ?? false,
		return_images: args.return_images ?? false,
		start_page_id: args.start_page_id ?? 0,
		end_page_id: args.end_page_id ?? 99999
	};
}
async function maybeTruncateMd(md, maxChars, taskId) {
	if (md.length <= maxChars) return {
		content: md,
		truncated: false
	};
	const fullMdPath = join(tmpdir(), `mineru-${taskId}.md`);
	await writeFile(fullMdPath, md, "utf8");
	return {
		content: md.slice(0, maxChars) + `\n\n... [truncated; full content saved to ${fullMdPath}]`,
		truncated: true,
		fullMdPath
	};
}
function renderHealthOutput(value) {
	const lines = [`MinerU server: ${value.status}`];
	if (value.version) lines.push(`Version: ${value.version}`);
	if (value.queued_tasks !== void 0) lines.push(`Queue: ${value.queued_tasks} queued, ${value.processing_tasks ?? 0} processing, ${value.completed_tasks ?? 0} completed, ${value.failed_tasks ?? 0} failed`);
	if (value.max_concurrent_requests !== void 0) lines.push(`Capacity: ${value.max_concurrent_requests} max concurrent`);
	return lines.join("\n");
}
function renderSubmitOutput(value) {
	const lines = [`MinerU task submitted: ${value.task_id}`, `Status: ${value.status}`];
	if (value.queued_ahead !== void 0) lines.push(`Queued ahead: ${value.queued_ahead}`);
	if (value.status_url) lines.push(`Status URL: ${value.status_url}`);
	if (value.result_url) lines.push(`Result URL: ${value.result_url}`);
	lines.push("");
	lines.push("Poll with mineru_get_parse_status, then fetch with mineru_get_parse_result.");
	return lines.join("\n");
}
function renderStatusOutput(value) {
	const lines = [`Task ${value.task_id}: ${value.status}`];
	if (value.file_names && value.file_names.length > 0) lines.push(`Files: ${value.file_names.join(", ")}`);
	if (value.queued_ahead !== void 0) lines.push(`Queued ahead: ${value.queued_ahead}`);
	if (value.extracted_pages !== void 0 && value.total_pages !== void 0) lines.push(`Progress: ${value.extracted_pages}/${value.total_pages} pages`);
	if (value.created_at) lines.push(`Created: ${value.created_at}`);
	if (value.completed_at) lines.push(`Completed: ${value.completed_at}`);
	if (value.error) lines.push(`Error: ${value.error}`);
	return lines.join("\n");
}
function renderResultOutput(value) {
	const lines = [`MinerU result for task ${value.task_id}`];
	if (value.backend) lines.push(`Backend: ${value.backend} (v${value.version ?? "?"})`);
	if (value.file_stems && value.file_stems.length > 0) lines.push(`Files: ${value.file_stems.join(", ")}`);
	if (value.raw_result_path) lines.push(`Full result JSON: ${value.raw_result_path}`);
	if (value.md_truncated && value.full_md_path) lines.push(`Full markdown: ${value.full_md_path}`);
	if (value.md_content) {
		lines.push("");
		lines.push(value.md_content);
	}
	return lines.join("\n");
}
function renderParseDocOutput(value) {
	const lines = [`MinerU parse ${value.status} (task: ${value.task_id})`];
	if (value.backend) lines.push(`Backend: ${value.backend} (v${value.version ?? "?"})`);
	if (value.file_stems && value.file_stems.length > 0) lines.push(`Files: ${value.file_stems.join(", ")}`);
	if (value.error) lines.push(`Error: ${value.error}`);
	else if (value.md_content) {
		if (value.md_truncated && value.full_md_path) lines.push(`[Markdown truncated; full content at ${value.full_md_path}]`);
		lines.push("");
		lines.push(value.md_content);
	}
	return lines.join("\n");
}
function toHealthOutput(h) {
	return {
		status: h.status,
		version: h.version,
		queued_tasks: h.queued_tasks,
		processing_tasks: h.processing_tasks,
		completed_tasks: h.completed_tasks,
		failed_tasks: h.failed_tasks,
		max_concurrent_requests: h.max_concurrent_requests
	};
}
function toSubmitOutput(s) {
	const out = {
		task_id: s.task_id,
		status: s.status
	};
	if (s.status_url) out.status_url = s.status_url;
	if (s.result_url) out.result_url = s.result_url;
	if (s.queued_ahead !== void 0) out.queued_ahead = s.queued_ahead;
	return out;
}
function toStatusOutput(s) {
	const out = {
		task_id: s.task_id,
		status: s.status
	};
	if (s.file_names && s.file_names.length > 0) out.file_names = s.file_names;
	if (s.created_at) out.created_at = s.created_at;
	if (s.started_at) out.started_at = s.started_at;
	if (s.completed_at) out.completed_at = s.completed_at;
	if (s.error) out.error = s.error;
	if (s.queued_ahead !== void 0) out.queued_ahead = s.queued_ahead;
	const extra = s;
	if (extra.extracted_pages !== void 0) out.extracted_pages = extra.extracted_pages;
	if (extra.total_pages !== void 0) out.total_pages = extra.total_pages;
	return out;
}
function registerTools(ctx, getClient, getConfig) {
	const client = () => getClient();
	const config = () => getConfig();
	ctx.tools.register(defineTool({
		name: "mineru_health",
		description: "Check MinerU server health and capacity. Returns server status, version, queue depth (queued/processing/completed/failed task counts), and max concurrency. Useful before submitting large batch jobs to check available capacity. No parameters required.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					status: {
						type: "string",
						required: true,
						description: "Server health status: \"healthy\" or \"unhealthy\"."
					},
					version: {
						type: "string",
						description: "MinerU server version."
					},
					queued_tasks: {
						type: "integer",
						description: "Number of tasks waiting in queue."
					},
					processing_tasks: {
						type: "integer",
						description: "Number of tasks currently being processed."
					},
					completed_tasks: {
						type: "integer",
						description: "Number of completed tasks (retained 24h)."
					},
					failed_tasks: {
						type: "integer",
						description: "Number of failed tasks."
					},
					max_concurrent_requests: {
						type: "integer",
						description: "Maximum concurrent processing requests."
					}
				}
			},
			render: textRender(renderHealthOutput)
		},
		execute: async (_args, exec) => {
			exec.signal.throwIfAborted();
			return toHealthOutput(await client().health(exec.signal));
		}
	}));
	ctx.tools.register(defineTool({
		name: "mineru_submit_parse_job",
		description: "Submit a document to MinerU for asynchronous parsing and return immediately with a task_id. Poll the task status with mineru_get_parse_status, then fetch results with mineru_get_parse_result. Use this for large documents that may take minutes to parse, or when submitting multiple jobs in parallel. The file must be a local filesystem path; if you only have a URL, download it first (e.g., via bash curl). Default backend is 'pipeline' (hallucination-free, supports all languages). In cloud mode (mineru.net API, set on the plugin configure page) the file uploads via a signed URL and the backend parameter is ignored in favor of the configured cloud model version.",
		parameters: {
			file_path: {
				type: "string",
				required: true,
				description: "Local filesystem path to the document (PDF, PNG, JPG, DOCX, PPTX, or XLSX)."
			},
			backend: {
				type: "string",
				enum: MINERU_BACKENDS,
				description: "Parsing backend. 'pipeline': hallucination-free, multi-language. 'hybrid-engine': MinerU default, requires VLM. 'vlm-engine': VLM only."
			},
			parse_method: {
				type: "string",
				enum: MINERU_PARSE_METHODS,
				description: "Parse method (pipeline/hybrid only). 'auto': auto-detect. 'txt': text only (fast). 'ocr': force OCR."
			},
			lang_list: {
				type: "array",
				items: { type: "string" },
				description: "Language codes for pipeline backend (e.g., 'ch' for Chinese/English/Japanese). Defaults to ['ch']."
			},
			formula_enable: {
				type: "boolean",
				description: "Enable formula parsing. Default: true."
			},
			table_enable: {
				type: "boolean",
				description: "Enable table parsing. Default: true."
			},
			start_page_id: {
				type: "integer",
				description: "PDF page range start (0-indexed). Default: 0."
			},
			end_page_id: {
				type: "integer",
				description: "PDF page range end (0-indexed, inclusive). Default: 99999 (all pages)."
			},
			return_middle_json: {
				type: "boolean",
				description: "Include middle JSON (intermediate parsing structure). Default: false."
			},
			return_content_list: {
				type: "boolean",
				description: "Include content list JSON (structured content blocks). Default: false."
			},
			return_images: {
				type: "boolean",
				description: "Include extracted images (base64 data URLs). Can be large. Default: false."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					task_id: {
						type: "string",
						required: true,
						description: "MinerU task ID. Use with mineru_get_parse_status and mineru_get_parse_result."
					},
					status: {
						type: "string",
						required: true,
						description: "Initial task status (typically \"pending\")."
					},
					status_url: {
						type: "string",
						description: "URL to poll task status."
					},
					result_url: {
						type: "string",
						description: "URL to fetch task result."
					},
					queued_ahead: {
						type: "integer",
						description: "Number of tasks ahead in queue."
					}
				}
			},
			render: textRender(renderSubmitOutput)
		},
		timeoutMs: 12e4,
		execute: async (args, exec) => {
			const a = args;
			exec.signal.throwIfAborted();
			return toSubmitOutput(await client().submitTask(a.file_path, toParseParams(a, config()), exec.signal));
		}
	}));
	ctx.tools.register(defineTool({
		name: "mineru_get_parse_status",
		description: "Check the status of an asynchronous MinerU parsing task. Returns: \"pending\" (in queue), \"processing\" (being parsed), \"completed\" (done — fetch with mineru_get_parse_result), or \"failed\" (error occurred). Poll every few seconds; a 1-page PDF takes ~1-2s, large documents can take minutes.",
		parameters: { task_id: {
			type: "string",
			required: true,
			description: "Task ID returned by mineru_submit_parse_job."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					task_id: {
						type: "string",
						required: true
					},
					status: {
						type: "string",
						description: "Task status: \"pending\", \"processing\", \"completed\", or \"failed\".",
						required: true
					},
					file_names: {
						type: "array",
						items: { type: "string" },
						description: "Normalized file stems being parsed."
					},
					created_at: {
						type: "string",
						description: "ISO-8601 timestamp."
					},
					started_at: {
						type: "string",
						description: "ISO-8601 timestamp."
					},
					completed_at: {
						type: "string",
						description: "ISO-8601 timestamp."
					},
					error: {
						type: "string",
						description: "Error message if status is \"failed\"."
					},
					queued_ahead: {
						type: "integer",
						description: "Tasks ahead in queue (only while pending)."
					},
					extracted_pages: {
						type: "integer",
						description: "Pages parsed so far (cloud mode, while processing)."
					},
					total_pages: {
						type: "integer",
						description: "Total document pages (cloud mode, while processing)."
					}
				}
			},
			render: textRender(renderStatusOutput)
		},
		execute: async (args, exec) => {
			const a = args;
			exec.signal.throwIfAborted();
			return toStatusOutput(await client().getTaskStatus(a.task_id, exec.signal));
		}
	}));
	ctx.tools.register(defineTool({
		name: "mineru_get_parse_result",
		description: "Fetch the parsing result for a completed MinerU task. The task must have status \"completed\" (check with mineru_get_parse_status first). Returns the parsed markdown content inline (truncated if very large; full content saved to a file). The full structured JSON result (including middle_json, content_list, and images if requested at submit time) is always saved to raw_result_path for inspection with file-reading tools.",
		parameters: { task_id: {
			type: "string",
			required: true,
			description: "Task ID of a completed parsing job."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					task_id: {
						type: "string",
						required: true
					},
					backend: { type: "string" },
					version: { type: "string" },
					file_stems: {
						type: "array",
						items: { type: "string" }
					},
					md_content: {
						type: "string",
						description: "Parsed markdown of the first file (truncated if exceeds maxMdOutputChars)."
					},
					md_truncated: {
						type: "boolean",
						description: "Whether md_content was truncated."
					},
					full_md_path: {
						type: "string",
						description: "Path to full markdown file if truncated."
					},
					raw_result_path: {
						type: "string",
						description: "Path to a JSON file with the full structured result (all files, all formats)."
					}
				}
			},
			render: textRender(renderResultOutput)
		},
		timeoutMs: 12e4,
		execute: async (args, exec) => {
			const a = args;
			exec.signal.throwIfAborted();
			const result = await client().getTaskResult(a.task_id, exec.signal);
			const fileStems = Object.keys(result.results);
			const firstStem = fileStems[0];
			const mdContent = (firstStem !== void 0 ? result.results[firstStem] : void 0)?.md_content ?? "";
			const rawResultPath = join(tmpdir(), `mineru-result-${a.task_id}.json`);
			await writeFile(rawResultPath, JSON.stringify(result, null, 2), "utf8");
			const { content, truncated, fullMdPath } = await maybeTruncateMd(mdContent, config().maxMdOutputChars, a.task_id);
			const out = {
				task_id: a.task_id,
				raw_result_path: rawResultPath
			};
			if (result.backend) out.backend = result.backend;
			if (result.version) out.version = result.version;
			if (fileStems.length > 0) out.file_stems = fileStems;
			if (content) out.md_content = content;
			if (truncated) out.md_truncated = truncated;
			if (fullMdPath) out.full_md_path = fullMdPath;
			return out;
		}
	}));
	ctx.tools.register(defineTool({
		name: "mineru_parse_document",
		description: "Parse a local document (PDF, image, DOCX, PPTX, or XLSX) via MinerU and return the extracted markdown. This is the recommended high-level tool: it submits the file, polls until parsing completes (up to poll_timeout_ms), and returns the markdown content inline. For large documents or when you need to interleave other work, use mineru_submit_parse_job + mineru_get_parse_status + mineru_get_parse_result instead. The file must be a local filesystem path; if you only have a URL, download it first (e.g., via bash curl). Default backend is 'pipeline' (hallucination-free, supports all languages). In cloud mode (mineru.net API, set on the plugin configure page) the file uploads via a signed URL and the backend parameter is ignored in favor of the configured cloud model version.",
		parameters: {
			file_path: {
				type: "string",
				required: true,
				description: "Local filesystem path to the document (PDF, PNG, JPG, DOCX, PPTX, or XLSX)."
			},
			backend: {
				type: "string",
				enum: MINERU_BACKENDS,
				description: "Parsing backend. 'pipeline': hallucination-free, multi-language. 'hybrid-engine': requires VLM model. Default: 'pipeline'."
			},
			parse_method: {
				type: "string",
				enum: MINERU_PARSE_METHODS,
				description: "Parse method (pipeline/hybrid only). 'auto': auto-detect. 'txt': text only (fast). 'ocr': force OCR."
			},
			lang_list: {
				type: "array",
				items: { type: "string" },
				description: "Language codes for pipeline backend (e.g., 'ch'). Defaults to ['ch']."
			},
			formula_enable: {
				type: "boolean",
				description: "Enable formula parsing. Default: true."
			},
			table_enable: {
				type: "boolean",
				description: "Enable table parsing. Default: true."
			},
			start_page_id: {
				type: "integer",
				description: "PDF page range start (0-indexed). Default: 0."
			},
			end_page_id: {
				type: "integer",
				description: "PDF page range end (0-indexed, inclusive). Default: 99999 (all pages)."
			},
			return_middle_json: {
				type: "boolean",
				description: "Include middle JSON in the saved result file. Default: false."
			},
			return_content_list: {
				type: "boolean",
				description: "Include content list JSON in the saved result file. Default: false."
			},
			return_images: {
				type: "boolean",
				description: "Include extracted images in the saved result file. Default: false."
			},
			poll_timeout_ms: {
				type: "number",
				description: "Maximum time (ms) to wait for parsing before timing out. Default: 600000 (10 min)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					task_id: {
						type: "string",
						required: true
					},
					status: {
						type: "string",
						description: "Parse status: \"completed\" or \"failed\".",
						required: true
					},
					backend: { type: "string" },
					version: { type: "string" },
					file_stems: {
						type: "array",
						items: { type: "string" }
					},
					md_content: {
						type: "string",
						description: "Parsed markdown content (truncated if very large)."
					},
					md_truncated: { type: "boolean" },
					full_md_path: {
						type: "string",
						description: "Path to full markdown if truncated."
					},
					error: {
						type: "string",
						description: "Error message if status is \"failed\"."
					}
				}
			},
			render: textRender(renderParseDocOutput)
		},
		timeoutMs: 9e5,
		execute: async (args, exec) => {
			const a = args;
			exec.signal.throwIfAborted();
			const cfg = config();
			const c = client();
			const submit = await c.submitTask(a.file_path, toParseParams(a, cfg), exec.signal);
			const pollTimeoutMs = a.poll_timeout_ms ?? cfg.pollTimeoutMs;
			const finalStatus = await pollUntilDone(client(), submit.task_id, {
				intervalMs: cfg.pollIntervalMs,
				timeoutMs: pollTimeoutMs,
				signal: exec.signal
			});
			if (finalStatus.status === "failed") return {
				task_id: submit.task_id,
				status: "failed",
				error: finalStatus.error ?? "Task failed without error message"
			};
			const result = await c.getTaskResult(submit.task_id, exec.signal);
			const fileStems = Object.keys(result.results);
			const firstStem = fileStems[0];
			const { content, truncated, fullMdPath } = await maybeTruncateMd((firstStem !== void 0 ? result.results[firstStem] : void 0)?.md_content ?? "", cfg.maxMdOutputChars, submit.task_id);
			const out = {
				task_id: submit.task_id,
				status: "completed"
			};
			if (result.backend) out.backend = result.backend;
			if (result.version) out.version = result.version;
			if (fileStems.length > 0) out.file_stems = fileStems;
			if (content) out.md_content = content;
			if (truncated) out.md_truncated = truncated;
			if (fullMdPath) out.full_md_path = fullMdPath;
			return out;
		}
	}));
}
//#endregion
//#region src/rpc.ts
/** Wire endpoint this route owns; the client calls `rpc.call('/api', 'mineru.health', {})`. */
const HEALTH_ENDPOINT = "mineru.health";
function ok(value) {
	return {
		ok: true,
		value
	};
}
function fail(message) {
	return {
		ok: false,
		error: {
			code: "internal",
			message,
			details: {}
		}
	};
}
/** Serialize one RPC result as a server-response envelope. */
function envelopeResponse(rpcId, result) {
	return new Response(JSON.stringify({
		type: "server-response",
		rpcId,
		result
	}), {
		status: 200,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store"
		}
	});
}
/**
* Register the `mineru.health` exact Fetch route on the host's connection
* service. The route rolls back with the plugin fiber; trust and browser
* authentication live on the physical `/api` carrier.
* @param ctx - host context (`connection` is injected by the entry).
* @param deps - live MinerU backend getter (sees the latest config and mode).
*/
function registerRpc(ctx, deps) {
	ctx.logger.info(`dsh-mineru: registering ${API_PATH}/${HEALTH_ENDPOINT} Fetch route`);
	ctx.effect(() => ctx.connection.fetch.register({
		path: `${API_PATH}/${HEALTH_ENDPOINT}`,
		methods: ["POST"],
		requestBody: "buffered",
		fetch: async (request) => {
			if (request.method !== "POST") return new Response("not found", { status: 404 });
			if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return new Response("content type must be application/json", { status: 415 });
			let body;
			try {
				body = await request.json();
			} catch {
				return new Response("body is not JSON", { status: 400 });
			}
			const envelope = body;
			if (envelope === null || typeof envelope !== "object" || envelope.type !== "client-request" || typeof envelope.rpcId !== "string" || envelope.rpcId === "" || typeof envelope.method !== "string") return envelopeResponse("invalid-request", fail("invalid client-request message"));
			if (envelope.method !== "mineru.health") return envelopeResponse(envelope.rpcId, fail(`method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(HEALTH_ENDPOINT)}`));
			try {
				const h = await deps.getBackend().health(request.signal);
				return envelopeResponse(envelope.rpcId, ok({
					status: h.status,
					version: h.version,
					queued_tasks: h.queued_tasks,
					processing_tasks: h.processing_tasks,
					completed_tasks: h.completed_tasks,
					failed_tasks: h.failed_tasks,
					max_concurrent_requests: h.max_concurrent_requests
				}));
			} catch (err) {
				return envelopeResponse(envelope.rpcId, fail(err instanceof Error ? err.message : String(err)));
			}
		}
	}), `dsh-mineru: ${API_PATH}/${HEALTH_ENDPOINT} Fetch route`);
}
//#endregion
//#region src/index.ts
/**
* index.ts — dsh-mineru cordis plugin entry (host half).
*
* Dual-entry bundle: this is the host half (exports `.`). The browser half
* ships via `./client` (see `src/client/index.ts`).
*
* Architecture:
*   - 5 model-facing tools (health, submit, status, result, parse_document)
*     registered once at load; each tool reads the live client/config via
*     getters, so config mutations hot-reload without re-registration.
*   - Settings are the profile-owned Cordis Config (dsh 0.1.7-rc.1
*     `DSH-0.1.7-J1-04`): every user-editable field is `.volatile()`, so the
*     Loader hands `apply` live references whose `.get()` returns the latest
*     accepted value. Edits from the plugin's configuration card (Plugins
*     page) travel through the Host
*     settings service (`ctx.configForms` on the browser side), persist per
*     profile in `cordis.patch.yml` under the entry id `dsh-mineru`, and
*     update the volatile references in place — no plugin remount. The
*     cordis.yml `config:` block stays the composition base (first-boot seed).
*   - One RPC endpoint remains for the browser configuration card: the
*     `mineru.health` probe, served as an exact Fetch route on the shared
*     `/api` channel (`connection.fetch.register`). Dedicated `rpc.handle`
*     channels cannot mount in the web profile (the webserver is a sibling
*     loader row, never an ancestor of this fiber), so config CRUD no longer
*     rides a custom channel at all.
*/
const name = "dsh-mineru";
const inject = ["tools", "connection"];
/**
* Schemastery schema for the plugin's profile-owned Config.
*
* Every field is `.volatile()` (dsh 0.1.7-rc.1): the settings service
* enumerates them for the configuration form, and a committed edit updates
* the running reference in place. Defaults are the composition-layer seed.
*/
const Config = z.object({
	mode: z.union(["local", "cloud"]).default("local").volatile(),
	baseURL: z.string().description("MinerU self-hosted API base URL (e.g. http://host:18000). Required in local mode.").volatile(),
	apiKeyEnv: z.string().role("credential-ref").default("MINERU_API_KEY").volatile(),
	cloudBaseURL: z.string().default("https://mineru.net").volatile(),
	cloudApiKeyEnv: z.string().role("credential-ref").default("MINERU_CLOUD_API_KEY").volatile(),
	cloudModelVersion: z.union(["pipeline", "vlm"]).default("vlm").volatile(),
	defaultBackend: z.union([
		"pipeline",
		"vlm-engine",
		"hybrid-engine",
		"vlm-http-client",
		"hybrid-http-client"
	]).default("pipeline").volatile(),
	defaultParseMethod: z.union([
		"auto",
		"txt",
		"ocr"
	]).default("auto").volatile(),
	defaultLang: z.string().default("ch").volatile(),
	pollIntervalMs: z.number().default(2e3).volatile(),
	pollTimeoutMs: z.number().default(6e5).volatile(),
	requestTimeoutMs: z.number().default(6e4).volatile(),
	maxMdOutputChars: z.number().default(2e5).volatile()
});
/** Read the current value of a volatile (or plain, in hand-built contexts) field. */
function live(ref) {
	if (typeof ref === "object" && ref !== null && typeof ref.get === "function") return ref.get();
	return ref;
}
function resolveConfig(entry) {
	const mode = live(entry.mode) === "cloud" ? "cloud" : "local";
	const baseURL = live(entry.baseURL);
	if (mode === "local" && (typeof baseURL !== "string" || baseURL === "")) throw new Error("dsh-mineru: config \"baseURL\" is required in local mode. Set it on the plugin's configure page in the DSH GUI Plugins list or in cordis.patch.yml.");
	return {
		mode,
		baseURL,
		apiKeyEnv: live(entry.apiKeyEnv) ?? "MINERU_API_KEY",
		cloudBaseURL: live(entry.cloudBaseURL) ?? "https://mineru.net",
		cloudApiKeyEnv: live(entry.cloudApiKeyEnv) ?? "MINERU_CLOUD_API_KEY",
		cloudModelVersion: live(entry.cloudModelVersion) === "pipeline" ? "pipeline" : "vlm",
		defaultBackend: live(entry.defaultBackend) ?? "pipeline",
		defaultParseMethod: live(entry.defaultParseMethod) ?? "auto",
		defaultLang: live(entry.defaultLang) ?? "ch",
		pollIntervalMs: live(entry.pollIntervalMs) ?? 2e3,
		pollTimeoutMs: live(entry.pollTimeoutMs) ?? 6e5,
		requestTimeoutMs: live(entry.requestTimeoutMs) ?? 6e4,
		maxMdOutputChars: live(entry.maxMdOutputChars) ?? 2e5
	};
}
function resolveApiKey(ctx, apiKeyEnv) {
	return async () => {
		try {
			const credentials = ctx.get("credentials");
			if (credentials?.resolve) {
				const hit = await credentials.resolve(apiKeyEnv);
				if (hit?.value) return hit.value;
			}
		} catch {}
		const envVal = process.env[apiKeyEnv];
		return envVal && envVal.length > 0 ? envVal : void 0;
	};
}
function makeBackend(ctx, resolved) {
	if (resolved.mode === "cloud") return new MinerUCloudClient({
		baseURL: resolved.cloudBaseURL,
		apiKeyEnv: resolved.cloudApiKeyEnv,
		modelVersion: resolved.cloudModelVersion,
		timeoutMs: resolved.requestTimeoutMs,
		apiKeyResolver: resolveApiKey(ctx, resolved.cloudApiKeyEnv)
	});
	return new MinerUClient({
		baseURL: resolved.baseURL,
		timeoutMs: resolved.requestTimeoutMs,
		apiKeyResolver: resolveApiKey(ctx, resolved.apiKeyEnv)
	});
}
function apply(ctx, config = {}) {
	let resolved = resolveConfig(config);
	let backend = makeBackend(ctx, resolved);
	const getResolved = () => {
		const next = resolveConfig(config);
		if (JSON.stringify(next) !== JSON.stringify(resolved)) {
			resolved = next;
			backend = makeBackend(ctx, next);
			ctx.logger.info(`dsh-mineru: config updated, mode=${next.mode}${next.mode === "cloud" ? ` (${next.cloudBaseURL}, ${next.cloudModelVersion})` : ` baseURL=${next.baseURL}`}`);
		}
		return resolved;
	};
	const getBackend = () => {
		getResolved();
		return backend;
	};
	registerTools(ctx, getBackend, getResolved);
	ctx.inject(["settings"], (sctx) => {
		sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber));
	});
	registerRpc(ctx, { getBackend });
}
//#endregion
export { Config, apply, inject, name };
