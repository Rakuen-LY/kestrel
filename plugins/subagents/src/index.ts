import type { AgentSession, PromptLayer, Tool, ToolExecutionResult } from "@kestrel/agent";
import type { Usage } from "@kestrel/protocol";
import type { Context, PluginDefinition } from "@kestrel/kernel";
import {
  SUBAGENT_DEFAULTS,
  resolveRole,
  roleTable,
  type ResolvedRole,
  type SubagentsConfig,
} from "./roles.js";

export type { ResolvedRole, SubagentRole, SubagentsConfig } from "./roles.js";
export { DEFAULT_ROLES, SUBAGENT_DEFAULTS, resolveRole, roleTable } from "./roles.js";

export const TOOL_NAME = "delegate";
const LAYER_ORDER = 70;

/** Read-only view other plugins (dashboards, policy checks) can consume. */
export interface SubagentService {
  roles(): ResolvedRole[];
  /** Sessions currently delegated by this plugin. */
  running(): string[];
}

type Outcome =
  | { kind: "finished"; status: "completed" | "cancelled" | "max_steps"; usage?: Usage }
  | { kind: "failed"; error: string }
  | { kind: "timeout" };

export function createDelegationLayer(config: SubagentsConfig = {}): PromptLayer {
  const maxDepth = config.maxDepth ?? SUBAGENT_DEFAULTS.maxDepth;
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
        `\`${TOOL_NAME}\` hands one scoped task to a subagent with a fresh context and its own step budget. The subagent cannot ask you questions; it returns a single final report.`,
        "Delegate when a subtask would flood this conversation with search results or file contents, or when an independent second pass (review, audit) is worth the tokens. Do not delegate work you can finish in a few tool calls.",
        "",
        "Roles:",
        ...lines,
      ].join("\n");
    },
  };
}

/**
 * Picks the tool names a subagent may use. An explicit role allowlist wins;
 * otherwise every tool that cannot prompt a human is available, which keeps a
 * delegated run from blocking on an approval nobody is watching for.
 */
export function toolAllowlist(
  role: ResolvedRole,
  tools: { list(): Tool[] },
  options: { canDelegate: boolean; exposeApprovalTools?: boolean },
): string[] {
  const available = tools.list();
  const allowed = role.allowTools
    ? role.allowTools.filter((name) => available.some((tool) => tool.schema.name === name))
    : available
        .filter((tool) => options.exposeApprovalTools || (tool.schema.permission ?? "auto") !== "ask")
        .map((tool) => tool.schema.name);

  const withoutDelegate = allowed.filter((name) => name !== TOOL_NAME);
  const canUseDelegate =
    options.canDelegate && available.some((tool) => tool.schema.name === TOOL_NAME);
  return canUseDelegate ? [...withoutDelegate, TOOL_NAME] : withoutDelegate;
}

