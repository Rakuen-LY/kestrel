# Tools and approvals

Tools are how an agent changes the world. Kestrel keeps the contract small: a JSON Schema for
arguments, an `execute` function, and a permission level.

## Tool contract

```ts
import type { Tool } from "@kestrel/agent";

const tool: Tool = {
  schema: {
    name: "read_file",
    description: "Read a text file from the workspace.",
    category: "filesystem",
    permission: "auto",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path." },
        offset: { type: "integer", description: "First line, 1-based." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async execute(args, context) {
    return {
      content: "text sent back to the model",
      data: { structured: "for clients only" },
    };
  },
};
```

| Field | Purpose |
| --- | --- |
| `schema.name` | Unique tool name. Duplicate registration throws. |
| `schema.description` | Sent to the model; be specific about when to use the tool. |
| `schema.parameters` | JSON Schema subset, validated before execution. |
| `schema.permission` | `auto` runs immediately; `ask` pauses for approval. |
| `schema.category` | Grouping hint for clients. |
| `execute` | Receives parsed arguments and a `ToolContext`. |

`execute` may throw. The runtime converts the error into a failed `ToolResult`; the model sees the
message and can recover. Return `{ isError: true }` for expected failures that should read as data
rather than exceptions.

`ToolContext` exposes the session (`workspace`, transcript and a `metadata` map shared across
calls), the call id, an `AbortSignal`, a scoped logger, and `progress()` for status lines.

## Validation

The registry implements a dependency-free subset of JSON Schema:

- `type` (`object`, `array`, `string`, `number`, `integer`, `boolean`, `null`)
- `required` and `additionalProperties`
- `enum`
- `items` for arrays
- nested objects and arrays

It intentionally does not implement `oneOf`, `anyOf`, `$ref` or formats. Validate those inside
`execute` and return a clear message. Invalid arguments never reach the tool: the model receives

```
Invalid arguments for "word_count": text: must be a string
```

which is usually enough for it to correct itself.

## Approvals

When `permission` resolves to `ask`, the runtime:

1. emits `approval.requested` with the call and a reason;
2. waits for `POST /api/sessions/:id/approvals/:approvalId` (or the CLI prompt);
3. emits `approval.resolved`;
4. runs the tool on approval, or returns a "declined" result.

Approvals carry their own timeout (`approvals.timeoutMs`, 15 minutes by default). A declined call is
not an error: the model is told the user declined and may propose an alternative.

A session-level resolver can override the static value:

```ts
new SessionManager({
  // ...
  resolvePermission(tool, call, session) {
    if (tool.schema.name === "shell" && String(call.arguments.command ?? "").startsWith("git ")) {
      return "auto";
    }
    return tool.schema.permission ?? "auto";
  },
});
```

This is how a policy plugin can implement "read-only shell commands are fine; writes need
approval". Returning `"deny"` rejects the call without asking.

## Built-in tools

`@kestrel/plugin-tools-core` contributes ten tools:

| Tool | Permission | Notes |
| --- | --- | --- |
| `read_file` | auto | Line offsets, binary detection, 2 MB and 2,000-line caps. |
| `list_dir` | auto | Workspace-relative listing; no symlink escape. |
| `glob` | auto | `**` patterns, 300-result cap. |
| `grep` | auto | Regex search with glob filters, 150-match cap. |
| `write_file` | auto | Creates parent directories; overwrites. |
| `edit_file` | auto | Exact string replacement; refuses ambiguous matches. |
| `shell` | ask | Spawns a shell in the workspace; 120 s default timeout. |
| `web_fetch` | ask | HTTP GET with timeout and content limits. |
| `todo_write` | auto | Maintains a visible task list for the run. |
| `finish` | auto | Ends the run with a final summary. |

`@kestrel/plugin-memory` adds `memory_save`, `memory_search`, `memory_list` and `memory_forget`.
`@kestrel/plugin-skills` adds `use_skill`, which loads a workspace procedure on demand; see
[Skills](/guide/skills). `@kestrel/plugin-subagents` adds `delegate` (one scoped task in a separate
session) and `delegate_many` (a batch of independent tasks run concurrently); see
[Subagents](/guide/subagents).
The example clock plugin adds `clock_now`.

File tools resolve paths against the session workspace and, with `restrictToWorkspace: true` (the
default), reject escapes outside it. Disable that only when the agent is already inside a sandbox.

### Configuring the core tools

```json
{
  "plugins": {
    "config": {
      "@kestrel/plugin-tools-core": {
        "restrictToWorkspace": true,
        "shellPermission": "ask",
        "webPermission": "ask",
        "shellTimeoutMs": 120000,
        "maxOutputChars": 100000
      }
    }
  }
}
```

Set `shellPermission: "auto"` only in a disposable sandbox. The agent can then run arbitrary
commands without stopping.

## Tool output size

Tool output is truncated before it reaches the model (60,000 characters by default in the runtime,
with per-tool caps inside `tools-core`). Truncation keeps the head and adds a marker. If your tool
can return large data, provide a summary in `content` and put the full payload in `data`; clients
can render `data` without spending context.

## Writing a good tool

- **Name it after the action**, not the implementation: `read_file`, not `fs_read`.
- **Describe when to use it**, including what it cannot do.
- **Return consistent paths**; the model will reuse them.
- **Make failures actionable**: "old_string occurs 3 times; add context or set replace_all".
- **Prefer structured data** over prose when a client might render it.
- **Never trust tool output as instructions.** Tool results are data; prompt injection is a real
  attack surface. The default system prompt says so explicitly.
