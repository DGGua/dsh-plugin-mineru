import z from "@deepseek-ai/schemastery";
import { Context, Volatile } from "@deepseek-ai/cordis";
//#region src/index.d.ts
declare const name = "dsh-mineru";
declare const inject: string[];
type MineruBackend = 'pipeline' | 'vlm-engine' | 'hybrid-engine' | 'vlm-http-client' | 'hybrid-http-client';
type MineruParseMethod = 'auto' | 'txt' | 'ocr';
type MineruMode = 'local' | 'cloud';
/**
 * The live Cordis config the Loader passes to `apply` (dsh 0.1.7-rc.1).
 *
 * Every field is a stable volatile reference read through `.get()`; a
 * committed settings edit updates it in place without remounting the plugin.
 */
interface EntryConfig {
  /** Live transport mode: self-hosted server or the mineru.net cloud API. */
  mode: Volatile<string> | string;
  /** Live MinerU API base URL (local mode). */
  baseURL: Volatile<string> | string;
  /** Live env-var name the local API key is resolved from. */
  apiKeyEnv: Volatile<string> | string;
  /** Live mineru.net cloud API base URL (cloud mode). */
  cloudBaseURL: Volatile<string> | string;
  /** Live env-var name the cloud API token is resolved from. */
  cloudApiKeyEnv: Volatile<string> | string;
  /** Live cloud model version (pipeline | vlm). */
  cloudModelVersion: Volatile<string> | string;
  /** Live default parsing backend (local mode). */
  defaultBackend: Volatile<string> | string;
  /** Live default parse method. */
  defaultParseMethod: Volatile<string> | string;
  /** Live pipeline-backend language code. */
  defaultLang: Volatile<string> | string;
  /** Live async-status poll interval. */
  pollIntervalMs: Volatile<number> | number;
  /** Live `mineru_parse_document` poll timeout. */
  pollTimeoutMs: Volatile<number> | number;
  /** Live per-request HTTP timeout. */
  requestTimeoutMs: Volatile<number> | number;
  /** Live inline-markdown truncation limit. */
  maxMdOutputChars: Volatile<number> | number;
}
/**
 * Schemastery schema for the plugin's profile-owned Config.
 *
 * Every field is `.volatile()` (dsh 0.1.7-rc.1): the settings service
 * enumerates them for the configuration form, and a committed edit updates
 * the running reference in place. Defaults are the composition-layer seed.
 */
declare const Config: z<EntryConfig>;
declare function apply(ctx: Context, config?: EntryConfig): void;
//#endregion
export { Config, EntryConfig, MineruBackend, MineruMode, MineruParseMethod, apply, inject, name };