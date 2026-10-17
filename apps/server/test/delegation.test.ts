import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedModel } from "@kestrel/testkit";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { createHttpServer } from "../src/http.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const PLUGIN_DIR = join(ROOT, "plugins");
const TOKEN = "test-token";

/**
 * This test loads the real built plugin over HTTP rather than importing its
 * source: it is the only place that proves delegation survives the plugin
 * loader, the session store and the protocol surface at once.
 */
const built = existsSync(join(PLUGIN_DIR, "subagents/dist/index.js"));
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

interface Harness {
  base: string;
  runtime: Runtime;
}

async function boot(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-delegation-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const configPath = join(root, "kestrel.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      server: { host: "127.0.0.1", port: 0, token: TOKEN },
      model: { default: "scripted", maxSteps: 6 },
      agent: { workspace },
      plugins: { directories: [PLUGIN_DIR] },
      storage: { directory: join(root, "data") },
    }),
  );

  const runtime = await createRuntime({ configPath });
  // Turn order follows execution: parent delegates, child answers, parent concludes.
  runtime.models.register(
    new ScriptedModel([
      { toolCalls: [{ name: "delegate", arguments: { task: "List the files", role: "researcher" } }] },
      { content: "child report: two files" },
      { content: "parent final" },
    ]),
    { setDefault: true },
  );

  const server: Server = createHttpServer(runtime);
  await new Promise<void>((listener) => server.listen(0, "127.0.0.1", listener));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  cleanups.push(async () => {
    await new Promise<void>((listener) => server.close(() => listener()));
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { base, runtime };
}

function headers(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
}

async function json<T>(harness: Harness, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${harness.base}${path}`, { headers: headers(), ...init });
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("condition not met in time");
}

interface SessionPayload {
  session: {
    id: string;
    status: string;
    parentId?: string;
    depth?: number;
    role?: string;
    messages: Array<{ role: string; content: string }>;
  };
}

describe.skipIf(!built)("delegation over HTTP", () => {
  it("exposes a subagent as a child session and returns its report", async () => {
    const harness = await boot();

    const created = await json<SessionPayload>(harness, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Parent" }),
    });
    const parentId = created.session.id;
    const { runtime } = harness;
    expect(runtime.tools.get("delegate")).toBeDefined();

    await json(harness, `/api/sessions/${parentId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "Delegate the file listing." }),
    });

    let childId: string | undefined;
    await waitFor(async () => {
      const listed = await json<{ sessions: Array<{ id: string; parentId?: string }> }>(harness, "/api/sessions");
      childId = listed.sessions.find((session) => session.parentId === parentId)?.id;
      const parent = await json<SessionPayload>(harness, `/api/sessions/${parentId}`);
      return Boolean(childId) && parent.session.status !== "running";
    });

    const child = await json<SessionPayload>(harness, `/api/sessions/${childId}`);
    expect(child.session).toMatchObject({ parentId, depth: 1, role: "researcher", status: "idle" });
    expect(child.session.messages.map((message) => message.content).join("\n")).toContain("List the files");

    const parent = await json<SessionPayload>(harness, `/api/sessions/${parentId}`);
    const toolMessage = parent.session.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("child report: two files");
    expect(parent.session.messages.at(-1)?.content).toBe("parent final");
    // The parent summary stays a root: delegation adds an edge, not an inheritance.
    expect(parent.session.parentId).toBeUndefined();
  });
});
