export type MineruKey =
  | 'page.summary'
  | 'page.unavailable'
  | 'page.readOnly'
  | 'field.mode'
  | 'field.mode.hint'
  | 'mode.local'
  | 'mode.cloud'
  | 'field.baseURL'
  | 'field.baseURL.placeholder'
  | 'field.apiKeyEnv'
  | 'field.apiKeyEnv.placeholder'
  | 'field.cloudBaseURL'
  | 'field.cloudBaseURL.placeholder'
  | 'field.cloudApiKeyEnv'
  | 'field.cloudApiKeyEnv.placeholder'
  | 'field.cloudApiKeyEnv.hint'
  | 'field.cloudModelVersion'
  | 'model.pipeline'
  | 'model.vlm'
  | 'field.defaultBackend'
  | 'field.defaultParseMethod'
  | 'field.defaultLang'
  | 'field.pollIntervalMs'
  | 'field.pollTimeoutMs'
  | 'field.requestTimeoutMs'
  | 'field.maxMdOutputChars'
  | 'action.save'
  | 'action.saved'
  | 'action.saveFailed'
  | 'action.test'
  | 'action.testing'
  | 'test.healthy'
  | 'test.unhealthy'
  | 'test.error'
  | 'backend.pipeline'
  | 'backend.vlm-engine'
  | 'backend.hybrid-engine'
  | 'backend.vlm-http-client'
  | 'backend.hybrid-http-client'
  | 'parse.auto'
  | 'parse.txt'
  | 'parse.ocr'

export const NS = 'dsh-mineru'

export const en: Record<MineruKey, string> = {
  'page.summary': 'Configure the MinerU document parsing backend (self-hosted API or mineru.net cloud API, key, parse defaults); changes apply immediately to all mineru_* tools.',
  'page.unavailable': 'Configuration is unavailable (the plugin entry is not served by this host).',
  'page.readOnly': 'The active profile does not accept configuration edits.',
  'field.mode': 'Mode',
  'field.mode.hint': 'Local: self-hosted MinerU server. Cloud: mineru.net precise-parsing API (requires an API token).',
  'mode.local': 'local (self-hosted server)',
  'mode.cloud': 'cloud (mineru.net API)',
  'field.baseURL': 'API Base URL (local)',
  'field.baseURL.placeholder': 'http://your-mineru-host:18000',
  'field.apiKeyEnv': 'API Key Env Var (local)',
  'field.apiKeyEnv.placeholder': 'MINERU_API_KEY',
  'field.cloudBaseURL': 'Cloud API Base URL',
  'field.cloudBaseURL.placeholder': 'https://mineru.net',
  'field.cloudApiKeyEnv': 'Cloud API Token Env Var',
  'field.cloudApiKeyEnv.placeholder': 'MINERU_CLOUD_API_KEY',
  'field.cloudApiKeyEnv.hint': 'Create a token on the mineru.net API management page, then export it as this environment variable (or a credentials ref with the same name).',
  'field.cloudModelVersion': 'Cloud Model Version',
  'model.pipeline': 'pipeline (no VLM, multi-language)',
  'model.vlm': 'vlm (recommended, VLM)',
  'field.defaultBackend': 'Default Backend (local)',
  'field.defaultParseMethod': 'Default Parse Method',
  'field.defaultLang': 'Default Language',
  'field.pollIntervalMs': 'Poll Interval (ms)',
  'field.pollTimeoutMs': 'Poll Timeout (ms)',
  'field.requestTimeoutMs': 'Request Timeout (ms)',
  'field.maxMdOutputChars': 'Max Markdown Output Chars',
  'action.save': 'Save',
  'action.saved': 'Saved',
  'action.saveFailed': 'Save failed',
  'action.test': 'Test Connection',
  'action.testing': 'Testing…',
  'test.healthy': 'Healthy',
  'test.unhealthy': 'Unhealthy',
  'test.error': 'Connection failed',
  'backend.pipeline': 'pipeline (no VLM, multi-language)',
  'backend.vlm-engine': 'vlm-engine (VLM only)',
  'backend.hybrid-engine': 'hybrid-engine (VLM + pipeline)',
  'backend.vlm-http-client': 'vlm-http-client',
  'backend.hybrid-http-client': 'hybrid-http-client',
  'parse.auto': 'auto',
  'parse.txt': 'txt (text only, no OCR)',
  'parse.ocr': 'ocr (force OCR)',
}

export const zh: Record<MineruKey, string> = {
  'page.summary': '配置 MinerU 文档解析后端(自托管 API 或 mineru.net 云端 API、密钥与解析默认值);修改对所有 mineru_* 工具即时生效。',
  'page.unavailable': '配置暂不可用(当前 host 未提供此插件条目)。',
  'page.readOnly': '当前 profile 不接受配置修改。',
  'field.mode': '模式',
  'field.mode.hint': 'local:自托管 MinerU 服务器;cloud:mineru.net 精准解析 API(需要 API token)。',
  'mode.local': 'local(自托管服务器)',
  'mode.cloud': 'cloud(mineru.net API)',
  'field.baseURL': 'API 地址(local)',
  'field.baseURL.placeholder': 'http://your-mineru-host:18000',
  'field.apiKeyEnv': 'API Key 环境变量(local)',
  'field.apiKeyEnv.placeholder': 'MINERU_API_KEY',
  'field.cloudBaseURL': '云端 API 地址',
  'field.cloudBaseURL.placeholder': 'https://mineru.net',
  'field.cloudApiKeyEnv': '云端 API Token 环境变量',
  'field.cloudApiKeyEnv.placeholder': 'MINERU_CLOUD_API_KEY',
  'field.cloudApiKeyEnv.hint': '在 mineru.net API 管理页创建 token,并将其导出为该环境变量(或同名凭据引用)。',
  'field.cloudModelVersion': '云端模型版本',
  'model.pipeline': 'pipeline(无 VLM,多语言)',
  'model.vlm': 'vlm(官方推荐,VLM)',
  'field.defaultBackend': '默认后端(local)',
  'field.defaultParseMethod': '默认解析方式',
  'field.defaultLang': '默认语言',
  'field.pollIntervalMs': '轮询间隔 (ms)',
  'field.pollTimeoutMs': '轮询超时 (ms)',
  'field.requestTimeoutMs': '请求超时 (ms)',
  'field.maxMdOutputChars': 'Markdown 输出字符上限',
  'action.save': '保存',
  'action.saved': '已保存',
  'action.saveFailed': '保存失败',
  'action.test': '测试连接',
  'action.testing': '测试中…',
  'test.healthy': '健康',
  'test.unhealthy': '异常',
  'test.error': '连接失败',
  'backend.pipeline': 'pipeline(无 VLM,多语言)',
  'backend.vlm-engine': 'vlm-engine(仅 VLM)',
  'backend.hybrid-engine': 'hybrid-engine(VLM + pipeline)',
  'backend.vlm-http-client': 'vlm-http-client',
  'backend.hybrid-http-client': 'hybrid-http-client',
  'parse.auto': 'auto',
  'parse.txt': 'txt(仅文本,不 OCR)',
  'parse.ocr': 'ocr(强制 OCR)',
}
