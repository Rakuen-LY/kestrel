# Process sandbox

By default the `shell` tool spawns commands in the server process, with the session workspace as the
initial directory. That is convenient and appropriate for a trusted local operator. When commands
are not trusted — running generated code, tests from an unfamiliar repository, or an unattended agent
with network access — install `@kestrel/plugin-sandbox-docker`. Every shell command then runs in a
fresh Docker container with only the workspace bind-mounted.

```json
{
  "plugins": {
    "config": {
      "@kestrel/plugin-sandbox-docker": {
        "enabled": true,
        "image": "node:22-bookworm",
        "network": "none",
        "memory": "2g",
        "cpus": "2"
      }
    }
  }
}
```

The plugin is discovered on every server but stays inactive until `enabled` is `true`, so a missing
Docker daemon never breaks a normal installation. Once enabled it provides the `sandbox` service;
`@kestrel/plugin-tools-core` prefers it whenever it exists and records `sandbox: "docker"` in the tool
result.

## What is isolated

- Each call is a new container (`docker run --rm`), so shell state, processes and `/tmp` do not leak
  between commands.
- Only the session workspace is mounted, read-write, at the same absolute path. The container cannot
  see the server's home directory, `.env` files outside the workspace, the Docker socket, or other
  tenants' workspaces.
- `--network none` is the default, so generated code cannot reach the network unless you opt in.
- The container runs as the server's `uid:gid` on Linux, so files written into the mounted workspace
  stay owned by the server user. `HOME` points at `/tmp`.
- `memory` and `cpus` map to Docker limits when set.

## What is not isolated

- **File tools still run on the host.** `read_file`, `write_file`, `edit_file`, `glob` and `grep` are
  not routed through the sandbox yet. The workspace they see is the same directory the container
  mounts, but a path that escapes the workspace is not blocked by the container. Keep
  `restrictToWorkspace` at its default and treat the workspace as the trust boundary.
- **No seccomp or capability tuning beyond Docker's defaults.** Harden the image and the daemon if
  your threat model needs it.
- **No persistent container.** A command cannot leave a daemon running for the next call. Long-lived
  services belong outside the agent or in a compose stack you manage.
- **Docker access is root-equivalent.** The server user must be allowed to talk to the Docker daemon.
  That is a significant privilege; do not give it to an agent process you would not trust with root.

## Failure behaviour

The sandbox fails closed. If the Docker CLI is missing, the daemon is unreachable, or the image cannot
be started, the shell tool returns an error; it never falls back to executing on the host. The plugin
logs the reason at startup and probes again on each call, so starting Docker after the server is safe.

## Images

The image must be Linux and provide a POSIX `sh`; `node:22-bookworm` is a reasonable default for
JavaScript projects, `python:3.12-slim` for Python, and `debian:bookworm-slim` for a minimal base.
Pre-pull the image in the deployment pipeline so the first tool call does not block on a large
download. Windows containers are not supported; Docker Desktop with Linux containers works on macOS
and Windows, subject to Docker's path-sharing rules for the workspace drive.

## Writing another sandbox

A sandbox is a small interface from `@kestrel/agent`, so a Kubernetes pod, Firecracker microVM or
remote executor can replace Docker without touching tools:

```ts
import type { Sandbox, SandboxExecOptions, SandboxExecResult } from "@kestrel/agent";

export class PodSandbox implements Sandbox {
  readonly name = "kubernetes";

  async exec(options: SandboxExecOptions): Promise<SandboxExecResult> {
    // Run options.command with options.workspace mounted, honour options.timeoutMs
    // and options.signal, and return captured output.
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  }
}
```

Register it with `context.provide("sandbox", sandbox)`. The tools layer calls `exec` per command and
does not care where it runs.
