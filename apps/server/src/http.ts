import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import {
  PROTOCOL_VERSION,
  type ApiErrorBody,
  type ApprovalDecision,
  type BootstrapResponse,
  type CheckpointInfo,
  type CreateSessionRequest,
  type HealthResponse,
  type ImageAttachment,
  type PluginChangeEvent,
  type PluginHttpRequest,
  type PluginInfo,
  type SendMessageRequest,
} from "@kestrel/protocol";
import {
  addUsage,
  emptyUsage,
  isRewindError,
  isSessionGuardError,
  SessionNotFoundError,
} from "@kestrel/agent";
import type { AgentSession } from "@kestrel/agent";
import { AuthError, type Principal } from "./auth.js";
import { CheckpointError } from "./checkpoints.js";
import type { PluginRouteMatch } from "./plugin-http.js";
import { WorkspaceFiles, WorkspaceFilesError } from "./workspace-files.js";
import type { Runtime } from "./runtime.js";

const VERSION = "0.1.0";

const workspaceFiles = new WorkspaceFiles();

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

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

  const pluginRoute = runtime.httpRoutes.match(method, url.pathname);
  if (pluginRoute?.route.public) {
    await dispatchPluginRoute(runtime, req, res, url, pluginRoute);
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
      plugins: withAssetRevisions(runtime, runtime.plugins.list()),
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

  if (url.pathname === "/api/plugins/events" && method === "GET") {
    streamPluginAssets(runtime, req, res);
    return;
  }

  if (url.pathname === "/api/plugins" && method === "GET") {
    json(res, 200, { plugins: withAssetRevisions(runtime, runtime.plugins.list()) });
    return;
  }

  if (url.pathname === "/api/usage" && method === "GET") {
    const scope = principal.role === "admin" ? undefined : principal.tenantId;
    const sessions = runtime.sessions.list(scope);
    const usage = sessions.reduce((total, session) => (session.usage ? addUsage(total, session.usage) : total), emptyUsage());
    json(res, 200, {
      sessions: sessions.length,
      running: sessions.filter((session) => session.status === "running").length,
      usage,
    });
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

  const sessionFilesMatch = /^\/api\/sessions\/([^/]+)\/(files|file)$/.exec(url.pathname);
  if (sessionFilesMatch) {
    if (method !== "GET") throw new HttpError(405, "method_not_allowed", "Workspace files are read-only.");
    const session = visibleSession(runtime, principal, decodeURIComponent(sessionFilesMatch[1]));
    const path = url.searchParams.get("path") ?? ".";
    const payload =
      sessionFilesMatch[2] === "files"
        ? await workspaceFiles.list(session.workspace, path)
        : await workspaceFiles.read(session.workspace, path);
    res.setHeader("cache-control", "no-store");
    json(res, 200, payload);
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

  const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(messages|events|cancel|resume|rewind))?$/.exec(url.pathname);
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
      if (typeof body.content !== "string") {
        throw new HttpError(400, "invalid_message", "content must be a string.");
      }
      if (body.content.length > 200_000) {
        throw new HttpError(413, "message_too_large", "Messages are limited to 200,000 characters.");
      }
      const images = normalizeImages(body.images);
      if (!body.content.trim() && images.length === 0) {
        throw new HttpError(400, "invalid_message", "content or images are required.");
      }
      const messageId = randomUUID();
      await snapshotBeforeRun(
        runtime,
        session,
        body.content || `image: ${images[0]?.name ?? images[0]?.mimeType}`,
        messageId,
      );
      const { runId, done } = session.start(body.content, { images, messageId });
      done.catch((error: unknown) => {
        runtime.logger.error("run rejected", { sessionId: id, runId, error: String(error) });
      });
      json(res, 202, { runId });
      return;
    }
    if (action === "rewind" && method === "POST") {
      if (session.isRunning) throw new HttpError(409, "session_busy", "Stop the run before rewinding.");
      const body = await readJson<{ messageId?: unknown; restoreFiles?: unknown }>(req, runtime);
      if (typeof body.messageId !== "string" || !body.messageId) {
        throw new HttpError(400, "invalid_message_id", "messageId must be a non-empty string.");
      }
      if (body.restoreFiles !== undefined && typeof body.restoreFiles !== "boolean") {
        throw new HttpError(400, "invalid_body", "restoreFiles must be a boolean.");
      }
      const target = session.messages.find((message) => message.id === body.messageId);
      if (!target) throw new HttpError(404, "message_not_found", "Unknown message.");
      if (target.role !== "user") {
        throw new HttpError(400, "invalid_rewind_target", "Only user messages can be a rewind target.");
      }

      const { removed, messages } = session.rewind(body.messageId);
      let restored: CheckpointInfo | null = null;
      let safety: CheckpointInfo | null = null;
      let warning: string | undefined;
      if (body.restoreFiles !== false) {
        const checkpoints = await runtime.checkpoints.list(session.workspace);
        const checkpoint = checkpoints
          .filter(
            (item) => item.messageId === body.messageId && (!item.sessionId || item.sessionId === session.id),
          )
          .at(-1);
        if (checkpoint) {
          try {
            const result = await runtime.checkpoints.restore(session.workspace, checkpoint.id);
            restored = result.restored;
            safety = result.safety;
          } catch (error) {
            warning = `The transcript was rewound, but files were not restored: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        } else {
          warning = "No checkpoint is linked to this message; the workspace was left unchanged.";
        }
      }
      json(res, 200, { messageId: body.messageId, removed, messages, restored, safety, warning });
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
    if (action === "resume" && method === "POST") {
      if (session.isRunning) throw new HttpError(409, "session_busy", "This session already has an active run.");
      if (session.status !== "interrupted" && session.status !== "error") {
        throw new HttpError(409, "not_resumable", "Only interrupted or failed sessions can be resumed.");
      }
      const lastUserMessage = session.messages.filter((message) => message.role === "user").at(-1);
      await snapshotBeforeRun(runtime, session, "Resume interrupted run", lastUserMessage?.id);
      const { runId, done } = session.resume();
      done.catch((error: unknown) => {
        runtime.logger.error("run rejected", { sessionId: id, runId, error: String(error) });
      });
      json(res, 202, { runId });
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

  if (pluginRoute) {
    await dispatchPluginRoute(runtime, req, res, url, pluginRoute, principal);
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

/**
 * Streams asset fingerprints to console clients. The `ready` frame carries the
 * current state so a late joiner does not reload every bundle; later frames
 * carry one changed plugin at a time. With hot reload off the stream is still
 * valid and simply never emits, which keeps clients from special-casing it.
 */
function streamPluginAssets(runtime: Runtime, req: IncomingMessage, res: ServerResponse): void {
  const watcher = runtime.pluginAssets;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 3000\n\n");
  res.write(
    `event: ready\ndata: ${JSON.stringify({
      enabled: Boolean(watcher),
      plugins: watcher?.snapshot() ?? [],
    })}\n\n`,
  );

  let closed = false;
  const unsubscribe = watcher?.subscribe((change) => {
    if (closed) return;
    const event: PluginChangeEvent = {
      type: "plugins.changed",
      plugins: [change],
      at: new Date().toISOString(),
    };
    res.write(`event: plugins.changed\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, 15_000);
  heartbeat.unref?.();

  const cleanup = (): void => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe?.();
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
}

/** Adds `web.revision` to plugin descriptors when the watcher is running. */
function withAssetRevisions(runtime: Runtime, plugins: PluginInfo[]): PluginInfo[] {
  const watcher = runtime.pluginAssets;
  if (!watcher) return plugins;
  return plugins.map((plugin) => {
    const revision = plugin.web ? watcher.revisionFor(plugin.id) : undefined;
    return revision && plugin.web ? { ...plugin, web: { ...plugin.web, revision } } : plugin;
  });
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
  if (url.pathname === "/plugin-sandbox.html") {
    servePluginSandbox(res, url);
    return;
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
            "default-src 'self'; connect-src *; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-src *",
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
 * Host document for plugin iframes. `sandbox="allow-scripts"` gives it an
 * opaque origin, so plugin code cannot read the console's localStorage or
 * cookies; every API call is proxied through the parent. The CSP restricts
 * the sandbox to its own bundle and styles, with no direct network access.
 */
function servePluginSandbox(res: ServerResponse, url: URL): void {
  res.removeHeader("x-frame-options");
  res.removeHeader("cross-origin-opener-policy");
  // Behind a TLS terminator the request URL may still be http while the browser
  // framed an https copy; allow both schemes on this host, nothing broader.
  const alternate = url.protocol === "https:" ? "http:" : "https:";
  const origin = `${url.origin} ${alternate}//${url.host}`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Kestrel plugin</title>
<style>html,body{margin:0;padding:0;background:transparent;color:var(--text,inherit);font-family:var(--sans,system-ui,sans-serif);font-size:13px}body{overflow:hidden}.kestrel-extension{display:block}</style>
</head>
<body>
<script type="module">
const parentWindow = window.parent;
const pending = new Map();
let sequence = 0;

const post = (message) => parentWindow.postMessage(message, "*");

function applyTheme(vars) {
  for (const [name, value] of Object.entries(vars ?? {})) {
    document.documentElement.style.setProperty(name, value);
  }
}

function request(path, init = {}) {
  const id = ++sequence;
  const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers) : init.headers;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({
      type: "kestrel:request",
      id,
      path,
      init: {
        method: init.method,
        headers: headers ?? undefined,
        body: typeof init.body === "string" ? init.body : undefined,
      },
    });
  });
}

function reportHeight() {
  post({ type: "kestrel:height", height: Math.ceil(document.body.getBoundingClientRect().height) });
}

function observeHeight() {
  new ResizeObserver(reportHeight).observe(document.body);
  reportHeight();
}

async function loadStyles(hrefs) {
  await Promise.all(
    (hrefs ?? []).map(
      (href) =>
        new Promise((resolve) => {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = href;
          link.onload = resolve;
          link.onerror = resolve;
          document.head.append(link);
        }),
    ),
  );
}

async function start(data) {
  applyTheme(data.theme);
  await loadStyles(data.css);

  const module = await import(data.entry);
  const activate = module.default;
  if (typeof activate !== "function") {
    throw new Error("The bundle must export default (api) => void.");
  }

  const context = {
    plugin: data.plugin,
    endpoint: data.endpoint,
    sessionId: data.sessionId,
    payload: data.payload ?? {},
    message: data.payload?.message,
    file: data.payload?.file,
    request,
    ...(data.slot === "composer.actions" && data.composer === true
      ? {
          composer: {
            submit(text) {
              if (typeof text === "string" && text.trim()) {
                post({ type: "kestrel:composer", op: "submit", text });
              }
            },
          },
        }
      : {}),
  };
  const registered = [];
  let mounted = false;

  await activate({
    context,
    register(extension) {
      if (!extension || typeof extension.mount !== "function" || !extension.id || !extension.slot) return;
      if (data.mode === "discover") {
        registered.push({
          id: extension.id,
          slot: extension.slot,
          order: extension.order,
          match: extension.match,
        });
        return;
      }
      if (extension.id !== data.extensionId || extension.slot !== data.slot) return;
      mounted = true;
      const element = document.createElement("div");
      element.className = "kestrel-extension";
      element.dataset.extension = extension.id;
      document.body.append(element);
      const cleanup = extension.mount(element, context);
      if (typeof cleanup === "function") window.addEventListener("pagehide", cleanup, { once: true });
    },
  });

  if (data.mode === "discover") {
    post({ type: "kestrel:registered", extensions: registered });
    return;
  }
  if (!mounted) {
    throw new Error('No extension "' + data.extensionId + '" for slot "' + data.slot + '".');
  }
  post({ type: "kestrel:mounted" });
  observeHeight();
}

window.addEventListener("message", (event) => {
  if (event.source !== parentWindow) return;
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "kestrel:init") {
    start(data).catch((error) =>
      post({ type: "kestrel:error", message: error instanceof Error ? error.message : String(error) }),
    );
  } else if (data.type === "kestrel:theme") {
    applyTheme(data.vars);
    reportHeight();
  } else if (data.type === "kestrel:response") {
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) entry.resolve(data.data);
    else entry.reject(new Error(typeof data.error === "string" ? data.error : "Request failed."));
  }
});

window.addEventListener("error", (event) => post({ type: "kestrel:error", message: String(event.message) }));
window.addEventListener("unhandledrejection", (event) =>
  post({ type: "kestrel:error", message: String(event.reason?.message ?? event.reason) }),
);

post({ type: "kestrel:ready" });
</script>
</body>
</html>`;
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": [
      "default-src 'none'",
      `script-src 'unsafe-inline' ${origin}`,
      `style-src 'unsafe-inline' ${origin}`,
      `img-src data: blob: ${origin}`,
      `font-src data: ${origin}`,
      "connect-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; "),
  });
  res.end(html);
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
/** Validates attachments and drops any `data:` prefix so storage stays plain base64. */
function normalizeImages(input: unknown): ImageAttachment[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new HttpError(400, "invalid_images", "images must be an array.");
  if (input.length > MAX_IMAGES) {
    throw new HttpError(413, "too_many_images", `Attach at most ${MAX_IMAGES} images per message.`);
  }
  let total = 0;
  return input.map((value, index) => {
    if (!value || typeof value !== "object") {
      throw new HttpError(400, "invalid_images", `images[${index}] must be an object.`);
    }
    const { mimeType, data, name } = value as Record<string, unknown>;
    if (typeof mimeType !== "string" || !IMAGE_MIME.has(mimeType)) {
      throw new HttpError(400, "invalid_images", `images[${index}].mimeType must be one of ${[...IMAGE_MIME].join(", ")}.`);
    }
    if (typeof data !== "string") {
      throw new HttpError(400, "invalid_images", `images[${index}].data must be base64 text.`);
    }
    const base64 = data.replace(/^data:[^;,]+;base64,/, "");
    if (!base64.length || base64.length % 4 !== 0 || !BASE64.test(base64)) {
      throw new HttpError(400, "invalid_images", `images[${index}].data is not valid base64.`);
    }
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    const bytes = (base64.length / 4) * 3 - padding;
    if (bytes > MAX_IMAGE_BYTES) {
      throw new HttpError(413, "image_too_large", `images[${index}] exceeds ${MAX_IMAGE_BYTES} bytes.`);
    }
    total += bytes;
    if (total > MAX_TOTAL_IMAGE_BYTES) {
      throw new HttpError(413, "images_too_large", `Attachments exceed ${MAX_TOTAL_IMAGE_BYTES} bytes in total.`);
    }
    const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : undefined;
    return label ? { mimeType, data: base64, name: label } : { mimeType, data: base64 };
  });
}

async function snapshotBeforeRun(
  runtime: Runtime,
  session: AgentSession,
  content: string,
  messageId?: string,
): Promise<void> {
  if (session.parentId) return;
  const label = content.trim().replace(/\s+/g, " ").slice(0, 72);
  try {
    await runtime.checkpoints.snapshot(session.workspace, {
      sessionId: session.id,
      messageId,
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

async function dispatchPluginRoute(
  runtime: Runtime,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  match: PluginRouteMatch,
  principal?: Principal,
): Promise<void> {
  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : await readJson<unknown>(req, runtime);
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) headers[key] = value;
  const request: PluginHttpRequest = {
    method,
    path: url.pathname,
    params: match.params,
    query: Object.fromEntries(url.searchParams),
    headers,
    body,
    principal: principal
      ? {
          id: principal.id,
          name: principal.name,
          role: principal.role,
          tenantId: principal.tenantId,
          email: principal.email,
        }
      : undefined,
  };

  let result;
  try {
    result = await match.route.handler(request);
  } catch (error) {
    throw new HttpError(
      500,
      "plugin_route_failed",
      `Plugin route ${method} ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const status = result?.status ?? 200;
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new HttpError(500, "plugin_route_failed", `Plugin route returned an invalid status ${status}.`);
  }
  for (const [key, value] of Object.entries(result?.headers ?? {})) res.setHeader(key, value);
  if (typeof result?.raw === "string") {
    res.writeHead(status, {
      "content-type": result.headers?.["content-type"] ?? "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(result.raw),
    });
    res.end(result.raw);
    return;
  }
  json(res, status, result?.body ?? { ok: true });
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
        : isSessionGuardError(error)
          ? 429
          : isRewindError(error)
            ? error.code === "message_not_found"
              ? 404
              : error.code === "session_busy"
                ? 409
                : 400
            : error instanceof CheckpointError || error instanceof WorkspaceFilesError
              ? error.status
              : 500;
  const code =
    error instanceof HttpError
      ? error.code
      : error instanceof SessionNotFoundError
        ? "session_not_found"
        : isSessionGuardError(error)
          ? error.code
          : isRewindError(error)
            ? error.code
            : error instanceof CheckpointError || error instanceof WorkspaceFilesError
              ? error.code
              : "internal_error";
  const message =
    error instanceof HttpError ||
    error instanceof SessionNotFoundError ||
    isSessionGuardError(error) ||
    isRewindError(error) ||
    error instanceof CheckpointError || error instanceof WorkspaceFilesError
      ? error.message
      : "The server hit an unexpected error. Check the server logs for details.";
  if (isSessionGuardError(error) && error.retryAfterSeconds) {
    res.setHeader("retry-after", String(error.retryAfterSeconds));
  }
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
