import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContext, silencedLogger } from "@kestrel/kernel";
import plugin, { DockerSandbox, dockerRunArgs } from "../src/index.js";

let root: string;
let log: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kestrel-sandbox-"));
  log = join(root, "docker.log");
  process.env.KESTREL_SANDBOX_TEST_LOG = log;
});

afterEach(async () => {
  delete process.env.KESTREL_SANDBOX_TEST_LOG;
  await rm(root, { recursive: true, force: true });
});

async function fakeDocker(body: string): Promise<string> {
  const path = join(root, "fake-docker.sh");
  await writeFile(
    path,
    `#!/bin/sh
if [ "$1" = "version" ]; then echo "27.0.0"; exit 0; fi
if [ "$1" = "rm" ]; then echo "$@" >> "$KESTREL_SANDBOX_TEST_LOG"; exit 0; fi
${body}
`,
  );
  await chmod(path, 0o755);
  return path;
}

const options = () => ({
  command: "echo hello",
  cwd: root,
  workspace: root,
  timeoutMs: 2_000,
});

describe("docker arguments", () => {
  it("mounts only the workspace and disables the network by default", () => {
    const args = dockerRunArgs(
      { image: "alpine:3", env: { A: "1" } },
      { ...options(), workspace: "/work", cwd: "/work/sub", env: { B: "2" } },
      "kestrel-sbx-test",
    );
    expect(args.slice(0, 4)).toEqual(["run", "--rm", "--init", "--name"]);
    expect(args).toContain("kestrel-sbx-test");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args[args.indexOf("--volume") + 1]).toBe("/work:/work");
    expect(args[args.indexOf("--workdir") + 1]).toBe("/work/sub");
    expect(args[args.indexOf("--env") + 1]).toBe("HOME=/tmp");
    expect(args).toContain("HOME=/tmp");
    expect(args.filter((arg) => arg === "--env")).toHaveLength(3);
    expect(args.slice(-4)).toEqual(["alpine:3", "sh", "-lc", "echo hello"]);
  });
});

describe("docker sandbox", () => {
  it.skipIf(process.platform === "win32")("reports the daemon version and executes once", async () => {
    const docker = await fakeDocker('echo "STDOUT:$*"; echo "STDERR" >&2; exit 7');
    const sandbox = new DockerSandbox({ docker, image: "test-image" });
    expect(await sandbox.probe()).toBe("27.0.0");

    const result = await sandbox.exec(options());
    expect(result.code).toBe(7);
    expect(result.stdout).toContain("STDOUT:run");
    expect(result.stdout).toContain("--network none");
    expect(result.stdout).toContain("echo hello");
    expect(result.stderr).toContain("STDERR");
    expect(result.timedOut).toBe(false);
  });

  it.skipIf(process.platform === "win32")("kills the container and reports a timeout", async () => {
    const docker = await fakeDocker("exec sleep 10");
    const sandbox = new DockerSandbox({ docker });

    const result = await sandbox.exec({ ...options(), timeoutMs: 150 });
    expect(result.timedOut).toBe(true);
    // exec settles only after the removal process has exited, so the log is
    // complete here without waiting on a timer.
    expect(await readFile(log, "utf8")).toMatch(/rm -f kestrel-sbx-/);
  });

  it.skipIf(process.platform === "win32")("stops on abort", async () => {
    const docker = await fakeDocker("exec sleep 10");
    const sandbox = new DockerSandbox({ docker });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const result = await sandbox.exec({ ...options(), signal: controller.signal });
    expect(result.code).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(await readFile(log, "utf8")).toMatch(/rm -f kestrel-sbx-/);
  });

  it("fails closed when Docker is missing", async () => {
    const sandbox = new DockerSandbox({ docker: join(root, "missing-docker") });
    await expect(sandbox.exec(options())).rejects.toThrow(/Docker is not available/);
  });

  it("refuses a working directory outside the workspace", async () => {
    const docker = await fakeDocker("exit 0");
    const sandbox = new DockerSandbox({ docker });
    await expect(sandbox.exec({ ...options(), cwd: tmpdir() })).rejects.toThrow(/outside the workspace/);
  });

  it("stays inactive unless explicitly enabled", async () => {
    const context = createContext({ logger: silencedLogger() });
    await plugin.apply(context, { image: "alpine:3" });
    expect(context.has("sandbox")).toBe(false);
    await context.dispose();
  });

  it("provides a fail-closed sandbox when enabled", async () => {
    const context = createContext({ logger: silencedLogger() });
    await plugin.apply(context, { enabled: true, docker: join(root, "missing-docker") });
    expect(context.has("sandbox")).toBe(true);
    await expect(context.get("sandbox").exec(options())).rejects.toThrow(/Docker is not available/);
    await context.dispose();
  });

  it("rejects invalid environment variable names", () => {
    expect(() => new DockerSandbox({ env: { "BAD=KEY": "x" } })).toThrow(/Invalid sandbox environment/);
  });
});
