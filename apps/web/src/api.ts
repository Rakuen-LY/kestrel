import type {
  ApprovalDecision,
  CheckpointInfo,
  ChatMessage,
  BootstrapResponse,
  CheckpointListResponse,
  CreateSessionRequest,
  HealthResponse,
  ImageAttachment,
  PluginInfo,
  ServerEventEnvelope,
  SessionDetail,
  SessionEvent,
  SessionSummary,
  WorkspaceFile,
  WorkspaceListing,
} from "@kestrel/protocol";

const TOKEN_KEY = "kestrel.token";
const ENDPOINT_KEY = "kestrel.endpoint";

export function normalizeEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const url = new URL(trimmed, window.location.origin);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The API endpoint must use http or https.");
  }
  return url.href.replace(/\/$/, "");
}

export function readEndpoint(): string {
  try {
    const query = new URLSearchParams(window.location.search).get("api");
    if (query) {
      const normalized = normalizeEndpoint(query);
      localStorage.setItem(ENDPOINT_KEY, normalized);
      return normalized;
    }
    return localStorage.getItem(ENDPOINT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeEndpoint(endpoint: string): void {
  try {
    const normalized = normalizeEndpoint(endpoint);
    if (normalized && normalized !== window.location.origin) localStorage.setItem(ENDPOINT_KEY, normalized);
    else localStorage.removeItem(ENDPOINT_KEY);
  } catch {
    // Invalid values are rejected by the settings form before this point.
  }
}

export function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private browsing may reject storage; the session still works in memory.
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface StreamHandlers {
  onEvent: (event: SessionEvent, envelope: ServerEventEnvelope) => void;
  onStatus: (status: "connecting" | "online" | "offline") => void;
}

export class KestrelApi {
  constructor(
    private readonly base = readEndpoint(),
    private token = readToken(),
  ) {}

  get endpoint(): string {
    return this.base || window.location.origin;
  }

  setToken(token: string): void {
    this.token = token;
    writeToken(token);
  }

  get hasToken(): boolean {
    return Boolean(this.token);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      ...init,
      headers: this.headers({
        "content-type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      }),
    });
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    if (!response.ok) {
      const error = (body as { error?: { code?: string; message?: string } }).error;
      throw new ApiError(response.status, error?.code ?? "request_failed", error?.message ?? response.statusText);
    }
    return body as T;
  }

  health(): Promise<HealthResponse> {
    return this.request("/api/health");
  }

  bootstrap(): Promise<BootstrapResponse> {
    return this.request("/api/bootstrap");
  }

  me(): Promise<{
    principal: { id: string; name: string; role: string; tenantId: string; email?: string };
    tenant: { id: string; name: string };
    mode: "none" | "token" | "accounts";
  }> {
    return this.request("/api/auth/me");
  }

  checkpoints(sessionId: string): Promise<CheckpointListResponse> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/checkpoints`);
  }

  createCheckpoint(sessionId: string, label?: string): Promise<{ checkpoint: CheckpointInfo }> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/checkpoints`, {
      method: "POST",
      body: JSON.stringify({ label }),
    });
  }

  restoreCheckpoint(
    sessionId: string,
    checkpointId: string,
  ): Promise<{ restored: CheckpointInfo; safety: CheckpointInfo }> {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/checkpoints/${encodeURIComponent(checkpointId)}/restore`,
      { method: "POST" },
    );
  }

  plugins(): Promise<{ plugins: PluginInfo[] }> {
    return this.request("/api/plugins");
  }

  listFiles(sessionId: string, path = "."): Promise<WorkspaceListing> {
    const query = new URLSearchParams({ path });
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/files?${query.toString()}`);
  }

  readFile(sessionId: string, path: string): Promise<WorkspaceFile> {
    const query = new URLSearchParams({ path });
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/file?${query.toString()}`);
  }

  listSessions(): Promise<{ sessions: SessionSummary[] }> {
    return this.request("/api/sessions");
  }

  createSession(body: CreateSessionRequest = {}): Promise<{ session: SessionDetail }> {
    return this.request("/api/sessions", { method: "POST", body: JSON.stringify(body) });
  }

  getSession(id: string): Promise<{ session: SessionDetail }> {
    return this.request(`/api/sessions/${encodeURIComponent(id)}`);
  }

  updateSession(
    id: string,
    patch: { title?: string; model?: string; systemPrompt?: string },
  ): Promise<{ session: SessionDetail }> {
    return this.request(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  deleteSession(id: string): Promise<void> {
    return this.request(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  sendMessage(id: string, content: string, images: ImageAttachment[] = []): Promise<{ runId: string }> {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: JSON.stringify(images.length ? { content, images } : { content }),
    });
  }

  rewind(
    sessionId: string,
    messageId: string,
    restoreFiles = true,
  ): Promise<{
    messageId: string;
    removed: number;
    messages: ChatMessage[];
    restored: CheckpointInfo | null;
    safety: CheckpointInfo | null;
    warning?: string;
  }> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/rewind`, {
      method: "POST",
      body: JSON.stringify({ messageId, restoreFiles }),
    });
  }

  resume(id: string): Promise<{ runId: string }> {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/resume`, { method: "POST" });
  }

  cancel(id: string): Promise<{ cancelled: boolean }> {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  }

  decideApproval(sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<{ resolved: boolean }> {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
      { method: "POST", body: JSON.stringify(decision) },
    );
  }

  /** Opens an SSE stream; EventSource reconnects and resumes automatically. */
  stream(sessionId: string, handlers: StreamHandlers): () => void {
    const query = new URLSearchParams();
    if (this.token) query.set("token", this.token);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const source = new EventSource(`${this.base}/api/sessions/${encodeURIComponent(sessionId)}/events${suffix}`);
    let opened = false;
    handlers.onStatus("connecting");

    source.onopen = () => {
      opened = true;
      handlers.onStatus("online");
    };
    source.onmessage = (message) => {
      try {
        const envelope = JSON.parse(message.data) as ServerEventEnvelope;
        handlers.onEvent(envelope.event, envelope);
      } catch {
        // Ignore malformed frames; the next one may be valid.
      }
    };
    source.onerror = () => {
      handlers.onStatus(opened ? "offline" : "connecting");
    };
    return () => source.close();
  }
}
