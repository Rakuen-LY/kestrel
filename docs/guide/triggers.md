# Triggers & schedules

Kestrel can start a run without a human clicking anything. Two triggers ship in
`@kestrel/plugin-triggers`: HTTP webhooks for external systems (CI, chatops, monitoring) and cron
schedules for recurring work (nightly triage, dependency audits, report generation). Both create a
normal session through `SessionManager`, so approvals, checkpoints, plugins and the console behave
exactly as they do for an interactive run.

## Configuration

```json
{
  "plugins": {
    "config": {
      "@kestrel/plugin-triggers": {
        "webhooks": {
          "deploy-review": {
            "prompt": "Review deployment {{payload}} and report risks.",
            "title": "Deploy review",
            "secret": "${DEPLOY_HOOK_SECRET}"
          }
        },
        "schedules": [
          {
            "id": "nightly-deps",
            "cron": "0 2 * * *",
            "prompt": "Audit dependencies and open a summary in the workspace.",
            "title": "Nightly dependency audit"
          }
        ],
        "tickMs": 30000
      }
    }
  }
}
```

`prompt` supports three placeholders: `{{payload}}` (the JSON request body, `{}` for schedules),
`{{id}}` (hook or schedule id) and `{{date}}` (ISO timestamp). Unknown placeholders are left intact.
`model` and `workspace` can pin a trigger to a specific model or directory; otherwise the session
inherits the server defaults.

## Webhooks

Each entry registers `POST /api/hooks/<id>`:

```bash
curl -X POST https://kestrel.example.com/api/hooks/deploy-review \
  -H "Authorization: Bearer $KESTREL_TOKEN" \
  -H "X-Kestrel-Hook-Secret: $DEPLOY_HOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"service":"api","version":"1.4.2"}'
```

The response is `202` with `{ "hook", "sessionId", "runId" }`; poll or stream the session like any
other run. A wrong or missing `X-Kestrel-Hook-Secret` returns `401` and starts nothing. `secret`
expands `${NAME}` from the environment, so the config can stay in version control. When `secret` is
omitted the hook is still protected by normal server authentication, but anyone holding a server
token can call it.

Set `"public": true` only when the caller cannot carry the server token (for example a third-party
webhook sender). Public routes are dispatched **before** authentication, so Kestrel requires a
`secret` for them and rejects the configuration otherwise. Keep public hooks narrow: the secret is
the only gate.

## Schedules

Schedules use five-field cron in **UTC**: minute, hour, day-of-month, month, day-of-week. The dialect
supports `*`, lists (`1,15`), ranges (`9-17`), steps (`*/15`, `0-30/10`) and both `0` and `7` for
Sunday. Standard cron OR semantics apply when both day fields are restricted.

The scheduler evaluates once per `tickMs` (default 30 s, minimum 1 s) and fires at most once per
minute. A run that is still active when the next tick matches is skipped with a warning rather than
started twice. There is no catch-up: a server that was down at 02:00 does not run the 02:00 job on
boot. Schedules live in configuration, not in the database, so restarting with the same config
restores them.

## Plugin HTTP routes

The triggers plugin uses a service any plugin can consume:

```ts
export default {
  name: "@acme/status",
  version: "0.1.0",
  inject: ["http.routes"],
  apply(context: Context) {
    const routes = context.get("http.routes");
    context.effect(() =>
      routes.route({
        method: "GET",
        path: "/api/status/:team",
        handler: (request) => ({
          body: { team: request.params.team, query: request.query },
        }),
      }),
    );
  },
};
```

Routes must live under `/api/`. `:name` segments become `request.params`; the query string arrives as
`request.query`, the decoded JSON body as `request.body`, and the authenticated caller as
`request.principal`. Return `{ status?, headers?, body? }`; the default is `200 { ok: true }`.
Handlers are isolated: a thrown error becomes `500 plugin_route_failed` and does not stop the
server.

Private routes run after authentication and tenant resolution. Public routes (`public: true`) run
before it, so they must verify their own credential. Registration is first-come and duplicate
method/path pairs throw, preventing one plugin from shadowing another. Disposers returned by
`route()` run when the plugin unloads.

## Limits

- In-process scheduler: one server replica owns the schedule. Running multiple replicas would fire
  each job once per replica.
- No retry or dead-letter queue. A failed run is a session with status `error`; inspect it in the
  console or resume it.
- No delivery history yet: hook calls are logged, not stored.
