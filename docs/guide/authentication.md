# Authentication and tenants

Kestrel runs in one of three authentication modes. The mode decides who may call the API and how
sessions are scoped.

| Mode | When to use it | Caller | Sessions |
| --- | --- | --- | --- |
| `none` | Loopback development, or a trusted proxy that already authenticates | A synthetic `Operator` (admin) | One tenant |
| `token` | Single operator on a shared network | A synthetic `Operator` (admin) | One tenant |
| `accounts` | Several people or teams, an open platform | A user with a role and a tenant | Isolated per tenant |

`none` and `token` are the v0.1 model and stay the default: nothing changes for an existing
deployment. `accounts` is opt-in and adds users, roles, tenants and per-tenant workspaces.

## Choosing a mode

`auth.mode` wins when set; otherwise a configured `server.token` means `token`, and no token means
`none`.

```json
{
  "auth": { "mode": "accounts" }
}
```

Environment variables override the file, which is convenient for containers:

| Variable | Meaning |
| --- | --- |
| `KESTREL_AUTH_MODE` | `none`, `token` or `accounts`. |
| `KESTREL_BOOTSTRAP_TOKEN` | First-run administrator token (accounts mode only). |
| `KESTREL_TOKEN` | Operator token (token mode). |

## Token mode

```json
{
  "server": { "token": "a-long-random-value" }
}
```

Every `/api/*` request needs `Authorization: Bearer <token>`. Browsers cannot set headers on
`EventSource`, so SSE endpoints also accept `?token=`. `GET /api/health` and the static console
remain public; the API they call does not.

## Accounts mode

### First run

Accounts mode refuses to start with no users, because an open API with no credentials is worse
than a failed boot. Bootstrap the first administrator in one of two ways:

```bash
# Option A: from the machine that owns the data directory
kestrel users create Ada --role admin

# Option B: let the server create it on first start
KESTREL_BOOTSTRAP_TOKEN=kst_... kestrel serve
```

Both paths print or accept a token once. The server stores only its SHA-256 hash.

### Managing users and tenants

The CLI reads the same data directory as the server:

```bash
kestrel tenants                          # list tenants and user counts
kestrel tenants create "Acme Corp"       # slugified id, e.g. acme-corp
kestrel users                            # list users (id, role, tenant, token hint)
kestrel users create Bob --role member --tenant acme-corp --email bob@example.com
kestrel users rotate Bob                 # invalidates the previous token
kestrel users delete Bob
```

The same operations are available over HTTP to an administrator:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/auth/me` | Caller, tenant and auth mode. |
| `GET` | `/api/users` | List users (never includes token hashes). |
| `POST` | `/api/users` | Create a user; the response contains the token **once**. |
| `POST` | `/api/users/:id/token` | Rotate a token; returns the new token once. |
| `DELETE` | `/api/users/:id` | Delete a user. |
| `GET` | `/api/tenants` | List tenants. |
| `POST` | `/api/tenants` | Create a tenant. |

Creating a user takes `{ "name", "email"?, "role"?, "tenantId"? }`. The role defaults to `member`
and the tenant to the caller's tenant.

### Roles

- **`member`** works inside one tenant: their own sessions, their tenant's workspace. The API hides
  every other tenant's sessions as `404`, not `403`, so ids cannot be probed.
- **`admin`** is a platform administrator: can create tenants and users, and can read and manage
  sessions in every tenant. Do not hand this role to ordinary users.

An administrator cannot delete the account they are currently using.

### Tenant isolation

Every session records a `tenantId`. Sessions are listed, fetched, cancelled and streamed within the
caller's tenant; `GET /api/events` filters events whose session belongs elsewhere.

Storage follows the same boundary:

```
<data>/
  sessions/<id>/session.json              # default tenant (v0.1 layout)
  tenants/<tenantId>/sessions/<id>/...    # every other tenant
  tenants/<tenantId>/workspace/           # default workspace for that tenant
  auth/accounts.json                      # tenants and users, hashed tokens
```

A member cannot choose a workspace: `POST /api/sessions` ignores `workspace` for them and uses the
tenant root. An administrator may still pass an explicit path. Override any tenant's root with:

```json
{
  "auth": {
    "mode": "accounts",
    "workspaces": { "acme-corp": "/srv/kestrel/acme" }
  }
}
```

Subagents inherit their parent's tenant, so delegation cannot widen access.

## Tokens

Tokens are `kst_` followed by 32 random bytes, base64url encoded (256 bits). Only the SHA-256 hash
and a display hint are stored; there is no way to recover a token, so rotate rather than look it up.

The console keeps the token in `localStorage` and shows a sign-in screen when the server answers
`401`. Signing out clears it.

## Operating notes

- **TLS is not optional.** Terminate it at a reverse proxy; bearer tokens over plain HTTP are
  readable by anyone on the path.
- **Rate limiting is not built in.** Add it at the proxy if the API is reachable from untrusted
  networks; failed authentication is cheap and unmetered.
- **Accounts are per process.** `auth/accounts.json` suits one server replica. Running several
  replicas requires a shared store behind the same interface.
- **Plugins are global.** Authentication scopes sessions and workspaces, not plugin code: every
  tenant runs the same plugins inside the same process. If tenants must not share a process, deploy
  one server per trust boundary.
- **Admins cross tenants by design.** If that is unacceptable, do not grant `admin` outside the
  operating team.

## Migrating from token mode

1. Set `auth.mode` to `accounts` and provide `KESTREL_BOOTSTRAP_TOKEN` (or create the admin first).
2. Start the server. Existing sessions in `<data>/sessions` are owned by the `default` tenant and
   remain visible to its members.
3. Remove `server.token` once every client uses an account token.

No file moves are needed: the default tenant deliberately keeps the v0.1 directory layout.
