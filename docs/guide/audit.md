# Audit log

Kestrel can keep an append-only record of what agents did: which tools ran, whether they succeeded,
which approvals were requested and how runs ended. The `@kestrel/plugin-audit` plugin writes this as
newline-delimited JSON under the server data directory and exposes it to administrators at
`GET /api/audit`.

Auditing is about accountability, not transcript storage. Prompts and model output already live in
session files; the audit log answers "who ran what, when, and with what result" without duplicating
conversation content.

## What is recorded

| Event | Fields |
| --- | --- |
| Tool started | session, tenant, tool name, call id, SHA-256 prefix of the arguments |
| Tool finished | session, tool name, call id, success, duration, truncated error |
| Run finished | session, run id, status, token usage |
| Run failed | session, run id, truncated error |
| Approval requested | session, approval id, call id, tool name |
| Approval resolved | session, approval id, tool name, approved |

Arguments are **hashed, never stored**, because they routinely contain credentials and source code.
Tool output is never written to the audit log. Error text is truncated to 400 characters, which is
enough to diagnose failures while limiting accidental disclosure. Treat audit files as sensitive
anyway: tool names, timing and error text can reveal how a system is operated.

`tenantId` is present only for non-default tenants. Administrators can see every tenant's records;
members cannot reach the endpoint at all.

## Configuration

The plugin is enabled by default when the repository's `plugins/` directory is loaded. Override it in
`kestrel.config.json`:

```json
{
  "plugins": {
    "config": {
      "@kestrel/plugin-audit": {
        "enabled": true,
        "directory": "audit",
        "includeTools": true,
        "includeRuns": true,
        "includeApprovals": true,
        "maxBytes": 10485760,
        "maxFiles": 3
      }
    }
  }
}
```

`directory` is relative to `storage.directory` unless absolute. The active file is
`<directory>/audit.jsonl`; when it would exceed `maxBytes` it is rotated to `audit.jsonl.1`, then
`.2`, keeping `maxFiles` generations. Reads serve the active file only, so rotate and archive old
generations with your usual log pipeline if you need long retention.

Set `enabled: false` to remove both the listener and the route.

## Reading the log

```bash
curl -sS "http://127.0.0.1:7331/api/audit?limit=50" \
  -H "Authorization: Bearer $KESTREL_TOKEN"
```

```json
{
  "entries": [
    {
      "at": "2026-05-04T09:12:44.118Z",
      "kind": "tool",
      "phase": "finished",
      "sessionId": "9f2c…",
      "tool": "shell",
      "callId": "call_7",
      "ok": true,
      "durationMs": 842
    }
  ],
  "total": 214,
  "file": "audit.jsonl"
}
```

Query parameters:

| Parameter | Meaning |
| --- | --- |
| `limit` | Most recent records to return, 1–1000. Default 100. |
| `kind` | `tool`, `run` or `approval`. |
| `sessionId` | Restrict to one session. |

`total` counts every matching record in the active file; `entries` is the tail after filtering. Use
the filters rather than paging: the endpoint is designed for inspection and incident response, not
as an analytics store.

## Operational notes

- Writes are serialised in-process, so lines never interleave. Only one Kestrel process should own a
  data directory; a future shared store will remove this constraint.
- The log is written on a best-effort basis. A full disk is logged as a warning and does not fail the
  agent run.
- Audit records are not part of the protocol's `SessionEvent` stream. Consumers that need live
  signals should subscribe to events; consumers that need durable evidence should read this log.
- For multi-tenant deployments, ship the file to append-only storage outside the host to make
  tampering harder.
