import type {
  ApprovalRequest,
  ChatMessage,
  ImageAttachment,
  SessionDetail,
  SessionEvent,
  SessionStatus,
  SessionSummary,
  ToolCall,
  ToolResult,
  ToolSchema,
} from "@kestrel/protocol";
import { formatValidationIssues, validateArguments } from "./registry.js";
import {
  addUsage,
  assistantMessage,
  createMessage,
  emptyUsage,
  estimateTokens,
  titleFromInput,
  toolMessage,
  truncateToolOutput,
} from "./messages.js";
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
  Usage,
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
const DEFAULT_FALLBACK_CONTEXT_WINDOW = 128_000;
const COMPACTION_OUTPUT_TOKENS = 1_500;
const COMPACTION_INPUT_CHARS = 60_000;
const COMPACTION_MESSAGE_CHARS = 1_500;

const COMPACTION_PROMPT = `You compress the transcript of a coding agent so the conversation can continue in a smaller context window.

Write a dense brief that preserves:
- the user's goals, constraints and preferences;
- decisions taken, and why alternatives were rejected;
- files and symbols touched, with the concrete names and paths;
- commands run and their outcomes, including failures;
- open questions and the next concrete step.

Omit greetings, restated instructions and tool output that no longer matters. Reply with the brief only.`;

