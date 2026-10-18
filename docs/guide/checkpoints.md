# Checkpoints

An agent that edits files is only as useful as your ability to undo it. Kestrel snapshots the
workspace before every turn, so a bad refactor costs one click instead of a stash, a `git reflog`
archaeology session or a restored backup.

Checkpoints started as workspace-only: restoring files never touched the transcript. The rewind API
below adds the transcript half, so a turn can be undone end to end and sent again with a better
prompt. The two remain separable: restoring a checkpoint alone still leaves the conversation
intact, and rewinding a message can leave files untouched with `restoreFiles: false`.

```
data/
├── checkpoints/
│   └── <workspace-hash>/
│       ├── repo.git/      shadow repository (never inside your project)
│       ├── index.json     labels, timestamps, file counts
│       └── excludes       ignore patterns for this workspace
└── tenants/<id>/workspace/
```

## Why a shadow repository

Copying a workspace before every turn is wasteful and slow on real projects. Kestrel uses git's
content-addressed object store instead: the first snapshot costs one tree scan, later snapshots add
only the blobs that changed, and deduplication happens automatically.

The repository lives under the data directory, so it never pollutes your project's `.git`, never
appears in `git status`, and survives even when the workspace is reset. It is also why checkpoints
need `git` on the host — Kestrel checks once and degrades gracefully if the binary is missing.

## What gets captured

Snapshotting respects ignore rules in this order:

1. Kestrel's built-in list: `node_modules/`, `dist/`, `build/`, `out/`, `.next/`, `.cache/`,
   `target/`, `coverage/`, `.venv/`, `venv/`, `__pycache__/`, `*.log` and OS metadata files.
2. Your workspace `.gitignore` (patterns are copied, not linked).
3. Any extra `checkpoints.exclude` patterns from the configuration.

Ignored files are not captured and are never deleted by a restore. That matters for dependency
directories: rewinding source code should not uninstall `node_modules` or invalidate a Python
virtualenv.

A workspace with more than `checkpoints.maxFiles` tracked files (20,000 by default) is refused
rather than silently truncated. Point the agent at a subdirectory, or raise the limit.

## When snapshots happen

| Trigger | Label |
| --- | --- |
| `POST /api/sessions/:id/messages` | `Before: <first 72 characters of the message>` |
| `kestrel run` / `kestrel chat` turn | `Before: <first 72 characters of the prompt>` |
| `POST /api/sessions/:id/checkpoints` | Caller-provided label, or `Snapshot` |
| Before a restore | `Before restoring "<label>"` |
| `kestrel checkpoints create` | Caller-provided label, or `Snapshot` |

Subagent runs do not snapshot: they share the parent's workspace and begin after the parent's
snapshot for the same turn, so a separate snapshot would only add noise.

If git is unavailable, snapshots are skipped and logged. A run never fails because a checkpoint
could not be taken.

## Rewinding a turn

`POST /api/sessions/:id/rewind` undoes a user turn:

```json
{ "messageId": "…", "restoreFiles": true }
```

The target must be a user message, and the session must not be running. Kestrel drops that message
and everything after it, then restores the snapshot whose `messageId` matches. Because the
snapshot is taken before the message is appended, the workspace returns to exactly what the user
saw when they typed it. The response returns the surviving transcript and the restored checkpoint:

```json
{
  "messageId": "…",
  "removed": 4,
  "messages": [{ "id": "…", "role": "user", "content": "…" }],
  "restored": { "id": "cp_…", "label": "Before: refactor auth", "messageId": "…" },
  "safety": { "id": "cp_…" },
  "warning": null
}
```

`restored` is `null` when no snapshot is linked to the message (checkpoints disabled, git missing,
or a session restored from an older store). The transcript is still rewound and `warning` explains
why files were left alone. File restoration happens after truncation; a restore failure does not
roll the transcript back, so `warning` is authoritative.

Clients receive `session.rewound` with the full surviving message list and should replace local
state rather than removing messages one by one. The console exposes this as a ↺ button on user
messages; the CLI as `kestrel sessions rewind <id> <messageId>`.

Usage counters are not decremented: tokens were spent, even if the turn is discarded.

## Restoring

`POST /api/sessions/:id/checkpoints/:checkpointId/restore` refuses while the session is running
(`409 session_busy`). It then:

1. Takes a safety snapshot of the current state.
2. Runs `git reset --hard <sha>` in the shadow repository.
3. Runs `git clean -fd`, removing files that were created after the snapshot while leaving ignored
   files alone.

The response names both the restored checkpoint and the safety checkpoint, so the operation is
itself undoable:

```json
{
  "restored": { "id": "cp_...", "label": "Before: refactor auth", "sha": "..." },
  "safety": { "id": "cp_...", "label": "Before restoring \"Before: refactor auth\"", "sha": "..." }
}
```

Because a tenant shares one workspace, a restore affects every session using that directory. The
console confirms before calling the endpoint, and so should any automation you build.

## Console

The clock icon in the session header opens the checkpoint drawer:

- capture an ad-hoc snapshot with an optional label;
- read the list in reverse chronological order with file counts and `+added ~modified -deleted`;
- restore any entry, with a confirmation prompt and the safety checkpoint reported back.

## CLI

```bash
kestrel checkpoints list <session-id>
kestrel checkpoints create <session-id> --label "before refactor"
kestrel checkpoints restore <session-id> <checkpoint-id>
```

## Configuration

```json
{
  "checkpoints": {
    "enabled": "auto",
    "maxFiles": 20000,
    "exclude": ["*.parquet", "datasets/"]
  }
}
```

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `"auto"` | `"auto"` probes for git; `false` disables the feature entirely. |
| `maxFiles` | `20000` | Refuse snapshots above this file count. |
| `exclude` | `[]` | Extra patterns appended to the ignore list. |

Environment: `KESTREL_CHECKPOINTS=auto|on|off`, `KESTREL_CHECKPOINTS_MAX_FILES`.

## Limits worth knowing

- **Shell side effects are invisible to git.** A tool that deletes files outside the workspace, or
  drops a database, cannot be rewound. Checkpoints cover the filesystem the agent was given.
- **Ignored files are not restored.** If an agent breaks a build artifact that was excluded, rewind
  will not fix it; rebuild instead.
- **Snapshots cost one tree walk per turn.** On very large repositories, raise the threshold or
  disable the feature; the agent loop itself is unaffected.
- **The transcript is not rewound.** Tools that already reported results keep those results in
  history. Start a fresh session if you want a clean context as well as clean files.
