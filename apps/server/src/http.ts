import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { PROTOCOL_VERSION, type ApiErrorBody, type ApprovalDecision, type BootstrapResponse, type CreateSessionRequest, type HealthResponse, type SendMessageRequest } from "@kestrel/protocol";
import { SessionNotFoundError } from "@kestrel/agent";
import type { Runtime } from "./runtime.js";

const VERSION = "0.1.0";

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff": "font/woff",
};

export function createHttpServer(runtime: Runtime): Server {
  return createServer((req, res) => {
    void handle(runtime, req, res).catch((error: unknown) => handleError(runtime, req, res, error));
  });
}

async function handle(runtime: Runtime, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const method = req.method ?? "GET";
  applyCors(runtime, req, res);
  applySecurityHeaders(res);

  if (method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (!url.pathname.startsWith("/api/")) {
    await serveStatic(runtime, req, res, url);
    return;
  }

  if (url.pathname === "/api/health" && method === "GET") {
    const health: HealthResponse = {
      status: "ok",
      name: runtime.config.name ?? "Kestrel",
      version: VERSION,
      protocol: PROTOCOL_VERSION,
      uptimeMs: Date.now() - runtime.startedAt,
      plugins: runtime.plugins.list().filter((plugin) => plugin.state === "active").length,
      sessions: runtime.sessions.list().length,
    };
    json(res, 200, health);
    return;
  }

  if (!authorized(runtime, req, url)) {
    throw new HttpError(401, "unauthorized", "Provide a valid bearer token.");
  }

  if (url.pathname === "/api/bootstrap" && method === "GET") {
    const bootstrap: BootstrapResponse = {
      name: runtime.config.name ?? "Kestrel",
      version: VERSION,
      protocol: PROTOCOL_VERSION,
      models: runtime.models.list(),
      tools: runtime.tools.schemas(),
      plugins: runtime.plugins.list(),
      features: { streaming: true, approvals: true, persistence: true, multiSession: true },
    };
    json(res, 200, bootstrap);
    return;
  }

  if (url.pathname === "/api/config" && method === "GET") {
    json(res, 200, {
      name: runtime.config.name ?? "Kestrel",
      defaultModel: runtime.models.defaultModel ?? null,
      workspace: runtime.config.agent.workspace ?? ".",
      pluginDirectories: runtime.plugins.directories(),
      maxSteps: runtime.config.model.maxSteps ?? null,
      authentication: Boolean(runtime.config.server.token),
    });
    return;
  }

  if (url.pathname === "/api/plugins" && method === "GET") {
    json(res, 200, { plugins: runtime.plugins.list() });
    return;
  }

  if (url.pathname === "/api/sessions") {
    if (method === "GET") {
      json(res, 200, { sessions: runtime.sessions.list() });
      return;
    }
    if (method === "POST") {
      const body = await readJson<CreateSessionRequest>(req, runtime);
      validateCreate(body);
      const session = runtime.sessions.create(body);
      json(res, 201, { session: session.detail() });
      return;
    }
    throw new HttpError(405, "method_not_allowed", "Use GET or POST.");
  }

  if (url.pathname === "/api/events" && method === "GET") {
    streamEvents(runtime, req, res, url);
    return;
  }

  const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(messages|events|cancel))?$/.exec(url.pathname);
  if (sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1]);
    const action = sessionMatch[2];
    const session = runtime.sessions.get(id);

    if (!action && method === "GET") {
      json(res, 200, { session: session.detail() });
      return;
    }
    if (!action && method === "DELETE") {
      await runtime.sessions.delete(id);
      res.writeHead(204).end();
      return;
    }
    if (!action && method === "PATCH") {
      const body = await readJson<{ title?: string; model?: string; systemPrompt?: string }>(req, runtime);
      if (body.title !== undefined) {
        if (typeof body.title !== "string" || !body.title.trim()) {
          throw new HttpError(400, "invalid_title", "title must be a non-empty string.");
        }
        session.rename(body.title);
      }
      if (body.model !== undefined) {
        if (typeof body.model !== "string") throw new HttpError(400, "invalid_model", "model must be a string.");
        if (!runtime.models.has(body.model)) {
          throw new HttpError(400, "unknown_model", `Unknown model "${body.model}".`);
        }
        session.setModel(body.model);
      }
      if (body.systemPrompt !== undefined) {
        if (typeof body.systemPrompt !== "string") {
          throw new HttpError(400, "invalid_prompt", "systemPrompt must be a string.");
        }
        session.setSystemPrompt(body.systemPrompt);
      }
      session.touch();
      json(res, 200, { session: session.detail() });
      return;
    }
    if (action === "messages" && method === "POST") {
      if (session.isRunning) throw new HttpError(409, "session_busy", "This session already has an active run.");
      const body = await readJson<SendMessageRequest>(req, runtime);
      if (typeof body.content !== "string" || !body.content.trim()) {
        throw new HttpError(400, "invalid_message", "content must be a non-empty string.");
      }
      if (body.content.length > 200_000) {
        throw new HttpError(413, "message_too_large", "Messages are limited to 200,000 characters.");
      }
      const { runId, done } = session.start(body.content);
      done.catch((error: unknown) => {
        runtime.logger.error("run rejected", { sessionId: id, runId, error: String(error) });
      });
      json(res, 202, { runId });
      return;
    }
    if (action === "events" && method === "GET") {
      streamEvents(runtime, req, res, url, id);
      return;
    }
    if (action === "cancel" && method === "POST") {
      const cancelled = runtime.sessions.cancel(id);
      json(res, 200, { cancelled });
      return;
    }
    throw new HttpError(405, "method_not_allowed", `Method ${method} is not supported here.`);
  }

  const approvalMatch = /^\/api\/sessions\/([^/]+)\/approvals\/([^/]+)$/.exec(url.pathname);
  if (approvalMatch && method === "POST") {
    const sessionId = decodeURIComponent(approvalMatch[1]);
    const approvalId = decodeURIComponent(approvalMatch[2]);
    runtime.sessions.get(sessionId);
    const body = await readJson<ApprovalDecision>(req, runtime);
    if (typeof body.approved !== "boolean") {
      throw new HttpError(400, "invalid_decision", "approved must be a boolean.");
    }
    const resolved = runtime.approvals.decide(approvalId, body.approved);
    if (!resolved) throw new HttpError(404, "approval_not_found", "This approval is no longer pending.");
    json(res, 200, { resolved: true });
    return;
  }

  throw new HttpError(404, "not_found", `No route for ${method} ${url.pathname}.`);
}

