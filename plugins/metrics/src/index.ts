import type { SessionManager } from "@kestrel/agent";
import type { Context } from "@kestrel/kernel";
import type { HttpRouteService, PluginHttpRequest, PluginHttpResult } from "@kestrel/protocol";

export type MetricKind = "counter" | "gauge" | "summary";

export interface MetricLabels {
  [key: string]: string | number | boolean;
}

export interface MetricOptions {
  help?: string;
  labels?: MetricLabels;
}

export interface ObserveOptions extends MetricOptions {
  by?: number;
}

export interface MetricSample {
  labels: Record<string, string>;
  value: number;
}

export interface CollectedMetric {
  name: string;
  kind: MetricKind;
  help?: string;
  samples: MetricSample[];
}

export interface CollectorSpec extends MetricOptions {
  /** Evaluated on every scrape. A number is a single unlabelled sample. */
  value: () => number | MetricSample[];
}

export interface MetricsService {
  increment(name: string, options?: ObserveOptions): void;
  gauge(name: string, value: number, options?: MetricOptions): void;
  observe(name: string, value: number, options?: MetricOptions): void;
  /** Registers a scrape-time collector. Returns a disposer. */
  collect(name: string, spec: CollectorSpec): () => void;
  snapshot(): CollectedMetric[];
  render(): string;
}

interface Series {
  labels: Record<string, string>;
  value: number;
}

interface Metric {
  kind: MetricKind;
  help?: string;
  series: Map<string, Series>;
}

export interface MetricsConfig {
  enabled?: boolean;
  /** Prepended to every metric name, with an underscore. Empty disables it. */
  prefix?: string;
  /** Cardinality guard per metric; further label sets are dropped and counted. */
  maxSeriesPerMetric?: number;
}

const NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const DEFAULT_PREFIX = "kestrel";

function labelKey(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(",");
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function stringifyLabels(labels: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (!NAME_PATTERN.test(key)) continue;
    result[key] = String(value);
  }
  return result;
}

/**
 * In-process metric registry. Memory only: a restart resets counters, which is
 * the expected contract for a scraper. Every plugin shares one registry through
 * the `metrics` service, so a plugin can publish its own numbers without
 * learning the exposition format.
 */
export class MetricRegistry implements MetricsService {
  private readonly metrics = new Map<string, Metric>();
  private readonly collectors = new Map<string, CollectorSpec>();
  private dropped = 0;

  constructor(
    private readonly options: {
      prefix?: string;
      maxSeriesPerMetric?: number;
      onError?: (name: string, error: unknown) => void;
    } = {},
  ) {}

  increment(name: string, options: ObserveOptions = {}): void {
    const metric = this.entry(name, "counter", options.help);
    this.add(metric, options.labels, options.by ?? 1);
  }

  gauge(name: string, value: number, options: MetricOptions = {}): void {
    const metric = this.entry(name, "gauge", options.help);
    const labels = stringifyLabels(options.labels ?? {});
    const key = labelKey(labels);
    if (!metric.series.has(key) && this.atCapacity(metric)) return;
    metric.series.set(key, { labels, value });
  }

  observe(name: string, value: number, options: MetricOptions = {}): void {
    const metric = this.entry(name, "summary", options.help);
    const labels = stringifyLabels(options.labels ?? {});
    const key = labelKey(labels);
    const sum = metric.series.get(`__sum__${key}`);
    if (sum) {
      sum.value += value;
      const count = metric.series.get(`__count__${key}`);
      if (count) count.value += 1;
      return;
    }
    const max = this.options.maxSeriesPerMetric ?? 200;
    if (metric.series.size + 2 > max) {
      this.dropped += 1;
      return;
    }
    metric.series.set(`__sum__${key}`, { labels: { ...labels, __part: "sum" }, value });
    metric.series.set(`__count__${key}`, { labels: { ...labels, __part: "count" }, value: 1 });
  }

  collect(name: string, spec: CollectorSpec): () => void {
    const full = this.fullName(name);
    this.collectors.set(full, spec);
    return () => {
      this.collectors.delete(full);
    };
  }

