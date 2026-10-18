import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChatMessage, SessionDetail } from "@kestrel/protocol";
import { ScriptedModel } from "@kestrel/testkit";
import { createHttpServer } from "../src/http.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

beforeAll(() => {
  process.env.KESTREL_LOG_LEVEL ??= "silent";
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function boot(): Promise<{ base: string; runtime: Runtime; workspace: string; close(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-rewind-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const configPath = join(root, "kestrel.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      server: { host: "127.0.0.1", port: 0 },
      model: { default: "scripted", maxSteps: 4 },
      agent: { workspace },
      plugins: { directories: [join(root, "plugins")] },
      storage: { directory: join(root, "data") },
      checkpoints: { enabled: true },
    }),
  );
  const runtime = await createRuntime({ configPath });
  runtime.models.register(new ScriptedModel([{ content: "done" }]), { setDefault: true });
  const server: Server = createHttpServer(runtime);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    runtime,
    workspace,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

async function createSession(base: string): Promise<string> {
  const response = await fetch(`${base}/api/sessions`, { method: "POST", body: JSON.stringify({}) });
  expect(response.status).toBe(201);
  return ((await response.json()) as { session: { id: string } }).session.id;
}

async function detail(base: string, id: string): Promise<SessionDetail> {
  const response = await fetch(`${base}/api/sessions/${id}`);
  return ((await response.json()) as { session: SessionDetail }).session;
}

async function send(base: string, id: string, content: string): Promise<ChatMessage[]> {
  const response = await fetch(`${base}/api/sessions/${id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  expect(response.status).toBe(202);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const session = await detail(base, id);
    if (session.status !== "running") return session.messages;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("run did not finish");
}

describe("rewind", () => {
  it("truncates the transcript and restores the workspace before the message", async () => {
    const harness = await boot();
    cleanups.push(harness.close);
    const id = await createSession(harness.base);

    await writeFile(join(harness.workspace, "app.ts"), "one\n");
    const first = await send(harness.base, id, "first turn");
    const firstUserId = first[0].id;

    await writeFile(join(harness.workspace, "app.ts"), "two\n");
    const second = await send(harness.base, id, "second turn");
    const secondUserId = second[2].id;
    expect(second).toHaveLength(4);

    await writeFile(join(harness.workspace, "app.ts"), "three\n");

    const response = await fetch(`${harness.base}/api/sessions/${id}/rewind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: secondUserId }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      removed: number;
      messages: ChatMessage[];
      restored: { label: string; messageId?: string } | null;
      warning?: string;
    };

    expect(result.removed).toBe(2);
    expect(result.messages.map((message) => message.id)).toEqual([firstUserId, first[1].id]);
    expect((await detail(harness.base, id)).messages).toHaveLength(2);

    const checkpoints = await harness.runtime.checkpoints.status();
    if (checkpoints.enabled) {
      expect(result.restored?.messageId).toBe(secondUserId);
      expect(result.restored?.label).toContain("second turn");
      expect(await readFile(join(harness.workspace, "app.ts"), "utf8")).toBe("two\n");
    } else {
      expect(result.warning).toBeDefined();
    }
  });

  it("rejects unknown and non-user targets", async () => {
    const harness = await boot();
    cleanups.push(harness.close);
    const id = await createSession(harness.base);
    const messages = await send(harness.base, id, "hello");

    const unknown = await fetch(`${harness.base}/api/sessions/${id}/rewind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "nope" }),
    });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("message_not_found");

    const assistant = await fetch(`${harness.base}/api/sessions/${id}/rewind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: messages[1].id }),
    });
    expect(assistant.status).toBe(400);
    expect(((await assistant.json()) as { error: { code: string } }).error.code).toBe("invalid_rewind_target");
  });

  it("can skip file restoration", async () => {
    const harness = await boot();
    cleanups.push(harness.close);
    const id = await createSession(harness.base);
    const messages = await send(harness.base, id, "hello");

    const response = await fetch(`${harness.base}/api/sessions/${id}/rewind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: messages[0].id, restoreFiles: false }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { restored: unknown; messages: unknown[] };
    expect(result.restored).toBeNull();
    expect(result.messages).toEqual([]);
  });
});
