import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { PROTOCOL_VERSION, type ApiErrorBody, type ApprovalDecision, type BootstrapResponse, type CreateSessionRequest, type HealthResponse, type SendMessageRequest } from "@kestrel/protocol";
import { SessionNotFoundError } from "@kestrel/agent";
import type { AgentSession } from "@kestrel/agent";
import { AuthError, type Principal } from "./auth.js";
import { CheckpointError } from "./checkpoints.js";
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

  const principal = requirePrincipal(runtime, req, url);
  const tenant = runtime.auth.store?.tenant(principal.tenantId);

  if (url.pathname === "/api/auth/me" && method === "GET") {
    json(res, 200, {
      principal: {
        id: principal.id,
        name: principal.name,
        role: principal.role,
        tenantId: principal.tenantId,
        email: principal.email,
      },
      tenant: tenant ?? { id: principal.tenantId, name: principal.tenantId },
      mode: runtime.auth.mode,
    });
    return;
  }

  if (url.pathname === "/api/tenants") {
    requireAdmin(principal);
    const store = requireStore(runtime);
    if (method === "GET") {
      json(res, 200, { tenants: store.listTenants() });
      return;
    }
    if (method === "POST") {
      const body = await readJson<{ name?: string }>(req, runtime);
      if (typeof body.name !== "string" || !body.name.trim()) {
        throw new HttpError(400, "invalid_name", "name must be a non-empty string.");
      }
      json(res, 201, { tenant: await store.createTenant(body.name) });
      return;
    }
    throw new HttpError(405, "method_not_allowed", "Use GET or POST.");
  }

  if (url.pathname === "/api/users") {
    requireAdmin(principal);
    const store = requireStore(runtime);
    if (method === "GET") {
      json(res, 200, { users: store.listUsers() });
      return;
    }
    if (method === "POST") {
      const body = await readJson<{
        name?: string;
        email?: string;
        role?: string;
        tenantId?: string;
      }>(req, runtime);
      if (typeof body.name !== "string" || !body.name.trim()) {
        throw new HttpError(400, "invalid_name", "name must be a non-empty string.");
      }
      if (body.role !== undefined && body.role !== "admin" && body.role !== "member") {
        throw new HttpError(400, "invalid_role", 'role must be "admin" or "member".');
      }
      try {
        const created = await store.createUser({
          name: body.name,
          email: typeof body.email === "string" ? body.email : undefined,
          role: body.role,
          tenantId: typeof body.tenantId === "string" ? body.tenantId : principal.tenantId,
        });
        json(res, 201, created);
      } catch (error) {
        throw authError(error);
      }
      return;
    }
    throw new HttpError(405, "method_not_allowed", "Use GET or POST.");
  }

  const userMatch = /^\/api\/users\/([^/]+)(?:\/(token))?$/.exec(url.pathname);
  if (userMatch) {
    requireAdmin(principal);
    const store = requireStore(runtime);
    const id = decodeURIComponent(userMatch[1]);
    const action = userMatch[2];

    if (!action && method === "DELETE") {
      if (id === principal.id) {
        throw new HttpError(409, "self_delete", "You cannot delete the account you are using.");
      }
      if (!(await store.deleteUser(id))) throw new HttpError(404, "user_not_found", "Unknown user.");
      res.writeHead(204).end();
      return;
    }
    if (action === "token" && method === "POST") {
      const rotated = await store.rotateToken(id);
      if (!rotated) throw new HttpError(404, "user_not_found", "Unknown user.");
      json(res, 200, rotated);
      return;
    }
    throw new HttpError(405, "method_not_allowed", "Use DELETE, or POST to rotate a token.");
  }

  if (url.pathname === "/api/bootstrap" && method === "GET") {
    const bootstrap: BootstrapResponse = {
      name: runtime.config.name ?? "Kestrel",
      version: VERSION,
      protocol: PROTOCOL_VERSION,
      models: runtime.models.list(),
      tools: runtime.tools.schemas(),
      plugins: runtime.plugins.list(),
      features: {
        streaming: true,
        approvals: true,
        persistence: true,
        multiSession: true,
        accounts: runtime.auth.mode === "accounts",
        multiTenant: runtime.auth.mode === "accounts",
      },
      principal: {
        id: principal.id,
        name: principal.name,
        role: principal.role,
        tenantId: principal.tenantId,
        email: principal.email,
      },
      tenant: tenant ?? { id: principal.tenantId, name: principal.tenantId },
    };
    json(res, 200, bootstrap);
    return;
  }

  if (url.pathname === "/api/config" && method === "GET") {
    json(res, 200, {
      name: runtime.config.name ?? "Kestrel",
      defaultModel: runtime.models.defaultModel ?? null,
      workspace: runtime.workspaceFor(principal.tenantId),
      pluginDirectories: runtime.plugins.directories(),
      maxSteps: runtime.config.model.maxSteps ?? null,
      authentication: runtime.auth.mode !== "none",
      authMode: runtime.auth.mode,
      tenant: tenant ?? { id: principal.tenantId, name: principal.tenantId },
    });
    return;
  }

  if (url.pathname === "/api/plugins" && method === "GET") {
    json(res, 200, { plugins: runtime.plugins.list() });
    return;
  }

  if (url.pathname === "/api/sessions") {
    if (method === "GET") {
      const scope = principal.role === "admin" ? undefined : principal.tenantId;
      json(res, 200, { sessions: runtime.sessions.list(scope) });
      return;
    }
    if (method === "POST") {
      const body = await readJson<CreateSessionRequest>(req, runtime);
      validateCreate(body);
      // Members are pinned to their tenant workspace; an admin may override it.
      const workspace =
        body.workspace && principal.role === "admin"
          ? body.workspace
          : runtime.workspaceFor(principal.tenantId);
      const session = runtime.sessions.create({ ...body, workspace }, principal.tenantId);
      json(res, 201, { session: session.detail() });
      return;
    }
    throw new HttpError(405, "method_not_allowed", "Use GET or POST.");
  }

  if (url.pathname === "/api/events" && method === "GET") {
    streamEvents(runtime, req, res, url, principal);
    return;
  }

  const checkpointMatch = /^\/api\/sessions\/([^/]+)\/checkpoints(?:\/([^/]+)\/restore)?$/.exec(url.pathname);
  if (checkpointMatch) {
    const session = visibleSession(runtime, principal, decodeURIComponent(checkpointMatch[1]));
    const checkpointId = checkpointMatch[2] ? decodeURIComponent(checkpointMatch[2]) : undefined;

    if (!checkpointId && method === "GET") {
      const status = await runtime.checkpoints.status();
      json(res, 200, {
        ...status,
        checkpoints: status.enabled ? await runtime.checkpoints.list(session.workspace) : [],
      });
      return;
    }
    if (!checkpointId && method === "POST") {
      const body = await readJson<{ label?: string }>(req, runtime);
      if (body.label !== undefined && typeof body.label !== "string") {
        throw new HttpError(400, "invalid_label", "label must be a string.");
      }
      const checkpoint = await runtime.checkpoints.snapshot(session.workspace, {
        sessionId: session.id,
        label: body.label,
      });
      json(res, 201, { checkpoint });
      return;
    }
    if (checkpointId && method === "POST") {
      if (session.isRunning) throw new HttpError(409, "session_busy", "Stop the run before restoring a checkpoint.");
      const result = await runtime.checkpoints.restore(session.workspace, checkpointId);
      session.touch();
      json(res, 200, result);
      return;
    }
    throw new HttpError(405, "method_not_allowed", "Checkpoints support GET and POST.");
  }

  const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(messages|events|cancel))?$/.exec(url.pathname);
  if (sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1]);
    const action = sessionMatch[2];
    const session = visibleSession(runtime, principal, id);

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
      await snapshotBeforeRun(runtime, session, body.content);
      const { runId, done } = session.start(body.content);
      done.catch((error: unknown) => {
        runtime.logger.error("run rejected", { sessionId: id, runId, error: String(error) });
      });
      json(res, 202, { runId });
      return;
    }
    if (action === "events" && method === "GET") {
      streamEvents(runtime, req, res, url, principal, id);
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
    visibleSession(runtime, principal, sessionId);
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
  principal: Principal,
  sessionId?: string,
): void {
  if (sessionId) visibleSession(runtime, principal, sessionId);
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
    if (!visibleEvent(runtime, principal, envelope.event)) return;
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
  if (await servePluginAsset(runtime, req, res, url)) return;
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

/**
 * Serves browser bundles from an active plugin's `web/` directory at
 * `/plugins/<encoded id>/<path>`. Public like the console itself: the files are
 * static assets, and anything secret belongs behind the API.
 */
async function servePluginAsset(
  runtime: Runtime,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "plugins") return false;
  if (segments.length < 3) throw new HttpError(404, "not_found", "Unknown plugin asset.");

  let id: string;
  let rest: string;
  try {
    id = decodeURIComponent(segments[1]);
    rest = segments.slice(2).map(decodeURIComponent).join("/");
  } catch {
    throw new HttpError(400, "bad_path", "Malformed plugin asset path.");
  }

  const plugin = runtime.plugins
    .list()
    .find((item) => item.id === id && item.state === "active" && item.web && item.path);
  if (!plugin?.web || !plugin.path) throw new HttpError(404, "not_found", "Unknown plugin asset.");

  const root = resolve(plugin.path, "web");
  const target = resolve(root, rest);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new HttpError(403, "forbidden", "Path traversal is not allowed.");
  }

  const info = await stat(target).catch(() => undefined);
  if (!info?.isFile()) throw new HttpError(404, "not_found", "Plugin asset not found.");

  res.writeHead(200, {
    "content-type": MIME[extname(target)] ?? "application/octet-stream",
    "content-length": info.size,
    "cache-control": "no-cache",
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(target).pipe(res);
  return true;
}

/**
 * Snapshots the workspace before a user turn. Failures are logged, never fatal:
 * an unavailable git binary must not stop the agent from working.
 */
async function snapshotBeforeRun(runtime: Runtime, session: AgentSession, content: string): Promise<void> {
  if (session.parentId) return;
  const label = content.trim().replace(/\s+/g, " ").slice(0, 72);
  try {
    await runtime.checkpoints.snapshot(session.workspace, {
      sessionId: session.id,
      label: label ? `Before: ${label}` : "Before turn",
    });
  } catch (error) {
    runtime.logger.warn("checkpoint skipped", {
      sessionId: session.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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

function requirePrincipal(runtime: Runtime, req: IncomingMessage, url: URL): Principal {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
  const principal = runtime.auth.authenticate(token ?? undefined);
  if (!principal) throw new HttpError(401, "unauthorized", "Provide a valid bearer token.");
  return principal;
}

function requireAdmin(principal: Principal): void {
  if (principal.role !== "admin") {
    throw new HttpError(403, "forbidden", "This operation requires an administrator.");
  }
}

function requireStore(runtime: Runtime) {
  const store = runtime.auth.store;
  if (!store) {
    throw new HttpError(
      409,
      "accounts_disabled",
      'User management requires auth.mode "accounts" in the server configuration.',
    );
  }
  return store;
}

function authError(error: unknown): HttpError {
  if (error instanceof AuthError) {
    const status = error.code === "unknown_tenant" ? 400 : 409;
    return new HttpError(status, error.code, error.message);
  }
  return new HttpError(500, "internal_error", error instanceof Error ? error.message : String(error));
}

/** Another tenant's session is reported as missing, not forbidden. */
function visibleSession(runtime: Runtime, principal: Principal, id: string): AgentSession {
  const session = runtime.sessions.get(id);
  if (principal.role !== "admin" && (session.tenantId ?? "default") !== principal.tenantId) {
    throw new HttpError(404, "session_not_found", `Session "${id}" does not exist.`);
  }
  return session;
}

function visibleEvent(runtime: Runtime, principal: Principal, event: unknown): boolean {
  if (principal.role === "admin") return true;
  const sessionId = (event as { sessionId?: string }).sessionId;
  if (!sessionId) return true;
  if (!runtime.sessions.has(sessionId)) return false;
  return (runtime.sessions.get(sessionId).tenantId ?? "default") === principal.tenantId;
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
    error instanceof HttpError
      ? error.status
      : error instanceof SessionNotFoundError
        ? 404
        : error instanceof CheckpointError
          ? error.status
          : 500;
  const code =
    error instanceof HttpError
      ? error.code
      : error instanceof SessionNotFoundError
        ? "session_not_found"
        : error instanceof CheckpointError
          ? error.code
          : "internal_error";
  const message =
    error instanceof HttpError || error instanceof SessionNotFoundError || error instanceof CheckpointError
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
