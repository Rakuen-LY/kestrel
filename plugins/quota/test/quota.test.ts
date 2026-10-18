import { afterEach, describe, expect, it } from "vitest";
import { ModelRegistry, SessionGuardError, SessionManager, ToolRegistry } from "@kestrel/agent";
import { createContext, silencedLogger } from "@kestrel/kernel";
import type { PluginHttpRequest, PluginHttpResult } from "@kestrel/protocol";
import { PluginHttpRouter } from "../../../apps/server/src/plugin-http.js";
import { ScriptedModel, echoTool } from "../../../packages/testkit/src/index.js";
import quotaPlugin, { type QuotaConfig, type QuotaService } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function harness(config: QuotaConfig) {
  const models = new ModelRegistry();
  models.register(new ScriptedModel([{ content: "ok" }]), { setDefault: true });
  const tools = new ToolRegistry();
  tools.register(echoTool());
  const sessions = new SessionManager({
    models,
    tools,
    logger: silencedLogger(),
    defaultWorkspace: process.cwd(),
  });
  const context = createContext({ logger: silencedLogger() });
  const router = new PluginHttpRouter();
  context.provide("sessions", sessions);
  context.provide("http.routes", router);
  quotaPlugin.apply(context, config);
  cleanups.push(async () => context.dispose());
  return { sessions, context, router };
}

async function quotas(
  router: PluginHttpRouter,
  role: "admin" | "member" = "admin",
): Promise<PluginHttpResult> {
  const match = router.match("GET", "/api/quotas");
  expect(match).toBeDefined();
  const request: PluginHttpRequest = {
    method: "GET",
    path: "/api/quotas",
    params: {},
    query: {},
    headers: {},
    principal: { id: "u1", name: "User", role, tenantId: "default" },
  };
  return (await match!.route.handler(request)) as PluginHttpResult;
}

describe("quota plugin", () => {
  it("rejects a session once maxSessions is reached", () => {
    const { sessions } = harness({ default: { maxSessions: 2 } });
    sessions.create({ title: "one" }, "acme");
    sessions.create({ title: "two" }, "acme");
    expect(() => sessions.create({ title: "three" }, "acme")).toThrow(SessionGuardError);
    expect(() => sessions.create({ title: "three" }, "acme")).toThrow(/limit of 2 session/);
    // Other tenants keep their own budget.
    expect(sessions.create({ title: "other" }, "beta")).toBeDefined();
  });

  it("applies per-tenant overrides instead of the default", () => {
    const { sessions, context } = harness({
      default: { maxSessions: 1 },
      tenants: { vip: { maxSessions: 5 } },
    });
    sessions.create({}, "vip");
    sessions.create({}, "vip");
    const service: QuotaService = context.get("quotas");
    expect(service.limits("vip").maxSessions).toBe(5);
    expect(service.limits("beta").maxSessions).toBe(1);
    expect(() => sessions.create({}, "beta")).not.toThrow();
    expect(() => sessions.create({}, "beta")).toThrow(SessionGuardError);
  });

  it("rejects a run while the concurrency limit is saturated", async () => {
    const { sessions, context } = harness({ default: { maxConcurrentRuns: 1 } });
    const first = sessions.create({}, "acme");
    const second = sessions.create({}, "acme");
    const run = first.start("work");
    expect(() => second.start("work")).toThrow(/the limit is 1/);
    await run.done;
    const service: QuotaService = context.get("quotas");
    expect(service.usage("acme").running).toBe(0);
    // Releasing the slot lets the next run through.
    await second.start("work").done;
  });

  it("rejects a run once the token budget is spent", async () => {
    const { sessions } = harness({ default: { maxTokens: 1 } });
    const session = sessions.create({}, "acme");
    await session.start("first").done;
    expect(() => session.start("second")).toThrow(/token budget/);
  });

  it("keeps the transcript untouched when a run is rejected", () => {
    const { sessions } = harness({ default: { maxConcurrentRuns: 1 } });
    const first = sessions.create({}, "acme");
    const second = sessions.create({}, "acme");
    void first.start("long task");
    const before = second.summary().messageCount;
    expect(() => second.start("rejected")).toThrow(SessionGuardError);
    expect(second.summary().messageCount).toBe(before);
  });

  it("reports usage and limits to administrators only", async () => {
    const { sessions, router } = harness({
      default: { maxSessions: 10, maxConcurrentRuns: 2 },
      tenants: { beta: { maxSessions: 1 } },
    });
    sessions.create({}, "acme");
    sessions.create({}, "beta");

    const denied = await quotas(router, "member");
    expect(denied.status).toBe(403);

    const result = await quotas(router);
    expect(result.status).toBe(200);
    const tenants = (result.body as { tenants: Array<{ tenantId: string; sessions: number; limits: { maxSessions?: number } }> })
      .tenants;
    const acme = tenants.find((tenant) => tenant.tenantId === "acme");
    expect(acme?.sessions).toBe(1);
    expect(acme?.limits.maxSessions).toBe(10);
    expect(tenants.find((tenant) => tenant.tenantId === "beta")?.limits.maxSessions).toBe(1);
  });

  it("rejects invalid configuration at load time", () => {
    expect(() => harness({ default: { maxSessions: -1 } })).toThrow(/non-negative integer/);
  });

  it("enforces limits on subagents too, because their runs go through the guard", async () => {
    const { sessions } = harness({ default: { maxConcurrentRuns: 1 } });
    const parent = sessions.create({}, "acme");
    const child = sessions.createSubagent(parent, { role: "researcher" });
    const run = parent.start("work");
    expect(() => child.start("nested")).toThrow(SessionGuardError);
    await run.done;
  });
});
