import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "../src/index.js";
import type { SessionDetail } from "@kestrel/protocol";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function store(): Promise<{ sessions: FileSessionStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-store-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return { sessions: new FileSessionStore(root), root };
}

function detail(id: string, title: string): SessionDetail {
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
  };
}

describe("FileSessionStore", () => {
  it("applies queued writes in order", async () => {
    const { sessions } = await store();

    void sessions.save(detail("one", "first"));
    void sessions.save(detail("one", "second"));
    await sessions.save(detail("one", "third"));

    expect((await sessions.load("one"))?.title).toBe("third");
  });

  it("flush() is a durability barrier for fire-and-forget writes", async () => {
    const { sessions } = await store();

    for (let index = 0; index < 5; index += 1) {
      void sessions.save(detail("two", `title-${index}`));
    }
    await sessions.flush();

    expect((await sessions.load("two"))?.title).toBe("title-4");
  });

  it("leaves no temporary files behind", async () => {
    const { sessions, root } = await store();
    await sessions.save(detail("three", "done"));

    expect(await readdir(join(root, "sessions/three"))).toEqual(["session.json"]);
  });
});
