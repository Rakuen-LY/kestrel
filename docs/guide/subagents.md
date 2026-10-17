# Subagents

Delegation lets one agent hand a scoped task to another. The child runs in its own session: a fresh
transcript, its own step budget, its own tool allowlist. The parent receives exactly one thing back,
the child's final message.

This is the difference between "the model spawned a thread in the same context" and genuine
context isolation. A parent that asks a subagent to audit forty files never pays for those file
contents in its own window.

```
parent session (depth 0)
├── researcher  (depth 1)  → "three call sites, listed by file"
├── reviewer    (depth 1)  → "two findings, one missing test"
└── implementer (depth 1)
    └── reviewer (depth 2)  ← allowed while maxDepth >= 2
```

## What a subagent gets, and what it does not

| Inherited | Not inherited |
| --- | --- |
| Workspace root | Parent's messages |
| Tool registry (filtered) | Parent's step budget or usage |
| Model, unless the role overrides it | Parent's title and metadata |
| Approval channel (see below) | Parent's transcript, including the task brief in full |

The parent's task text *is* the child's first user message, so a good delegation states the goal,
the relevant paths, and what a useful answer contains.

## The `delegate` tool

```json
{
  "task": "Find every caller of buildSession and report file:line plus the signature at each site.",
  "role": "researcher",
  "title": "Callers of buildSession"
}
```

| Argument | Required | Meaning |
| --- | --- | --- |
| `task` | yes | Self-contained instructions. The child cannot see this conversation. |
| `role` | no | A configured role; defaults to `general`. |
| `title` | no | Session title, so the child is recognisable in the console. |

The result is a short report: status, duration, child session id, and the child's final message:

```md
Subagent `researcher` finished in 12.4s (session 0f3c…).

Found three call sites:
- `packages/agent/src/manager.ts:118` — `create(...)`
...
```

The tool result also carries structured data — `sessionId`, `role`, `status`, `durationMs` and the
child's `usage` — so a client can chart cost per branch without parsing prose.

If the child fails, times out or is cancelled, the result is an error with the partial report
attached. The parent decides whether to retry, narrow the task, or do the work itself.

Delegation is one tool call, so a model that issues two `delegate` calls in one turn runs them
sequentially. To work on independent tasks at the same time, use `delegate_many` below.
`maxConcurrent` caps how many children *one* parent may have in flight; a deeper tree can exceed it
across levels.

## Fan-out: `delegate_many`

Some work is embarrassingly parallel: auditing four directories, reviewing three pull requests, or
sketching two competing designs. `delegate_many` starts a batch and returns one report per task, in
the order the tasks were given.

```json
{
  "tasks": [
    { "task": "Audit packages/agent for unhandled promise rejections.", "role": "reviewer" },
    { "task": "Audit plugins/* for the same problem.", "role": "reviewer", "title": "Plugin audit" },
    { "task": "Summarise how errors surface in the HTTP layer.", "role": "researcher" }
  ]
}
```

| Argument | Required | Meaning |
| --- | --- | --- |
| `tasks` | yes | 1 … `maxFanOut` objects with `task`, optional `role` and `title`. |
| `tasks[].task` | yes | Self-contained instructions for that child. |
| `tasks[].role` | no | A configured role; defaults to `general`. |

### Concurrency and queuing

A batch does not bypass the budget. `delegate` and `delegate_many` acquire slots from the same
per-parent gate, so at most `maxConcurrent` children run at once, whether they came from one call or
several:

```
maxConcurrent = 2, batch of 5
┌─ running ─┐  ┌──── queued ────┐
│ task 1    │  │ task 3  task 4 │
│ task 2    │  │ task 5         │
└───────────┘  └────────────────┘
```

Queued tasks do not create sessions until they get a slot, so a large batch does not flood the
session list, and a cancelled parent drops its queue instead of starting work nobody is waiting for.

The trade-off is honest: `delegate_many` blocks the parent's turn until every task finishes, so the
batch's worst case is roughly `ceil(tasks / maxConcurrent) × timeoutMs`. Keep batches focused; a
twelve-task batch is usually a sign the task should be decomposed differently.

### Result shape

```
Delegated 3 tasks in 41.2s wall clock (2 completed, 1 failed).
640 input / 210 output tokens across all tasks.

### 1. reviewer · completed · 38.4s · session 4c1e…
No unhandled rejections; two floating promises in the queue helper.

### 2. reviewer · failed · 12.0s · session 91ab…
Error: provider exploded

### 3. researcher · completed · 9.8s · session 7702…
Errors are converted to `message.*` events at the tool boundary.
```

A partially failed batch is **not** an error result: the parent usually still benefits from the
reports that succeeded, and the failure is visible in the text and in the structured data. Only a
batch where every task failed is marked as an error.

Structured data:

