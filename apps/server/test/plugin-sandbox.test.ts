import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

beforeAll(() => {
  process.env.KESTREL_LOG_LEVEL ??= "silent";
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function boot(): Promise<{ base: string; runtime: Runtime; close(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-plugin-ui-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const configPath = join(root, "kestrel.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      server: { host: "127.0.0.1", port: 0 },
      agent: { workspace },
      plugins: { directories: [join(root, "plugins")] },
      storage: { directory: join(root, "data") },
    }),
  );
  const runtime = await createRuntime({ configPath });
  const server: Server = createHttpServer(runtime);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    runtime,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

describe("plugin sandbox host", () => {
  it("serves a locked-down document that the console can frame", async () => {
    const harness = await boot();
    cleanups.push(harness.close);

    const response = await fetch(`${harness.base}/plugin-sandbox.html`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("cross-origin-opener-policy")).toBeNull();

    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("script-src 'unsafe-inline' http://127.0.0.1");

    const html = await response.text();
    expect(html).toContain("kestrel:ready");
    expect(html).toContain("kestrel:request");
    expect(html).toContain("import(data.entry)");
  });

  it("is read-only", async () => {
    const harness = await boot();
    cleanups.push(harness.close);
    const response = await fetch(`${harness.base}/plugin-sandbox.html`, { method: "POST" });
    expect(response.status).toBe(405);
  });
});
