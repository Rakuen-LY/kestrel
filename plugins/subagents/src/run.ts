import type { AgentSession, SessionManager, Tool } from "@kestrel/agent";
import type { Usage } from "@kestrel/protocol";
import { DelegationGate } from "./gate.js";
import { resolveRole, roleTable, type ResolvedRole, type SubagentsConfig } from "./roles.js";

export type ChildStatus = "completed" | "max_steps" | "cancelled" | "timeout" | "failed" | "rejected";

export interface ChildSpec {
  task: string;
  role?: string;
  title?: string;
}

/** What happened to one delegated run, independent of how it is rendered. */
export interface ChildResult {
  role: string;
  status: ChildStatus;
  /** The subagent's final assistant message, empty when it produced none. */
  report: string;
  /** Set for transport-level failures; never for a model's own answer. */
  error?: string;
  sessionId?: string;
  usage?: Usage;
  /** Time spent waiting for a concurrency slot. */
  queueMs: number;
  /** Time the subagent actually ran. */
  durationMs: number;
}

export interface RunOptions {
  signal: AbortSignal;
  progress(message: string): void;
  /** Metadata map of the calling session, used to record child ids. */
  metadata: Map<string, unknown>;
}

type Outcome =
  | { kind: "finished"; status: "completed" | "cancelled" | "max_steps"; usage?: Usage }
  | { kind: "failed"; error: string }
  | { kind: "timeout" };

/**
 * Executes delegated runs. It owns the concurrency gate, the live set of child
 * sessions and every limit the plugin enforces, so the tools stay thin and a
 * second tool cannot reimplement (or bypass) the policy.
 */
export class DelegationRunner {
  readonly gate: DelegationGate;
  readonly maxDepth: number;
  readonly maxSteps: number;
  readonly maxConcurrent: number;
  readonly timeoutMs: number;
  private readonly running = new Set<string>();

  constructor(
    private readonly config: SubagentsConfig,
    private readonly deps: { sessions: SessionManager; tools: { list(): Tool[] }; defaults: Limits },
  ) {
    this.maxDepth = config.maxDepth ?? deps.defaults.maxDepth;
    this.maxSteps = config.maxSteps ?? deps.defaults.maxSteps;
    this.maxConcurrent = config.maxConcurrent ?? deps.defaults.maxConcurrent;
    this.timeoutMs = config.timeoutMs ?? deps.defaults.timeoutMs;
    this.gate = new DelegationGate(() => this.maxConcurrent);
  }

  roles(): ResolvedRole[] {
    return Object.keys(roleTable(this.config)).map((name) => resolveRole(this.config, name)!);
  }

  runningIds(): string[] {
    return [...this.running];
  }

  /** The calling session, or `undefined` if it was deleted between turns. */
  session(id: string): AgentSession | undefined {
    try {
      return this.deps.sessions.get(id);
    } catch {
      return undefined;
    }
  }

  /** Stops every child this plugin started; used on dispose and reload. */
  cancelAll(sessions: SessionManager): void {
    for (const id of this.running) {
      try {
        sessions.get(id).cancel();
      } catch {
        // Session was already removed.
      }
    }
    this.running.clear();
  }

  async run(parent: AgentSession, spec: ChildSpec, options: RunOptions): Promise<ChildResult> {
    const requested = spec.role?.trim() || "general";
    const role = resolveRole(this.config, requested);
    if (!role) {
      return this.rejected(
        requested,
        `unknown role "${requested}". Available roles: ${Object.keys(roleTable(this.config)).sort().join(", ")}.`,
      );
    }
    if (parent.depth >= this.maxDepth) {
      return this.rejected(
        role.name,
        `delegation depth limit reached (${parent.depth}/${this.maxDepth}). Do this work yourself.`,
      );
    }

    const queuedAt = Date.now();
    const release = await this.gate.acquire(parent.id, options.signal);
    const queueMs = Date.now() - queuedAt;
    if (!release) {
      return {
        role: role.name,
        status: "cancelled",
        report: "",
        error: "The parent run was cancelled before this subagent started.",
        queueMs,
        durationMs: 0,
      };
    }

    try {
      return await this.execute(parent, role, spec, options, queueMs);
    } catch (error) {
      // A batch must not reject wholesale because one child could not be created.
      return {
        role: role.name,
        status: "failed",
        report: "",
        error: errorMessage(error),
        queueMs,
        durationMs: 0,
      };
    } finally {
      release();
    }
  }

  private async execute(
    parent: AgentSession,
    role: ResolvedRole,
    spec: ChildSpec,
    options: RunOptions,
    queueMs: number,
  ): Promise<ChildResult> {
    const canDelegate = parent.depth + 1 < this.maxDepth;
    const child = this.deps.sessions.createSubagent(parent, {
      title: spec.title,
      role: role.name,
      instructions: role.instructions,
      model: role.model,
      maxSteps: role.maxSteps ?? this.maxSteps,
      allowTools: toolAllowlist(role, this.deps.tools, {
        canDelegate,
        exposeApprovalTools: this.config.exposeApprovalTools,
      }),
      maxDepth: this.maxDepth,
      canDelegate,
    });

    this.running.add(child.id);
    recordChild(options.metadata, child.id);
    options.progress(`${role.name} subagent started (${child.id})`);

    const startedAt = Date.now();
    const { done } = child.start(spec.task);
    void done
      .finally(() => this.running.delete(child.id))
      .catch(() => undefined);

    const outcome = await supervise(done, child, options.signal, this.timeoutMs);
    const durationMs = Date.now() - startedAt;
    const report = finalAnswer(child);

    if (outcome.kind === "failed") {
      return {
        role: role.name,
        status: "failed",
        report,
        error: outcome.error,
        sessionId: child.id,
        queueMs,
        durationMs,
      };
    }
    if (outcome.kind === "timeout") {
      return {
        role: role.name,
        status: "timeout",
        report,
        error: `exceeded the ${duration(this.timeoutMs)} limit and was cancelled`,
        sessionId: child.id,
        queueMs,
        durationMs,
      };
    }
    return {
      role: role.name,
      status: outcome.status,
      report,
      sessionId: child.id,
      usage: outcome.usage,
      queueMs,
      durationMs,
    };
  }

  private rejected(role: string, error: string): ChildResult {
    return { role, status: "rejected", report: "", error, queueMs: 0, durationMs: 0 };
  }
}

export interface Limits {
  maxDepth: number;
  maxSteps: number;
  maxConcurrent: number;
  timeoutMs: number;
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

  const withoutDelegate = allowed.filter((name) => !isDelegationTool(name));
  if (!options.canDelegate) return withoutDelegate;
  const registered = DELEGATION_TOOLS.filter((name) =>
    available.some((tool) => tool.schema.name === name),
  );
  return [...withoutDelegate, ...registered];
}

const DELEGATION_TOOLS = ["delegate", "delegate_many"];

function isDelegationTool(name: string): boolean {
  return DELEGATION_TOOLS.includes(name);
}

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

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[Truncated at ${limit} characters. Open the subagent session for the full transcript.]`;
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
