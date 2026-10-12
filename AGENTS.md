# dsh-mineru — Agent Guide

## Plugin overview

Bundle-style DSH plugin exposing 5 MinerU document-parsing tools to the model. Dual transport modes selected on the configure card (`plugins.row.config`): `local` (self-hosted FastAPI, protocol v2) and `cloud` (mineru.net precise-parsing API `/api/v4`). Both modes share the same 5 tools and the same parameter schemas; only the backend adapter swaps.

## Key conventions

- **Bundle form**: `cordis.patch.yml` inserts one plugin row; `package.json` has `dsh.bundle.patch`. No source patches to DSH staging.
- **Peer deps**: `@deepseek-ai/cordis` + `@deepseek-ai/dsh-tools` / `dsh-llm` (host half) and `dsh-client-connection` / `dsh-client-locale` / `dsh-client-ui-settings` / `dsh-client-ui-slots` / `dsh-client-ui-renderer` (client half, type-only). `schemastery` is a direct dependency (config validator).
- **Types from real packages**: `ctx.tools` / `ctx.connection` / `ctx.locale` / `ctx.slots` come from each package's `@deepseek-ai/cordis` Context merge resolved through node_modules links; `src/types.d.ts` only declares CSS modules. `tsconfig.json` `paths` must point at a real DSH installation's `node_modules/@deepseek-ai/*/lib/types` (this machine: the global dsh install at `~/.nvm/versions/node/<v>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`).
- **ESM-only**: `"type": "module"`, relative imports use `.js` extensions (NodeNext).
- **Backend abstraction**: tools depend on `MinerUBackend` (src/client.ts). `MinerUClient` = local; `MinerUCloudClient` (src/cloud.ts) = mineru.net v4. `apply` builds one via `makeBackend` from the live config; hot config edits swap the instance in place, tools never re-register.
- **defineTool contract**: `execute` returns a canonical JSON value; `render` is a separate pure projection. `exec.signal` honored at every await point.
- **API keys**: resolved lazily via `ctx.get('credentials')` (if loaded) then `process.env[apiKeyEnv]`. Local: `MINERU_API_KEY`; cloud: `MINERU_CLOUD_API_KEY`. MinerU's open-source server has no built-in auth; the cloud API requires a Bearer token created on the mineru.net API management page.
- **Settings are the profile-owned Cordis Config** (dsh 0.1.7-rc.1 `DSH-0.1.7-J1-04`): every user-editable field is `.volatile()`, so `apply` receives live references (`EntryConfig`) whose values re-resolve on every read. The settings page reads/writes through `ctx.configForms` (`DSH-0.1.7-J1-27`); edits persist to the active profile's `cordis.patch.yml` under the entry id `dsh-mineru` and hot-reload the running instance. `settings.configure({ auto: false })` suppresses the schema-generated page (this plugin ships its own `plugins.row.config` card on the Plugins page).
- **Health RPC is an exact Fetch route on `/api`** (`mineru.health` via `connection.fetch.register`): dedicated `rpc.handle` channels cannot mount in the web profile (the webserver is a sibling loader row, never an ancestor of this fiber).

## File responsibilities

