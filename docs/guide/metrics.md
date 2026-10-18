# Metrics

`@kestrel/plugin-metrics` keeps an in-process registry of counters, gauges and summaries and exposes
it in two shapes: JSON for the console and dashboards, and Prometheus text for a scraper. It also
provides a `metrics` service, so every other plugin can publish numbers without importing a metrics
library.

Metrics are deliberately simple. They live in memory, reset on restart, and describe the process
that owns them. Anything durable — usage history, per-tenant billing — belongs in a store, not here;
see [Audit log](/guide/audit) for the durable trail and the `/api/usage` endpoint for accumulated
tokens.

## Endpoints

| Endpoint | Format | Access |
| --- | --- | --- |
| `GET /api/metrics` | JSON snapshot | Administrators |
| `GET /api/metrics/prometheus` | Prometheus text (0.0.4) | Administrators |

Both require the usual bearer token. Metrics aggregate across tenants, so they are admin-only.

```bash
curl -sS http://127.0.0.1:7331/api/metrics/prometheus \
  -H "Authorization: Bearer $KESTREL_TOKEN"
```

```text
# HELP kestrel_runs_finished_total Runs that reached a terminal status.
# TYPE kestrel_runs_finished_total counter
kestrel_runs_finished_total{status="completed"} 12
# HELP kestrel_info Always 1; the version label identifies the runtime.
# TYPE kestrel_info gauge
kestrel_info{version="0.1.0"} 1
# HELP kestrel_sessions Sessions currently held in memory, by status.
# TYPE kestrel_sessions gauge
kestrel_sessions{status="idle"} 3
```

## What ships by default

| Metric | Type | Labels |
| --- | --- | --- |
| `kestrel_runs_started_total` | counter | — |
| `kestrel_runs_finished_total` | counter | `status` (`completed`, `cancelled`, `max_steps`, `failed`) |
| `kestrel_run_duration_seconds` | summary | — |
| `kestrel_tool_calls_total` | counter | `tool`, `ok` |
| `kestrel_tool_duration_seconds` | summary | `tool` |
| `kestrel_tokens_total` | counter | `kind` (`input`, `output`) |
| `kestrel_approvals_total` | counter | `decision` (`approved`, `denied`) |
| `kestrel_sessions` | gauge, scrape-time | `status` |
| `kestrel_uptime_seconds` | gauge, scrape-time | — |
| `kestrel_info` | gauge, scrape-time | `version` |
| `kestrel_metrics_series_dropped_total` | counter | — |

Durations are wall-clock, measured between the runtime's own events, so they include queueing and
streaming. Token counts are exactly what providers reported; a provider that omits usage contributes
nothing.

## Publishing your own metrics

Inject `metrics` in the manifest and use the service. Names are prefixed once, so write them without
the prefix:

```ts
export default {
  name: "@acme/plugin-webhooks",
  version: "1.0.0",
  inject: ["metrics"],
  apply(context) {
    const metrics = context.get("metrics");
    context.effect(() => {
      const off = metrics.collect("webhook_queue_depth", {
        help: "Deliveries waiting to be sent.",
        value: () => queue.length,
      });
      return off;
    });
    metrics.increment("webhook_deliveries_total", { labels: { outcome: "ok" } });
  },
};
```

The service surface:

```ts
interface MetricsService {
  increment(name: string, options?: { by?: number; help?: string; labels?: MetricLabels }): void;
  gauge(name: string, value: number, options?: { help?: string; labels?: MetricLabels }): void;
  observe(name: string, value: number, options?: { help?: string; labels?: MetricLabels }): void;
  collect(name: string, spec: { help?: string; labels?: MetricLabels; value: () => number | MetricSample[] }): () => void;
  snapshot(): CollectedMetric[];
  render(): string;
}
```

- `increment` is the default for anything that only grows.
- `gauge` sets an absolute value; call it again to overwrite.
- `observe` accumulates `_sum` and `_count`, rendered as a Prometheus `summary`.
- `collect` runs at scrape time, which is what you want for queue depths, cache sizes and other
  values that must not go stale. A throwing collector is logged and skipped.

Registering the same name twice with a different kind throws at startup, which surfaces copy-paste
mistakes early. Labels are sorted before rendering so output is stable across runs.

## Configuration

```json
{
  "plugins": {
    "config": {
      "@kestrel/plugin-metrics": {
        "enabled": true,
        "prefix": "kestrel",
        "maxSeriesPerMetric": 200
      }
    }
  }
}
```

`maxSeriesPerMetric` is a cardinality guard. Once a metric has that many label sets, new sets are
dropped and `kestrel_metrics_series_dropped_total` increases. Never label by session id, user id or
prompt text: each value creates a new series and the guard will silently hide them. Label by tool
name, status or decision instead.

Set `enabled: false` to unload the plugin entirely.

## Scraping

A minimal Prometheus job:

```yaml
scrape_configs:
  - job_name: kestrel
    authorization:
      credentials_file: /etc/prometheus/kestrel-token
    static_configs:
      - targets: ["kestrel.internal:7331"]
    metrics_path: /api/metrics/prometheus
    scrape_interval: 30s
```

In Kubernetes, point the scrape annotation at the same path and mount the token as a secret. If you
run several Kestrel processes behind one service name, scrape each pod rather than the service, so
`kestrel_sessions` stays meaningful per process.

## Limitations

- Counters reset on restart. Use `rate()` and tolerate a reset, or ship events to a time-series
  system that supports reset detection.
- No histograms with buckets: summaries are enough for latency averages and counts, but they cannot
  be aggregated across processes. Add bucket support when a real need appears.
- Everything is per process. A shared registry would need a shared store and is out of scope for
  `0.1`.
