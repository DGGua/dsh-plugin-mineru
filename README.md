<p align="center">
  <a href="https://dshfind.com/zh/plugins/huanlinoto/dsh-plugin-mineru"><img src="https://dshfind.com/api/card/huanlinoto/dsh-plugin-mineru?lang=zh" alt="dsh-plugin-mineru card"></a>
</p>

# dsh-mineru

[![npm version](https://img.shields.io/npm/v/@huanlin/dsh-plugin-mineru)](https://www.npmjs.com/package/@huanlin/dsh-plugin-mineru)

DSH 插件：向模型暴露 [MinerU](https://github.com/opendatalab/MinerU) 文档解析工具。MinerU 可将 PDF、图片、DOCX、PPTX、XLSX 等文件转换为结构化的 Markdown / JSON。支持两种后端模式：**local**（自托管 MinerU 服务器）与 **cloud**（[mineru.net](https://mineru.net/apiManage/docs) 官方精准解析 API）。

## 安装

```sh
# 从 npm 安装（推荐）：
dsh plugin --profile web add @huanlin/dsh-plugin-mineru

# 从本地 checkout 开发安装：
dsh plugin --profile web add link:D:\Projects\deepseek-harness\dsh-mineru
```

若从 git 安装（pnpm ≥10），需在 profile 的 `pnpm-workspace.yaml` 中允许构建：

```yaml
allowBuilds:
  '@huanlin/dsh-plugin-mineru': true
```

## 配置

在 DSH GUI 的 **Plugins 页**（插件列表 → `@huanlin/dsh-plugin-mineru` 包 → `dsh-mineru` 行 → Configure）或 `cordis.patch.yml` 中配置。配置页的修改通过 dsh 0.1.7-rc.1 的 profile-owned Config 持久化到当前 profile 的 `cordis.patch.yml`，并对运行中的 `mineru_*` 工具即时生效：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `mode` | enum | `local` | `local`（自托管服务器）/ `cloud`（mineru.net 精准解析 API） |
| `baseURL` | string | *(local 必填)* | 自托管 MinerU API 地址，如 `http://your-mineru-host:18000` |
| `apiKeyEnv` | credential-ref | `MINERU_API_KEY` | local 模式 API key 的环境变量名 / 凭据引用。测试实例无需鉴权。 |
| `cloudBaseURL` | string | `https://mineru.net` | cloud 模式 API 地址（一般不用改） |
| `cloudApiKeyEnv` | credential-ref | `MINERU_CLOUD_API_KEY` | cloud 模式 token 的环境变量名 / 凭据引用。在 [mineru.net API 管理页](https://mineru.net/apiManage) 创建 token 后 `export MINERU_CLOUD_API_KEY=...` |
| `cloudModelVersion` | enum | `vlm` | cloud 模式模型版本：`vlm`（官方推荐）/ `pipeline`（无 VLM、多语言） |
| `defaultBackend` | enum | `pipeline` | local 模式默认后端：`pipeline` / `vlm-engine` / `hybrid-engine` / `vlm-http-client` / `hybrid-http-client` |
| `defaultParseMethod` | enum | `auto` | `auto` / `txt` / `ocr`（cloud 模式映射为 `is_ocr`） |
| `defaultLang` | string | `ch` | 语言代码（两种模式通用，cloud 映射为 `language`） |
| `pollIntervalMs` | number | `2000` | 异步状态轮询间隔 |
| `pollTimeoutMs` | number | `600000` | `mineru_parse_document` 最大轮询时长（10 分钟） |
| `requestTimeoutMs` | number | `60000` | 单次 HTTP 请求超时 |
| `maxMdOutputChars` | number | `200000` | 内联返回给模型的 markdown 字符上限；超出时完整内容存到临时文件 |

### 双模式说明

- **local（默认）**：直连自托管 MinerU FastAPI 服务器（v3.4.4，protocol v2），行为与旧版本完全一致。
- **cloud**：走 mineru.net 官方精准解析 API（`/api/v4`）。本地文件经"申请预签名上传链接 → PUT 上传 → 服务端自动提交"三步流转；工具层的 `task_id` 即官方 `batch_id`；完成后插件自动下载结果 zip 并解出 markdown / content_list / layout.json。结果 zip 原样存于临时目录 `mineru-cloud-<task_id>.zip` 可供检查。
  - 限制：单文件 ≤200MB、≤200 页；每账号每天 1000 页最高优先级额度，超出降级排队；`backend` 参数在 cloud 模式下被忽略（用 `cloudModelVersion`）；`start/end_page_id`（0 基）自动映射为官方 1 基 `page_ranges`。
  - cloud 无公开健康端点，「测试连接」用一次只读查询探测可达性与 token 有效性（`A0202`/`A0211` 会提示检查 token），不产生解析任务。
  - 两种模式下 5 个工具的名称、参数 schema 完全一致，切换模式无需改任何调用方。

## 工具

### `mineru_parse_document`（推荐）

解析本地文档并返回提取出的 markdown。内部自动完成：提交文件 → 轮询至完成 → 返回 markdown。大多数解析任务用这个即可。

### `mineru_submit_parse_job`

异步提交解析任务，立即返回 `task_id`。适合大文档或并行批量提交。

### `mineru_get_parse_status`

轮询异步任务状态，返回 `pending` / `processing` / `completed` / `failed`。

### `mineru_get_parse_result`

获取已完成任务的结果。内联返回 markdown（过大则截断），并将完整结构化 JSON 存到 `raw_result_path`。

### `mineru_health`

检查服务器健康状态、版本、队列深度与并发容量。

## 开发

```sh
pnpm install          # 安装开发依赖（schemastery、typescript、vitest）
pnpm run typecheck    # tsc --noEmit 类型检查
pnpm test             # vitest run 单元测试
pnpm run build        # tsdown 构建 → lib/
```

## 目录结构

```
dsh-mineru/
├── src/
│   ├── index.ts        # 入口：name、inject、Config（Schemastery，字段 .volatile()）、apply、makeBackend(local/cloud)
│   ├── client.ts       # MinerUClient（自托管 protocol v2）+ MinerUBackend 统一接口 + pollUntilDone
│   ├── cloud.ts        # MinerUCloudClient（mineru.net /api/v4：签名上传、轮询、zip 解压）+ 零依赖 zip reader
│   ├── tools.ts        # 5 个 defineTool 定义 + 辅助函数 + registerTools
│   ├── rpc.ts          # mineru.health /api Fetch 路由（Plugins 页配置卡「测试连接」）
│   ├── client/         # 浏览器半：plugins.row.config 注册（Plugins 页行配置卡）+ configForms 取数/写数
│   └── types.d.ts      # CSS modules 环境类型声明
├── tests/
│   ├── tools.spec.ts   # local 模式单元测试（mock fetch，无需真实服务器）
│   └── cloud.spec.ts   # cloud 模式单元测试（v4 协议映射 + zip 解压）
├── cordis.patch.yml    # bundle 层：插入 dsh-mineru 插件行
├── package.json        # dsh.bundle.patch 声明 + peerDeps
└── tsconfig.json       # NodeNext、ES2022、strict
```

## 测试 API

- **local 模式**：请自己部署 MinerU 实例。`cordis.patch.yml` 默认指向 `http://localhost:18000`，请在 DSH GUI 的 Plugins 页打开本插件的 Configure 页覆盖 `baseURL`，改为你的 MinerU 服务器地址。
- **cloud 模式**：在 [mineru.net](https://mineru.net) 注册并在 [API 管理页](https://mineru.net/apiManage) 创建 token，`export MINERU_CLOUD_API_KEY=<token>` 后在 Configure 页把 Mode 切到 cloud 即可，无需部署任何服务。
