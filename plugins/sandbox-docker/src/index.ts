import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Sandbox, SandboxExecOptions, SandboxExecResult } from "@kestrel/agent";
import type { Context } from "@kestrel/kernel";

export interface DockerSandboxConfig {
  /** Opt in explicitly; the plugin is discovered but inactive without it. */
  enabled?: boolean;
  /** Linux image with a POSIX shell. Defaults to `node:22-bookworm`. */
  image?: string;
  /** Docker CLI binary. Defaults to `docker`. */
  docker?: string;
  /** Container network. `none` by default so commands cannot exfiltrate. */
  network?: "none" | "bridge" | "host";
  memory?: string;
  cpus?: string;
  /** `uid:gid` inside the container. Defaults to the server user on POSIX. */
  user?: string;
  /** Extra environment variables for every command. Avoid long-lived secrets. */
  env?: Record<string, string>;
}

interface ResolvedConfig {
  image: string;
  docker: string;
  network: "none" | "bridge" | "host";
  memory?: string;
  cpus?: string;
  user?: string;
  env: Record<string, string>;
}

const DEFAULTS = {
  image: "node:22-bookworm",
  docker: "docker",
  network: "none" as const,
  user: currentUser(),
};

const CAPTURE_LIMIT = 1_000_000;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Executes each command in a fresh container. The session workspace is mounted
 * read-write at the same absolute path; nothing else from the host is visible.
 * Containers are disposable, so shell state does not survive between calls.
 */
export class DockerSandbox implements Sandbox {
  readonly name = "docker";
  private readonly config: ResolvedConfig;
  private version?: string;

  constructor(config: DockerSandboxConfig = {}) {
    for (const key of Object.keys(config.env ?? {})) {
      if (!ENV_KEY.test(key)) throw new Error(`Invalid sandbox environment variable "${key}".`);
    }
    this.config = { ...DEFAULTS, ...config, env: { ...config.env } };
  }

  /** Returns the daemon version, or throws a user-facing error. */
  async probe(): Promise<string> {
    if (this.version) return this.version;
    this.version = await new Promise<string>((resolveVersion, reject) => {
      execFile(
        this.config.docker,
        ["version", "--format", "{{.Server.Version}}"],
        { timeout: 10_000, windowsHide: true },
        (error, stdout) => {
          if (error) reject(new Error(`Docker is not available via "${this.config.docker}": ${error.message}`));
          else resolveVersion(stdout.trim() || "unknown");
        },
      );
    });
    return this.version;
  }

  async exec(options: SandboxExecOptions): Promise<SandboxExecResult> {
    await this.probe();

    const workspace = resolve(options.workspace);
    const cwd = resolve(options.cwd);
    if (!isInside(workspace, cwd)) {
      throw new Error(`Sandbox working directory "${cwd}" is outside the workspace "${workspace}".`);
    }
    assertDirectory(workspace, "workspace");
    assertDirectory(cwd, "working directory");
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("Sandbox requires a positive timeout.");
    }
    if (options.signal?.aborted) {
      return { code: null, stdout: "", stderr: "", timedOut: false };
    }

    const name = `kestrel-sbx-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const args = dockerRunArgs(this.config, { ...options, cwd, workspace }, name);

    return await new Promise<SandboxExecResult>((resolveResult, reject) => {
      const child = spawn(this.config.docker, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const cleanup = (): void => {
        try {
          const killer = spawn(this.config.docker, ["rm", "-f", name], {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.on("error", () => {});
          killer.unref?.();
        } catch {
          // The container may never have been created; nothing to clean up.
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        cleanup();
        child.kill("SIGKILL");
      }, options.timeoutMs);
      timer.unref?.();

      const onAbort = (): void => {
        cleanup();
        child.kill("SIGKILL");
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const finish = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        complete();
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      child.on("error", (error) => {
        finish(() => reject(new Error(`Failed to start container: ${error.message}`)));
      });
      child.on("close", (code) => {
        finish(() => resolveResult({ code, stdout, stderr, timedOut }));
      });
    });
  }
}

/** Exported for tests: the exact argv handed to the Docker CLI. */
export function dockerRunArgs(
  config: DockerSandboxConfig,
  options: SandboxExecOptions,
  name: string,
): string[] {
  const resolved: ResolvedConfig = { ...DEFAULTS, ...config, env: config.env ?? {} };
  const args = [
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    "--network",
    resolved.network,
    "--workdir",
    options.cwd,
    "--volume",
    `${options.workspace}:${options.workspace}`,
  ];
  if (resolved.memory) args.push("--memory", resolved.memory);
  if (resolved.cpus) args.push("--cpus", resolved.cpus);
  if (resolved.user) args.push("--user", resolved.user);
  for (const [key, value] of Object.entries({ HOME: "/tmp", ...resolved.env, ...options.env })) {
    args.push("--env", `${key}=${value}`);
  }
  args.push(resolved.image, "sh", "-lc", options.command);
  return args;
}

function currentUser(): string | undefined {
  if (process.platform === "win32") return undefined;
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return typeof uid === "number" && typeof gid === "number" ? `${uid}:${gid}` : undefined;
}
function append(current: string, chunk: Buffer): string {
  if (current.length >= CAPTURE_LIMIT) return current;
  return current + chunk.toString("utf8").slice(0, CAPTURE_LIMIT - current.length);
}

function isInside(workspace: string, target: string): boolean {
  const path = relative(workspace, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function assertDirectory(path: string, label: string): void {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new Error(`Sandbox ${label} "${path}" does not exist.`);
  }
  if (!stats.isDirectory()) throw new Error(`Sandbox ${label} "${path}" is not a directory.`);
}

export default {
  name: "@kestrel/plugin-sandbox-docker",
  version: "0.1.0",
  description: "Runs shell commands in short-lived Docker containers.",
  inject: [],
  async apply(context: Context, config: DockerSandboxConfig = {}) {
    if (config.enabled !== true) {
      context.logger.info("docker sandbox disabled", { hint: "set enabled=true to run shell in containers" });
      return;
    }
    const sandbox = new DockerSandbox(config);
    context.provide("sandbox", sandbox);
    try {
      const version = await sandbox.probe();
      context.logger.info("docker sandbox ready", {
        image: config.image ?? DEFAULTS.image,
        network: config.network ?? DEFAULTS.network,
        version,
      });
    } catch (error) {
      context.logger.error("docker sandbox unavailable; shell commands will fail closed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};
