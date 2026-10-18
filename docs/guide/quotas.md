# Quotas and policy guards

Every open platform eventually needs a way to say "no". Kestrel answers with **session guards**: a
synchronous veto over session creation and run launches. The runtime knows nothing about tenants,
billing or maintenance windows — it only knows that a guard may throw. Policy lives in plugins,
where it can be replaced without touching the agent.

`@kestrel/plugin-quota` is the reference consumer. It enforces per-tenant session, concurrency and
token limits, and it doubles as a worked example for your own policy plugin.

## Enabling limits

Quotas are off until configured. Limits are keyed by tenant; a tenant listed under `tenants` does
**not** inherit `default`, so an override is complete rather than merged.

```json
{
  "plugins": {
    "config": {
      "@kestrel/plugin-quota": {
        "default": { "maxSessions": 50, "maxConcurrentRuns": 2, "maxTokens": 2000000 },
        "tenants": {
          "acme": { "maxSessions": 500, "maxConcurrentRuns": 16, "maxTokens": 50000000 },
          "trial": { "maxSessions": 3, "maxTokens": 50000 }
        }
      }
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `maxSessions` | Sessions a tenant may keep, subagents included. |
| `maxConcurrentRuns` | Runs a tenant may execute at the same time. |
| `maxTokens` | Lifetime tokens, summed over the tenant's sessions. |

Omit a field for no limit. Invalid values (negative, fractional) fail at plugin load, not at the
first request.

Tenant ids come from `auth.mode: "accounts"`. In `none` or `token` mode every session belongs to
`default`, so configure the `default` entry.

## What a rejection looks like

A guard veto becomes `429 Too Many Requests` over HTTP, with the guard's code and a `Retry-After`
header when the plugin supplies one:

```json
{
  "error": {
    "code": "quota_exceeded",
    "message": "Tenant \"acme\" is already running 2 run(s); the limit is 2. Wait for a run to finish."
  }
}
```

The rejection happens **before** anything mutates. A blocked `POST /api/sessions/:id/messages`
leaves no orphan user message in the transcript, and a blocked resume leaves pending tool calls
alone. `kestrel run` and `kestrel chat` print `Rejected: <message>` and exit with status `2`.

Guard errors are recognised by `name === "SessionGuardError"` and a string `code`, not by
`instanceof`. A plugin bundle may contain its own copy of `@kestrel/agent`, and class identity does
not survive that; the structural check does.

## Inspecting usage

```bash
curl -sS http://127.0.0.1:7331/api/quotas -H "Authorization: Bearer $KESTREL_TOKEN"
```

```json
{
  "tenants": [
    {
      "tenantId": "acme",
      "sessions": 12,
      "running": 1,
      "tokens": 184320,
      "limits": { "maxSessions": 500, "maxConcurrentRuns": 16, "maxTokens": 50000000 }
    }
  ]
}
```

Administrators only, because the response spans tenants. Plugins can read the same numbers through
the `quotas` service (`limits(tenantId)`, `usage(tenantId)`, `describe()`), for example to render a
badge in a console extension.

## Writing your own guard

Inject `sessions` and register a guard. The callback is synchronous and runs in registration order:

```ts
import { SessionGuardError } from "@kestrel/agent";

export default {
  name: "@acme/plugin-maintenance",
  version: "0.1.0",
  inject: ["sessions"],
  apply(context) {
    const sessions = context.get("sessions");
    context.effect(() =>
      sessions.addGuard((check) => {
        if (isMaintenanceWindow() && check.action === "run") {
          throw new SessionGuardError("maintenance", "Runs are paused until 18:00 UTC.", {
            retryAfterSeconds: 600,
          });
        }
      }),
    );
  },
};
```

The context is:

```ts
interface SessionGuardContext {
  action: "create" | "run";
  tenantId: string;
  sessionId?: string;                 // present for "run"
  request?: { title?: string; model?: string; workspace?: string };  // present for "create"
}
```

Guidelines:

- **Stay cheap.** Guards are synchronous, so count in-memory state. An `await` in a guard would
  either block the event loop or force the runtime to become async; neither is worth it. If the
  decision needs a database, cache the answer and refresh it on events.
- **Throw only `SessionGuardError`.** Any other exception is a bug and surfaces as a `500`, which
  tells the operator to read the logs instead of the message.
- **Use a stable code.** `quota_exceeded` is understood by clients; pick a code per policy
  (`maintenance`, `model_not_allowed`, `region_locked`) so tooling can branch on it.
- **Dispose with `context.effect`.** The guard is removed when the plugin unloads.

Multiple guards compose: the first rejection wins, and every guard sees every action, so a quota
plugin and a maintenance plugin can coexist without knowing about each other.

## Limitations

- Counts are per process. Several replicas behind one load balancer each enforce their own limits;
  a shared quota needs a shared counter and is not part of `0.1`.
- `maxTokens` uses the token usage sessions already carry. A provider that omits usage does not
  consume budget.
- Session counts include subagents and sessions restored from disk.
