import { randomUUID } from "node:crypto";
import type { Logger } from "@kestrel/kernel";
import type { CreateSessionRequest, SessionDetail, SessionEvent, SessionSummary } from "@kestrel/protocol";
import { AgentSession } from "./session.js";
import { defaultSystemPrompt, subagentSystemPrompt } from "./prompt.js";
import type { PromptPipeline } from "./prompts.js";
import type { SessionStore } from "./store.js";
import type { ModelRegistry, ToolRegistry } from "./registry.js";
import type { ApprovalHandler, CompactionOptions, PermissionResolver, RunResult } from "./types.js";

export class SessionNotFoundError extends Error {
  readonly code = "session_not_found";
  constructor(id: string) {
    super(`Session "${id}" does not exist.`);
    this.name = "SessionNotFoundError";
  }
}

export interface SubagentOptions {
  /** Session title; defaults to the role and the first words of the task. */
  title?: string;
  /** Standing brief for this role, prepended to the framing. */
  instructions?: string;
  role?: string;
  model?: string;
  maxSteps?: number;
  /** Restrict the tools this subagent can see and call. */
  allowTools?: readonly string[];
  /** Defaults to the parent workspace. */
  workspace?: string;
  /** Depth ceiling used only to phrase the prompt. */
  maxDepth?: number;
  canDelegate?: boolean;
}

export interface SessionManagerOptions {
  models: ModelRegistry;
  tools: ToolRegistry;
  logger: Logger;
  defaultWorkspace: string;
  store?: SessionStore;
  systemPrompt?: (workspace: string) => string;
  /** Layers applied to every new session's base prompt. */
  prompts?: PromptPipeline;
  defaultModel?: string;
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  compaction?: CompactionOptions;
  approve?: ApprovalHandler;
  resolvePermission?: PermissionResolver;
}

/**
 * Owns the session set, persistence and event fan-out. It is transport
 * agnostic: the HTTP server, CLI and tests all drive the same manager.
 */
export class SessionManager {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private initialized = false;

