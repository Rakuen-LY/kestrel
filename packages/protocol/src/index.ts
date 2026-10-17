/**
 * The Kestrel wire protocol.
 *
 * This package is intentionally dependency-free and platform-neutral: the
 * server, CLI, desktop shell and browser console all compile against the same
 * definitions. It describes data only; behaviour lives in the runtime.
 */

export const PROTOCOL_VERSION = "1.0";

export type JsonSchema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly unknown[];
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  [keyword: string]: unknown;
};

export type ToolPermission = "auto" | "ask";

export interface ToolSchema {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** `ask` pauses the run until a human (or policy) approves the call. */
  permission?: ToolPermission;
  /** Grouping hint for clients, e.g. "filesystem" or "network". */
  category?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  ok: boolean;
  content: string;
  durationMs?: number;
  error?: string;
  /** Structured payload for rich clients; never sent to the model. */
  data?: unknown;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** Provider-native reasoning trace, when the model exposes one. */
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  createdAt: string;
  /** Model that produced an assistant message, for provenance in clients. */
  model?: string;
  /** Hidden messages are replayed to the model but not shown in the UI. */
  hidden?: boolean;
  meta?: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export type SessionStatus = "idle" | "running" | "error" | "cancelled";

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  model: string;
  messageCount: number;
  workspace: string;
  /** Session that spawned this one, when it is a subagent. */
  parentId?: string;
  /** `0` for a root session, `1` for a direct subagent, and so on. */
  depth?: number;
  /** Subagent role name, e.g. `researcher`. Root sessions omit it. */
  role?: string;
  /** Owning tenant. Omitted for the default tenant, so v0.1 payloads are unchanged. */
  tenantId?: string;
}

export interface SessionDetail extends SessionSummary {
  messages: ChatMessage[];
  systemPrompt?: string;
}

/** A restorable workspace snapshot taken before a run or on demand. */
export interface CheckpointInfo {
  id: string;
  /** Commit in the shadow repository. */
  sha: string;
  label: string;
  createdAt: string;
  sessionId?: string;
  /** Tracked files at the time of the snapshot. */
  files: number;
  changes: { added: number; modified: number; deleted: number };
}

export interface CheckpointListResponse {
  enabled: boolean;
  /** Why checkpoints are unavailable, when they are. */
  reason?: string;
  checkpoints: CheckpointInfo[];
}

export interface TenantInfo {
  id: string;
  name: string;
  createdAt?: string;
}

export interface PrincipalInfo {
  id: string;
  name: string;
  /** `admin` may manage tenants and accounts; `member` is scoped to one tenant. */
  role: "admin" | "member";
  tenantId: string;
  email?: string;
}

export interface ApprovalRequest {
  id: string;
  call: ToolCall;
  reason: string;
  createdAt: string;
}

export interface ModelInfo {
  id: string;
  provider: string;
  label?: string;
  description?: string;
  contextWindow?: number;
  supportsTools: boolean;
  supportsReasoning?: boolean;
}

export interface PluginManifest {
  /** Stable identity, conventionally `@scope/name` or `kestrel-plugin-x`. */
  name: string;
  version: string;
  description?: string;
  /** Module entry, relative to the plugin directory. */
  entry?: string;
  /** Other plugin names that must be active first. */
  requires?: string[];
  /** Kernel service keys this plugin waits for. */
  inject?: string[];
  /** Default configuration; merged with user configuration. */
  config?: Record<string, unknown>;
  /**
   * Optional browser bundle served by the console. A string is shorthand for
   * `{ entry: "web/<string>" }`; paths are relative to the plugin's `web/`
   * directory.
   */
  web?: string | PluginWeb;
}

export interface PluginWeb {
  /** ESM module exporting `default (api) => void | Promise<void>`. */
  entry: string;
  /** Stylesheets injected before the module runs. */
  css?: string[];
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  state: "waiting" | "loading" | "active" | "error" | "disposed";
  dependencies: string[];
  error?: string;
  source: "builtin" | "local" | "package";
  path?: string;
  /** Browser contribution, with paths relative to the plugin's `web/` directory. */
  web?: PluginWeb;
}

export type SessionEvent =
  | { type: "session.updated"; sessionId: string; session: SessionSummary }
  | { type: "run.started"; sessionId: string; runId: string }
  | {
      type: "run.finished";
      sessionId: string;
      runId: string;
      status: "completed" | "cancelled" | "max_steps";
      usage?: Usage;
    }
  | { type: "run.failed"; sessionId: string; runId: string; error: string }
  | { type: "message.started"; sessionId: string; message: ChatMessage }
  | {
      type: "message.delta";
      sessionId: string;
      messageId: string;
      channel: "text" | "reasoning";
      delta: string;
    }
  | { type: "message.completed"; sessionId: string; message: ChatMessage }
  | { type: "tool.started"; sessionId: string; call: ToolCall }
  | { type: "tool.finished"; sessionId: string; result: ToolResult }
  | { type: "approval.requested"; sessionId: string; approval: ApprovalRequest }
  | { type: "approval.resolved"; sessionId: string; approvalId: string; approved: boolean }
  | { type: "session.deleted"; sessionId: string }
  | { type: "plugin.changed"; plugin: PluginInfo }
  | {
      type: "context.compacted";
      sessionId: string;
      removedMessages: number;
      keptMessages: number;
      tokensBefore: number;
      tokensAfter: number;
    }
  | { type: "notice"; level: "info" | "warn" | "error"; message: string };

export interface ServerEventEnvelope {
  /** Monotonic per server process; SSE clients resume with Last-Event-ID. */
  seq: number;
  at: string;
  event: SessionEvent;
}

export interface CreateSessionRequest {
  title?: string;
  model?: string;
  systemPrompt?: string;
  workspace?: string;
}

export interface SendMessageRequest {
  content: string;
}

export interface ApprovalDecision {
  approved: boolean;
  note?: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface HealthResponse {
  status: "ok";
  name: string;
  version: string;
  protocol: string;
  uptimeMs: number;
  plugins: number;
  sessions: number;
}

export interface BootstrapResponse {
  name: string;
  version: string;
  protocol: string;
  models: ModelInfo[];
  tools: ToolSchema[];
  plugins: PluginInfo[];
  features: {
    streaming: boolean;
    approvals: boolean;
    persistence: boolean;
    multiSession: boolean;
    /** The server authenticates accounts rather than a single operator token. */
    accounts?: boolean;
    multiTenant?: boolean;
  };
  /** The authenticated caller. Absent when authentication is disabled. */
  principal?: PrincipalInfo;
  tenant?: TenantInfo;
}

/** Paths are stable API surface; keep them in one place for all clients. */
export const ENDPOINTS = {
  health: "/api/health",
  bootstrap: "/api/bootstrap",
  sessions: "/api/sessions",
  session: (id: string) => `/api/sessions/${encodeURIComponent(id)}`,
  messages: (id: string) => `/api/sessions/${encodeURIComponent(id)}/messages`,
  events: (id: string) => `/api/sessions/${encodeURIComponent(id)}/events`,
  cancel: (id: string) => `/api/sessions/${encodeURIComponent(id)}/cancel`,
  approval: (sessionId: string, approvalId: string) =>
    `/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
  plugins: "/api/plugins",
} as const;
