import type {
  ApprovalRequest,
  ChatMessage,
  SessionDetail,
  SessionEvent,
  SessionStatus,
  SessionSummary,
  ToolCall,
  ToolResult,
  ToolSchema,
} from "@kestrel/protocol";
import { formatValidationIssues, validateArguments } from "./registry.js";
import { addUsage, assistantMessage, createMessage, emptyUsage, titleFromInput, toolMessage, truncateToolOutput } from "./messages.js";
import type {
  AgentSessionOptions,
  CompletionRequest,
  CompletionResponse,
  LanguageModel,
  RunResult,
  TokenDelta,
  ToolContext,
  ToolPermission,
  ToolSession,
} from "./types.js";

class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

interface ActiveRun {
  id: string;
  controller: AbortController;
  done: Promise<RunResult>;
}

const DEFAULT_MAX_STEPS = 40;

/**
 * One conversation with an agent. The session owns message history, the tool
 * loop and cancellation; transport, persistence and approval UX are injected.
 */
export class AgentSession {
  readonly id: string;
  readonly createdAt: string;
  readonly workspace: string;
  readonly parentId?: string;
  readonly depth: number;
  readonly role?: string;
  readonly tenantId?: string;
  private readonly options: AgentSessionOptions;
  private readonly listeners: Array<(event: SessionEvent) => void> = [];
  private readonly toolSession: ToolSession;
  private messageList: ChatMessage[];
  private _title: string;
  private _model: string;
  private _systemPrompt: string;
  private _status: SessionStatus = "idle";
  private _updatedAt: string;
  private activeRun?: ActiveRun;

  constructor(options: AgentSessionOptions) {
    this.options = options;
    this.id = options.id;
    this._title = options.title;
    this._model = options.model;
    this._systemPrompt = options.systemPrompt;
    this.workspace = options.workspace;
    this.parentId = options.parentId;
    this.depth = options.depth ?? 0;
    this.role = options.role;
    this.tenantId = options.tenantId;
    this.createdAt = options.createdAt ?? new Date().toISOString();
    this._updatedAt = options.updatedAt ?? this.createdAt;
    this.messageList = options.messages ? [...options.messages] : [];
    this.toolSession = {
      id: options.id,
      workspace: options.workspace,
      messages: this.messageList,
      depth: this.depth,
      parentId: this.parentId,
      role: this.role,
      metadata: new Map(),
    };
  }

  get title(): string {
    return this._title;
  }

  get model(): string {
    return this._model;
  }

  get systemPrompt(): string {
    return this._systemPrompt;
  }

  get status(): SessionStatus {
    return this._status;
  }

  get updatedAt(): string {
    return this._updatedAt;
  }

  get messages(): readonly ChatMessage[] {
    return this.messageList;
  }

