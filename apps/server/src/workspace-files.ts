import { open, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { WorkspaceEntry, WorkspaceFile, WorkspaceListing } from "@kestrel/protocol";

/**
 * Read-only view of a session workspace for clients. Paths are always
 * workspace-relative: the browser console never learns the server's filesystem
 * layout, and `..`, absolute paths and symlinks that leave the workspace are
 * rejected after resolving the real path.
 */
export interface WorkspaceFilesOptions {
  /** Largest file returned in full; larger files are truncated. */
  maxFileBytes?: number;
  /** Largest directory listing, to keep a pathological tree from stalling a client. */
  maxEntries?: number;
  /** Names never listed or opened (build output, credentials, VCS metadata). */
  ignore?: string[];
}

const DEFAULTS: Required<WorkspaceFilesOptions> = {
  maxFileBytes: 2_000_000,
  maxEntries: 500,
  ignore: [".git", "node_modules", ".kestrel", "dist", "build", "coverage", ".venv", "__pycache__"],
};

const TEXT_MIME: Record<string, string> = {
  ".css": "text/css",
  ".csv": "text/csv",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".jsx": "text/javascript",
  ".md": "text/markdown",
  ".mjs": "text/javascript",
  ".py": "text/x-python",
  ".rs": "text/x-rust",
  ".sh": "text/x-shellscript",
  ".svg": "image/svg+xml",
  ".toml": "text/plain",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".txt": "text/plain",
  ".xml": "text/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
};

const IMAGE_MIME: Record<string, string> = {
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export class WorkspaceFilesError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceFilesError";
  }
}

export class WorkspaceFiles {
  private readonly config: Required<WorkspaceFilesOptions>;

  constructor(options: WorkspaceFilesOptions = {}) {
    this.config = { ...DEFAULTS, ...options };
  }

  async list(workspace: string, path = "."): Promise<WorkspaceListing> {
    const root = await this.root(workspace);
    const directory = await this.resolveInside(root, path || ".");
    const info = await stat(directory).catch(() => undefined);
    if (!info) throw new WorkspaceFilesError(404, "not_found", `No such directory: ${path}`);
    if (!info.isDirectory()) throw new WorkspaceFilesError(400, "not_a_directory", `${path} is a file.`);

    const dirents = await readdir(directory, { withFileTypes: true });
    const entries: WorkspaceEntry[] = [];
    let truncated = false;
    for (const dirent of dirents) {
      if (this.config.ignore.includes(dirent.name)) continue;
      const absolute = resolve(directory, dirent.name);
      const entryPath = toPosix(relative(root, absolute));
      if (dirent.isSymbolicLink()) {
        // A link is listed only when it stays inside the workspace; pointing a
        // console at /etc through a checked-in symlink would leak host files.
        if (!(await this.inside(root, absolute))) continue;
      }
      if (!dirent.isDirectory() && !dirent.isFile() && !dirent.isSymbolicLink()) continue;
      const details = await stat(absolute).catch(() => undefined);
      if (!details) continue;
      if (entries.length >= this.config.maxEntries) {
        truncated = true;
        break;
      }
      entries.push({
        name: dirent.name,
        path: entryPath,
        type: details.isDirectory() ? "directory" : "file",
        ...(details.isFile() ? { size: details.size } : {}),
        modifiedAt: details.mtime.toISOString(),
      });
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
    });
    return { path: toPosix(relative(root, directory)) || ".", entries, truncated };
  }

  async read(workspace: string, path: string): Promise<WorkspaceFile> {
    const root = await this.root(workspace);
    const target = await this.resolveInside(root, path);
    const info = await stat(target).catch(() => undefined);
    if (!info) throw new WorkspaceFilesError(404, "not_found", `No such file: ${path}`);
    if (!info.isFile()) throw new WorkspaceFilesError(400, "not_a_file", `${path} is a directory.`);

    const extension = extname(target).toLowerCase();
    const image = IMAGE_MIME[extension];
    const mimeType = image ?? TEXT_MIME[extension] ?? "text/plain";
    const limit = this.config.maxFileBytes;
    const length = Math.min(info.size, limit);
    const buffer = Buffer.alloc(length);
    const handle = await open(target, "r");
    try {
      await handle.read(buffer, 0, length, 0);
    } finally {
      await handle.close();
    }
    const truncated = info.size > limit;
    const binary = image === undefined && looksBinary(buffer);

    return {
      path: toPosix(relative(root, target)),
      name: target.split(sep).pop() ?? path,
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      mimeType,
      encoding: binary || image ? "base64" : "utf8",
      content: binary || image ? buffer.toString("base64") : buffer.toString("utf8"),
      truncated,
      binary,
      ...(binary || image ? {} : { lines: countLines(buffer) }),
    };
  }

  private async root(workspace: string): Promise<string> {
    try {
      return await realpath(workspace);
    } catch {
      throw new WorkspaceFilesError(404, "workspace_missing", "The session workspace does not exist.");
    }
  }

  private async resolveInside(root: string, input: string): Promise<string> {
    if (typeof input !== "string" || input.includes("\0")) {
      throw new WorkspaceFilesError(400, "invalid_path", "A path must be a string without NUL bytes.");
    }
    if (isAbsolute(input)) {
      throw new WorkspaceFilesError(400, "invalid_path", "Paths are relative to the session workspace.");
    }
    const candidate = resolve(root, input);
    if (!isWithin(root, candidate)) {
      throw new WorkspaceFilesError(403, "outside_workspace", `${input} is outside the session workspace.`);
    }
    try {
      const real = await realpath(candidate);
      if (!isWithin(root, real)) {
        throw new WorkspaceFilesError(403, "outside_workspace", `${input} is outside the session workspace.`);
      }
      return real;
    } catch (error) {
      if (error instanceof WorkspaceFilesError) throw error;
      // A missing path is a 404 for the caller, not a containment failure.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw error;
    }
  }

  private async inside(root: string, candidate: string): Promise<boolean> {
    try {
      const real = await realpath(candidate);
      return isWithin(root, real);
    } catch {
      return false;
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_000));
  return sample.includes(0);
}

function countLines(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let lines = 1;
  for (const byte of buffer) if (byte === 10) lines += 1;
  return buffer[buffer.length - 1] === 10 ? lines - 1 : lines;
}
