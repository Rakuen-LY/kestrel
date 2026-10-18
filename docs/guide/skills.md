# Skills

Skills are reusable procedures stored in the workspace as markdown. They are the middle ground
between a system prompt (always in context) and a tool (code the model can run): a skill is
*instructions the model loads when it recognises the task*.

Kestrel implements the progressive-disclosure pattern popularised by Claude Agent Skills and
DeepSeek Harness:

1. At session creation, a prompt layer lists every skill's **name**, **description** and
   optional **when-to-use** hint.
2. The model calls the `use_skill` tool with one of those names.
3. Only then is the skill **body** appended to the conversation.

A workspace with forty skills costs a few hundred tokens of prompt, not forty documents.

## Layout

Skills are discovered in two directories, in priority order:

```
<workspace>/.kestrel/skills/    # checked first
<workspace>/skills/
```

Two shapes are supported:

```
skills/release-checklist/SKILL.md    # directory form, preferred
skills/deploy.md                     # flat file form
```

Entries starting with `.` or `_` are ignored, so drafts and hidden directories stay out of the
catalogue. When two skills resolve to the same name, the first directory wins.

## Format

```md
---
name: release-checklist
description: Cut a versioned release without breaking the changelog.
when-to-use: The user asks to ship, tag, publish or bump a version.
---

# Release checklist

1. Confirm the working tree is clean.
2. Run `pnpm build && pnpm typecheck && pnpm lint && pnpm test`.
...
```

| Field | Required | Notes |
| --- | --- | --- |
| `name` | no | Defaults to the directory or file name. Normalised to kebab-case. |
| `description` | no | Defaults to the first prose line. Shown in the prompt; keep it under one sentence. |
| `when-to-use` | no | Extra routing hint for the model. `whenToUse` and `when_to_use` also work. |

Only a deliberately small frontmatter subset is parsed: `key: value` pairs between `---` fences,
optionally quoted. Anything else stays part of the body, so skills may use whatever markdown
structure they like.

A copyable example lives in
[`examples/skills/release-checklist`](https://github.com/kestrel-dev/kestrel/tree/main/examples/skills/release-checklist).

## Authoring and linting

`kestrel skills new` writes a scaffold into the first configured directory:

```bash
kestrel skills new release-checklist \
  --description "Publish a release safely." \
  --when "cutting a tag" \
  --workspace /srv/app
```

The name is normalized to kebab-case, an existing file is never overwritten, and the generated
frontmatter plus body pass `kestrel skills lint` unchanged.

`kestrel skills lint` checks every candidate file, including ones the runtime would silently skip.
It exits `1` when there is at least one error, which makes it usable in CI.

| Code | Level | Meaning |
| --- | --- | --- |
| `workspace-missing` | error | The workspace path does not exist. |
| `directory-escape` | error | A configured directory resolves outside the workspace. |
| `file-missing` | error | A skill directory has no `SKILL.md`. |
| `path-escape` | error | The file resolves outside the workspace, for example through a symlink. |
| `empty-body` | error | Frontmatter exists but nothing follows it. |
| `name-invalid` | error | The normalized name does not match `[a-z0-9][a-z0-9._-]*`. |
| `duplicate-name` | error | Two files claim the same skill; only the first is loaded. |
| `no-frontmatter` | warning | Name and description are inferred from the path and first line. |
| `no-description` | warning | The prompt will use the first body line. |
| `name-mismatch` | warning | Directory/file name and frontmatter `name` disagree. |
| `name-normalized` | warning | The raw name was rewritten to kebab-case. |
| `description-long` | warning | The prompt truncates descriptions at 240 characters. |
| `too-large` | warning | The runtime reads only `maxSkillBytes`. |

`--json` emits the full report (`workspace`, per-file `issues`, counts) for other tools.

## The `use_skill` tool

| Argument | Behaviour |
| --- | --- |
| `name` | Returns the skill body, prefixed with `# Skill: <name>`. |
| omitted | Lists the available skills, useful when the model wants to check again. |
| unknown | Returns `isError: true` with the available names. |

Loaded skills are recorded on the session under `skills.loaded`, so other plugins (telemetry,
policy checks, UI badges) can see what a run pulled in without re-reading the workspace.

## Configuration

```json
{
  "plugins": {
    "config": {
      "@kestrel/plugin-skills": {
        "directories": [".kestrel/skills", "skills"],
        "maxSkillBytes": 64000,
        "maxSkills": 100,
        "toolName": "use_skill"
      }
    }
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `directories` | `[".kestrel/skills", "skills"]` | Workspace-relative scan roots, highest priority first. |
| `maxSkillBytes` | `64000` | Bytes read per skill. Larger files are truncated, never dropped. |
| `maxSkills` | `100` | Catalogue budget per workspace. |
| `toolName` | `use_skill` | Tool name, for workspaces that need to avoid a clash. |

## Consuming skills from another plugin

The plugin provides a `skills` service:

```ts
import type { SkillService } from "@kestrel/plugin-skills";

export default {
  name: "@acme/plugin-skill-metrics",
  version: "0.1.0",
  inject: ["skills"],
  apply(context) {
    const skills = context.get("skills");
    context.effect(() =>
      context.on("session/event", (event) => {
        if (event.type !== "tool.finished" || event.result.name !== "use_skill") return;
        // skills.list(workspace) / skills.load(workspace, name) are available here
      }),
    );
  },
};
```

`list()` returns summaries; `load()` returns the body plus `truncated` and byte count. Both are
synchronous and cached by mtime, so calling them per session is cheap.

## Safety

- Discovery never leaves the workspace: directory traversal and symlinks pointing outside the
  session workspace are rejected with a warning.
- Skill text is injected as project guidance, and the layer says so explicitly. It cannot
  override the base identity or safety rules.
- Nothing is executed. A skill is text; if it tells the model to run a command, that command still
  goes through the normal tool permission path.

## When to use a skill, a tool or a plugin

| You want to… | Build |
| --- | --- |
| Teach a procedure: how to release, migrate, review, triage | A skill |
| Give the agent a new action: run a command, call an API | A tool plugin |
| Give the agent a new capability that is not a tool: a model, a memory store, a UI | A plugin with a service |
| Change what every session sees before it starts | A prompt layer |
