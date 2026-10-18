import type {
  ChatMessage,
  JsonSchema,
  ModelInfo,
  ToolCall,
  ToolPermission,
  ToolSchema,
  Usage,
  ImageAttachment,
} from "@kestrel/protocol";
import type { Logger } from "@kestrel/kernel";
import type { RetryOptions } from "./retry.js";
import type { ModelRegistry, ToolRegistry } from "./registry.js";
import type { AgentSession } from "./session.js";

export interface TokenDelta {
  channel: "text" | "reasoning";
  delta: string;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error" | (string & {});

export interface CompletionResponse {
  content: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: FinishReason;
}

/** A provider adapter over one concrete model. */
export interface LanguageModel {
  readonly info: ModelInfo;
  generate(request: CompletionRequest, onDelta?: (delta: TokenDelta) => void): Promise<CompletionResponse>;
}

export interface ToolExecutionResult {
  content: string;
  data?: unknown;
  isError?: boolean;
  /** Ask the agent loop to stop after this result (e.g. a `finish` tool). */
  terminate?: boolean;
  /** Images to show in clients and feed back to vision models. */
  images?: ImageAttachment[];
}

export interface ToolSession {
  readonly id: string;
  readonly workspace: string;
  readonly messages: readonly ChatMessage[];
  /** Delegation depth: `0` for a session a human started. */
  readonly depth?: number;
  readonly parentId?: string;
  readonly role?: string;
  metadata: Map<string, unknown>;
}

export interface ToolContext {
  readonly session: ToolSession;
  readonly callId: string;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  progress(message: string): void;
}

export interface Tool {
  readonly schema: ToolSchema;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> | ToolExecutionResult;
}

export type PermissionResolver = (
  tool: Tool,
  call: ToolCall,
  session: ToolSession,
) => ToolPermission | "deny" | Promise<ToolPermission | "deny">;

/** Bridges a paused tool call to a human decision. */
export type ApprovalHandler = (
  request: import("@kestrel/protocol").ApprovalRequest,
  signal: AbortSignal,
) => Promise<boolean>;

/**
 * Long sessions eventually outgrow the model window. When the estimated prompt
 * crosses `threshold` of the window, the oldest messages are replaced by one
 * model-written summary; the transcript keeps a visible record of it.
 */
export interface CompactionOptions {
  enabled?: boolean;
  /** Fraction of the context window that triggers compaction (default 0.8). */
  threshold?: number;
  /** Messages kept verbatim after the summary (default 8). */
  keepRecent?: number;
  /** Window assumed when the model does not declare one (default 128000). */
  fallbackContextWindow?: number;
}

export interface AgentSessionOptions {
  id: string;
  title: string;
  model: string;
  workspace: string;
  systemPrompt: string;
  /** Owning tenant; `undefined` means the default tenant. */
  tenantId?: string;
  messages?: ChatMessage[];
  /** Persisted status, so an interrupted or failed session stays resumable after a restart. */
  status?: import("@kestrel/protocol").SessionStatus;
  /** Cumulative usage restored from persistence. */
  usage?: Usage;
  createdAt?: string;
  updatedAt?: string;
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  compaction?: CompactionOptions;
  /** Set for subagents; omitted for sessions a human started. */
  parentId?: string;
  depth?: number;
  role?: string;
  /** When set, only these tool names are offered and executable. */
  allowTools?: readonly string[];
  models: ModelRegistry;
  tools: ToolRegistry;
  logger: Logger;
  emit: (event: import("@kestrel/protocol").SessionEvent) => void;
  approve?: ApprovalHandler;
  resolvePermission?: PermissionResolver;
  onPersist?: (session: AgentSession) => void;
  /** Runs immediately before a run is launched; throwing cancels the start. */
  beforeRun?: (session: AgentSession) => void;
  /** Backoff for transient model failures; `attempts: 1` disables retries. */
  retry?: RetryOptions;
}

export class RewindError extends Error {
  constructor(
    readonly code: "session_busy" | "message_not_found" | "invalid_rewind_target",
    message: string,
  ) {
    super(message);
    this.name = "RewindError";
  }
}

export function isRewindError(error: unknown): error is RewindError {
  if (error instanceof RewindError) return true;
  return (
    error instanceof Error &&
    error.name === "RewindError" &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

/**
 * A synchronous veto over session creation and run launches. Throwing
 * `SessionGuardError` rejects the action and surfaces the message to the
 * caller; any other error is treated as a bug and reported as a 500.
 *
 * Guards run in registration order on the event loop, so they must be cheap:
 * count what is already in memory instead of awaiting I/O.
 */
export interface SessionGuardContext {
  action: "create" | "run";
  tenantId: string;
  /** Present for `run`, absent for `create`. */
  sessionId?: string;
  /** Present for `create`, absent for `run`. */
  request?: { title?: string; model?: string; workspace?: string };
}

export type SessionGuard = (context: SessionGuardContext) => void;

export class SessionGuardError extends Error {
  readonly code: string;
  readonly retryAfterSeconds?: number;
  constructor(code: string, message: string, options: { retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = "SessionGuardError";
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/**
 * Structural check, because a plugin bundle may contain its own copy of this
 * class: `instanceof` fails across module instances, while `name` and `code`
 * survive bundling and serialization.
 */
export function isSessionGuardError(error: unknown): error is SessionGuardError {
  if (error instanceof SessionGuardError) return true;
  return (
    error instanceof Error &&
    error.name === "SessionGuardError" &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

export interface RunResult {
  runId: string;
  status: "completed" | "cancelled" | "max_steps";
  usage: Usage;
}

export interface ModelRegistryOptions {
  defaultModel?: string;
}

export interface ToolRegistration {
  register(tool: Tool): () => void;
  get(name: string): Tool | undefined;
  list(): Tool[];
  schemas(): ToolSchema[];
  readonly size: number;
}

export interface JsonValidationIssue {
  path: string;
  message: string;
}

export type { ChatMessage, JsonSchema, ModelInfo, ToolCall, ToolPermission, ToolSchema, Usage };