  get isRunning(): boolean {
    return this.activeRun !== undefined;
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  summary(): SessionSummary {
    return {
      id: this.id,
      title: this._title,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
      status: this._status,
      model: this._model,
      messageCount: this.messageList.length,
      workspace: this.workspace,
      ...(this.parentId ? { parentId: this.parentId, depth: this.depth, role: this.role } : {}),
      ...(this.tenantId && this.tenantId !== "default" ? { tenantId: this.tenantId } : {}),
    };
  }

  detail(): SessionDetail {
    return {
      ...this.summary(),
      messages: this.messageList.map((message) => ({ ...message })),
      systemPrompt: this._systemPrompt,
    };
  }

  rename(title: string): void {
    const trimmed = title.trim();
    if (!trimmed) throw new Error("Session title cannot be empty.");
    this._title = trimmed.slice(0, 200);
    this.touch();
  }

  setModel(model: string): void {
    this._model = model;
    this.touch();
  }

  setSystemPrompt(prompt: string): void {
    this._systemPrompt = prompt;
    this.touch();
  }

  reset(): void {
    if (this.activeRun) throw new Error("Cannot reset a session while it is running.");
    this.messageList = [];
    this.toolSession.metadata.clear();
    this.touch();
  }

  start(input: string): { runId: string; done: Promise<RunResult> } {
    if (this.activeRun) throw new Error("This session already has an active run.");
    const content = input.trim();
    if (!content) throw new Error("Message content cannot be empty.");

    if (this.messageList.length === 0 && (this._title === "New session" || !this._title)) {
      this._title = titleFromInput(content);
    }

    const userMessage = createMessage("user", content);
    this.messageList.push(userMessage);
    this.emit({ type: "message.completed", sessionId: this.id, message: { ...userMessage } });

    const runId = crypto.randomUUID();
    const controller = new AbortController();
    this._status = "running";
    this._updatedAt = new Date().toISOString();
    this.emit({ type: "run.started", sessionId: this.id, runId });
    this.emit({ type: "session.updated", sessionId: this.id, session: this.summary() });
    this.persist();

    // Started only after `run.started` so subscribers observe the run before
    // the first model call can produce deltas.
    const done = this.execute(runId, controller);
    this.activeRun = { id: runId, controller, done };
    return { runId, done };
  }

  cancel(): boolean {
    if (!this.activeRun) return false;
    this.activeRun.controller.abort(new RunCancelledError());
    return true;
  }

  /** Persist state after an external change (rename, model switch, delete). */
  touch(): void {
    this._updatedAt = new Date().toISOString();
    this.persist();
    this.emit({ type: "session.updated", sessionId: this.id, session: this.summary() });
  }

  private async execute(runId: string, controller: AbortController): Promise<RunResult> {
    const maxSteps = this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    let usage = emptyUsage();
    let steps = 0;
    let finalStatus: RunResult["status"] = "max_steps";

    try {
      while (steps < maxSteps) {
        this.throwIfCancelled(controller.signal);
        steps += 1;
        const model = this.options.models.get(this._model);
        const draft = assistantMessage("");
        this.emit({ type: "message.started", sessionId: this.id, message: { ...draft } });

        let streamedText = "";
        let streamedReasoning = "";
        const response = await this.callModel(
          model,
          {
            model: this._model,
            messages: this.promptMessages(),
            tools: this.visibleTools(),
            temperature: this.options.temperature,
            maxTokens: this.options.maxTokens,
            signal: controller.signal,
          },
          controller.signal,
          (delta) => {
            if (delta.channel === "text") streamedText += delta.delta;
            else streamedReasoning += delta.delta;
            this.emit({
              type: "message.delta",
              sessionId: this.id,
              messageId: draft.id,
              channel: delta.channel,
              delta: delta.delta,
            });
          },
        );

        const assistant = {
          ...draft,
          content: response.content || streamedText,
          reasoning: response.reasoning || streamedReasoning || undefined,
          toolCalls: response.toolCalls.length ? response.toolCalls : undefined,
          model: this._model,
        };
        this.messageList.push(assistant);
        usage = addUsage(usage, response.usage);
        this.emit({ type: "message.completed", sessionId: this.id, message: { ...assistant } });
        this._updatedAt = new Date().toISOString();
        this.persist();

        if (response.toolCalls.length === 0) {
          finalStatus = "completed";
          break;
        }

        let terminated = false;
        for (const call of response.toolCalls) {
          this.throwIfCancelled(controller.signal);
          const { result, terminate } = await this.executeTool(call, controller.signal);
          const message = toolMessage(call, result.content);
          this.messageList.push(message);
          this._updatedAt = new Date().toISOString();
          this.persist();
          if (terminate) {
            terminated = true;
            break;
          }
        }

        if (terminated) {
          finalStatus = "completed";
          break;
        }
      }

      if (finalStatus === "max_steps") {
        this.emit({
          type: "notice",
          level: "warn",
          message: `The agent reached the ${maxSteps}-step limit and stopped.`,
        });
      }
      this._status = "idle";
      this._updatedAt = new Date().toISOString();
      this.emit({ type: "run.finished", sessionId: this.id, runId, status: finalStatus, usage });
      this.emit({ type: "session.updated", sessionId: this.id, session: this.summary() });
      this.persist();
      return { runId, status: finalStatus, usage };
    } catch (error) {
      if (isCancellation(error, controller.signal)) {
        this._status = "idle";
        this._updatedAt = new Date().toISOString();
        this.emit({ type: "run.finished", sessionId: this.id, runId, status: "cancelled", usage });
        this.emit({ type: "session.updated", sessionId: this.id, session: this.summary() });
        this.persist();
        return { runId, status: "cancelled", usage };
      }
      this._status = "error";
      this._updatedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.error("agent run failed", { sessionId: this.id, runId, error: message });
      this.emit({ type: "run.failed", sessionId: this.id, runId, error: message });
      this.emit({ type: "session.updated", sessionId: this.id, session: this.summary() });
      this.persist();
      throw error;
    } finally {
      if (this.activeRun?.id === runId) this.activeRun = undefined;
    }
  }

  private async executeTool(
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<{ result: ToolResult; terminate: boolean }> {
    const startedAt = Date.now();
    this.emit({ type: "tool.started", sessionId: this.id, call });
    const finish = (result: ToolResult, terminate = false): { result: ToolResult; terminate: boolean } => {
      const completed = { ...result, durationMs: Date.now() - startedAt };
      this.emit({ type: "tool.finished", sessionId: this.id, result: completed });
      return { result: completed, terminate };
    };

    const tool = this.isToolAllowed(call.name) ? this.options.tools.get(call.name) : undefined;
    if (!tool) {
      return finish(errorResult(call, `Unknown tool "${call.name}".`));
    }

    const issues = validateArguments(tool.schema.parameters, call.arguments);
    if (issues.length > 0) {
      return finish(errorResult(call, `Invalid arguments: ${formatValidationIssues(issues)}`));
    }

    let permission: ToolPermission | "deny" = tool.schema.permission ?? "auto";
    if (this.options.resolvePermission) {
      try {
        permission = await this.options.resolvePermission(tool, call, this.toolSession);
      } catch (error) {
        return finish(errorResult(call, `Permission check failed: ${messageOf(error)}`));
      }
    }
    if (permission === "deny") {
      return finish(errorResult(call, "Denied by policy."));
    }
    if (permission === "ask") {
      if (!this.options.approve) {
        return finish(errorResult(call, "This tool requires approval, but no approval channel is connected."));
      }
      this.throwIfCancelled(signal);
      const approval: ApprovalRequest = {
        id: crypto.randomUUID(),
        call,
        reason: `The agent wants to run “${call.name}”.`,
        createdAt: new Date().toISOString(),
      };
      this.emit({ type: "approval.requested", sessionId: this.id, approval });
      let approved = false;
      try {
        approved = await this.options.approve(approval, signal);
      } catch (error) {
        if (isCancellation(error, signal)) throw error;
        return finish(errorResult(call, `Approval failed: ${messageOf(error)}`));
      } finally {
        this.emit({ type: "approval.resolved", sessionId: this.id, approvalId: approval.id, approved });
      }
      if (!approved) return finish(errorResult(call, "The user declined this tool call."));
    }

    const context: ToolContext = {
      session: this.toolSession,
      callId: call.id,
      signal,
      logger: this.options.logger.child({ sessionId: this.id, tool: call.name }),
      progress: (message) => {
        this.emit({ type: "notice", level: "info", message: `${call.name}: ${message}` });
      },
    };

    try {
      const result = await tool.execute(call.arguments, context);
      const content = truncateToolOutput(result.content);
      return finish(
        {
          callId: call.id,
          name: call.name,
          ok: !result.isError,
          content,
          error: result.isError ? content : undefined,
          data: result.data,
        },
        result.terminate ?? false,
      );
    } catch (error) {
      if (isCancellation(error, signal)) throw error;
      return finish(errorResult(call, messageOf(error)));
    }
  }

  /**
   * A provider is expected to honour the abort signal, but cancellation must not
   * depend on it: racing the call means a hung request cannot pin the session
   * in `running` forever.
   */
  private callModel(
    model: LanguageModel,
    request: CompletionRequest,
    signal: AbortSignal,
    onDelta: (delta: TokenDelta) => void,
  ): Promise<CompletionResponse> {
    if (signal.aborted) return Promise.reject(new RunCancelledError());
    return new Promise<CompletionResponse>((resolve, reject) => {
      const onAbort = () => reject(new RunCancelledError());
      signal.addEventListener("abort", onAbort, { once: true });
      model.generate(request, onDelta).then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    });
  }

  private isToolAllowed(name: string): boolean {
    const allow = this.options.allowTools;
    return allow === undefined || allow.includes(name);
  }

  private visibleTools(): ToolSchema[] {
    const schemas = this.options.tools.schemas();
    return this.options.allowTools ? schemas.filter((schema) => this.isToolAllowed(schema.name)) : schemas;
  }

  private promptMessages(): ChatMessage[] {
    const messages: ChatMessage[] = [];
    if (this._systemPrompt.trim()) {
      messages.push(createMessage("system", this._systemPrompt, { hidden: true }));
    }
    messages.push(...this.messageList);
    return messages;
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new RunCancelledError();
  }

  private emit(event: SessionEvent): void {
    this.options.emit(event);
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (error) {
        this.options.logger.warn("session event listener failed", { error: messageOf(error) });
      }
    }
  }

  private persist(): void {
    try {
      this.options.onPersist?.(this);
    } catch (error) {
      this.options.logger.warn("session persistence failed", { sessionId: this.id, error: messageOf(error) });
    }
  }
}

function errorResult(call: ToolCall, message: string): ToolResult {
  return { callId: call.id, name: call.name, ok: false, content: `Error: ${message}`, error: message };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof RunCancelledError || (error instanceof Error && error.name === "AbortError");
}