  constructor(private readonly options: SessionManagerOptions) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.options.store) return;
    const summaries = await this.options.store.list();
    for (const summary of summaries) {
      const detail = await this.options.store.load(summary.id, summary.tenantId);
      if (!detail) continue;
      this.instantiate(detail);
    }
    this.options.logger.info("sessions restored", { count: this.sessions.size });
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: SessionEvent): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (error) {
        this.options.logger.warn("session manager listener failed", { error: errorText(error) });
      }
    }
  }

  create(request: CreateSessionRequest = {}, tenantId?: string): AgentSession {
    const id = randomUUID();
    const workspace = request.workspace ?? this.options.defaultWorkspace;
    const model = request.model ?? this.defaultModel();
    const basePrompt = request.systemPrompt ?? this.basePrompt(workspace);
    const session = new AgentSession(
      this.sessionOptions({
        id,
        title: request.title?.trim() || "New session",
        workspace,
        model,
        tenantId,
        systemPrompt: this.renderPrompt(basePrompt, workspace, id),
      }),
    );
    this.sessions.set(id, session);
    this.options.logger.info("session created", { sessionId: id, model, workspace, tenantId: tenantId ?? "default" });
    session.touch();
    return session;
  }

  /**
   * Creates a child session for delegation. The child shares the workspace and
   * the tool registry with its parent but gets a fresh transcript and its own
   * step budget, which is what keeps a delegated run from polluting - or being
   * polluted by - the parent's context.
   */
  createSubagent(parent: AgentSession, options: SubagentOptions = {}): AgentSession {
    const id = randomUUID();
    const workspace = options.workspace ?? parent.workspace;
    const depth = parent.depth + 1;
    const model = options.model ?? parent.model;
    const framing = subagentSystemPrompt({
      workspace,
      role: options.role,
      instructions: options.instructions,
      depth,
      maxDepth: options.maxDepth,
      canDelegate: options.canDelegate ?? false,
    });
    const basePrompt = `${framing}\n\n${this.basePrompt(workspace)}`;
    const title =
      options.title?.trim() ||
      [options.role && options.role !== "general" ? options.role : "subagent", `of ${parent.title}`].join(" ");

    const session = new AgentSession(
      this.sessionOptions({
        id,
        title: title.slice(0, 200),
        workspace,
        model,
        tenantId: parent.tenantId,
        systemPrompt: this.renderPrompt(basePrompt, workspace, id, depth, options.role),
        parentId: parent.id,
        depth,
        role: options.role,
        maxSteps: options.maxSteps,
        allowTools: options.allowTools,
      }),
    );
    this.sessions.set(id, session);
    this.options.logger.info("subagent created", { sessionId: id, parentId: parent.id, depth, role: options.role });
    session.touch();
    return session;
  }

  /** Sessions spawned by `parentId`, oldest first. */
  childrenOf(parentId: string): AgentSession[] {
    return [...this.sessions.values()]
      .filter((session) => session.parentId === parentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): AgentSession {
    const session = this.sessions.get(id);
    if (!session) throw new SessionNotFoundError(id);
    return session;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  /** Summaries, optionally scoped to one tenant. */
  list(tenantId?: string): SessionSummary[] {
    return [...this.sessions.values()]
      .filter((session) => !tenantId || (session.tenantId ?? "default") === tenantId)
      .map((session) => session.summary())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  send(id: string, content: string): { runId: string; done: Promise<RunResult> } {
    return this.get(id).start(content);
  }

  cancel(id: string): boolean {
    return this.get(id).cancel();
  }

  async delete(id: string): Promise<void> {
    const session = this.get(id);
    session.cancel();
    this.sessions.delete(id);
    await this.options.store?.delete(id, session.tenantId);
    this.publish({ type: "session.deleted", sessionId: id });
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) session.cancel();
    this.sessions.clear();
    this.listeners.clear();
    await this.options.store?.flush?.();
  }

  private instantiate(detail: SessionDetail): AgentSession {
    const session = new AgentSession({
      ...this.sessionOptions({
        id: detail.id,
        title: detail.title,
        workspace: detail.workspace,
        model: detail.model,
        tenantId: detail.tenantId,
        systemPrompt: detail.systemPrompt ?? "",
        parentId: detail.parentId,
        depth: detail.depth,
        role: detail.role,
      }),
      messages: detail.messages,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
    });
    this.sessions.set(detail.id, session);
    return session;
  }

  private sessionOptions(input: {
    id: string;
    title: string;
    workspace: string;
    model: string;
    systemPrompt: string;
    tenantId?: string;
    parentId?: string;
    depth?: number;
    role?: string;
    maxSteps?: number;
    allowTools?: readonly string[];
  }): ConstructorParameters<typeof AgentSession>[0] {
    const { id, title, workspace, model, systemPrompt } = input;
    return {
      id,
      title,
      model,
      workspace,
      tenantId: input.tenantId,
      systemPrompt,
      parentId: input.parentId,
      depth: input.depth,
      role: input.role,
      allowTools: input.allowTools,
      maxSteps: input.maxSteps ?? this.options.maxSteps,
      temperature: this.options.temperature,
      maxTokens: this.options.maxTokens,
      compaction: this.options.compaction,
      models: this.options.models,
      tools: this.options.tools,
      logger: this.options.logger.child({ sessionId: id }),
      approve: this.options.approve,
      resolvePermission: this.options.resolvePermission,
      emit: (event) => this.publish(event),
      onPersist: (session) => {
        void this.options.store?.save(session.detail()).catch((error: unknown) => {
          this.options.logger.warn("session save failed", { sessionId: id, error: errorText(error) });
        });
      },
    };
  }

  private defaultModel(): string {
    return this.options.models.defaultModel ?? this.options.defaultModel ?? "unconfigured";
  }

  private basePrompt(workspace: string): string {
    return (this.options.systemPrompt ?? ((path: string) => defaultSystemPrompt({ workspace: path })))(workspace);
  }

  private renderPrompt(
    base: string,
    workspace: string,
    sessionId: string,
    depth?: number,
    role?: string,
  ): string {
    return (
      this.options.prompts?.render(base, {
        workspace,
        sessionId,
        tools: this.options.tools.schemas().map((tool) => tool.name),
        depth,
        role,
      }) ?? base
    );
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
