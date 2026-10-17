import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PrincipalInfo, TenantInfo } from "@kestrel/protocol";
import type { KestrelConfig } from "./config.js";

export type Role = "admin" | "member";
export type AuthMode = "none" | "token" | "accounts";

/** The authenticated caller for one request. */
export interface Principal extends PrincipalInfo {
  /** Human-readable hint identifying which token was used. */
  tokenHint?: string;
}

export interface TenantRecord extends TenantInfo {
  createdAt: string;
}

export interface UserRecord {
  id: string;
  name: string;
  email?: string;
  role: Role;
  tenantId: string;
  createdAt: string;
  disabled: boolean;
  /** First characters of the token, so an operator can tell tokens apart. */
  tokenHint: string;
}

interface StoredUser extends UserRecord {
  /** SHA-256 of the full token. Tokens are 256-bit random, so this is one-way in practice. */
  tokenHash: string;
}

interface AccountsFile {
  version: 1;
  tenants: TenantRecord[];
  users: StoredUser[];
}

export interface CreatedUser {
  user: UserRecord;
  /** Returned exactly once; the server only keeps its hash. */
  token: string;
}

export interface CreateUserInput {
  name: string;
  email?: string;
  role?: Role;
  tenantId?: string;
  /** Import an existing token instead of generating one (bootstrap, migrations). */
  token?: string;
  disabled?: boolean;
}

const DEFAULT_TENANT = "default";
const SAFE_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const TOKEN_PREFIX = "kst_";

/**
 * Accounts and tenants, persisted as one JSON document.
 *
 * The store is intentionally small and inspectable. It suits a single server
 * process; a deployment that runs several replicas should back the same
 * interface with a shared database.
 */
export class AuthStore {
  private readonly file: string;
  private state: AccountsFile = { version: 1, tenants: [], users: [] };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.file = join(directory, "auth", "accounts.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as AccountsFile;
      this.state = {
        version: 1,
        tenants: Array.isArray(parsed.tenants) ? parsed.tenants : [],
        users: Array.isArray(parsed.users) ? parsed.users : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.ensureDefaultTenant();
  }

  listTenants(): TenantRecord[] {
    return this.state.tenants.map((tenant) => ({ ...tenant }));
  }

  tenant(id: string): TenantRecord | undefined {
    const found = this.state.tenants.find((tenant) => tenant.id === id);
    return found ? { ...found } : undefined;
  }

  listUsers(): UserRecord[] {
    return this.state.users.map(sanitize);
  }

  user(id: string): UserRecord | undefined {
    const found = this.state.users.find((user) => user.id === id);
    return found ? sanitize(found) : undefined;
  }

  async createTenant(name: string): Promise<TenantRecord> {
    const trimmed = name.trim();
    if (!trimmed) throw new AuthError("invalid_tenant", "Tenant name cannot be empty.");
    const slug = slugify(trimmed);
    let id = slug;
    let suffix = 1;
    while (this.state.tenants.some((tenant) => tenant.id === id)) {
      id = `${slug}-${suffix++}`;
    }
    const tenant: TenantRecord = { id, name: trimmed, createdAt: new Date().toISOString() };
    this.state.tenants.push(tenant);
    await this.persist();
    return { ...tenant };
  }

  async createUser(input: CreateUserInput): Promise<CreatedUser> {
    const name = input.name.trim();
    if (!name) throw new AuthError("invalid_user", "User name cannot be empty.");
    const tenantId = input.tenantId ?? DEFAULT_TENANT;
    if (!this.tenant(tenantId)) {
      throw new AuthError("unknown_tenant", `Unknown tenant "${tenantId}".`);
    }
    if (this.state.users.some((user) => user.tenantId === tenantId && user.name === name)) {
      throw new AuthError("duplicate_user", `A user named "${name}" already exists in this tenant.`);
    }

    const token = input.token ?? generateToken();
    const stored: StoredUser = {
      id: randomBytes(8).toString("hex"),
      name,
      email: input.email?.trim() || undefined,
      role: input.role ?? "member",
      tenantId,
      createdAt: new Date().toISOString(),
      disabled: input.disabled ?? false,
      tokenHint: tokenHint(token),
      tokenHash: hashToken(token),
    };
    this.state.users.push(stored);
    await this.persist();
    return { user: sanitize(stored), token };
  }

  async deleteUser(id: string): Promise<boolean> {
    const index = this.state.users.findIndex((user) => user.id === id);
    if (index < 0) return false;
    this.state.users.splice(index, 1);
    await this.persist();
    return true;
  }

  async setDisabled(id: string, disabled: boolean): Promise<UserRecord | undefined> {
    const found = this.state.users.find((user) => user.id === id);
    if (!found) return undefined;
    found.disabled = disabled;
    await this.persist();
    return sanitize(found);
  }

  async rotateToken(id: string): Promise<{ user: UserRecord; token: string } | undefined> {
    const found = this.state.users.find((user) => user.id === id);
    if (!found) return undefined;
    const token = generateToken();
    found.tokenHash = hashToken(token);
    found.tokenHint = tokenHint(token);
    await this.persist();
    return { user: sanitize(found), token };
  }

  /**
   * Verifies a bearer token. Every account is compared, in full, so a match
   * cannot be distinguished from a miss by timing on the loop itself.
   */
  verify(token: string | undefined): Principal | undefined {
    if (!token) return undefined;
    const digest = Buffer.from(hashToken(token), "hex");
    let match: StoredUser | undefined;
    for (const user of this.state.users) {
      const candidate = Buffer.from(user.tokenHash, "hex");
      const equal = candidate.length === digest.length && timingSafeEqual(candidate, digest);
      if (equal) match ??= user;
    }
    if (!match || match.disabled) return undefined;
    return principalOf(match);
  }

  /** Creates the first administrator, or returns false when users already exist. */
  async bootstrap(token: string, name = "Admin"): Promise<boolean> {
    if (this.state.users.length > 0) return false;
    await this.createUser({ name, role: "admin", tenantId: DEFAULT_TENANT, token });
    return true;
  }

  async countUsers(): Promise<number> {
    return this.state.users.length;
  }

  private ensureDefaultTenant(): void {
    if (this.state.tenants.some((tenant) => tenant.id === DEFAULT_TENANT)) return;
    this.state.tenants.unshift({
      id: DEFAULT_TENANT,
      name: "Default",
      createdAt: new Date().toISOString(),
    });
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(
      { ...this.state, tenants: this.state.tenants, users: this.state.users },
      null,
      2,
    );
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temp, `${snapshot}\n`, "utf8");
      await rename(temp, this.file);
    });
    await this.writeChain;
  }
}

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthService {
  readonly mode: AuthMode;
  authenticate(token: string | undefined): Principal | undefined;
  /** Present only in `accounts` mode. */
  readonly store?: AuthStore;
}

