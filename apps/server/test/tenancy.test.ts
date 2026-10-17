import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ScriptedModel } from "@kestrel/testkit";
import { createHttpServer } from "../src/http.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

beforeAll(() => {
  process.env.KESTREL_LOG_LEVEL ??= "silent";
});

const ADMIN = "kst_bootstrap_admin_token_000000000000";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

interface Harness {
  base: string;
  runtime: Runtime;
  root: string;
  close(): Promise<void>;
}

async function boot(root?: string): Promise<Harness> {
  const directory = root ?? (await mkdtemp(join(tmpdir(), "kestrel-tenancy-")));
  const workspace = join(directory, "workspace");
  const plugins = join(directory, "plugins");
  await mkdir(workspace, { recursive: true });
  await mkdir(plugins, { recursive: true });

  const configPath = join(directory, "kestrel.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      server: { host: "127.0.0.1", port: 0 },
      auth: { mode: "accounts", bootstrapToken: ADMIN },
      model: { default: "scripted", maxSteps: 6 },
      agent: { workspace },
      plugins: { directories: [plugins] },
      storage: { directory: join(directory, "data") },
      approvals: { timeoutMs: 5_000 },
    }),
  );

  const runtime = await createRuntime({ configPath });
  runtime.models.register(new ScriptedModel([{ content: "ok" }]), { setDefault: true });

  const server: Server = createHttpServer(runtime);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.shutdown();
  };
  return { base, runtime, root: directory, close };
}

interface Reply<T = any> {
  status: number;
  body: T;
}

async function api<T = any>(
  harness: Harness,
  path: string,
  options: { token?: string; method?: string; body?: unknown } = {},
): Promise<Reply<T>> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${harness.base}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function workspaceSetup(harness: Harness) {
  const tenant = await api<{ tenant: { id: string } }>(harness, "/api/tenants", {
    token: ADMIN,
    method: "POST",
    body: { name: "Acme Corp" },
  });
  expect(tenant.status).toBe(201);
  const tenantId = tenant.body.tenant.id;

  const created = await api<{ user: { id: string; tokenHint: string }; token: string }>(
    harness,
    "/api/users",
    {
      token: ADMIN,
      method: "POST",
      body: { name: "Ada", role: "member", tenantId },
    },
  );
  expect(created.status).toBe(201);
  return { tenantId, member: created.body.user, memberToken: created.body.token };
}

async function createSession(harness: Harness, token: string, body: Record<string, unknown> = {}) {
  const reply = await api<{ session: Record<string, any> }>(harness, "/api/sessions", {
    token,
    method: "POST",
    body,
  });
  expect(reply.status).toBe(201);
  return reply.body.session;
}

