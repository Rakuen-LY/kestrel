import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedModel } from "@kestrel/testkit";
import { createRuntime, type Runtime } from "@kestrel/server";

const ROOT = resolve(import.meta.dirname, "../../..");
const PLUGIN_DIR = join(ROOT, "plugins");
const built = existsSync(join(PLUGIN_DIR, "browser/dist/index.js"));
const browser = existsSync("/usr/bin/chromium") || existsSync("/usr/bin/google-chrome") || Boolean(process.env.CHROME_PATH);

const fixture = `<!doctype html>
<html>
  <head><title>Runtime fixture</title></head>
  <body>
    <a href="/next">Next page</a>
    <button onclick="document.getElementById('out').textContent = 'pressed'">Press</button>
    <input placeholder="Your name" oninput="document.getElementById('echo').textContent = this.value" />
    <div id="out"></div><div id="echo"></div>
  </body>
</html>`;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe.skipIf(!built || !browser)("browser tools through the runtime", () => {
  it("registers, calls and disposes the real plugin", async () => {
    const server: Server = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (request.url === "/next") {
        response.end("<!doctype html><title>Second</title><h1>Second</h1>");
        return;
      }
      response.end(fixture);
    });
    await new Promise<void>((listener) => server.listen(0, "127.0.0.1", listener));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port.");
    const origin = `http://127.0.0.1:${address.port}`;

    const root = await mkdtemp(join(tmpdir(), "kestrel-browser-runtime-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const configPath = join(root, "kestrel.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        server: { host: "127.0.0.1", port: 0, token: "" },
        model: { default: "scripted", maxSteps: 10 },
        agent: { workspace },
        plugins: {
          directories: [PLUGIN_DIR],
          config: { "@kestrel/plugin-browser": { permission: "auto", settleMs: 100 } },
        },
        storage: { directory: join(root, "data") },
      }),
    );

    let runtime: Runtime | undefined;
    cleanups.push(async () => {
      await new Promise<void>((listener) => server.close(() => listener()));
      await runtime?.shutdown();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    runtime = await createRuntime({ configPath });
    const active = runtime;
    expect(active.plugins.list().find((plugin) => plugin.id === "@kestrel/plugin-browser")?.state).toBe("active");
    expect(active.tools.get("browser_open")?.schema.permission).toBe("auto");
    expect(active.context.has("browser")).toBe(true);

    active.models.register(
      new ScriptedModel([
        { toolCalls: [{ name: "browser_open", arguments: { url: origin } }] },
        { toolCalls: [{ name: "browser_click", arguments: { ref: 2 } }] },
        { toolCalls: [{ name: "browser_type", arguments: { ref: 3, text: "Ada" } }] },
        { toolCalls: [{ name: "browser_screenshot", arguments: { path: "shots/runtime.png", include_image: true } }] },
        { toolCalls: [{ name: "browser_close", arguments: {} }] },
        { content: "done" },
      ]),
      { setDefault: true },
    );

    const session = active.sessions.create({});
    const finished = await session.start("Inspect the fixture page.").done;
    expect(finished.status).toBe("completed");

    const toolResults = session.messages
      .flatMap((message) => (message.role === "tool" ? [message] : []))
      .map((message) => message.content)
      .join("\n");
    expect(toolResults).toContain("Title: Runtime fixture");
    expect(toolResults).toContain("pressed");
    expect(toolResults).toContain("Ada");
    expect(toolResults).toContain("Saved screenshot");
    expect(toolResults).toContain("The image is attached");

    const png = await readFile(join(workspace, "shots/runtime.png"));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

    const shot = session.messages.find((message) => message.role === "tool" && message.toolName === "browser_screenshot");
    expect(shot?.images).toHaveLength(1);
    expect(shot?.images?.[0].mimeType).toBe("image/png");
    expect(shot?.images?.[0].data).toBe(png.toString("base64"));
  }, 90_000);
});