/**
 * Summarizes the oldest part of a conversation once the prompt approaches the
 * model window. The cut always lands on a user message, so a tool call and its
 * results are never separated.
 */

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
  private _usage: Usage;
  private _updatedAt: string;
  private activeRun?: ActiveRun;

  constructor(options: AgentSessionOptions) {
    this.options = options;
    this.id = options.id;
    this._title = options.title;
    this._model = options.model;
    this._systemPrompt = options.systemPrompt;
    this._status = options.status ?? "idle";
    this._usage = options.usage ?? emptyUsage();
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

  get usage(): Usage {
    return { ...this._usage };
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
      ...(this._usage.totalTokens > 0 ? { usage: { ...this._usage } } : {}),
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

  start(input: string, options: { images?: ImageAttachment[] } = {}): { runId: string; done: Promise<RunResult> } {
    if (this.activeRun) throw new Error("This session already has an active run.");
    const content = input.trim();
    const images = options.images?.length ? options.images : undefined;
    if (!content && !images) throw new Error("Message content cannot be empty.");

    if (this.messageList.length === 0 && (this._title === "New session" || !this._title)) {
      this._title = titleFromInput(content || images?.[0]?.name || "Image");
    }

    const userMessage = createMessage("user", content, images ? { images } : {});
    this.messageList.push(userMessage);
    this.emit({ type: "message.completed", sessionId: this.id, message: { ...userMessage } });

    return this.launchRun();
  }

  /**
   * Continue a run that did not survive the server process. Pending tool calls
   * are answered without re-executing them: a side effect may already have
   * happened, so the model is told to verify rather than retry blindly.
   */
  resume(): { runId: string; done: Promise<RunResult> } {
    if (this.activeRun) throw new Error("This session already has an active run.");
    if (this._status !== "interrupted" && this._status !== "error") {
      throw new Error("Only interrupted or failed sessions can be resumed.");
    }
    if (this.messageList.length === 0) throw new Error("This session has no messages to resume.");
    const repaired = this.repairPendingToolCalls();
    if (repaired > 0) {
      this.emit({
        type: "notice",
        level: "warn",
        message: `Recovered ${repaired} tool call(s) from the interrupted run; they were not executed again.`,
      });
      this._updatedAt = new Date().toISOString();
      this.persist();
    }
    return this.launchRun();
  }

  /** Marks a session whose persisted state says "running" but has no live run. */
  markInterrupted(): void {
    if (this.activeRun) return;
    this._status = "interrupted";
    this._updatedAt = new Date().toISOString();
    this.persist();
  }

  private launchRun(): { runId: string; done: Promise<RunResult> } {
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

  private repairPendingToolCalls(): number {
    const answered = new Set(this.messageList.map((message) => message.toolCallId).filter(Boolean));
    const repaired: ToolCall[] = [];
    for (const message of this.messageList) {
      for (const call of message.toolCalls ?? []) {
        if (!answered.has(call.id)) repaired.push(call);
      }
    }
    for (const call of repaired) {
      this.messageList.push(
        toolMessage(
          call,
          "Error: the previous run was interrupted before this tool's result was recorded. " +
            "It may or may not have executed; verify the workspace state before retrying.",
        ),
      );
    }
    return repaired.length;
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
        const compacted = await this.maybeCompact(model, controller.signal);
        usage = addUsage(usage, compacted);
        this._usage = addUsage(this._usage, compacted);

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
        this._usage = addUsage(this._usage, response.usage);
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

  private estimateContextTokens(): number {
    const system = this._systemPrompt.trim();
    return this.messageList.reduce((total, message) => total + messageTokens(message), estimateTokens(system));
  }

  private async maybeCompact(model: LanguageModel, signal: AbortSignal): Promise<Usage> {
    const config = this.options.compaction;
    if (config?.enabled === false) return emptyUsage();
    const window = model.info.contextWindow ?? config?.fallbackContextWindow ?? DEFAULT_FALLBACK_CONTEXT_WINDOW;
    const threshold = config?.threshold ?? 0.8;
    const budget = Math.max(64, Math.floor(window * threshold));
    const before = this.estimateContextTokens();
    if (before <= budget) return emptyUsage();

    const keepRecent = Math.max(2, config?.keepRecent ?? 8);
    let cut = Math.max(0, this.messageList.length - keepRecent);
    while (cut > 0 && this.messageList[cut]?.role !== "user") cut -= 1;
    if (cut < 2) return emptyUsage();

    const removed = this.messageList.slice(0, cut);
    // Compacting a tiny prefix does not pay for the summary call and would run
    // again on the next step. Compare against conversation tokens only: a large
    // system prompt must not make every prefix look negligible.
    const conversation = before - estimateTokens(this._systemPrompt.trim());
    const removedTokens = removed.reduce((total, message) => total + messageTokens(message), 0);
    if (removedTokens < conversation * 0.25) return emptyUsage();

    this.options.logger.info("compacting context", { sessionId: this.id, removed: removed.length, before });
    let response: CompletionResponse;
    try {
      response = await this.callModel(
        model,
        {
          model: this._model,
          messages: [
            createMessage("system", COMPACTION_PROMPT),
            createMessage("user", `Transcript:\n\n${transcriptForSummary(removed)}`),
          ],
          tools: [],
          temperature: 0.2,
          maxTokens: COMPACTION_OUTPUT_TOKENS,
          signal,
        },
        signal,
        () => {},
      );
    } catch (error) {
      if (isCancellation(error, signal)) throw error;
      this.options.logger.warn("context compaction failed", { sessionId: this.id, error: messageOf(error) });
      return emptyUsage();
    }

    const summary = response.content.trim();
    if (!summary) {
      this.options.logger.warn("context compaction returned no text", { sessionId: this.id });
      return emptyUsage();
    }

    this.messageList = [
      createMessage("assistant", `[Summary of the earlier conversation]\n\n${summary}`, {
        model: this._model,
        meta: { kind: "compaction", removedMessages: removed.length, tokensBefore: before },
      }),
      ...this.messageList.slice(cut),
    ];
    const after = this.estimateContextTokens();
    this._updatedAt = new Date().toISOString();
    this.persist();
    this.emit({
      type: "context.compacted",
      sessionId: this.id,
      removedMessages: removed.length,
      keptMessages: this.messageList.length - 1,
      tokensBefore: before,
      tokensAfter: after,
    });
    this.options.logger.info("context compacted", { sessionId: this.id, before, after });
    return response.usage;
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

/** Vision models bill roughly a thousand tokens per image; keep estimates honest. */
const TOKENS_PER_IMAGE = 1_100;

function messageTokens(message: ChatMessage): number {
  const tools = message.toolCalls ? JSON.stringify(message.toolCalls) : "";
  const images = (message.images?.length ?? 0) * TOKENS_PER_IMAGE;
  return estimateTokens(`${message.content}${message.reasoning ?? ""}${tools}`) + images + 4;
}

function transcriptForSummary(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const calls = message.toolCalls?.map((call) => {
      const args = JSON.stringify(call.arguments);
      return `${call.name}(${args.length > 400 ? `${args.slice(0, 400)}...` : args})`;
    });
    const body = message.content.length > COMPACTION_MESSAGE_CHARS
      ? `${message.content.slice(0, COMPACTION_MESSAGE_CHARS)}...`
      : message.content;
    const suffix = calls?.length ? ` [called ${calls.join(", ")}]` : "";
    const name = message.toolName ? ` ${message.toolName}` : "";
    const images = message.images?.length
      ? ` [${message.images.length} image${message.images.length === 1 ? "" : "s"} attached: ${message.images
          .map((image) => image.name ?? image.mimeType)
          .join(", ")}]`
      : "";
    lines.push(`${message.role}${name}: ${body}${images}${suffix}`);
  }
  const transcript = lines.join("\n\n");
  return transcript.length > COMPACTION_INPUT_CHARS
    ? `...earlier transcript omitted...\n\n${transcript.slice(-COMPACTION_INPUT_CHARS)}`
    : transcript;
}
