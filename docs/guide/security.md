# Security

An agent with a shell is a remote execution system with a language model in front of it. Treat it
accordingly. This page states what Kestrel does and does not protect against, so you can choose the
right deployment boundary.

## Threat model

In scope:

- A remote attacker reaching the HTTP API without a token.
- An agent being manipulated by content it reads (prompt injection) into destructive actions.
- A malicious or buggy plugin running with the privileges of the server process.
- Secrets leaking into logs, transcripts or responses.

Out of scope for the current release:

- A determined attacker with code execution inside the process. Plugins are not sandboxed.
- Isolation between tenants that share one process. Accounts mode scopes sessions, workspaces and
  event streams per tenant, but every tenant still runs the same plugins in the same process and a
  platform administrator can read every tenant. Deploy one server per trust boundary if that is not
  enough; see [Authentication and tenants](/guide/authentication).
- Kernel-level escapes from the container you choose to run.

## Exposure checklist

Before binding to anything other than loopback:

1. Require a credential: `KESTREL_TOKEN` for a single operator, or `auth.mode: "accounts"` with
   per-user tokens. Without either the API is unauthenticated.
2. Terminate TLS at a proxy; do not send bearer tokens over plain HTTP.
3. Set explicit `corsOrigins`; the default `*` is for local development.
4. Keep the console behind the same proxy. It is a static client, not an auth boundary.
5. Run in a container or VM with only the workspace mounted.
6. Do not mount the Docker socket, SSH agent or cloud credentials.
7. Review every plugin you install.

`GET /api/health` and static files are public by design. Everything else requires the token.

## Workspace confinement

File tools resolve paths against the session workspace and reject lexical escapes (`../`,
absolute paths outside the root). They do **not** resolve symlinks. A symlink inside the workspace
that points outside it will be followed. If that matters, run the agent in a container where the
workspace is the only mount, or mount with `nosymfollow` (Linux 5.10+).

`shell` is confined by neither policy. It runs a shell with the workspace as the initial directory;
the command can `cd` anywhere the process can read. Approvals are a speed bump, not a sandbox. Install
[`@kestrel/plugin-sandbox-docker`](/guide/sandbox) to run shell commands in disposable containers with
only the workspace mounted; file tools still run in the server process.

Recommendations:

- Use a dedicated container per trust boundary.
- Run as a non-root user (the image does).
- Set `readOnlyRootFilesystem` and mount only the workspace (the Kubernetes base does).
- Drop capabilities; do not add `SYS_ADMIN` or `docker`.
- Set CPU and memory limits so a runaway command cannot starve the host.

## Prompt injection

Tool output, fetched pages, repository files and dependency READMEs are untrusted input. The default
system prompt tells the model to treat them as data, but that is mitigation, not a guarantee.

Practical controls:

- Keep `shell` and `web_fetch` at `ask` for interactive use.
- Use a `resolvePermission` policy to auto-approve read-only commands and block the rest.
- Run unattended agents in a disposable container with no credentials and no network egress beyond
  the model endpoint.
- Review diffs before merging; the agent's own summary is not evidence.

Tool results are truncated and never executed. There is no template evaluation or shell
interpolation of model output outside the `shell` tool, where it is the entire point.

## Secrets

- Configuration supports `apiKeyEnv` so keys live in the environment, not in JSON.
- `/api/config` returns a sanitized view: no tokens or provider keys.
- Errors returned to clients are generic for 500s; details go to the log.
- Transcripts contain whatever the model saw, including file contents and tool output. Treat
  `.kestrel/sessions` as sensitive.

Do not put secrets in a workspace the agent can read unless the task requires it. If the agent must
handle credentials, scope them to a throwaway environment.

## Plugins

Plugins run in-process with full Node privileges: filesystem, network, child processes. The manifest
cannot restrict this. Consequences:

- Install plugins the way you install npm packages: from sources you trust, pinned by version.
- Use `plugins.allow` when the plugin directory is writable by another process.
- The `applyTimeoutMs` guard limits startup hangs, not runtime behaviour.
- A plugin can register a tool with any permission level, including `auto` for destructive actions.

### Browser bundles

A plugin's `web` bundle runs in a sandboxed iframe served by the API. `sandbox="allow-scripts"`
gives it an opaque origin, so it cannot read the console's storage, cookies or DOM, and CSP blocks
direct network access. API calls are proxied through the console, which attaches the bearer token
outside the sandbox.

- Review browser bundles with the same care as server-side plugin code: the sandbox prevents token
  theft, not misuse of the user's API privileges.
- Assets are public and served only for active plugins; traversal outside `<plugin>/web` is rejected.
- The sandbox allows scripts and styles from the API origin only; there is no CDN or remote font
  access.
- Each extension gets its own iframe, and discovery runs the bundle once more. Keep bundles small.
- Per-plugin API capability grants are a roadmap item; today the proxy exposes the same routes the
  user can call.

There is no plugin signature or registry yet. That is a roadmap item; until then, review the code.

## Authentication details

- Bearer tokens are compared in constant time.
- Tokens are accepted in the `Authorization` header, or as `?token=` for `EventSource` clients that
  cannot set headers. Query tokens can appear in proxy logs; prefer a reverse proxy that strips
  query strings from access logs.
- There is no user model, session cookie, rate limit or audit trail. Put Kestrel behind an
  authenticating proxy if multiple people need access.

## Reporting a vulnerability

Do not open a public issue for a security problem. Send a private report to the maintainers with:

- affected version or commit;
- a minimal reproduction;
- impact assessment;
- any suggested fix.

You will receive an acknowledgement, a triage decision and credit in the advisory unless you prefer
otherwise. Please allow time for a fix before disclosure.

## Hardening summary

| Control | Default | Recommended for remote use |
| --- | --- | --- |
| Bind address | `127.0.0.1` | Loopback behind a proxy |
| Auth | Off | `KESTREL_TOKEN` set |
| CORS | `*` | Explicit origins |
| Shell permission | `ask` | `ask` plus a policy |
| Web fetch | `ask` | `ask` or disabled |
| Workspace restriction | On (lexical) | Container boundary as well |
| Container user | `node` (uid 1000) | Non-root, read-only root |
| Secrets | Environment | Secret manager / env injection |
