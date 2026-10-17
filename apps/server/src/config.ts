import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { CheckpointsConfig } from "./checkpoints.js";

export interface ServerConfig {
  host: string;
  port: number;
  /** Bearer token. Empty disables authentication (recommended for localhost only). */
  token?: string;
  corsOrigins?: string[];
  bodyLimitBytes?: number;
  webRoot?: string;
}

export interface ModelConfig {
  default?: string;
  temperature?: number;
  maxTokens?: number;
  maxSteps?: number;
}

export interface CompactionConfig {
  enabled?: boolean;
  threshold?: number;
  keepRecent?: number;
  fallbackContextWindow?: number;
}

export interface AgentConfig {
  workspace?: string;
  systemPrompt?: string;
  restrictToWorkspace?: boolean;
  /** Summarize old turns once the prompt approaches the model window. */
  compaction?: CompactionConfig;
}

export interface PluginsConfig {
  directories?: string[];
  allow?: string[];
  config?: Record<string, Record<string, unknown>>;
}

export interface StorageConfig {
  directory?: string;
  /**
   * `file` writes one JSON document per session, `sqlite` keeps every
   * transcript in `<directory>/kestrel.db`. Both are single-process stores.
   * Env: KESTREL_STORAGE_DRIVER. Default: `file` until the SQLite importer ships.
   */
  driver?: "file" | "sqlite";
}

export interface AuthConfig {
  /**
   * `none` trusts the network, `token` keeps the v0.1 single-operator model and
   * `accounts` enables users, roles and tenant isolation.
   */
  mode?: "none" | "token" | "accounts";
  /** First-run administrator token in `accounts` mode. Env: KESTREL_BOOTSTRAP_TOKEN. */
  bootstrapToken?: string;
  bootstrapName?: string;
  /** Workspace root per tenant. Unlisted tenants get a directory under the data dir. */
  workspaces?: Record<string, string>;
}

export interface KestrelConfig {
  name?: string;
  server: ServerConfig;
  model: ModelConfig;
  agent: AgentConfig;
  plugins: PluginsConfig;
  storage: StorageConfig;
  auth: AuthConfig;
  approvals: { timeoutMs?: number };
  checkpoints: CheckpointsConfig;
}

const DEFAULT_CONFIG: KestrelConfig = {
  name: "Kestrel",
  server: {
    host: "127.0.0.1",
    port: 7331,
    corsOrigins: ["*"],
    bodyLimitBytes: 10 * 1024 * 1024,
  },
  model: {},
  agent: {},
  plugins: { directories: ["plugins"] },
  storage: {},
  auth: {},
  approvals: { timeoutMs: 15 * 60_000 },
  checkpoints: { enabled: "auto", maxFiles: 20_000 },
};

export async function loadConfig(path?: string): Promise<KestrelConfig> {
  const file = path ?? process.env.KESTREL_CONFIG ?? "kestrel.config.json";
  let base: KestrelConfig = structuredClone(DEFAULT_CONFIG);
  if (file) {
    try {
      const raw = await readFile(isAbsolute(file) ? file : resolve(process.cwd(), file), "utf8");
      base = mergeConfig(DEFAULT_CONFIG, JSON.parse(raw) as Partial<KestrelConfig>);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!missing || path || process.env.KESTREL_CONFIG) throw error;
    }
  }
  return applyEnvironment(base);
}

function mergeConfig(base: KestrelConfig, override: Partial<KestrelConfig>): KestrelConfig {
  const driver = override.storage?.driver;
  if (driver !== undefined && driver !== "file" && driver !== "sqlite") {
    throw new Error(`storage.driver must be "file" or "sqlite", got "${String(driver)}".`);
  }
  return {
    ...base,
    ...override,
    server: { ...base.server, ...override.server },
    model: { ...base.model, ...override.model },
    agent: { ...base.agent, ...override.agent },
    plugins: {
      ...base.plugins,
      ...override.plugins,
      config: { ...base.plugins.config, ...override.plugins?.config },
    },
    storage: { ...base.storage, ...override.storage },
    auth: { ...base.auth, ...override.auth, workspaces: { ...base.auth?.workspaces, ...override.auth?.workspaces } },
    approvals: { ...base.approvals, ...override.approvals },
    checkpoints: { ...base.checkpoints, ...override.checkpoints },
  };
}

function parseSwitch(value: string | undefined): boolean | "auto" | undefined {
  if (!value) return undefined;
  if (value === "auto") return "auto";
  return ["1", "true", "on", "yes"].includes(value.toLowerCase());
}

function applyEnvironment(config: KestrelConfig): KestrelConfig {
  const env = process.env;
  const plugins = env.KESTREL_PLUGINS?.split(",").map((entry) => entry.trim()).filter(Boolean);
  return {
    ...config,
    server: {
      ...config.server,
      host: env.KESTREL_HOST ?? config.server.host,
      port: env.KESTREL_PORT ? Number(env.KESTREL_PORT) : config.server.port,
      token: env.KESTREL_TOKEN ?? config.server.token,
      corsOrigins: env.KESTREL_CORS_ORIGINS
        ? env.KESTREL_CORS_ORIGINS.split(",").map((origin) => origin.trim())
        : config.server.corsOrigins,
    },
    model: {
      ...config.model,
      default: env.KESTREL_MODEL ?? config.model.default,
    },
    agent: {
      ...config.agent,
      workspace: env.KESTREL_WORKSPACE ?? config.agent.workspace,
      systemPrompt: env.KESTREL_SYSTEM_PROMPT ?? config.agent.systemPrompt,
    },
    plugins: { ...config.plugins, directories: plugins ?? config.plugins.directories },
    storage: {
      ...config.storage,
      directory: env.KESTREL_DATA_DIR ?? config.storage.directory,
      driver:
        env.KESTREL_STORAGE_DRIVER === "sqlite" || env.KESTREL_STORAGE_DRIVER === "file"
          ? env.KESTREL_STORAGE_DRIVER
          : config.storage.driver,
    },
    checkpoints: {
      ...config.checkpoints,
      enabled: parseSwitch(env.KESTREL_CHECKPOINTS) ?? config.checkpoints.enabled,
      maxFiles: env.KESTREL_CHECKPOINTS_MAX_FILES
        ? Number(env.KESTREL_CHECKPOINTS_MAX_FILES)
        : config.checkpoints.maxFiles,
    },
    auth: {
      ...config.auth,
      mode: (env.KESTREL_AUTH_MODE as AuthConfig["mode"]) ?? config.auth.mode,
      bootstrapToken: env.KESTREL_BOOTSTRAP_TOKEN ?? config.auth.bootstrapToken,
    },
  };
}

export function resolveDataDirectory(config: KestrelConfig): string {
  return resolve(process.cwd(), config.storage.directory ?? ".kestrel");
}

export function resolveWorkspace(config: KestrelConfig): string {
  return resolve(process.cwd(), config.agent.workspace ?? ".");
}
