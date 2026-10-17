import type { Tool, ToolExecutionResult } from "@kestrel/agent";
import type { Usage } from "@kestrel/protocol";
import { SUBAGENT_DEFAULTS, resolveRole, roleTable, type SubagentsConfig } from "./roles.js";
import { seconds, truncate, type ChildResult, type ChildSpec, type DelegationRunner } from "./run.js";

export const DELEGATE_TOOL = "delegate";
export const FAN_OUT_TOOL = "delegate_many";

/** Tool that hands one scoped task to a subagent. */
export function createDelegateTool(runner: DelegationRunner, config: SubagentsConfig): Tool {
  return {
    schema: {
      name: DELEGATE_TOOL,
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

      const parent = runner.session(toolContext.session.id);
      if (!parent) return missingSession();

      const result = await runner.run(
        parent,
        {
          task,
          role: typeof args.role === "string" ? args.role : undefined,
          title: typeof args.title === "string" ? args.title : undefined,
        },
        {
          signal: toolContext.signal,
          progress: (message) => toolContext.progress(message),
          metadata: toolContext.session.metadata,
        },
      );

      return renderSingle(result, config.maxResultChars ?? SUBAGENT_DEFAULTS.maxResultChars);
    },
  };
}

/**
 * Tool that hands several independent tasks to subagents at once. Concurrency
 * is bounded by the same per-parent budget as `delegate`, so a batch of eight
 * with a limit of three starts three and queues the rest instead of spawning
 * eight model loops.
 */
export function createFanOutTool(runner: DelegationRunner, config: SubagentsConfig): Tool {
  const maxFanOut = config.maxFanOut ?? SUBAGENT_DEFAULTS.maxFanOut;
  const budget = config.maxBatchResultChars ?? SUBAGENT_DEFAULTS.maxBatchResultChars;

  return {
    schema: {
      name: FAN_OUT_TOOL,
      description:
        `Delegate several independent tasks at once (at most ${maxFanOut}). Up to ${runner.maxConcurrent} subagents run in parallel and the rest queue; each returns its own report. Use it when tasks do not depend on each other — parallel searches over different areas, or several reviewers on the same change.`,
      category: "agents",
      permission: "auto",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            minItems: 1,
            maxItems: maxFanOut,
            description: "Independent tasks. Order is preserved in the result.",
            items: {
              type: "object",
              properties: {
                task: { type: "string", description: "Self-contained instructions for this subagent." },
                role: {
                  type: "string",
                  description: `One of: ${Object.keys(roleTable(config)).join(", ")}. Defaults to general.`,
                },
                title: { type: "string", description: "Short session title." },
              },
              required: ["task"],
            },
          },
        },
        required: ["tasks"],
      },
    },
    async execute(args, toolContext): Promise<ToolExecutionResult> {
      const raw = Array.isArray(args.tasks) ? args.tasks : [];
      if (raw.length === 0) {
        return { content: "Error: `tasks` must contain at least one task.", isError: true };
      }
      if (raw.length > maxFanOut) {
        return {
          content: `Error: ${raw.length} tasks requested; the limit is ${maxFanOut}. Split the work into smaller batches or use \`${DELEGATE_TOOL}\` for the rest.`,
          isError: true,
        };
      }

      const specs: ChildSpec[] = [];
      for (const [index, item] of raw.entries()) {
        const spec = typeof item === "string" ? { task: item } : asSpec(item);
        if (!spec || !spec.task) {
          return { content: `Error: task ${index + 1} is missing a non-empty \`task\`.`, isError: true };
        }
        specs.push(spec);
      }

      const parent = runner.session(toolContext.session.id);
      if (!parent) return missingSession();

      const invalid = specs.find((spec) => !resolveRole(config, spec.role ?? "general"));
      if (invalid) {
        const names = Object.keys(roleTable(config)).sort().join(", ");
        return {
          content: `Error: unknown role "${invalid.role}". Available roles: ${names}.`,
          isError: true,
        };
      }

      toolContext.progress(
        `delegating ${specs.length} tasks (${Math.min(specs.length, runner.maxConcurrent)} at a time)`,
      );

      const results = await Promise.all(
        specs.map((spec) =>
          runner.run(parent, spec, {
            signal: toolContext.signal,
            progress: (message) => toolContext.progress(message),
            metadata: toolContext.session.metadata,
          }),
        ),
      );

      const perTask = Math.max(
        SUBAGENT_DEFAULTS.minBatchResultChars,
        Math.floor(budget / Math.max(1, results.length)),
      );
      return renderBatch(results, perTask);
    },
  };
}

function asSpec(item: unknown): ChildSpec | undefined {
  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  const task = typeof record.task === "string" ? record.task.trim() : "";
  if (!task) return undefined;
  return {
    task,
    role: typeof record.role === "string" ? record.role : undefined,
    title: typeof record.title === "string" ? record.title : undefined,
  };
}

