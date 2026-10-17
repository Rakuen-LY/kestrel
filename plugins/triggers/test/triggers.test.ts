import { afterEach, describe, expect, it, vi } from "vitest";
import { createContext, silencedLogger, type Context } from "@kestrel/kernel";
import { ModelRegistry, SessionManager, ToolRegistry } from "@kestrel/agent";
import { ScriptedModel } from "../../../packages/testkit/src/index.js";
import { PluginHttpRouter } from "../../../apps/server/src/plugin-http.js";
import triggersPlugin, {
  cronMatches,
  parseCron,
  renderTemplate,
} from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  vi.useRealTimers();
});

function harness(): { context: Context; router: PluginHttpRouter; sessions: SessionManager; model: ScriptedModel } {
  const model = new ScriptedModel([{ content: "done" }]);
  const models = new ModelRegistry();
  models.register(model, { setDefault: true });
  const sessions = new SessionManager({
    models,
    tools: new ToolRegistry(),
    logger: silencedLogger(),
    defaultWorkspace: process.cwd(),
  });
  const context = createContext({ logger: silencedLogger() });
  const router = new PluginHttpRouter();
  context.provide("sessions", sessions);
  context.provide("http.routes", router);
  cleanups.push(async () => context.dispose());
  return { context, router, sessions, model };
}

async function startHook(
  router: PluginHttpRouter,
  id: string,
  headers: Record<string, string>,
  body: unknown,
) {
  const match = router.match("POST", `/api/hooks/${id}`);
  expect(match).toBeDefined();
  return match!.route.handler({
    method: "POST",
    path: `/api/hooks/${id}`,
    params: {},
    query: {},
    headers,
    body,
  });
}

describe("cron expressions", () => {
  it("parses lists, ranges and steps", () => {
    const schedule = parseCron("*/15 9-10 * * 1-5");
    expect([...schedule.minutes].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...schedule.hours].sort((a, b) => a - b)).toEqual([9, 10]);
    expect([...schedule.daysOfWeek].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("matches in UTC and treats 7 as Sunday", () => {
    const weekdays = parseCron("30 9 * * 1-5");
    expect(cronMatches(weekdays, new Date("2026-10-19T09:30:00Z"))).toBe(true);
    expect(cronMatches(weekdays, new Date("2026-10-18T09:30:00Z"))).toBe(false);

    const sunday = parseCron("0 0 * * 7");
    expect(cronMatches(sunday, new Date("2026-10-18T00:00:00Z"))).toBe(true);
  });

  it("uses OR semantics when day-of-month and day-of-week are restricted", () => {
    const schedule = parseCron("0 0 1 * 0");
    expect(cronMatches(schedule, new Date("2026-11-01T00:00:00Z"))).toBe(true);
    expect(cronMatches(schedule, new Date("2026-10-18T00:00:00Z"))).toBe(true);
    expect(cronMatches(schedule, new Date("2026-10-19T00:00:00Z"))).toBe(false);
  });

  it("rejects malformed expressions", () => {
    expect(() => parseCron("60 * * * *")).toThrow(/Invalid cron field/);
    expect(() => parseCron("* * * *")).toThrow(/five fields/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/Invalid cron field/);
  });
});

describe("templates", () => {
  it("substitutes known values and leaves unknown placeholders alone", () => {
    expect(renderTemplate("deploy {{id}}: {{payload}} {{missing}}", { id: "api", payload: "{}" })).toBe(
      "deploy api: {} {{missing}}",
    );
  });
});

describe("webhooks", () => {
  it("starts a run with the rendered payload", async () => {
    const { context, router, sessions, model } = harness();
    process.env.KESTREL_TEST_HOOK_SECRET = "s3cret";
    await triggersPlugin.apply(context, {
      webhooks: { build: { prompt: "Build {{payload}} for {{id}}", secret: "${KESTREL_TEST_HOOK_SECRET}" } },
    });

    const result = await startHook(router, "build", { "x-kestrel-hook-secret": "s3cret" }, { ref: "main" });
    expect(result?.status).toBe(202);
    const body = result?.body as { sessionId: string; runId: string; hook: string };
    expect(body.hook).toBe("build");
    expect(body.runId).toBeTruthy();

    await waitFor(() => sessions.get(body.sessionId).messages.some((message) => message.role === "assistant"));
    const prompt = String(model.requests[0].messages.at(-1)?.content);
    expect(prompt).toContain('{"ref":"main"}');
    expect(prompt).toContain("for build");
  });

  it("rejects a wrong or missing secret without creating a session", async () => {
    const { context, router, sessions } = harness();
    await triggersPlugin.apply(context, {
      webhooks: { build: { prompt: "Build", secret: "s3cret" } },
    });

    const missing = await startHook(router, "build", {}, {});
    expect(missing?.status).toBe(401);
    const wrong = await startHook(router, "build", { "x-kestrel-hook-secret": "nope" }, {});
    expect(wrong?.status).toBe(401);
    expect(sessions.list()).toHaveLength(0);
  });

  it("refuses to expose a public hook without a secret", async () => {
    const { context, router } = harness();
    await triggersPlugin.apply(context, {
      webhooks: { open: { prompt: "Run", public: true } },
    });
    expect(router.match("POST", "/api/hooks/open")).toBeUndefined();
  });

  it("registers public routes so the server can skip its auth check", async () => {
    const { context, router } = harness();
    await triggersPlugin.apply(context, {
      webhooks: { open: { prompt: "Run", public: true, secret: "s3cret" } },
    });
    const match = router.match("POST", "/api/hooks/open");
    expect(match?.route.public).toBe(true);
    expect(router.list().map((route) => route.path)).toEqual(["/api/hooks/open"]);
  });
});

describe("schedules", () => {
  it("fires once per matching minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T09:29:50Z"));
    const { context, sessions } = harness();
    await triggersPlugin.apply(context, {
      tickMs: 1_000,
      schedules: [{ id: "every-minute", cron: "* * * * *", prompt: "Tick {{id}} at {{date}}" }],
    });

    await vi.advanceTimersByTimeAsync(15_000);
    const summaries = sessions.list();
    expect(summaries).toHaveLength(1);
    const session = sessions.get(summaries[0].id);
    await vi.advanceTimersByTimeAsync(0);
    expect(String(session.messages[0].content)).toBe("Tick every-minute at 2026-10-19T09:30:00.000Z");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sessions.list()).toHaveLength(1);
  });

  it("skips invalid cron expressions instead of failing the plugin", async () => {
    const { context } = harness();
    expect(() =>
      triggersPlugin.apply(context, {
        schedules: [{ id: "broken", cron: "every day", prompt: "no" }],
      }),
    ).not.toThrow();
  });
});

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