| File | Role |
|------|------|
| `src/index.ts` | Entry: `name`, `inject = ['tools', 'connection']`, `Config` (Schemastery, all fields `.volatile()`), `apply` (live-config getters + `makeBackend` local/cloud + settings own-page policy + RPC) |
| `src/client.ts` | `MinerUBackend` interface, `MinerUClient` (local protocol v2: fetch + signal + optional bearer), `buildFormData`, `pollUntilDone`, `sleep`, types |
| `src/cloud.ts` | `MinerUCloudClient` (mineru.net `/api/v4`: file-urls/batch + pre-signed PUT upload, extract-results polling, zip download + extraction), zero-dependency zip reader (`readZipEntries`/`unzipEntry`), `toPageRanges` |
| `src/tools.ts` | 5 `defineTool` definitions, `registerTools()`, render helpers, `maybeTruncateMd` |
| `src/rpc.ts` | Host RPC: `mineru.health` exact Fetch route on `/api` (envelope handling; config CRUD lives in the settings service, not here) |
| `src/types.d.ts` | Ambient CSS-module declarations |
| `src/client/index.ts` | Client entry: `inject = ['slots','locale','connection','configForms']`; binds the entry `ConfigForm`, registers the `plugins.row.config` card (key `@huanlin/dsh-plugin-mineru#dsh-mineru`) while the Host serves the entry |
| `src/client/settings-form.ts` | `MineruSettingsController`: staged edits over the `ConfigForm`, publishes the card snapshot store |
| `src/client/SettingsPage.tsx` | Plugins-page row config card: `view: 'summary'` one-liner + `view: 'page'` form (mode selector + mode-conditional fields + save + test connection, reads via bound `useMineruSettings`) |
| `src/client/locales.ts` | en/zh dictionaries (`dsh-mineru` namespace) |
| `src/client/dictionaries.ts` | better-locale override dictionaries (19 locales) |
| `tests/tools.spec.ts` | Local-mode unit tests (mocked fetch, no live server) |
| `tests/cloud.spec.ts` | Cloud-mode unit tests (v4 protocol mapping, zip reader, envelope errors) |

## Commands

```sh
pnpm run typecheck    # tsc --noEmit (src only)
pnpm test             # vitest run
pnpm run build        # tsdown → lib/
```

## Adding a new tool

1. Add a `ctx.tools.register(defineTool({ ... }))` call in `registerTools()` in `src/tools.ts`.
2. Follow the C-contract: `parameters` as plain `ParameterSchemaSpec` object, `output.schema` as `ValueSchemaSpec`, `output.render` as pure function returning `ContentBlock[]`.
3. Object schemas must declare `additionalProperties: boolean`.
4. Honor `exec.signal` — call `exec.signal.throwIfAborted()` before async work and pass `exec.signal` to `fetch`.

## MinerU API gotchas

### Local (self-hosted, protocol v2)
- Default backend `hybrid-engine` requires a VLM model; use `pipeline` for CPU-only servers.
- `lang_list` is pipeline-only; silently ignored for VLM/hybrid backends.
- `return_images` can produce very large base64 payloads; prefer `response_format_zip` for image-heavy docs.
- Tasks are retained 24h; don't cache `task_id` across long sessions.
- `end_page_id` default is `99999` (not "last page").
- File stems in results are normalized (no extension); match via the `file_names` array from the submit response.

### Cloud (mineru.net `/api/v4` precise-parsing)
- Submit is two-step: `POST /api/v4/file-urls/batch` returns `batch_id` + pre-signed `file_urls`; then `PUT` the raw bytes with **no Content-Type and no Authorization header** (the URL carries its own auth). The server auto-submits the parse task after upload.
- Tool-level `task_id` **is** the v4 `batch_id`; poll via `GET /api/v4/extract-results/batch/{batch_id}`.
- v4 states map `waiting-file/pending → pending`, `running/converting → processing`, `done → completed`, `failed → failed`. `done` carries `full_zip_url`; the zip contains `full.md`, `layout.json` (= middle.json), `*_content_list.json`.
- `page_ranges` is 1-based and a string (`"2-5"`); the tools' 0-based `start_page_id/end_page_id` map by +1; the `99999` sentinel maps to an open-ended range (`"3-"`) or omits the param for full range.
- Envelope: HTTP 200 + `{code, msg, trace_id, data}`; `code !== 0` is a business failure. `A0202`/`A0211` = bad/expired token.
- Limits: 200 MB / 200 pages per file; 1000 pages/day top-priority quota per account (beyond it priority drops); foreign URLs (github, aws) time out on their fetcher.
- `model_version` only accepts `pipeline` / `vlm`; the tool `backend` parameter is ignored in cloud mode in favor of `cloudModelVersion`.
- No public health endpoint: `health()` probes with `GET /api/v4/extract/task/dsh-mineru-probe` — `code -60012` (task not found) proves reachability + valid token without creating a task.
- The plugin only submits local files (no URL submission): the tool contract stays `file_path` in both modes.
