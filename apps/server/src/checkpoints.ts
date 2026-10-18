import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Logger } from "@kestrel/kernel";
import type { CheckpointInfo } from "@kestrel/protocol";

export interface CheckpointsConfig {
  /** `auto` uses git when it is available; `false` disables checkpoints. */
  enabled?: boolean | "auto";
  /** Extra ignore patterns, appended to `.gitignore` and the built-in list. */
  exclude?: string[];
  /** Refuse to snapshot workspaces with more tracked files than this. */
  maxFiles?: number;
}

export interface CheckpointServiceOptions {
  /** Data root; snapshots live under `<directory>/checkpoints`. */
  directory: string;
  logger: Logger;
  config?: CheckpointsConfig;
  timeoutMs?: number;
}

export class CheckpointError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "CheckpointError";
  }
}

/**
 * Workspace snapshots backed by a shadow git repository outside the workspace.
 *
 * The repository is keyed by the workspace path, not by session, because a
 * tenant shares one workspace between sessions: a rewind restores files for
 * everyone using that directory. Snapshots honour `.gitignore`, never touch the
 * workspace's own `.git`, and are serialized per workspace.
 */
export class CheckpointService {
  private readonly root: string;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly probes = new Map<string, Promise<boolean>>();
  private readonly timeoutMs: number;
  private readonly maxFiles: number;

  constructor(private readonly options: CheckpointServiceOptions) {
    this.root = join(options.directory, "checkpoints");
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxFiles = options.config?.maxFiles ?? 20_000;
  }

  async status(): Promise<{ enabled: boolean; reason?: string }> {
    if (this.options.config?.enabled === false) {
      return { enabled: false, reason: "Checkpoints are disabled in the configuration." };
    }
    const available = await this.gitAvailable();
    return available
      ? { enabled: true }
      : { enabled: false, reason: "git is not installed on this host; checkpoints need git." };
  }

  async list(workspace: string): Promise<CheckpointInfo[]> {
    return this.readIndex(this.stateDirectory(workspace));
  }

  async snapshot(
    workspace: string,
    meta: { label?: string; sessionId?: string; messageId?: string } = {},
  ): Promise<CheckpointInfo> {
    return this.enqueue(workspace, async () => {
      const { enabled, reason } = await this.status();
      if (!enabled) throw new CheckpointError("checkpoints_disabled", reason ?? "Checkpoints are unavailable.", 409);
      await this.ensureRepository(workspace);
      const candidates = await this.git(workspace, ["ls-files", "--cached", "--others", "--exclude-standard"]);
      const files = candidates.stdout.split("\n").filter(Boolean).length;
      if (files > this.maxFiles) {
        throw new CheckpointError(
          "checkpoint_too_large",
          `The workspace has ${files} files, above the ${this.maxFiles} checkpoint limit.`,
          409,
        );
      }
      return this.snapshotUnlocked(workspace, {
        label: meta.label?.trim() || "Snapshot",
        sessionId: meta.sessionId,
        messageId: meta.messageId,
      });
    });
  }

  /**
   * Restores the workspace to a checkpoint. A snapshot of the current state is
   * taken first, so a restore can itself be undone. Ignored files (for example
   * `node_modules/`) are left in place.
   */
  async restore(
    workspace: string,
    checkpointId: string,
  ): Promise<{ restored: CheckpointInfo; safety: CheckpointInfo }> {
    return this.enqueue(workspace, async () => {
      const { enabled, reason } = await this.status();
      if (!enabled) throw new CheckpointError("checkpoints_disabled", reason ?? "Checkpoints are unavailable.", 409);
      const state = await this.ensureRepository(workspace);
      const records = await this.readIndex(state.directory);
      const record = records.find((item) => item.id === checkpointId);
      if (!record) throw new CheckpointError("checkpoint_not_found", "Unknown checkpoint.", 404);

      await this.git(workspace, ["cat-file", "-e", `${record.sha}^{commit}`]);
      const safety = await this.snapshotUnlocked(workspace, {
        label: `Before restoring "${record.label}"`,
        sessionId: record.sessionId,
      });
      await this.git(workspace, ["reset", "--hard", record.sha]);
      // No `-x`: ignored files such as dependency directories are not part of
      // the snapshot and must survive a rewind.
      await this.git(workspace, ["clean", "-fd"]);
      this.options.logger.info("workspace restored", {
        workspace,
        checkpoint: record.id,
        safety: safety.id,
      });
      return { restored: record, safety };
    });
  }

