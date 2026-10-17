import {
  ModelRegistry,
  PromptPipeline,
  SessionManager,
  ToolRegistry,
  type Tool,
  type ToolContext,
} from "@kestrel/agent";
import { createContext, silencedLogger, type Context } from "@kestrel/kernel";
import { ScriptedModel, echoTool, type ScriptedTurn } from "../../../packages/testkit/src/index.js";
import plugin, { type SubagentsConfig } from "../src/index.js";

export const logger = silencedLogger();

const cleanups: Array<() => Promise<void>> = [];

/** Registers a cleanup that runs after the current test. */
export function onCleanup(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup);
}

export async function cleanupAll(): Promise<void> {
  while (cleanups.length) await cleanups.pop()?.();
}

export interface Harness {
  context: Context;
  sessions: SessionManager;
  tools: ToolRegistry;
  models: ModelRegistry;
  prompts: PromptPipeline;
  delegate: Tool;
  fanOut: Tool;
  child: ScriptedModel;
}

export async function harness(
  options: { config?: SubagentsConfig; child?: ScriptedTurn[] | "hang" } = {},
): Promise<Harness> {
  const models = new ModelRegistry();
  const tools = new ToolRegistry();
  const prompts = new PromptPipeline();
  tools.register(echoTool());

  const sessions = new SessionManager({
    models,
    tools,
    prompts,
    logger,
    defaultWorkspace: process.cwd(),
    systemPrompt: () => "base prompt",
  });

  const context = createContext({ name: "test", logger });
  context.provide("models", models);
  context.provide("tools", tools);
  context.provide("prompts", prompts);
  context.provide("sessions", sessions);
  onCleanup(() => context.dispose());

  const handle = context.plugin(plugin, {
    timeoutMs: 5_000,
    roles: { helper: { description: "Helps with scoped work.", model: "child" } },
    ...options.config,
  });
  await handle.ready();
  onCleanup(() => handle.dispose());

  const child =
    options.child === "hang"
      ? new HangModel([{ content: "" }], { id: "child" })
      : new ScriptedModel(options.child ?? [{ content: "child report" }], { id: "child" });
  models.register(child);

  return {
    context,
    sessions,
    tools,
    models,
    prompts,
    delegate: tools.get("delegate") as Tool,
    fanOut: tools.get("delegate_many") as Tool,
    child,
  };
}

export interface Caller {
  id: string;
  workspace: string;
  depth?: number;
  parentId?: string;
}

export function toolContext(caller: Caller, signal = new AbortController().signal): ToolContext {
  return {
    session: {
      id: caller.id,
      workspace: caller.workspace,
      depth: caller.depth,
      parentId: caller.parentId,
      messages: [],
      metadata: new Map(),
    },
    callId: "call-1",
    signal,
    logger,
    progress: () => {},
  };
}

export async function runTool(
  tool: Tool,
  caller: Caller,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  return tool.execute(args, toolContext(caller, signal));
}

/** A model that never answers, to prove a delegation can be cut off. */
export class HangModel extends ScriptedModel {
  async generate(): Promise<never> {
    return new Promise(() => {});
  }
}

/**
 * A model that blocks inside `generate` until the test releases it, so a test
 * can observe how many subagents are actually running at the same time.
 */
export class GatedModel extends ScriptedModel {
  peak = 0;
  current = 0;
  private readonly waiting: Array<() => void> = [];

  override async generate(request: Parameters<ScriptedModel["generate"]>[0], onDelta?: Parameters<ScriptedModel["generate"]>[1]) {
    this.current += 1;
    this.peak = Math.max(this.peak, this.current);
    this.onGenerate?.();
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.current -= 1;
    return super.generate(request, onDelta);
  }

  onGenerate: (() => void) | undefined;

  /**
   * Releases the calls blocked *right now*. Calls that arrive afterwards stay
   * blocked, which is what lets a test observe the next wave of a batch.
   */
  async releaseAll(): Promise<void> {
    for (const resolve of this.waiting.splice(0)) resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  async waitForRunning(count: number, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.current < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (this.current < count) throw new Error(`only ${this.current} runs started, wanted ${count}`);
  }
}
