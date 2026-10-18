import { afterEach, describe, expect, it } from "vitest";
import { ModelRegistry, SessionManager, ToolRegistry } from "@kestrel/agent";
import { createContext, silencedLogger } from "@kestrel/kernel";
import type { PluginHttpRequest, PluginHttpResult } from "@kestrel/protocol";
import { PluginHttpRouter } from "../../../apps/server/src/plugin-http.js";
import { ScriptedModel, echoTool } from "../../../packages/testkit/src/index.js";
import metricsPlugin, { MetricRegistry, type MetricsService } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function harness(config: { prefix?: string; maxSeriesPerMetric?: number } = {}) {
  const models = new ModelRegistry();
  models.register(
    new ScriptedModel([
      { toolCalls: [{ name: "echo", arguments: { text: "hi" } }] },
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
    defaultWorkspace: process.cwd(),
  });
  const context = createContext({ logger: silencedLogger() });
  const router = new PluginHttpRouter();
  context.provide("sessions", sessions);
  context.provide("http.routes", router);
  metricsPlugin.apply(context, config);
  cleanups.push(async () => context.dispose());
  return { context, router, sessions };
}

async function call(
  router: PluginHttpRouter,
  path: string,
  role: "admin" | "member" = "admin",
): Promise<{ status: number; result: PluginHttpResult }> {
  const match = router.match("GET", path);
  expect(match).toBeDefined();
  const request: PluginHttpRequest = {
    method: "GET",
    path,
    params: {},
    query: {},
    headers: {},
    principal: { id: "u1", name: "User", role, tenantId: "default" },
  };
  const result = (await match!.route.handler(request)) as PluginHttpResult;
  return { status: result.status ?? 200, result };
}

interface JsonMetrics {
  metrics: Array<{ name: string; kind: string; samples: Array<{ labels: Record<string, string>; value: number }> }>;
}

function find(metrics: JsonMetrics["metrics"], name: string) {
  return metrics.find((metric) => metric.name === name);
}

describe("MetricRegistry", () => {
  it("accumulates counters, formats labels deterministically and escapes values", () => {
    const registry = new MetricRegistry({ prefix: "test" });
    registry.increment("requests_total", { help: "Requests.", labels: { b: 2, a: "one" } });
    registry.increment("requests_total", { labels: { a: "one", b: 2 }, by: 4 });
    registry.gauge("temperature", 21.5, { labels: { room: 'say "hi"' } });

    const text = registry.render();
    expect(text).toContain("# HELP test_requests_total Requests.");
    expect(text).toContain("# TYPE test_requests_total counter");
    expect(text).toContain('test_requests_total{a="one",b="2"} 5');
    expect(text).toContain('test_temperature{room="say \\"hi\\""} 21.5');
  });

  it("folds repeated observations into sum and count", () => {
    const registry = new MetricRegistry({ prefix: "" });
    registry.observe("latency_seconds", 0.5);
    registry.observe("latency_seconds", 1.5);
    const summary = registry.snapshot().find((metric) => metric.name === "latency_seconds");
    expect(summary?.kind).toBe("summary");
    const sum = summary?.samples.find((sample) => sample.labels.__part === "sum");
    const count = summary?.samples.find((sample) => sample.labels.__part === "count");
    expect(sum?.value).toBe(2);
    expect(count?.value).toBe(2);
    expect(registry.render()).toContain("latency_seconds_sum 2");
    expect(registry.render()).toContain("latency_seconds_count 2");
  });

  it("drops excess label sets and reports the drop count", () => {
    const registry = new MetricRegistry({ prefix: "capped", maxSeriesPerMetric: 2 });
    for (let index = 0; index < 5; index += 1) {
      registry.increment("events_total", { labels: { id: index } });
    }
    const events = registry.snapshot().find((metric) => metric.name === "capped_events_total");
    expect(events?.samples).toHaveLength(2);
    const dropped = registry.snapshot().find((metric) => metric.name === "capped_metrics_series_dropped_total");
    expect(dropped?.samples[0].value).toBe(3);
  });

  it("rejects a type change for an existing name", () => {
    const registry = new MetricRegistry({ prefix: "" });
    registry.increment("mixed");
    expect(() => registry.gauge("mixed", 1)).toThrow(/already registered/);
  });
});

describe("metrics plugin", () => {
  it("counts runs, tools and tokens from session events", async () => {
    const { router, sessions } = harness();
    const session = sessions.create({ title: "Measured" });
    await session.start("go").done;
    const expected = session.summary().usage;

    const { result } = await call(router, "/api/metrics");
    const payload = result.body as JsonMetrics;
    const tools = find(payload.metrics, "kestrel_tool_calls_total");
    expect(tools?.samples).toEqual([{ labels: { ok: "true", tool: "echo" }, value: 1 }]);
    const runs = find(payload.metrics, "kestrel_runs_finished_total");
    expect(runs?.samples).toEqual([{ labels: { status: "completed" }, value: 1 }]);
    const tokens = find(payload.metrics, "kestrel_tokens_total");
    expect(tokens?.samples).toEqual([
      { labels: { kind: "input" }, value: expected?.inputTokens },
      { labels: { kind: "output" }, value: expected?.outputTokens },
    ]);
    const duration = find(payload.metrics, "kestrel_run_duration_seconds");
    expect(duration?.kind).toBe("summary");
    const count = duration?.samples.find((sample) => sample.labels.__part === "count");
    expect(count?.value).toBe(1);
  });

  it("renders Prometheus text with scrape-time gauges", async () => {
    const { router, sessions } = harness({ prefix: "k" });
    await sessions.create({ title: "Idle" });

    const { result } = await call(router, "/api/metrics/prometheus");
    expect(result.headers?.["content-type"]).toMatch(/text\/plain/);
    expect(result.raw).toContain("# TYPE k_info gauge");
    expect(result.raw).toContain('k_sessions{status="idle"} 1');
    expect(result.raw).toMatch(/k_uptime_seconds \d/);
    expect(result.raw?.endsWith("\n")).toBe(true);
  });

  it("shares one registry with other plugins through the metrics service", async () => {
    const { context, router } = harness();
    const metrics: MetricsService = context.get("metrics");
    metrics.increment("webhooks_total", { help: "Webhook deliveries." });
    const { result } = await call(router, "/api/metrics");
    const payload = result.body as JsonMetrics;
    expect(find(payload.metrics, "kestrel_webhooks_total")?.samples).toEqual([
      { labels: {}, value: 1 },
    ]);
  });

  it("is available to administrators only", async () => {
    const { router } = harness();
    const json = await call(router, "/api/metrics", "member");
    expect(json.status).toBe(403);
    const prometheus = await call(router, "/api/metrics/prometheus", "member");
    expect(prometheus.status).toBe(403);
  });

  it("ignores collectors that throw", async () => {
    const { context, router } = harness();
    const metrics: MetricsService = context.get("metrics");
    metrics.collect("broken", {
      help: "Always fails.",
      value: () => {
        throw new Error("boom");
      },
    });
    const { status, result } = await call(router, "/api/metrics");
    expect(status).toBe(200);
    const payload = result.body as JsonMetrics;
    expect(find(payload.metrics, "kestrel_broken")).toBeUndefined();
  });
});