  snapshot(): CollectedMetric[] {
    const collected = new Map<string, CollectedMetric>();
    for (const [name, metric] of this.metrics) {
      collected.set(name, {
        name,
        kind: metric.kind,
        help: metric.help,
        samples: metric.kind === "summary" ? mergeSummaries(metric) : [...metric.series.values()],
      });
    }
    for (const [name, spec] of this.collectors) {
      let samples: MetricSample[];
      try {
        const value = spec.value();
        samples = Array.isArray(value)
          ? value.map((sample) => ({ labels: stringifyLabels(sample.labels), value: sample.value }))
          : [{ labels: stringifyLabels(spec.labels ?? {}), value }];
      } catch (error) {
        this.options.onError?.(name, error);
        continue;
      }
      collected.set(name, { name, kind: "gauge", help: spec.help, samples });
    }
    collected.set(this.fullName("metrics_series_dropped_total"), {
      name: this.fullName("metrics_series_dropped_total"),
      kind: "counter",
      help: "Label sets rejected by the per-metric cardinality limit.",
      samples: [{ labels: {}, value: this.dropped }],
    });
    return [...collected.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  render(): string {
    const lines: string[] = [];
    for (const metric of this.snapshot()) {
      if (metric.help) lines.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
      lines.push(`# TYPE ${metric.name} ${metric.kind}`);
      for (const sample of metric.samples) {
        const suffix =
          sample.labels.__part === "sum" ? "_sum" : sample.labels.__part === "count" ? "_count" : "";
        const labels = { ...sample.labels };
        delete labels.__part;
        lines.push(`${metric.name}${suffix}${formatLabels(labels)} ${sample.value}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  private entry(name: string, kind: MetricKind, help?: string): Metric {
    const full = this.fullName(name);
    if (!NAME_PATTERN.test(full)) throw new Error(`Invalid metric name "${full}".`);
    const existing = this.metrics.get(full);
    if (existing) {
      if (existing.kind !== kind) {
        throw new Error(`Metric "${full}" is already registered as ${existing.kind}.`);
      }
      return existing;
    }
    const metric: Metric = { kind, help, series: new Map() };
    this.metrics.set(full, metric);
    return metric;
  }

  private add(metric: Metric, labels: Record<string, unknown> | undefined, by: number): void {
    const normalized = stringifyLabels(labels ?? {});
    const key = labelKey(normalized);
    const existing = metric.series.get(key);
    if (existing) {
      existing.value += by;
      return;
    }
    if (this.atCapacity(metric)) return;
    metric.series.set(key, { labels: normalized, value: by });
  }

  private atCapacity(metric: Metric): boolean {
    const max = this.options.maxSeriesPerMetric ?? 200;
    if (metric.series.size < max) return false;
    this.dropped += 1;
    return true;
  }

  private fullName(name: string): string {
    const prefix = this.options.prefix ?? DEFAULT_PREFIX;
    return prefix ? `${prefix}_${name}` : name;
  }
}

/** Summaries store sum and count as separate series; fold them back together. */
function mergeSummaries(metric: Metric): MetricSample[] {
  const merged = new Map<string, { labels: Record<string, string>; sum: number; count: number }>();
  for (const [key, series] of metric.series) {
    const part = series.labels.__part;
    const base = key.replace(/^__(sum|count)__/, "");
    const labels = { ...series.labels };
    delete labels.__part;
    const bucket = merged.get(base) ?? { labels, sum: 0, count: 0 };
    if (part === "sum") bucket.sum += series.value;
    else bucket.count += series.value;
    merged.set(base, bucket);
  }
  const samples: MetricSample[] = [];
  for (const { labels, sum, count } of merged.values()) {
    samples.push({ labels: { ...labels, __part: "sum" }, value: sum });
    samples.push({ labels: { ...labels, __part: "count" }, value: count });
  }
  return samples;
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

function requireAdmin(request: PluginHttpRequest): PluginHttpResult | undefined {
  if (request.principal?.role === "admin") return undefined;
  return { status: 403, body: { error: "Metrics are available to administrators only." } };
}

export default {
  name: "@kestrel/plugin-metrics",
  version: "0.1.0",
  description: "Counters, gauges and histograms with Prometheus exposition.",
  inject: ["sessions", "http.routes"],
  apply(context: Context, config: MetricsConfig = {}) {
    if (config.enabled === false) return;
    const sessions: SessionManager = context.get("sessions");
    const routes: HttpRouteService = context.get("http.routes");
    const metrics = new MetricRegistry({
      prefix: config.prefix ?? DEFAULT_PREFIX,
      maxSeriesPerMetric: config.maxSeriesPerMetric,
      onError: (name, error) =>
        context.logger.warn("metric collector failed", {
          metric: name,
          error: error instanceof Error ? error.message : String(error),
        }),
    });
    context.provide("metrics", metrics);
    const startedAt = Date.now();
    const running = new Map<string, number>();

    context.effect(() => {
      const unsubscribe = sessions.subscribe((event) => {
        switch (event.type) {
          case "run.started":
            running.set(event.runId, Date.now());
            metrics.increment("runs_started_total", { help: "Runs accepted by the runtime." });
            break;
          case "run.finished": {
            const began = running.get(event.runId);
            running.delete(event.runId);
            metrics.increment("runs_finished_total", {
              help: "Runs that reached a terminal status.",
              labels: { status: event.status },
            });
            if (began !== undefined) {
              metrics.observe("run_duration_seconds", (Date.now() - began) / 1000, {
                help: "Wall-clock duration of a run.",
              });
            }
            if (event.usage) {
              metrics.increment("tokens_total", {
                help: "Tokens reported by model providers.",
                labels: { kind: "input" },
                by: event.usage.inputTokens,
              });
              metrics.increment("tokens_total", {
                labels: { kind: "output" },
                by: event.usage.outputTokens,
              });
            }
            break;
          }
          case "run.failed":
            running.delete(event.runId);
            metrics.increment("runs_finished_total", {
              help: "Runs that reached a terminal status.",
              labels: { status: "failed" },
            });
            break;
          case "tool.finished":
            metrics.increment("tool_calls_total", {
              help: "Tool calls by tool name and outcome.",
              labels: { tool: event.result.name, ok: event.result.ok ? "true" : "false" },
            });
            if (event.result.durationMs !== undefined) {
              metrics.observe("tool_duration_seconds", event.result.durationMs / 1000, {
                help: "Wall-clock duration of a tool call.",
                labels: { tool: event.result.name },
              });
            }
            break;
          case "approval.resolved":
            metrics.increment("approvals_total", {
              help: "Approval decisions.",
              labels: { decision: event.approved ? "approved" : "denied" },
            });
            break;
          default:
            break;
        }
      });

      const offInfo = metrics.collect("info", {
        help: "Always 1; the version label identifies the runtime.",
        labels: { version: "0.1.0" },
        value: () => 1,
      });
      const offUptime = metrics.collect("uptime_seconds", {
        help: "Seconds since the metrics plugin started.",
        value: () => (Date.now() - startedAt) / 1000,
      });
      const offSessions = metrics.collect("sessions", {
        help: "Sessions currently held in memory, by status.",
        value: () => {
          const counts = new Map<string, number>();
          for (const session of sessions.list()) {
            counts.set(session.status, (counts.get(session.status) ?? 0) + 1);
          }
          return [...counts.entries()].map(([status, value]) => ({ labels: { status }, value }));
        },
      });

      const offJson = routes.route({
        method: "GET",
        path: "/api/metrics",
        handler: (request) => {
          const denied = requireAdmin(request);
          if (denied) return denied;
          return {
            status: 200,
            body: { collectedAt: new Date().toISOString(), metrics: metrics.snapshot() },
          };
        },
      });
      const offPrometheus = routes.route({
        method: "GET",
        path: "/api/metrics/prometheus",
        handler: (request) => {
          const denied = requireAdmin(request);
          if (denied) return denied;
          return {
            status: 200,
            raw: metrics.render(),
            headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
          };
        },
      });

      return () => {
        unsubscribe();
        offInfo();
        offUptime();
        offSessions();
        offJson();
        offPrometheus();
      };
    });
  },
};

declare module "@kestrel/kernel" {
  interface ServiceMap {
    metrics: MetricsService;
    "http.routes": HttpRouteService;
  }
}
