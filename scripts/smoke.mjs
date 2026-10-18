#!/usr/bin/env node
/**
 * Boots the built server (`apps/server/dist/bin.js`) against a throwaway
 * workspace and asserts the release-facing surface: health, auth, bootstrap,
 * the packaged console, plugin discovery and the SSE handshake.
 *
 * Run `pnpm build` first. Used by CI and by the release workflow so a bundle
 * that only type-checks but cannot start never ships.
 */
import { spawn } from "node:child_process";
import { builtinModules } from "node:module";
import { createServer } from "node:net";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "smoke-token";
const failures = [];
let serverOutput = "";

async function jsFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await jsFiles(path)));
    else if (entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitForHealth(base, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`server did not become healthy: ${lastError ?? "timed out"}`);
}

async function check(label, fn) {
  try {
    const detail = await fn();
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    console.error(`  FAIL  ${label} — ${error instanceof Error ? error.message : String(error)}`);
    failures.push(label);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function sseHandshake(base) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${base}/api/plugins/events?token=${TOKEN}`, { signal: controller.signal });
    expect(response.ok, `SSE status ${response.status}`);
    expect(response.headers.get("content-type")?.includes("text/event-stream"), "wrong SSE content type");
    const reader = response.body.getReader();
    let buffer = "";
    while (!buffer.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
    }
    await reader.cancel();
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

const port = await freePort();
const root = await mkdtemp(join(tmpdir(), "kestrel-smoke-"));
const workspace = join(root, "workspace");
const data = join(root, "data");
await mkdir(workspace, { recursive: true });
await mkdir(data, { recursive: true });

const child = spawn(process.execPath, [join(repoRoot, "apps/server/dist/bin.js")], {
  cwd: repoRoot,
  env: {
    ...process.env,
    NODE_ENV: "production",
    KESTREL_HOST: "127.0.0.1",
    KESTREL_PORT: String(port),
    KESTREL_TOKEN: TOKEN,
    KESTREL_WORKSPACE: workspace,
    KESTREL_DATA_DIR: data,
    KESTREL_PLUGINS: "plugins,examples/plugins",
    KESTREL_HOT_RELOAD: "on",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => (serverOutput += chunk));
child.stderr.on("data", (chunk) => (serverOutput += chunk));

const base = `http://127.0.0.1:${port}`;
const auth = { authorization: `Bearer ${TOKEN}` };
const releaseVersion = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")).version;

try {
  console.log(`Smoke test against ${base}\n`);

  await check("plugin bundles are self-contained", async () => {
    const directory = join(repoRoot, "plugins");
    const isolated = await mkdtemp(join(tmpdir(), "kestrel-plugins-"));
    await writeFile(join(isolated, "package.json"), '{"type":"module"}');
    const plugins = await readdir(directory);
    const problems = [];

    for (const plugin of plugins) {
      let files;
      try {
        files = await jsFiles(join(directory, plugin, "dist"));
      } catch {
        continue;
      }
      for (const file of files) {
        const source = await readFile(file, "utf8");
        for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
          const specifier = match[1];
          const bare = !specifier.startsWith(".") && !specifier.startsWith("/");
          const resolvable = /^(@[\w.-]+\/)?[\w.-]+$/.test(specifier);
          if (bare && resolvable && !specifier.startsWith("node:") && !builtinModules.includes(specifier)) {
            problems.push(`${file.slice(repoRoot.length + 1)} imports ${specifier}`);
          }
        }
      }

      // Load the bundle the way the image does: dist alone, no node_modules.
      const entry = join(directory, plugin, "dist/index.js");
      const copy = join(isolated, plugin);
      await cp(join(directory, plugin, "dist"), join(copy, "dist"), { recursive: true });
      try {
        await import(pathToFileURL(join(copy, "dist/index.js")).href);
      } catch (error) {
        problems.push(`${entry.slice(repoRoot.length + 1)} failed to load: ${error.message}`);
      }
    }

    await rm(isolated, { recursive: true, force: true });
    expect(problems.length === 0, problems.join("; "));
    return `${plugins.length} plugins`;
  });

  const health = await waitForHealth(base, 60_000);

  await check("health reports the release version", () => {
    expect(health.status === "ok", `status ${health.status}`);
    expect(health.version === releaseVersion, `version ${health.version} != ${releaseVersion}`);
    expect(health.protocol === "1.0", `protocol ${health.protocol}`);
    return `${health.version}, ${health.plugins} plugins`;
  });

  await check("health counts active plugins", () => {
    expect(health.plugins > 0, "no plugins loaded");
    return String(health.plugins);
  });

  await check("session routes reject anonymous callers", async () => {
    const response = await fetch(`${base}/api/sessions`);
    expect(response.status === 401, `status ${response.status}`);
  });

  await check("bootstrap returns models, tools and plugins", async () => {
    const response = await fetch(`${base}/api/bootstrap`, { headers: auth });
    expect(response.status === 200, `status ${response.status}`);
    const payload = await response.json();
    expect(Array.isArray(payload.plugins) && payload.plugins.length > 0, "no plugins in bootstrap");
    expect(Array.isArray(payload.tools) && payload.tools.length > 0, "no tools in bootstrap");
    expect(payload.features?.streaming === true, "streaming feature missing");
    return `${payload.tools.length} tools, ${payload.plugins.length} plugins`;
  });

  await check("declared example plugin is discovered", async () => {
    const response = await fetch(`${base}/api/plugins`, { headers: auth });
    expect(response.status === 200, `status ${response.status}`);
    const { plugins } = await response.json();
    const names = plugins.map((plugin) => plugin.name);
    expect(names.includes("@example/plugin-csv-viewer"), `csv-viewer missing: ${names.join(", ")}`);
    const csv = plugins.find((plugin) => plugin.name === "@example/plugin-csv-viewer");
    expect(csv.state === "active", `csv-viewer state ${csv.state}`);
    return `${plugins.length} plugins`;
  });

  await check("every discovered plugin activated", async () => {
    const response = await fetch(`${base}/api/plugins`, { headers: auth });
    const { plugins } = await response.json();
    // A plugin that cannot resolve an import still lets the server boot; without
    // this check a broken bundle would only surface when a user opened it.
    const broken = plugins.filter((plugin) => plugin.state === "error");
    expect(broken.length === 0, broken.map((plugin) => `${plugin.name}: ${plugin.error}`).join("; "));
    expect(plugins.length >= 14, `only ${plugins.length} plugins discovered`);
    return `${plugins.length} active`;
  });

  await check("packaged console is served", async () => {
    const response = await fetch(`${base}/`);
    expect(response.status === 200, `status ${response.status}`);
    const html = await response.text();
    expect(html.includes('id="root"'), "console markup missing");
    expect(response.headers.get("content-security-policy")?.includes("default-src 'self'"), "CSP missing");
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(asset, "index.html references no compiled bundle");
    const bundle = await fetch(`${base}${asset}`);
    expect(bundle.status === 200, `bundle ${asset} returned ${bundle.status}`);
    expect(bundle.headers.get("content-type")?.includes("javascript"), "bundle content type is wrong");
    return `${asset}`;
  });

  await check("unknown API routes return a protocol error", async () => {
    const response = await fetch(`${base}/api/does-not-exist`, { headers: auth });
    expect(response.status === 404, `status ${response.status}`);
    const payload = await response.json();
    expect(payload.error?.code === "not_found", `code ${payload.error?.code}`);
  });

  await check("SSE plugin channel emits a ready frame", async () => {
    const frame = await sseHandshake(base);
    expect(frame.includes("ready"), `first frame: ${frame.slice(0, 80)}`);
    expect(frame.includes("plugin-csv-viewer"), `plugin revision missing: ${frame.slice(0, 400)}`);
  });
} catch (error) {
  console.error(`\nSmoke test could not start: ${error instanceof Error ? error.message : String(error)}`);
  failures.push("startup");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveExit();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

if (failures.length) {
  console.error(`\n${failures.length} smoke check(s) failed: ${failures.join(", ")}`);
  if (serverOutput.trim()) console.error(`\n--- server output ---\n${serverOutput.trim().split("\n").slice(-40).join("\n")}`);
  process.exit(1);
}
console.log("\nSmoke test passed.");
