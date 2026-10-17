import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStore, generateToken } from "../src/auth.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function store(): Promise<{ store: AuthStore; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-auth-"));
  const auth = new AuthStore(directory);
  await auth.load();
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return { store: auth, directory };
}

describe("AuthStore", () => {
  it("starts with a default tenant and no users", async () => {
    const { store: auth } = await store();

    expect(auth.listTenants().map((tenant) => tenant.id)).toEqual(["default"]);
    expect(auth.listUsers()).toEqual([]);
    expect(await auth.countUsers()).toBe(0);
  });

  it("creates a user whose token verifies exactly once", async () => {
    const { store: auth } = await store();
    const created = await auth.createUser({ name: "Ada", role: "admin" });

    expect(created.token.startsWith("kst_")).toBe(true);
    expect(created.user).toMatchObject({ name: "Ada", role: "admin", tenantId: "default", disabled: false });
    expect(created.user).not.toHaveProperty("tokenHash");
    expect(auth.verify(created.token)).toMatchObject({ name: "Ada", role: "admin" });
    expect(auth.verify(`${created.token}x`)).toBeUndefined();
    expect(auth.verify(undefined)).toBeUndefined();
    expect(auth.verify("")).toBeUndefined();
  });

  it("does not store the token in clear text", async () => {
    const { store: auth, directory } = await store();
    const created = await auth.createUser({ name: "Ada" });

    const raw = await readFile(join(directory, "auth", "accounts.json"), "utf8");
    expect(raw).not.toContain(created.token);
    expect(JSON.parse(raw).users[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects duplicate names inside a tenant but allows them across tenants", async () => {
    const { store: auth } = await store();
    const other = await auth.createTenant("Acme");
    await auth.createUser({ name: "Ada" });

    await expect(auth.createUser({ name: "Ada" })).rejects.toThrow(/already exists/);
    await expect(auth.createUser({ name: "Ada", tenantId: other.id })).resolves.toBeDefined();
  });

  it("rejects unknown tenants", async () => {
    const { store: auth } = await store();
    await expect(auth.createUser({ name: "Ada", tenantId: "nope" })).rejects.toThrow(/Unknown tenant/);
  });

  it("disables a user without deleting the record", async () => {
    const { store: auth } = await store();
    const created = await auth.createUser({ name: "Ada" });

    await auth.setDisabled(created.user.id, true);
    expect(auth.verify(created.token)).toBeUndefined();
    expect(auth.listUsers()).toHaveLength(1);

    await auth.setDisabled(created.user.id, false);
    expect(auth.verify(created.token)).toBeDefined();
  });

  it("rotating a token invalidates the previous one", async () => {
    const { store: auth } = await store();
    const created = await auth.createUser({ name: "Ada" });

    const rotated = await auth.rotateToken(created.user.id);
    expect(rotated?.token).not.toBe(created.token);
    expect(auth.verify(created.token)).toBeUndefined();
    expect(auth.verify(rotated?.token)).toMatchObject({ id: created.user.id });
  });

  it("imports a bootstrap token verbatim and only once", async () => {
    const { store: auth } = await store();
    const token = generateToken();

    expect(await auth.bootstrap(token, "Root")).toBe(true);
    expect(auth.verify(token)).toMatchObject({ name: "Root", role: "admin" });
    expect(await auth.bootstrap(generateToken(), "Second")).toBe(false);
    expect(auth.listUsers()).toHaveLength(1);
  });

  it("persists tenants and users across reloads", async () => {
    const { store: auth, directory } = await store();
    const tenant = await auth.createTenant("Acme");
    const created = await auth.createUser({ name: "Ada", tenantId: tenant.id });

    const reloaded = new AuthStore(directory);
    await reloaded.load();
    expect(reloaded.listTenants().map((entry) => entry.id)).toContain(tenant.id);
    expect(reloaded.verify(created.token)).toMatchObject({ name: "Ada", tenantId: tenant.id });
  });

  it("derives a safe slug and keeps tenant ids unique", async () => {
    const { store: auth } = await store();
    const first = await auth.createTenant("Acme Corp!");
    const second = await auth.createTenant("Acme Corp!");

    expect(first.id).toBe("acme-corp");
    expect(second.id).toBe("acme-corp-1");
  });
});
