import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ScriptedModel } from "@kestrel/testkit";
import { createRuntime } from "../src/runtime.js";
import type { SessionDetail } from "@kestrel/protocol";

const cleanups: Array<() => Promise<void>> = [];
const TOKEN = "sqlite-token";

beforeAll(() => {
  process.env.KESTREL_LOG_LEVEL ??= "silent";
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function boot(data: string, workspaces: string) {
  const configPath = join(data, "kestrel.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      server: { host: "127.0.0.1", port: 0, token: TOKEN },
      model: { default: "scripted", maxSteps: 2 },
      agent: { workspace: workspaces },
      plugins: { directories: [join(workspaces, "plugins")] },
      storage: { directory: join(data, "store"), driver: "sqlite" },
    }),
  );
  const runtime = await createRuntime({ configPath });
  runtime.models.register(new ScriptedModel([{ content: "stored answer" }]), { setDefault: true });
  return runtime;
}

describe("sqlite storage driver", () => {
  it("persists a transcript across a restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "kestrel-sqlite-http-"));
    cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await mkdir(join(workspace, "plugins"), { recursive: true });

    const first = await boot(root, workspace);
    const session = first.sessions.create({ title: "Persisted", workspace });
    await first.sessions.send(session.id, "remember this").done;
    await first.shutdown();

    expect(existsSync(join(root, "store", "kestrel.db"))).toBe(true);

    const second = await boot(root, workspace);
    cleanups.push(() => second.shutdown());
    const restored: SessionDetail = second.sessions.get(session.id).detail();
    expect(restored.title).toBe("Persisted");
    expect(restored.messages.map((message) => message.content)).toContain("remember this");
    expect(restored.messages.map((message) => message.content)).toContain("stored answer");
  });
});
