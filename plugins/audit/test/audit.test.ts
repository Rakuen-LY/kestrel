import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRegistry, SessionManager, ToolRegistry } from "@kestrel/agent";
import { createContext, silencedLogger, type Context } from "@kestrel/kernel";
import type { PluginHttpRequest, PluginHttpResult } from "@kestrel/protocol";
import { PluginHttpRouter } from "../../../apps/server/src/plugin-http.js";
import { ScriptedModel, echoTool } from "../../../packages/testkit/src/index.js";
import auditPlugin, { AuditLog, type AuditPage, type StorageService } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function harness(config: Parameters<typeof auditPlugin.apply>[1] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-audit-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const models = new ModelRegistry();
  models.register(
    new ScriptedModel([
      { toolCalls: [{ name: "echo", arguments: { text: "top-secret-value" } }] },
      { content: "done" },
    ]),
    { setDefault: true },
  );
  const tools = new ToolRegistry();
  tools.register(echoTool());
  const sessions = new SessionManager({
    models,
    tools,
    logger: silencedLogger(),
    defaultWorkspace: directory,
  });
  const context = createContext({ logger: silencedLogger() });
  const router = new PluginHttpRouter();
  context.provide("sessions", sessions);
  context.provide("http.routes", router);
  const storage: StorageService = {
    directory,
    resolve: (...parts) => join(directory, ...parts),
  };
  context.provide("storage", storage);
  auditPlugin.apply(context as Context, config);
  cleanups.push(async () => context.dispose());
  return { context, router, sessions, directory };
}

async function readAudit(
  router: PluginHttpRouter,
  query: Record<string, string> = {},
  role: "admin" | "member" = "admin",
): Promise<{ status: number; page: AuditPage & { error?: string } }> {
  const match = router.match("GET", "/api/audit");
  expect(match).toBeDefined();
  const request: PluginHttpRequest = {
    method: "GET",
    path: "/api/audit",
    params: {},
    query,
    headers: {},
    principal: { id: "u1", name: "User", role, tenantId: "default" },
  };
  const result = (await match!.route.handler(request)) as PluginHttpResult;
  return { status: result.status ?? 200, page: result.body as AuditPage & { error?: string } };
}

describe("audit plugin", () => {
  it("records tool and run events without storing arguments", async () => {
    const { router, sessions, directory } = await harness();
    const session = sessions.create({ title: "Audited" });
    await session.start("do the thing").done;

    const { status, page } = await readAudit(router);
    expect(status).toBe(200);
    const tools = page.entries.filter((entry) => entry.kind === "tool");
    expect(tools.map((entry) => entry.phase)).toEqual(["started", "finished"]);
    expect(tools[0]).toMatchObject({ tool: "echo", sessionId: session.id });
    expect(tools[0].argsHash).toMatch(/^[0-9a-f]{16}$/);
    expect(tools[1]).toMatchObject({ tool: "echo", ok: true });
    expect(typeof tools[1].durationMs).toBe("number");
    expect(page.entries.at(-1)).toMatchObject({ kind: "run", status: "completed" });
    expect(page.entries.at(-1)?.usage?.totalTokens).toBe(30);

    const raw = await readFile(join(directory, "audit", "audit.jsonl"), "utf8");
    expect(raw).not.toContain("top-secret-value");
  });

  it("filters by kind and enforces the limit", async () => {
    const { router, sessions } = await harness();
    await sessions.create({ title: "One" }).start("go").done;

    const tools = await readAudit(router, { kind: "tool", limit: "1" });
    expect(tools.page.total).toBe(2);
    expect(tools.page.entries).toHaveLength(1);

    const runs = await readAudit(router, { kind: "run" });
    expect(runs.page.entries).toHaveLength(1);
  });

  it("is available to administrators only", async () => {
    const { router } = await harness();
    const { status, page } = await readAudit(router, {}, "member");
    expect(status).toBe(403);
    expect(page.error).toMatch(/administrators/);
  });

  it("rotates oversized logs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kestrel-audit-rotate-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const log = new AuditLog(directory, { maxBytes: 200, maxFiles: 2 });
    for (let index = 0; index < 10; index += 1) {
      log.append({
        at: new Date().toISOString(),
        kind: "run",
        phase: "finished",
        sessionId: `session-${index}`,
      });
    }
    await log.read();
    expect((await stat(join(directory, "audit.jsonl.1"))).size).toBeGreaterThan(0);
    const page = await log.read({ limit: 10 });
    expect(page.entries.length).toBeLessThan(10);
  });
});
