import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FileSessionStore,
  ModelRegistry,
  PromptPipeline,
  SessionManager,
  ToolRegistry,
  defaultSystemPrompt,
} from "@kestrel/agent";
import { createContext, createLogger, type Context, type Logger } from "@kestrel/kernel";
import { PluginHost } from "@kestrel/plugin-host";
import type { ApprovalRequest, PluginInfo } from "@kestrel/protocol";
import { loadConfig, resolveDataDirectory, resolveWorkspace, type KestrelConfig } from "./config.js";
import { EventHub } from "./events.js";

export class ApprovalBroker {
  private readonly pending = new Map<
    string,
    { resolve: (approved: boolean) => void; timer: NodeJS.Timeout; cleanup: () => void }
  >();

  constructor(
    private readonly timeoutMs: number,
    private readonly logger: Logger,
  ) {}

  wait(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolveDecision) => {
      const settle = (approved: boolean) => {
        const entry = this.pending.get(request.id);
        if (!entry) return;
        this.pending.delete(request.id);
        clearTimeout(entry.timer);
        entry.cleanup();
        resolveDecision(approved);
      };
      const timer = setTimeout(() => {
        this.logger.warn("approval timed out", { approvalId: request.id });
        settle(false);
      }, this.timeoutMs);
      timer.unref?.();
      const onAbort = () => settle(false);
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(request.id, {
        resolve: settle,
        timer,
        cleanup: () => signal.removeEventListener("abort", onAbort),
      });
    });
  }

  decide(approvalId: string, approved: boolean): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    // `entry.resolve` is the settle closure: it removes the entry, clears the
    // timer and releases the waiting run. Deleting here first would make that
    // closure a no-op and leave the run waiting until timeout.
    entry.resolve(approved);
    return true;
  }

  get size(): number {
    return this.pending.size;
  }

  close(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.cleanup();
      entry.resolve(false);
    }
    this.pending.clear();
  }
}

export interface Runtime {
  config: KestrelConfig;
  context: Context;
  logger: Logger;
  models: ModelRegistry;
  tools: ToolRegistry;
  sessions: SessionManager;
  plugins: PluginHost;
  events: EventHub;
  approvals: ApprovalBroker;
  pluginInfos: PluginInfo[];
  startedAt: number;
  shutdown(): Promise<void>;
}

export interface RuntimeOptions {
  configPath?: string;
}

/**
 * Composition root. Every capability the server exposes is assembled here out
 * of services and plugins; the HTTP layer only translates protocol.
 */
export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const config = await loadConfig(options.configPath);
  const logger = createLogger({ level: (process.env.KESTREL_LOG_LEVEL as never) ?? "info" });
  const context = createContext({ name: "kestrel", logger });
  const models = new ModelRegistry({ defaultModel: config.model.default });
  const tools = new ToolRegistry();
  const events = new EventHub();

  context.provide("models", models);
  context.provide("tools", tools);

  const prompts = new PromptPipeline({
    onError: (layer, error) => logger.warn("prompt layer failed", { layer: layer.name, error: String(error) }),
  });
  context.provide("prompts", prompts);

  const approvals = new ApprovalBroker(config.approvals.timeoutMs ?? 15 * 60_000, logger);
  const workspace = resolveWorkspace(config);
  const dataDirectory = resolveDataDirectory(config);

  const sessions = new SessionManager({
    models,
    tools,
    logger: logger.child({ component: "sessions" }),
    defaultWorkspace: workspace,
    store: new FileSessionStore(dataDirectory),
    defaultModel: config.model.default,
    prompts,
    maxSteps: config.model.maxSteps,
    temperature: config.model.temperature,
    maxTokens: config.model.maxTokens,
    approve: (request, signal) => approvals.wait(request, signal),
    systemPrompt: (sessionWorkspace) =>
      defaultSystemPrompt({
        workspace: sessionWorkspace,
        toolNames: tools.schemas().map((tool) => tool.name),
        extra: config.agent.systemPrompt,
      }),
  });
  await sessions.initialize();
  context.provide("sessions", sessions);
  sessions.subscribe((event) => events.publish(event));

  const root = repoRoot();
  const pluginConfig = { ...config.plugins.config };
  if (config.agent.restrictToWorkspace !== undefined) {
    const key = "@kestrel/plugin-tools-core";
    pluginConfig[key] = { restrictToWorkspace: config.agent.restrictToWorkspace, ...pluginConfig[key] };
  }

  const host = new PluginHost({
    context,
    logger: logger.child({ component: "plugins" }),
    directories: resolvePluginDirectories(config.plugins.directories ?? ["plugins"], root),
    config: pluginConfig,
    allow: config.plugins.allow,
  });
  context.provide("plugins", host);
  await host.discover();
  const pluginInfos: PluginInfo[] = [];
  for (const info of host.list()) {
    try {
      pluginInfos.push(await host.load(info.name));
    } catch {
      pluginInfos.push(host.get(info.name) ?? info);
    }
  }

  if (config.model.default && models.has(config.model.default)) {
    models.setDefault(config.model.default);
  }

  const runtime: Runtime = {
    config,
    context,
    logger,
    models,
    tools,
    sessions,
    plugins: host,
    events,
    approvals,
    pluginInfos,
    startedAt: Date.now(),
    async shutdown() {
      approvals.close();
      await sessions.close();
      await host.dispose();
      await context.dispose();
      events.clear();
    },
  };

  logger.info("runtime ready", {
    workspace,
    dataDirectory,
    models: models.list().map((model) => model.id),
    tools: tools.size,
    plugins: pluginInfos.filter((plugin) => plugin.state === "active").length,
  });
  return runtime;
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function resolvePluginDirectories(directories: string[], root: string): string[] {
  return directories.map((directory) => {
    if (isAbsolute(directory)) return directory;
    const fromCwd = resolve(process.cwd(), directory);
    if (existsSync(fromCwd)) return fromCwd;
    const fromRoot = resolve(root, directory);
    return existsSync(fromRoot) ? fromRoot : fromCwd;
  });
}