function missingSession(): ToolExecutionResult {
  return { content: "Error: the calling session no longer exists.", isError: true };
}

function renderSingle(result: ChildResult, maxResultChars: number): ToolExecutionResult {
  const data = {
    sessionId: result.sessionId,
    role: result.role,
    status: result.status,
    durationMs: result.durationMs,
    queueMs: result.queueMs,
    usage: result.usage,
    truncated: false,
  };

  if (result.status === "rejected") {
    return { content: `Error: ${result.error}.`, isError: true, data };
  }
  if (result.status === "failed") {
    return {
      content: `Error: subagent "${result.role}" failed after ${seconds(result.durationMs)}: ${result.error}`,
      isError: true,
      data,
    };
  }
  if (result.status === "timeout") {
    const partial = result.report ? `\n\nPartial report:\n\n${result.report}` : "";
    return {
      content: `Error: subagent "${result.role}" ${result.error}.${partial}`,
      isError: true,
      data,
    };
  }

  const body = truncate(result.report, maxResultChars);
  const notes: string[] = [];
  if (result.status === "cancelled") notes.push("The run was cancelled.");
  if (result.status === "max_steps") notes.push("The subagent hit its step limit; the report may be partial.");
  if (!result.report) notes.push("The subagent produced no final answer.");
  if (result.queueMs >= 1_000) notes.push(`Waited ${seconds(result.queueMs)} for a concurrency slot.`);

  const heading = `Subagent \`${result.role}\` ${result.status === "completed" ? "finished" : result.status} in ${seconds(result.durationMs)} (session ${result.sessionId}).`;
  const content = [heading, notes.join(" "), "", body || "(empty)"]
    .filter((line, index) => index === 0 || index >= 2 || line !== "")
    .join("\n");

  return {
    content,
    isError: result.status === "cancelled",
    data: { ...data, truncated: body.length < result.report.length },
  };
}

function renderBatch(results: ChildResult[], perTask: number): ToolExecutionResult {
  const counts = new Map<ChildResult["status"], number>();
  for (const result of results) counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
  const totalMs = results.reduce((sum, result) => sum + result.durationMs, 0);
  const slowestMs = results.reduce((max, result) => Math.max(max, result.durationMs), 0);
  const usage = aggregateUsage(results);

  const summary = [...counts.entries()].map(([status, count]) => `${count} ${label(status)}`).join(", ");
  const lines = [
    `Delegated ${results.length} tasks in ${seconds(slowestMs)} wall clock (${summary}).`,
  ];
  if (usage) {
    lines.push(`${usage.inputTokens} input / ${usage.outputTokens} output tokens across all tasks.`);
  }
  lines.push("");

  results.forEach((result, index) => {
    const heading = [
      `### ${index + 1}. ${result.role}`,
      label(result.status),
      seconds(result.durationMs),
      result.sessionId ? `session ${result.sessionId}` : "no session",
      result.queueMs >= 1_000 ? `queued ${seconds(result.queueMs)}` : undefined,
    ].filter(Boolean);
    lines.push(heading.join(" · "));
    if (result.error) lines.push(`Error: ${result.error}`);
    lines.push(truncate(result.report, perTask) || "(no report)");
    lines.push("");
  });

  const failed = results.filter((result) => result.status !== "completed" && result.status !== "max_steps");
  return {
    content: lines.join("\n").trimEnd(),
    // Partial information is still useful, so only a wholly failed batch is an error.
    isError: failed.length === results.length,
    data: {
      total: results.length,
      wallClockMs: slowestMs,
      durationMs: totalMs,
        counts: Object.fromEntries(counts),
      usage,
      results: results.map((result, index) => ({
        index,
        role: result.role,
        status: result.status,
        sessionId: result.sessionId,
        durationMs: result.durationMs,
        queueMs: result.queueMs,
        usage: result.usage,
        error: result.error,
      })),
    },
  };
}

function aggregateUsage(results: ChildResult[]): Usage | undefined {
  const used = results.filter((result) => result.usage);
  if (used.length === 0) return undefined;
  return used.reduce<Usage>(
    (total, result) => ({
      inputTokens: total.inputTokens + (result.usage?.inputTokens ?? 0),
      outputTokens: total.outputTokens + (result.usage?.outputTokens ?? 0),
      totalTokens: total.totalTokens + (result.usage?.totalTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
}

function label(status: ChildResult["status"]): string {
  switch (status) {
    case "max_steps":
      return "hit step limit";
    case "cancelled":
      return "cancelled";
    case "timeout":
      return "timed out";
    case "failed":
      return "failed";
    case "rejected":
      return "rejected";
    default:
      return status;
  }
}
