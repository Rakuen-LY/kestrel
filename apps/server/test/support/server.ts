import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type { Tool } from "@kestrel/agent";
import { ScriptedModel, type ScriptedTurn } from "@kestrel/testkit";
import { createRuntime, type Runtime } from "../../src/runtime.js";
import { createHttpServer } from "../../src/http.js";

export const TOKEN = "test-token";

export interface Harness {
  base: string;
  runtime: Runtime;
  token: string;
  close(): Promise<void>;
}

export interface BootOptions {
  turns?: ScriptedTurn[];
  tools?: Tool[];
  token?: string;
  pluginSource?: string;
  pluginInject?: string[];
  /** Extra config merged over the defaults, e.g. `{ plugins: { hotReload: true } }`. */
  config?: Record<string, unknown>;
}

export async function boot(options: BootOptions = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-http-"));
  const workspace = join(root, "workspace");
  const plugins = join(root, "plugins");
  const data = join(root, "data");
  await mkdir(workspace, { recursive: true });
  await mkdir(plugins, { recursive: true });
  if (options.pluginSource) {
    const directory = join(plugins, "test-layer");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "kestrel.plugin.json"),
      JSON.stringify({
        name: "@test/plugin-layer",
        version: "0.0.0",
        entry: "index.js",
        inject: options.pluginInject ?? ["prompts"],
      }),
    );
    await writeFile(join(directory, "index.js"), options.pluginSource);
  }

  const token = options.token === undefined ? TOKEN : options.token;
  const configPath = join(root, "kestrel.config.json");
  const config: Record<string, unknown> = {
    server: { host: "127.0.0.1", port: 0, token, ...(options.config?.server as object | undefined) },
    model: { default: "scripted", maxSteps: 6, ...(options.config?.model as object | undefined) },
    agent: { workspace, ...(options.config?.agent as object | undefined) },
    plugins: { directories: [plugins], ...(options.config?.plugins as object | undefined) },
    storage: { directory: data, ...(options.config?.storage as object | undefined) },
    approvals: { timeoutMs: 5_000, ...(options.config?.approvals as object | undefined) },
  };
  for (const [key, value] of Object.entries(options.config ?? {})) {
    if (!(key in config)) config[key] = value;
  }
  await writeFile(configPath, JSON.stringify(config));

  const runtime = await createRuntime({ configPath });
  runtime.models.register(new ScriptedModel(options.turns ?? [{ content: "hello" }]), { setDefault: true });
  for (const tool of options.tools ?? []) runtime.tools.register(tool);

  const server: Server = createHttpServer(runtime);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  return { base, runtime, token, close };
}

export function headers(token = TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

export async function createSession(harness: Harness, body: Record<string, unknown> = {}): Promise<string> {
  const response = await fetch(`${harness.base}/api/sessions`, {
    method: "POST",
    headers: headers(harness.token),
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  const payload = (await response.json()) as { session: { id: string } };
  return payload.session.id;
}

export async function waitForIdle(harness: Harness, id: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${harness.base}/api/sessions/${id}`, { headers: headers(harness.token) });
    const payload = (await response.json()) as { session: Record<string, unknown> };
    if (payload.session.status !== "running") return payload.session;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("session did not become idle");
}