```json
{
  "total": 3,
  "wallClockMs": 41200,
  "durationMs": 60200,
  "counts": { "completed": 2, "failed": 1 },
  "usage": { "inputTokens": 640, "outputTokens": 210, "totalTokens": 850 },
  "results": [
    { "index": 0, "role": "reviewer", "status": "completed", "sessionId": "4c1e…", "queueMs": 0 }
  ]
}
```

`durationMs` is the sum of child runtimes (what you pay for); `wallClockMs` is the slowest child
(what you wait for). Report text is truncated per task from a shared
`maxBatchResultChars` budget, with a floor per task so a large batch cannot truncate every report to
nothing.

### When not to fan out

- The tasks depend on each other's output. Delegate sequentially instead.
- The work is a few tool calls. A child costs a model round trip and a session.
- Two children would edit the same files. They share the workspace; concurrent writes to one file
  are a race, not a speed-up.

## Roles

Roles are prompts with a budget. Built-ins:

| Role | Intent | Default tools |
| --- | --- | --- |
| `general` | Any scoped task | Every tool that cannot prompt a human |
| `researcher` | Read-only investigation | `read_file`, `list_dir`, `glob`, `grep`, `fetch`, `use_skill`, memory reads |
| `reviewer` | Review, no edits | Same as `researcher`, without `fetch` |
| `implementer` | A bounded code change | Researcher tools plus `write_file`, `edit_file`, `memory_save` |

Configuring a role extends the built-in role rather than replacing it:

```json
{
  "plugins": {
    "config": {
      "@kestrel/plugin-subagents": {
        "maxDepth": 2,
        "maxConcurrent": 3,
        "maxFanOut": 6,
        "maxSteps": 12,
        "timeoutMs": 600000,
        "roles": {
          "researcher": { "model": "gpt-4o-mini" },
          "migrator": {
            "description": "Port one module at a time.",
            "instructions": "Change one module per run. Never touch the public API.",
            "allowTools": ["read_file", "edit_file", "grep", "glob"]
          }
        }
      }
    }
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `maxDepth` | `2` | Deepest allowed child. `1` disables nesting. |
| `maxConcurrent` | `3` | Running children per parent, shared by both tools. `0` means unbounded. |
| `maxFanOut` | `6` | Tasks accepted by one `delegate_many` call. |
| `maxBatchResultChars` | `40000` | Total report budget for one batch, split per task (floor 1500). |
| `maxSteps` | `12` | Step budget per child; roles may override. |
| `timeoutMs` | `600000` | Wall-clock limit; the child is cancelled on expiry. |
| `maxResultChars` | `20000` | Cap on the report returned to the parent. |
| `exposeApprovalTools` | `false` | Include tools that require human approval. |

## Approvals inside a subagent

Subagents do not get tools whose permission is `ask` by default. An approval request belongs to a
session the human may not be looking at, so the run would block until it timed out instead of
asking a question that could be answered. Set `exposeApprovalTools: true` only when your client
surfaces approvals across sessions.

The workaround is deliberate and documented: a subagent that needs a shell asks its parent, and the
parent's own approval flow applies.

## Depth and recursion

`maxDepth` is enforced twice:

1. The tool refuses to run when `session.depth >= maxDepth`.
2. Session creation strips `delegate` and `delegate_many` from the child's allowlist once no depth
   remains, so the model does not even see a tool it cannot use.

Depth is a property of the session, persisted with it, so a restarted server still knows which
sessions were delegated and how deep.

## Observability

Child sessions are real sessions. They appear in `GET /api/sessions`, stream their own events, and
can be inspected, cancelled or deleted individually. Their summary carries `parentId`, `depth` and
`role`:

```json
{
  "id": "0f3c…",
  "title": "researcher of Callers of buildSession",
  "parentId": "9a1b…",
  "depth": 1,
  "role": "researcher",
  "status": "idle"
}
```

The console indents them under their parent and shows the role chip; `kestrel sessions` does the
same in the terminal.

## Using the service from another plugin

```ts
const subagents = context.get("subagents");
subagents.roles();                  // [{ name, description, allowTools?, model?, maxSteps? }]
subagents.running();                // child session ids currently delegated by this plugin
subagents.concurrency(parentId);    // { limit, active, queued } — useful for a load indicator
```

A dashboard, a policy guard or a cost tracker can consume this without knowing how delegation
works internally.

## Design notes

- **Isolation is the feature.** Sharing the tool registry but not the transcript keeps a child
  cheap to start and impossible to confuse with its parent's history.
- **The report is the interface.** No shared mutable state, no callbacks into the parent. If the
  child's answer is insufficient, the parent delegates again with a better brief.
- **Budgets are explicit.** Steps, wall clock, concurrency, batch size, depth and result size are
  all bounded, because delegation is the easiest way to multiply token spend by accident.
- **One gate for every tool.** Concurrency policy lives in a single semaphore rather than in each
  tool, so a new delegation tool cannot accidentally exceed the budget.
- **Disposal cancels children.** Unloading the plugin does not leave orphaned runs burning tokens.
