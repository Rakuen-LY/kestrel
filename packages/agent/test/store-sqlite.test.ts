import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSessionStore } from "../src/index.js";
import type { SessionDetail } from "@kestrel/protocol";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function store(): Promise<{ sessions: SqliteSessionStore; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-sqlite-"));
  const file = join(root, "nested", "kestrel.db");
  const sessions = new SqliteSessionStore(file);
  cleanups.push(async () => {
    await sessions.close();
    await rm(root, { recursive: true, force: true });
  });
  return { sessions, file };
}

function detail(id: string, title: string, extra: Partial<SessionDetail> = {}): SessionDetail {
  const now = new Date().toISOString();
  return {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    status: "idle",
    model: "test",
    messageCount: 0,
    workspace: "/tmp",
    messages: [],
    systemPrompt: "prompt",
    ...extra,
  };
}

describe("SqliteSessionStore", () => {
  it("round-trips a session including its transcript", async () => {
    const { sessions } = await store();
    const session = detail("s1", "first", {
      messageCount: 2,
      messages: [
        { id: "m1", role: "user", content: "hello", createdAt: new Date().toISOString() },
        {
          id: "m2",
          role: "user",
          content: "see this",
          createdAt: new Date().toISOString(),
          images: [{ mimeType: "image/png", data: "AAAA", name: "a.png" }],
        },
      ],
    });

    await sessions.save(session);
    expect(await sessions.load("s1")).toEqual(session);
  });

  it("lists newest first without loading transcripts", async () => {
    const { sessions } = await store();
    await sessions.save(detail("old", "Old", { updatedAt: "2024-01-01T00:00:00.000Z" }));
    await sessions.save(
      detail("new", "New", { updatedAt: "2024-06-01T00:00:00.000Z", depth: 1, parentId: "old", role: "researcher" }),
    );

    const list = await sessions.list();
    expect(list.map((session) => session.id)).toEqual(["new", "old"]);
    expect(list[0]).toMatchObject({ title: "New", parentId: "old", depth: 1, role: "researcher" });
  });

  it("isolates tenants and omits the default tenant from summaries", async () => {
    const { sessions } = await store();
    await sessions.save(detail("shared", "Default copy"));
    await sessions.save(detail("shared", "Tenant copy", { tenantId: "acme" }));

    expect((await sessions.load("shared"))?.title).toBe("Default copy");
    expect((await sessions.load("shared", "acme"))?.title).toBe("Tenant copy");
    expect(await sessions.load("shared", "other")).toBeUndefined();

    const summaries = await sessions.list();
    expect(summaries.find((session) => session.title === "Default copy")?.tenantId).toBeUndefined();
    expect(summaries.find((session) => session.title === "Tenant copy")?.tenantId).toBe("acme");
  });

  it("survives a reopen", async () => {
    const { sessions, file } = await store();
    await sessions.save(detail("kept", "Persisted", { messageCount: 1 }));
    await sessions.close();

    const reopened = new SqliteSessionStore(file);
    cleanups.push(() => reopened.close());
    expect((await reopened.load("kept"))?.title).toBe("Persisted");
    expect((await stat(file)).size).toBeGreaterThan(0);
  });

  it("deletes only the addressed tenant's row", async () => {
    const { sessions } = await store();
    await sessions.save(detail("both", "Default"));
    await sessions.save(detail("both", "Acme", { tenantId: "acme" }));

    await sessions.delete("both");
    expect(await sessions.load("both")).toBeUndefined();
    expect((await sessions.load("both", "acme"))?.title).toBe("Acme");
  });

  it("upserts on repeated saves", async () => {
    const { sessions } = await store();
    await sessions.save(detail("one", "first"));
    await sessions.save(detail("one", "second"));
    expect((await sessions.list())).toHaveLength(1);
    expect((await sessions.load("one"))?.title).toBe("second");
  });
});
