import type { PromptLayer } from "@kestrel/agent";
import type { Context, PluginDefinition } from "@kestrel/kernel";
import { SUBAGENT_DEFAULTS, roleTable, type ResolvedRole, type SubagentsConfig } from "./roles.js";
import { DelegationRunner } from "./run.js";
import { DELEGATE_TOOL, FAN_OUT_TOOL, createDelegateTool, createFanOutTool } from "./tools.js";

export type { ResolvedRole, SubagentRole, SubagentsConfig } from "./roles.js";
export type { ChildResult, ChildSpec, ChildStatus } from "./run.js";
export { DEFAULT_ROLES, SUBAGENT_DEFAULTS, resolveRole, roleTable } from "./roles.js";
export { DelegationGate } from "./gate.js";
export { DelegationRunner, toolAllowlist } from "./run.js";
export { DELEGATE_TOOL, FAN_OUT_TOOL };

export const TOOL_NAME = DELEGATE_TOOL;
const LAYER_ORDER = 70;

/** Read-only view other plugins (dashboards, policy checks) can consume. */
export interface SubagentService {
  roles(): ResolvedRole[];
  /** Sessions currently delegated by this plugin. */
  running(): string[];
  /** Concurrency budget and current use, per parent session. */
  concurrency(parentId: string): { limit: number; active: number; queued: number };
}

export function createDelegationLayer(config: SubagentsConfig = {}): PromptLayer {
  const maxDepth = config.maxDepth ?? SUBAGENT_DEFAULTS.maxDepth;
  const maxFanOut = config.maxFanOut ?? SUBAGENT_DEFAULTS.maxFanOut;
  const maxConcurrent = config.maxConcurrent ?? SUBAGENT_DEFAULTS.maxConcurrent;
  const roles = roleTable(config);

  return {
    name: "subagent-delegation",
    order: LAYER_ORDER,
    transform(prompt, context) {
      if ((context.depth ?? 0) >= maxDepth) return prompt;
      const lines = Object.entries(roles).map(
        ([name, role]) => `- \`${name}\` — ${role.description}`,
      );
      return [
        prompt,
        "",
        "## Delegation",
        "",
        `\`${DELEGATE_TOOL}\` hands one scoped task to a subagent with a fresh context and its own step budget. The subagent cannot ask you questions; it returns a single final report.`,
        "Delegate when a subtask would flood this conversation with search results or file contents, or when an independent second pass (review, audit) is worth the tokens. Do not delegate work you can finish in a few tool calls.",
        "",
        `\`${FAN_OUT_TOOL}\` takes several tasks and runs them concurrently (up to ${maxConcurrent} at a time, at most ${maxFanOut} tasks per call), returning one report per task in order. Use it only for tasks that are genuinely independent — different areas of the codebase, or several reviewers on the same change. Never fan out tasks where one depends on another's output; delegate those in sequence.`,
        "",
        "Roles:",
        ...lines,
      ].join("\n");
    },
  };
}

const plugin: PluginDefinition<SubagentsConfig> = {
  name: "@kestrel/plugin-subagents",
  version: "0.1.0",
  description: "Delegation: runs scoped subagent sessions with isolated context and bounded depth.",
  inject: ["sessions", "tools"],
  apply(context: Context, config: SubagentsConfig = {}) {
    const sessions = context.get("sessions");
    const tools = context.get("tools");

    const runner = new DelegationRunner(config, {
      sessions,
      tools,
      defaults: {
        maxDepth: SUBAGENT_DEFAULTS.maxDepth,
        maxSteps: SUBAGENT_DEFAULTS.maxSteps,
        maxConcurrent: SUBAGENT_DEFAULTS.maxConcurrent,
        timeoutMs: SUBAGENT_DEFAULTS.timeoutMs,
      },
    });

    context.effect(() => tools.register(createDelegateTool(runner, config)));
    context.effect(() => tools.register(createFanOutTool(runner, config)));
    context.effect(() => context.get("prompts").add(createDelegationLayer(config)));

    // A plugin that is disposed or reloaded must not leave sessions running.
    context.effect(() => () => {
      let live;
      try {
        live = context.get("sessions");
      } catch {
        return; // The session service is already gone; its sessions are stopped.
      }
      runner.cancelAll(live);
    });

    context.provide("subagents", {
      roles: () => runner.roles(),
      running: () => runner.runningIds(),
      concurrency: (parentId) => ({
        limit: runner.maxConcurrent,
        active: runner.gate.activeCount(parentId),
        queued: runner.gate.waitingCount(parentId),
      }),
    } satisfies SubagentService);

    context.logger.info("delegation ready", {
      maxDepth: runner.maxDepth,
      maxConcurrent: runner.maxConcurrent,
      maxFanOut: config.maxFanOut ?? SUBAGENT_DEFAULTS.maxFanOut,
      maxSteps: runner.maxSteps,
      timeoutMs: runner.timeoutMs,
    });
  },
};

export default plugin;

declare module "@kestrel/kernel" {
  interface ServiceMap {
    subagents: SubagentService;
  }
}
