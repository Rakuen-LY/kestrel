import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
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

interface Harness {
  base: string;
  runtime: Runtime;
  workspace: string;
  close(): Promise<void>;
}

async function boot(options: { checkpoints?: Record<string, unknown> } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-cp-http-"));
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
      approvals: { timeoutMs: 2_000 },
      checkpoints: options.checkpoints ?? { enabled: true },
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
  const response = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(response.status).toBe(201);
  const { session } = (await response.json()) as { session: { id: string } };
  return session.id;
}

describe("checkpoint routes", () => {
  it("creates, lists and restores checkpoints", async () => {
    const harness = await boot();
    cleanups.push(harness.close);
    const id = await createSession(harness.base);

    await writeFile(join(harness.workspace, "notes.txt"), "version one");

    const created = await fetch(`${harness.base}/api/sessions/${id}/checkpoints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "before edits" }),
    });
    expect(created.status).toBe(201);
    const { checkpoint } = (await created.json()) as { checkpoint: { id: string; label: string; files: number } };
    expect(checkpoint.label).toBe("before edits");
    expect(checkpoint.files).toBe(1);

    await writeFile(join(harness.workspace, "notes.txt"), "version two");

    const listed = await fetch(`${harness.base}/api/sessions/${id}/checkpoints`);
    const payload = (await listed.json()) as {
      enabled: boolean;
      checkpoints: Array<{ id: string; label: string }>;
    };
    expect(payload.enabled).toBe(true);
    expect(payload.checkpoints).toHaveLength(1);

    const restored = await fetch(
      `${harness.base}/api/sessions/${id}/checkpoints/${checkpoint.id}/restore`,
      { method: "POST" },
    );
    expect(restored.status).toBe(200);
    const result = (await restored.json()) as { restored: { id: string }; safety: { id: string } };
    expect(result.restored.id).toBe(checkpoint.id);
    expect(result.safety.id).not.toBe(checkpoint.id);
    expect(await readFile(join(harness.workspace, "notes.txt"), "utf8")).toBe("version one");

    const after = (await (await fetch(`${harness.base}/api/sessions/${id}/checkpoints`)).json()) as {
      checkpoints: unknown[];
    };
    expect(after.checkpoints).toHaveLength(2);
  });

  it("snapshots before every user turn", async () => {
    const harness = await boot();
    cleanups.push(harness.close);
    const id = await createSession(harness.base);
    await writeFile(join(harness.workspace, "app.ts"), "export const value = 1;\n");

    const sent = await fetch(`${harness.base}/api/sessions/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Change the value to 2" }),
    });
    expect(sent.status).toBe(202);

    const { checkpoints } = (await (await fetch(`${harness.base}/api/sessions/${id}/checkpoints`)).json()) as {
      checkpoints: Array<{ label: string; sessionId?: string }>;
    };
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].label).toContain("Change the value to 2");
    expect(checkpoints[0].sessionId).toBe(id);
  });

  it("reports disabled checkpoints and refuses writes", async () => {
    const harness = await boot({ checkpoints: { enabled: false } });
    cleanups.push(harness.close);
    const id = await createSession(harness.base);

    const listed = await fetch(`${harness.base}/api/sessions/${id}/checkpoints`);
    expect(listed.status).toBe(200);
    const payload = (await listed.json()) as { enabled: boolean; reason?: string; checkpoints: unknown[] };
    expect(payload.enabled).toBe(false);
    expect(payload.checkpoints).toEqual([]);

    const created = await fetch(`${harness.base}/api/sessions/${id}/checkpoints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(409);
    const error = (await created.json()) as { error: { code: string } };
    expect(error.error.code).toBe("checkpoints_disabled");
  });

  it("keeps checkpoints inside the tenant's session", async () => {
    const harness = await boot();
    cleanups.push(harness.close);
    const first = await createSession(harness.base);
    const second = await createSession(harness.base);
    expect(first).not.toBe(second);

    await writeFile(join(harness.workspace, "shared.txt"), "content");
    await fetch(`${harness.base}/api/sessions/${first}/checkpoints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "from first" }),
    });

    // Sessions share the tenant workspace, so both see the snapshot; the record
    // names the session that produced it.
    const listed = (await (await fetch(`${harness.base}/api/sessions/${second}/checkpoints`)).json()) as {
      checkpoints: Array<{ sessionId?: string }>;
    };
    expect(listed.checkpoints).toHaveLength(1);
    expect(listed.checkpoints[0].sessionId).toBe(first);
  });

  it("rejects unknown session ids", async () => {
    const harness = await boot();
    cleanups.push(harness.close);
    const response = await fetch(`${harness.base}/api/sessions/missing/checkpoints`);
    expect(response.status).toBe(404);
  });
});