  private async snapshotUnlocked(
    workspace: string,
    meta: { label: string; sessionId?: string; messageId?: string },
  ) {
    const state = await this.ensureRepository(workspace);
    await this.git(workspace, ["add", "-A"]);
    await this.git(workspace, ["commit", "--quiet", "--allow-empty", "-m", meta.label]);
    const sha = (await this.git(workspace, ["rev-parse", "HEAD"])).stdout.trim();
    const records = await this.readIndex(state.directory);
    const previous = records.at(-1);
    const files = (await this.git(workspace, ["ls-files"])).stdout.split("\n").filter(Boolean).length;
    const changes = previous ? await this.diffStats(workspace, previous.sha, sha) : { added: files, modified: 0, deleted: 0 };
    const record: CheckpointInfo = {
      id: `cp_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      sha,
      label: meta.label,
      createdAt: new Date().toISOString(),
      sessionId: meta.sessionId,
      messageId: meta.messageId,
      files,
      changes,
    };
    await this.writeIndex(state.directory, [...records, record]);
    this.options.logger.info("workspace checkpoint", {
      workspace,
      sessionId: meta.sessionId,
      sha: sha.slice(0, 12),
      files,
      changes,
    });
    return record;
  }

  private async diffStats(workspace: string, from: string, to: string) {
    const result = await this.git(workspace, ["diff", "--name-status", from, to]);
    const changes = { added: 0, modified: 0, deleted: 0 };
    for (const line of result.stdout.split("\n")) {
      if (!line) continue;
      const status = line[0];
      if (status === "A") changes.added += 1;
      else if (status === "D") changes.deleted += 1;
      else changes.modified += 1;
    }
    return changes;
  }

  private stateDirectory(workspace: string): string {
    const key = createHash("sha1").update(resolve(workspace)).digest("hex").slice(0, 16);
    return join(this.root, key);
  }

  private async ensureRepository(workspace: string): Promise<{ directory: string; gitDir: string; excludes: string }> {
    const directory = this.stateDirectory(workspace);
    const gitDir = join(directory, "repo.git");
    const excludes = join(directory, "excludes");
    await mkdir(directory, { recursive: true });
    await mkdir(workspace, { recursive: true });

    const patterns = new Set(DEFAULT_EXCLUDES);
    for (const pattern of this.options.config?.exclude ?? []) patterns.add(pattern);
    const workspaceIgnore = await readFile(join(workspace, ".gitignore"), "utf8").catch(() => "");
    for (const line of workspaceIgnore.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) patterns.add(trimmed);
    }
    const body = `${[...patterns].join("\n")}\n`;
    const current = await readFile(excludes, "utf8").catch(() => undefined);
    if (current !== body) await writeFile(excludes, body);

    const exists = await stat(join(gitDir, "HEAD")).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await this.git(workspace, ["init", "--quiet"], gitDir);
    }
    return { directory, gitDir, excludes };
  }

  private async gitAvailable(): Promise<boolean> {
    const key = "git";
    let probe = this.probes.get(key);
    if (!probe) {
      probe = new Promise<boolean>((resolveProbe) => {
        execFile("git", ["--version"], { timeout: 10_000 }, (error) => resolveProbe(!error));
      });
      this.probes.set(key, probe);
    }
    return probe;
  }

  private async git(
    workspace: string,
    args: string[],
    gitDirOverride?: string,
  ): Promise<{ stdout: string; stderr: string }> {
    const gitDir = gitDirOverride ?? join(this.stateDirectory(workspace), "repo.git");
    const excludes = join(this.stateDirectory(workspace), "excludes");
    const base = [
      "--git-dir",
      gitDir,
      "--work-tree",
      workspace,
      "-c",
      `core.excludesFile=${excludes}`,
      "-c",
      "core.autocrlf=false",
      "-c",
      "user.name=Kestrel",
      "-c",
      "user.email=checkpoints@kestrel.local",
    ];
    return new Promise((resolveGit, rejectGit) => {
      execFile(
        "git",
        [...base, ...args],
        { timeout: this.timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            rejectGit(
              new CheckpointError(
                "git_failed",
                `git ${args[0]} failed: ${(stderr || error.message).trim()}`,
                500,
              ),
            );
            return;
          }
          resolveGit({ stdout, stderr });
        },
      );
    });
  }

  private async readIndex(directory: string): Promise<CheckpointInfo[]> {
    try {
      const raw = await readFile(join(directory, "index.json"), "utf8");
      const parsed = JSON.parse(raw) as { checkpoints?: CheckpointInfo[] };
      return Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [];
    } catch {
      return [];
    }
  }

  private async writeIndex(directory: string, checkpoints: CheckpointInfo[]): Promise<void> {
    const target = join(directory, "index.json");
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, checkpoints }, null, 2));
    await rename(temporary, target);
  }

  private enqueue<T>(workspace: string, task: () => Promise<T>): Promise<T> {
    const key = resolve(workspace);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}

/**
 * Defaults for directories and files that are either regenerated or too large
 * to be useful in a rewind. `.gitignore` in the workspace is honoured on top.
 */
const DEFAULT_EXCLUDES = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".cache/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "target/",
  "coverage/",
  "*.log",
  ".DS_Store",
  "Thumbs.db",
];