export const OPERATOR: Principal = {
  id: "operator",
  name: "Operator",
  role: "admin",
  tenantId: DEFAULT_TENANT,
};

/**
 * Resolves the configured authentication mode. `token` preserves the v0.1
 * single-operator model; `accounts` adds users and tenant isolation.
 */
export async function createAuthService(
  config: KestrelConfig,
  dataDirectory: string,
): Promise<AuthService> {
  const mode = resolveMode(config);
  if (mode === "none") {
    return { mode, authenticate: () => OPERATOR };
  }
  if (mode === "token") {
    const expected = config.server.token?.trim();
    if (!expected) {
      throw new Error('Auth mode "token" requires `server.token` (or set auth.mode to "none").');
    }
    return {
      mode,
      authenticate: (token) =>
        token && constantTimeEqual(token, expected) ? OPERATOR : undefined,
    };
  }

  const store = new AuthStore(dataDirectory);
  await store.load();
  if ((await store.countUsers()) === 0) {
    const bootstrap = process.env.KESTREL_BOOTSTRAP_TOKEN?.trim() || config.auth?.bootstrapToken?.trim();
    if (!bootstrap) {
      throw new Error(
        "Auth mode \"accounts\" has no users. Create one with `kestrel users create --role admin`, " +
          "or set auth.bootstrapToken (env: KESTREL_BOOTSTRAP_TOKEN) for the first start.",
      );
    }
    await store.bootstrap(bootstrap, config.auth?.bootstrapName ?? "Admin");
  }
  return { mode, store, authenticate: (token) => store.verify(token) };
}

export function resolveMode(config: KestrelConfig): AuthMode {
  const explicit = config.auth?.mode;
  if (explicit) return explicit;
  return config.server.token?.trim() ? "token" : "none";
}

/** Tenant workspace roots: explicit config wins, then the legacy workspace, then a per-tenant dir. */
export function tenantWorkspace(
  config: KestrelConfig,
  dataDirectory: string,
  tenantId: string,
  fallbackWorkspace: string,
): string {
  const configured = config.auth?.workspaces?.[tenantId];
  if (configured) return configured;
  if (tenantId === DEFAULT_TENANT) return fallbackWorkspace;
  return join(dataDirectory, "tenants", tenantId, "workspace");
}

export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenHint(token: string): string {
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

function principalOf(user: StoredUser): Principal {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId,
    email: user.email,
    tokenHint: user.tokenHint,
  };
}

function sanitize(user: StoredUser): UserRecord {
  const { tokenHash: _hash, ...rest } = user;
  return { ...rest };
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (SAFE_ID.test(slug)) return slug;
  return `tenant-${randomBytes(4).toString("hex")}`;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

export { DEFAULT_TENANT };