const plugin: PluginDefinition<SubagentsConfig> = {
  name: "@kestrel/plugin-subagents",
  version: "0.1.0",
  description: "Delegation: runs scoped subagent sessions with isolated context and bounded depth.",
  inject: ["sessions", "tools"],
  apply(context: Context, config: SubagentsConfig = {}) {
    const maxDepth = config.maxDepth ?? SUBAGENT_DEFAULTS.maxDepth;
    const maxConcurrent = config.maxConcurrent ?? SUBAGENT_DEFAULTS.maxConcurrent;
    const maxSteps = config.maxSteps ?? SUBAGENT_DEFAULTS.maxSteps;
    const timeoutMs = config.timeoutMs ?? SUBAGENT_DEFAULTS.timeoutMs;
    const maxResultChars = config.maxResultChars ?? SUBAGENT_DEFAULTS.maxResultChars;
    const running = new Set<string>();

    const tool: Tool = {
      schema: {
        name: TOOL_NAME,
        description:
          "Delegate one scoped task to a subagent. The subagent works in a fresh session with its own context window and returns a single final report. Use it for broad searches, multi-file audits, or an independent review pass.",
        category: "agents",
        permission: "auto",
        parameters: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description:
                "Self-contained instructions. The subagent cannot see this conversation, so state the goal, the relevant paths and what a good answer contains.",
            },
            role: {
              type: "string",
              description: `One of: ${Object.keys(roleTable(config)).join(", ")}. Defaults to general.`,
            },
            title: { type: "string", description: "Short session title for the subagent." },
          },
          required: ["task"],
        },
      },
      async execute(args, toolContext): Promise<ToolExecutionResult> {
        const task = typeof args.task === "string" ? args.task.trim() : "";
        if (!task) {
          return { content: "Error: `task` is required and cannot be empty.", isError: true };
        }

        const sessions = context.get("sessions");
        const tools = context.get("tools");

        let parent: AgentSession;
        try {
          parent = sessions.get(toolContext.session.id);
        } catch {
          return { content: "Error: the calling session no longer exists.", isError: true };
        }

        if (parent.depth >= maxDepth) {
          return {
            content: `Error: delegation depth limit reached (${parent.depth}/${maxDepth}). Do this work yourself.`,
            isError: true,
          };
        }

        const requested = typeof args.role === "string" && args.role.trim() ? args.role.trim() : "general";
        const role = resolveRole(config, requested);
        if (!role) {
          const names = Object.keys(roleTable(config)).sort();
          return {
            content: `Error: unknown role "${requested}". Available roles: ${names.join(", ")}.`,
            isError: true,
          };
        }

        const active = sessions.childrenOf(parent.id).filter((child) => child.isRunning);
        if (active.length >= maxConcurrent) {
          return {
            content: `Error: this session already has ${active.length} subagents running (limit ${maxConcurrent}). Wait for one to finish or do the work yourself.`,
            isError: true,
          };
        }

        const canDelegate = parent.depth + 1 < maxDepth;
        const child = sessions.createSubagent(parent, {
          title: typeof args.title === "string" ? args.title : undefined,
          role: role.name,
          instructions: role.instructions,
          model: role.model,
          maxSteps: role.maxSteps ?? maxSteps,
          allowTools: toolAllowlist(role, tools, {
            canDelegate,
            exposeApprovalTools: config.exposeApprovalTools,
          }),
          maxDepth,
          canDelegate,
        });

        running.add(child.id);
        recordChild(toolContext.session.metadata, child.id);
        toolContext.progress(`${role.name} subagent started (${child.id})`);

        const startedAt = Date.now();
        const { done } = child.start(task);
        void done.finally(() => running.delete(child.id)).catch(() => {});

        const outcome = await supervise(done, child, toolContext.signal, timeoutMs);
        const durationMs = Date.now() - startedAt;
        const text = finalAnswer(child);

        if (outcome.kind === "failed") {
          return {
            content: `Error: subagent "${role.name}" failed after ${seconds(durationMs)}: ${outcome.error}`,
            isError: true,
            data: { sessionId: child.id, role: role.name, status: "error", durationMs },
          };
        }

        if (outcome.kind === "timeout") {
          return {
            content: `Error: subagent "${role.name}" exceeded the ${duration(timeoutMs)} limit and was cancelled.${text ? `\n\nPartial report:\n\n${text}` : ""}`,
            isError: true,
            data: { sessionId: child.id, role: role.name, status: "timeout", durationMs },
          };
        }

        const body = truncate(text, maxResultChars);
        const notes: string[] = [];
        if (outcome.status === "cancelled") notes.push("The run was cancelled.");
        if (outcome.status === "max_steps") notes.push("The subagent hit its step limit; the report may be partial.");
        if (!text) notes.push("The subagent produced no final answer.");

        const heading = `Subagent \`${role.name}\` ${outcome.status === "completed" ? "finished" : outcome.status} in ${seconds(durationMs)} (session ${child.id}).`;
        const summary = [heading, notes.join(" "), "", body || "(empty)"]
          .filter((line, index) => index === 0 || index >= 2 || line !== "")
          .join("\n");

        return {
          content: summary,
          isError: outcome.status === "cancelled",
          data: {
            sessionId: child.id,
            role: role.name,
            status: outcome.status,
            durationMs,
            usage: outcome.usage,
            truncated: body.length < text.length,
          },
        };
      },
    };

    context.effect(() => context.get("tools").register(tool));
    context.effect(() => context.get("prompts").add(createDelegationLayer(config)));

    // A plugin that is disposed or reloaded must not leave sessions running.
    context.effect(() => () => {
      let sessions;
      try {
        sessions = context.get("sessions");
      } catch {
        return; // The session service is already gone; its sessions are stopped.
      }
      for (const id of running) {
        try {
          sessions.get(id).cancel();
        } catch {
          // Session was already removed.
        }
      }
      running.clear();
    });

    context.provide("subagents", {
      roles: () => Object.keys(roleTable(config)).map((name) => resolveRole(config, name)!),
      running: () => [...running],
    } satisfies SubagentService);

    context.logger.info("delegation ready", { maxDepth, maxConcurrent, maxSteps, timeoutMs });
  },
};

/** Waits for a child run, cancelling it on parent abort or timeout. */
async function supervise(
  done: Promise<unknown>,
  child: AgentSession,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Outcome> {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanup: (() => void) | undefined;

  try {
    return await new Promise<Outcome>((resolve) => {
      const finish = (outcome: Outcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      const onAbort = () => {
        child.cancel();
        finish({ kind: "finished", status: "cancelled" });
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });

      done.then(
        (result) => {
          const { status, usage } = result as { status?: unknown; usage?: Usage };
          finish({
            kind: "finished",
            status: status === "completed" || status === "max_steps" ? status : "cancelled",
            usage,
          });
        },
        (error: unknown) => finish({ kind: "failed", error: errorMessage(error) }),
      );
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          child.cancel();
          finish({ kind: "timeout" });
        }, timeoutMs);
      }
      cleanup = () => signal.removeEventListener("abort", onAbort);
    });
  } finally {
    if (timer) clearTimeout(timer);
    cleanup?.();
  }
}

function finalAnswer(session: AgentSession): string {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message.role === "assistant" && message.content.trim()) return message.content.trim();
  }
  return "";
}

function recordChild(metadata: Map<string, unknown>, id: string): void {
  const existing = metadata.get("subagents.children");
  const ids = existing instanceof Set ? (existing as Set<string>) : new Set<string>();
  ids.add(id);
  metadata.set("subagents.children", ids);
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[Truncated at ${limit} characters. Open the subagent session for the full transcript.]`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default plugin;

declare module "@kestrel/kernel" {
  interface ServiceMap {
    subagents: SubagentService;
  }
}
