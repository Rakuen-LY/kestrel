import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

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

export interface AgentConfig {
  workspace?: string;
  systemPrompt?: string;
  restrictToWorkspace?: boolean;
}

export interface PluginsConfig {
  directories?: string[];
  allow?: string[];
  config?: Record<string, Record<string, unknown>>;
}

export interface StorageConfig {
  directory?: string;
}

export interface KestrelConfig {
  name?: string;
  server: ServerConfig;
  model: ModelConfig;
  agent: AgentConfig;
  plugins: PluginsConfig;
  storage: StorageConfig;
  approvals: { timeoutMs?: number };
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
  approvals: { timeoutMs: 15 * 60_000 },
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
    approvals: { ...base.approvals, ...override.approvals },
  };
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
    storage: { ...config.storage, directory: env.KESTREL_DATA_DIR ?? config.storage.directory },
  };
}

export function resolveDataDirectory(config: KestrelConfig): string {
  return resolve(process.cwd(), config.storage.directory ?? ".kestrel");
}

export function resolveWorkspace(config: KestrelConfig): string {
  return resolve(process.cwd(), config.agent.workspace ?? ".");
}
