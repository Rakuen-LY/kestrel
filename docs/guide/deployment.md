# Deployment

Kestrel is one Node process with two ports of interest: the HTTP API and the SSE stream on the same
listener. Any platform that can run a container or a Node 22 service can host it. This page covers
the shapes we test and the operational details that are easy to get wrong.

## Choosing a target

| Target | Good for | Notes |
| --- | --- | --- |
| `node apps/server/dist/bin.js` | Development, single-user desktop | No service supervision; use systemd/launchd for uptime. |
| Docker | Reproducible single node | Image includes git and curl for the shell tool. |
| Compose | Local team instance | Token required, workspace and data mounted. |
| Kubernetes | Shared internal deployment | Single replica today; see scaling. |
| systemd | Linux servers | Hardened unit included. |
| launchd | macOS | Per-user agent, logs under `~/Library` or a shared path. |
| Scheduled Task | Windows | Included PowerShell installer. |

## Docker

```bash
docker build -t kestrel .
docker run --rm -p 127.0.0.1:7331:7331 \
  -e KESTREL_TOKEN="$(openssl rand -hex 24)" \
  -e OPENAI_API_KEY=sk-... \
  -v "$PWD/workspace:/workspace" \
  -v kestrel-data:/data \
  kestrel
```

The image runs as the unprivileged `node` user (uid 1000). `/workspace` is where tools operate;
`/data` holds transcripts. Mount a project directory, never the Docker socket.

### Compose

```bash
cp .env.example .env
# edit KESTREL_TOKEN and provider keys
mkdir -p workspace
docker compose up -d --build
docker compose logs -f kestrel
```

Compose binds to `127.0.0.1` by default. Put a TLS-terminating proxy in front for remote access.

## Kubernetes

The manifests in `deploy/k8s` are a kustomize base:

```bash
kubectl create namespace kestrel
kubectl -n kestrel create secret generic kestrel-secrets \
  --from-literal=KESTREL_TOKEN="$(openssl rand -hex 24)" \
  --from-literal=OPENAI_API_KEY=sk-...
kubectl apply -k deploy/k8s
```

What the base sets:

- `runAsNonRoot`, uid/gid 1000, `seccompProfile: RuntimeDefault`.
- `readOnlyRootFilesystem` with emptyDir mounts for `/tmp`.
- Separate PVCs for `/data` (transcripts) and `/workspace` (the project).
- Liveness and readiness probes against `/api/health`.
- `Recreate` strategy, because both PVCs are `ReadWriteOnce` and the in-memory event buffer is
  process-local.
- Ingress annotations that disable proxy buffering and extend timeouts for SSE.

### Scaling

The current architecture assumes a single writer:

- sessions and the event replay buffer live in process memory;
- the file store is not safe for concurrent writers across pods;
- approvals are held in memory.

Run **one replica**. If you need more, the path is a shared `SessionStore` (Postgres/Redis), a
shared event bus, and sticky routing for SSE. Those are roadmap items, not configuration flags.

## systemd

```bash
sudo useradd --system --home /opt/kestrel --shell /usr/sbin/nologin kestrel
sudo mkdir -p /opt/kestrel /etc/kestrel /var/lib/kestrel /srv/workspace
sudo chown -R kestrel:kestrel /opt/kestrel /var/lib/kestrel /srv/workspace
# copy the built repository to /opt/kestrel
sudo cp deploy/systemd/kestrel.service /etc/systemd/system/
sudo cp deploy/systemd/kestrel.env.example /etc/kestrel/kestrel.env
sudo chmod 600 /etc/kestrel/kestrel.env
sudo systemctl daemon-reload
sudo systemctl enable --now kestrel
journalctl -u kestrel -f
```

The unit uses `ProtectSystem=strict` and allows writes only to `/var/lib/kestrel` and
`/srv/workspace`. Add your own workspace path to `ReadWritePaths` if it differs.

## macOS (launchd)

```bash
sudo cp -R . /opt/kestrel
sudo mkdir -p /Users/Shared/kestrel-workspace /Users/Shared/kestrel-data
sudo cp deploy/launchd/dev.kestrel.agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/dev.kestrel.agent.plist
```

The example plist does not inject secrets. Put them in the plist's `EnvironmentVariables` (readable
by the user) or start through a wrapper that reads a protected file. Logs go to
`/Users/Shared/kestrel-data/`.

## Windows

Run `deploy/windows/install-task.ps1` from an elevated PowerShell prompt after copying the built
repository to `C:\kestrel`:

```powershell
.\install-task.ps1 -Workspace 'C:\src\my-app' -Token (New-Guid).Guid
```

It registers a scheduled task at logon, writes a launcher and an environment file under
`C:\ProgramData\kestrel`, and starts the server. For a true Windows service, wrap the same command
with NSSM or a similar service host.

## Reverse proxy

SSE needs three things: no response buffering, a long read timeout, and HTTP/1.1 keep-alive.

```nginx
location / {
  proxy_pass http://127.0.0.1:7331;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_buffering off;
  proxy_cache off;
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;
}
```

If the console shows repeated reconnects, buffering is the usual cause. Caddy works without extra
configuration; Traefik needs `buffering` disabled on the service.

The server binds to loopback by default. Keep it that way when a proxy is in front, and set
`KESTREL_TOKEN` even then.

## Persistence and backups

```
/data/sessions/<id>/session.json
```

Each session is a single JSON document written atomically. Back up the directory; restore it before
starting the process. A newer build ignores unknown fields and fills missing optional ones, so
downgrades are not guaranteed. There is no migration tool yet.

Memory notes live inside the workspace by default (`.kestrel/memory.json`), so back them up with the
project if they matter.

## Upgrades

1. Build the new image or copy the new build.
2. Stop the old process (SIGTERM; it cancels runs and disposes plugins).
3. Start the new one with the same `/data` and workspace mounts.

Sessions are forward-compatible within the same protocol major. A protocol change that removes
fields would require a migration; `/api/health` reports the protocol version so orchestrators can
gate a rollout.

## Observability

- Logs: structured lines; `KESTREL_LOG_FORMAT=json` for collectors.
- Health: `GET /api/health` includes uptime, plugin count and session count.
- Bootstrap: `GET /api/bootstrap` is a cheap way to assert models, tools and plugins after deploy.
- SSE: `/api/events` is an operator firehose; do not expose it publicly.

Metrics and tracing are not built in yet. The kernel's service ownership makes instrumentation
straightforward, but it is on the roadmap rather than in this release.

## Resource guidance

| Workload | CPU | Memory |
| --- | --- | --- |
| One developer, small repo | 0.25 core | 256 MB |
| Several sessions, large repo | 1 core | 1 GB |
| Shell-heavy builds | 2 cores | 2 GB |

The agent itself is I/O-bound; the shell tool inherits whatever the container allows. Set pod or
container limits so a runaway build cannot starve the host.