function streamEvents(
  runtime: Runtime,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sessionId?: string,
): void {
  if (sessionId) runtime.sessions.get(sessionId);
  // Replay only for reconnects. A first connection receives session history
  // through GET /api/sessions/:id, so replaying the buffer would duplicate it.
  const rawLast = req.headers["last-event-id"] ?? url.searchParams.get("lastEventId");
  const lastEventId = rawLast === undefined ? undefined : Number.parseInt(String(rawLast), 10) || 0;

  // Subscribe before flushing headers so a run started by the client immediately
  // after the response cannot publish an event into the gap between subscribe
  // and the first write.
  const pending: Array<{ seq: number; at: string; event: unknown }> = [];
  const written = new Set<number>();
  let live = false;

  const send = (envelope: { seq: number; at: string; event: unknown }) => {
    if (written.has(envelope.seq)) return;
    written.add(envelope.seq);
    if (!live) {
      pending.push(envelope);
      return;
    }
    res.write(`id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`);
  };

  const unsubscribe = sessionId
    ? runtime.events.subscribe(sessionId, send)
    : runtime.events.subscribeAll(send);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 3000\n\n");

  if (lastEventId !== undefined) {
    for (const envelope of runtime.events.replay(lastEventId, sessionId)) send(envelope);
  }
  live = true;
  for (const envelope of pending.sort((a, b) => a.seq - b.seq)) {
    res.write(`id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`);
  }
  pending.length = 0;
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  heartbeat.unref?.();

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
}

async function serveStatic(
  runtime: Runtime,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    throw new HttpError(405, "method_not_allowed", "Static content is read-only.");
  }
  const root = resolve(runtime.config.server.webRoot ?? resolve(process.cwd(), "apps/web/dist"));
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, "bad_path", "Malformed URL.");
  }
  let target = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!target.startsWith(root + sep) && target !== root) {
    throw new HttpError(403, "forbidden", "Path traversal is not allowed.");
  }

  let info = await stat(target).catch(() => undefined);
  if (!info?.isFile()) {
    if (extname(target)) throw new HttpError(404, "not_found", "Asset not found.");
    target = resolve(root, "index.html");
    info = await stat(target).catch(() => undefined);
    if (!info) {
      json(res, 200, {
        name: runtime.config.name ?? "Kestrel",
        message: "The Kestrel API is running. The web console has not been built yet.",
        console: "Run `pnpm build:web` or use the Vite dev server.",
        api: "/api/bootstrap",
      });
      return;
    }
  }

  const ext = extname(target);
  const immutable = target.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "content-length": info.size,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    ...(ext === ".html"
      ? {
          "content-security-policy":
            "default-src 'self'; connect-src *; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:",
        }
      : {}),
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(target).pipe(res);
}

function applyCors(runtime: Runtime, req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  const allowed = runtime.config.server.corsOrigins ?? ["*"];
  if (allowed.includes("*")) {
    res.setHeader("access-control-allow-origin", origin ?? "*");
    if (origin) res.setHeader("vary", "Origin");
  } else if (origin && allowed.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
  }
  res.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type, last-event-id");
  res.setHeader("access-control-max-age", "86400");
}

function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("cross-origin-opener-policy", "same-origin");
}

function authorized(runtime: Runtime, req: IncomingMessage, url: URL): boolean {
  const expected = runtime.config.server.token;
  if (!expected) return true;
  const header = req.headers.authorization;
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
  if (!supplied) return false;
  return constantTimeEqual(supplied, expected);
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

async function readJson<T>(req: IncomingMessage, runtime: Runtime): Promise<T> {
  const limit = runtime.config.server.bodyLimitBytes ?? 10 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new HttpError(413, "payload_too_large", `Request body exceeds ${limit} bytes.`);
    chunks.push(buffer);
  }
  if (size === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

function validateCreate(body: CreateSessionRequest): void {
  for (const key of ["title", "model", "systemPrompt", "workspace"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "string") {
      throw new HttpError(400, "invalid_body", `${key} must be a string.`);
    }
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function handleError(runtime: Runtime, req: IncomingMessage, res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status =
    error instanceof HttpError ? error.status : error instanceof SessionNotFoundError ? 404 : 500;
  const code =
    error instanceof HttpError ? error.code : error instanceof SessionNotFoundError ? "session_not_found" : "internal_error";
  const message =
    error instanceof HttpError || error instanceof SessionNotFoundError
      ? error.message
      : "The server hit an unexpected error. Check the server logs for details.";
  if (status >= 500) {
    runtime.logger.error("request failed", {
      method: req.method,
      url: req.url,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
  const body: ApiErrorBody = {
    error: { code, message, details: error instanceof HttpError ? error.details : undefined },
  };
  json(res, status, body);
}
