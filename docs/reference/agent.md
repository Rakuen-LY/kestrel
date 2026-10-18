# Agent reference

Package: `@kestrel/agent` · depends on `@kestrel/kernel` and `@kestrel/protocol`.

The runtime owns sessions, the model/tool registries and the execution loop. It performs no I/O
except through `SessionStore` and the model implementations it is given.

## `SessionManager`

```ts
interface SessionManagerOptions {
  models: ModelRegistry;
  tools: ToolRegistry;
  logger: Logger;
  defaultWorkspace: string;
  store?: SessionStore;
  systemPrompt?: (workspace: string) => string;
  defaultModel?: string;
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  approve?: ApprovalHandler;
  resolvePermission?: PermissionResolver;
}

class SessionManager {
  constructor(options: SessionManagerOptions);
  initialize(): Promise<void>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  publish(event: SessionEvent): void;          // used by adapters/tests
  addGuard(guard: SessionGuard): () => void;   // veto create/run; see Quotas
  checkGuards(context: SessionGuardContext): void;  // throws SessionGuardError
  create(request?: CreateSessionRequest, tenantId?: string): AgentSession;
  get(id: string): AgentSession;               // throws SessionNotFoundError
  has(id: string): boolean;
  list(): SessionSummary[];
  send(id: string, content: string): { runId: string; done: Promise<RunResult> };
  cancel(id: string): boolean;
  delete(id: string): Promise<void>;
  close(): Promise<void>;
}
```

`initialize()` loads persisted sessions from the store once. `subscribe` receives every session
event; the HTTP event hub is built on it. `close()` cancels active runs and drops in-memory sessions
during runtime shutdown. Nothing is deleted from the store.

`SessionNotFoundError` has `code = "session_not_found"`, which the HTTP layer maps to `404`.

## `AgentSession`

```ts
class AgentSession {
  readonly id: string;
  readonly isRunning: boolean;
  readonly model: string;
  readonly workspace: string;

  summary(): SessionSummary;
  detail(): SessionDetail;
  rename(title: string): void;
  setModel(model: string): void;
  setSystemPrompt(prompt: string): void;
  reset(): void;
  start(input: string): { runId: string; done: Promise<RunResult> };
  cancel(): boolean;
  touch(): void;
  subscribe(listener: (event: SessionEvent) => void): () => void;
}
```

`start()` appends the user message, emits `message.completed`, emits `run.started` and begins
execution without awaiting it. The returned `done` promise resolves with a `RunResult`:

```ts
type RunResult = {
  runId: string;
  status: "completed" | "cancelled" | "max_steps";
  usage: Usage;
};
```

A model or transport failure rejects `done` after emitting `run.failed`; it does not produce an
`"error"` status. Callers that need to distinguish outcomes must catch the rejection.

Starting a second run while `isRunning` throws. `cancel()` aborts the signal; the run resolves with
`status: "cancelled"`.

## `ModelRegistry`

```ts
class ModelRegistry {
  constructor(options?: { defaultModel?: string });
  register(model: LanguageModel, options?: { setDefault?: boolean }): () => void;
  get(id?: string): LanguageModel;   // throws when missing or no default
  has(id: string): boolean;
  setDefault(id: string): void;
  get defaultModel(): string | undefined;
  list(): ModelInfo[];
  get size(): number;
}
```

`register` returns a disposer. The first registered model becomes the default unless
`defaultModel` was configured; `setDefault` marks an explicit choice, which later registrations
cannot override.

## `ToolRegistry`

```ts
class ToolRegistry {
  register(tool: Tool): () => void;  // throws on duplicate name
  get(name: string): Tool | undefined;
  list(): Tool[];                    // sorted by name
  schemas(): ToolSchema[];
  get size(): number;
}
```

`schemas()` is what the runtime sends to the model. `list()` and `schemas()` are sorted by tool name
so prompts and console output are stable across restarts.

## Provider types

```ts
interface LanguageModel {
  readonly info: ModelInfo;
  generate(request: CompletionRequest, onDelta?: (delta: TokenDelta) => void): Promise<CompletionResponse>;
}

interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

interface CompletionResponse {
  content: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "error" | (string & {});
}
```

`ModelInfo` is defined in `@kestrel/protocol`:

```ts
interface ModelInfo {
  id: string;
  provider: string;
  label?: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
}
```

## Tool types

```ts
interface Tool {
  readonly schema: ToolSchema;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> | ToolExecutionResult;
}

interface ToolExecutionResult {
  content: string;        // sent to the model
  data?: unknown;         // sent to clients only
  isError?: boolean;      // expected failure, rendered as an error
  terminate?: boolean;    // stop the run after this result
}

interface ToolContext {
  readonly session: ToolSession;   // id, workspace, messages, metadata
  readonly callId: string;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  progress(message: string): void;
}
```

`ToolSession.metadata` is a per-session `Map` shared by every tool invocation. Use it for caches or
counters, not for large payloads.

## Permissions and approvals

```ts
type PermissionResolver = (
  tool: Tool,
  call: ToolCall,
  session: ToolSession,
) => ToolPermission | "deny" | Promise<ToolPermission | "deny">;

type ApprovalHandler = (request: ApprovalRequest, signal: AbortSignal) => Promise<boolean>;
```

Resolution order: `resolvePermission` if provided, otherwise `tool.schema.permission ?? "auto"`.
`"ask"` calls the approval handler; `"deny"` returns an error result without asking. The default
handler used by the server waits on the approval broker, which is fed by the HTTP endpoint.

## Stores

```ts
interface SessionStore {
  list(): Promise<SessionSummary[]>;
  load(id: string): Promise<SessionDetail | undefined>;
  save(session: SessionDetail): Promise<void>;
  delete(id: string): Promise<void>;
}

class MemorySessionStore implements SessionStore {}
class FileSessionStore implements SessionStore {
  constructor(directory: string);
}
```

`FileSessionStore` writes `<directory>/sessions/<id>/session.json` via a temporary file and rename. It
ignores corrupt files rather than failing startup.

## Prompt construction

```ts
defaultSystemPrompt(options: {
  workspace: string;
  toolNames: string[];
  extra?: string;
}): string;
```

The default prompt states the workspace, the available tool names, the rule to prefer small
verified changes, and that tool output is untrusted data. `config.agent.systemPrompt` is appended as
additional instructions.

## Message helpers

| Function | Purpose |
| --- | --- |
| `createMessage(role, content)` | New message with id and timestamp. |
| `assistantMessage(partial)` | Builds an assistant message from a completion. |
| `toolMessage(call, content)` | Correlates a result with its call id. |
| `estimateTokens(text)` | Rough token estimate (~4 chars/token). |
| `titleFromInput(text)` | Derives a session title from the first message. |

## Validation

`validateArguments(schema, args)` returns `JsonValidationIssue[]`; `formatValidationIssues` renders
them as `path: message`. The agent loop validates before calling a tool and turns issues into a
tool error the model can read.