describe("accounts mode", () => {
  it("rejects missing and invalid tokens, and reports the caller", async () => {
    const harness = await boot();
    cleanups.push(harness.close);

    expect((await api(harness, "/api/sessions")).status).toBe(401);
    expect((await api(harness, "/api/sessions", { token: "nope" })).status).toBe(401);

    const me = await api(harness, "/api/auth/me", { token: ADMIN });
    expect(me.status).toBe(200);
    expect(me.body.principal).toMatchObject({ name: "Admin", role: "admin", tenantId: "default" });
    expect(me.body.tenant).toMatchObject({ id: "default" });

    const health = await api(harness, "/api/health");
    expect(health.status).toBe(200);
  });

  it("scopes members to their tenant while admins see everything", async () => {
    const harness = await boot();
    cleanups.push(harness.close);
    const { tenantId, memberToken } = await workspaceSetup(harness);

    const root = await createSession(harness, ADMIN, { title: "Root work" });
    const scoped = await createSession(harness, memberToken, { title: "Tenant work" });

    expect(root.tenantId).toBeUndefined();
    expect(scoped.tenantId).toBe(tenantId);
    expect(scoped.workspace).toBe(join(harness.root, "data", "tenants", tenantId, "workspace"));

    const listedForMember = await api<{ sessions: Array<{ id: string }> }>(harness, "/api/sessions", {
      token: memberToken,
    });
    expect(listedForMember.body.sessions.map((session) => session.id)).toEqual([scoped.id]);

    const listedForAdmin = await api<{ sessions: Array<{ id: string }> }>(harness, "/api/sessions", {
      token: ADMIN,
    });
    expect(listedForAdmin.body.sessions.map((session) => session.id).sort()).toEqual(
      [root.id, scoped.id].sort(),
    );

    // Cross-tenant reads are reported as missing, not forbidden.
    expect((await api(harness, `/api/sessions/${root.id}`, { token: memberToken })).status).toBe(404);
    expect((await api(harness, `/api/sessions/${scoped.id}`, { token: ADMIN })).status).toBe(200);
    expect(
      (await api(harness, `/api/sessions/${root.id}`, { token: memberToken, method: "DELETE" })).status,
    ).toBe(404);
  });

  it("pins a member to the tenant workspace even when one is requested", async () => {
    const harness = await boot();
    cleanups.push(harness.close);
    const { tenantId, memberToken } = await workspaceSetup(harness);

    const session = await createSession(harness, memberToken, { workspace: "/tmp/elsewhere" });
    expect(session.workspace).toBe(join(harness.root, "data", "tenants", tenantId, "workspace"));
  });

  it("keeps user and tenant management admin-only", async () => {
    const harness = await boot();
    cleanups.push(harness.close);
    const { memberToken } = await workspaceSetup(harness);

    expect((await api(harness, "/api/users", { token: memberToken })).status).toBe(403);
    expect((await api(harness, "/api/tenants", { token: memberToken })).status).toBe(403);
    expect(
      (
        await api(harness, "/api/users", {
          token: memberToken,
          method: "POST",
          body: { name: "Mallory", role: "admin" },
        })
      ).status,
    ).toBe(403);

    const users = await api<{ users: Array<Record<string, unknown>> }>(harness, "/api/users", {
      token: ADMIN,
    });
    expect(users.body.users).toHaveLength(2);
    expect(JSON.stringify(users.body)).not.toContain("tokenHash");
    expect(users.body.users.find((user) => user.name === "Ada")).toMatchObject({ tenantId: expect.any(String) });
  });

  it("rotates tokens and refuses self-deletion", async () => {
    const harness = await boot();
    cleanups.push(harness.close);
    const { member, memberToken } = await workspaceSetup(harness);

    const rotated = await api<{ token: string }>(harness, `/api/users/${member.id}/token`, {
      token: ADMIN,
      method: "POST",
    });
    expect(rotated.status).toBe(200);
    expect((await api(harness, "/api/sessions", { token: memberToken })).status).toBe(401);
    expect((await api(harness, "/api/sessions", { token: rotated.body.token })).status).toBe(200);

    const me = await api<{ principal: { id: string } }>(harness, "/api/auth/me", { token: ADMIN });
    expect(
      (await api(harness, `/api/users/${me.body.principal.id}`, { token: ADMIN, method: "DELETE" })).status,
    ).toBe(409);
  });

  it("persists accounts, tenants and tenant sessions across a restart", async () => {
    const first = await boot();
    const { tenantId, memberToken } = await workspaceSetup(first);
    const session = await createSession(first, memberToken, { title: "Durable" });
    await first.close();

    const second = await boot(first.root);
    cleanups.push(second.close);

    expect((await api(second, "/api/sessions", { token: memberToken })).status).toBe(200);
    const detail = await api<{ session: Record<string, any> }>(second, `/api/sessions/${session.id}`, {
      token: memberToken,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.session).toMatchObject({ title: "Durable", tenantId });
    cleanups.push(() => rm(first.root, { recursive: true, force: true, maxRetries: 5 }));
  });

  it("does not stream another tenant's events", async () => {
    const harness = await boot();
    cleanups.push(harness.close);
    const { memberToken } = await workspaceSetup(harness);

    const events: Array<{ type?: string; sessionId?: string }> = [];
    const controller = new AbortController();
    cleanups.push(async () => controller.abort());

    const stream = await fetch(`${harness.base}/api/events`, {
      headers: { authorization: `Bearer ${memberToken}` },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    void (async () => {
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf("\n\n");
          while (index >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              const envelope = JSON.parse(line.slice(6)) as { event: { type?: string; sessionId?: string } };
              events.push(envelope.event);
            }
            index = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // Aborted by cleanup.
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 100));

    const foreign = await createSession(harness, ADMIN, { title: "Secret" });
    await api(harness, `/api/sessions/${foreign.id}/messages`, {
      token: ADMIN,
      method: "POST",
      body: { content: "work" },
    });
    await waitFor(() => events.some((event) => event.sessionId === foreign.id), 1_000).catch(() => undefined);

    const own = await createSession(harness, memberToken, { title: "Mine" });
    await api(harness, `/api/sessions/${own.id}/messages`, {
      token: memberToken,
      method: "POST",
      body: { content: "work" },
    });
    await waitFor(() => events.some((event) => event.sessionId === own.id), 5_000);

    expect(events.some((event) => event.sessionId === own.id)).toBe(true);
    expect(events.some((event) => event.sessionId === foreign.id)).toBe(false);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not met in time");
}
