import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const IGNORED = new Set([".git", "node_modules", "dist", "build", "coverage", ".kestrel", ".venv", "__pycache__"]);
const MAX_DEPTH = 16;

export function resolveWorkspacePath(workspace: string, input: string, restrict: boolean): string {
  const target = isAbsolute(input) ? resolve(input) : resolve(workspace, input);
  if (restrict && !isInside(workspace, target)) {
    throw new Error(`Path "${input}" escapes the workspace. Set restrictToWorkspace to false in the tools-core plugin config to allow it.`);
  }
  return target;
}

export function isInside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function displayPath(workspace: string, target: string): string {
  const path = relative(workspace, target);
  return path && !path.startsWith("..") ? path : target;
}

/** Segment-wise glob matching supporting `**`, `*`, `?` and `{a,b}`. */
export function matchesGlob(path: string, pattern: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalizedPattern = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  for (const alternative of expandBraces(normalizedPattern)) {
    if (matchSegments(alternative.split("/").filter(Boolean), normalizedPath.split("/").filter(Boolean))) return true;
  }
  return false;
}

function matchSegments(pattern: string[], path: string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [head, ...rest] = pattern;
  if (head === "**") {
    if (matchSegments(rest, path)) return true;
    return path.length > 0 && matchSegments(pattern, path.slice(1));
  }
  if (path.length === 0) return false;
  return segmentMatches(head, path[0]) && matchSegments(rest, path.slice(1));
}

function segmentMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*").replaceAll("?", "[^/]");
  return new RegExp(`^${escaped}$`).test(value);
}

function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]+)\}/.exec(pattern);
  if (!match) return [pattern];
  return match[1]
    .split(",")
    .flatMap((part) => expandBraces(pattern.slice(0, match.index) + part + pattern.slice(match.index + match[0].length)));
}

export interface WalkOptions {
  maxDepth?: number;
  includeDirectories?: boolean;
  shouldSkip?: (name: string) => boolean;
}

export async function walkFiles(root: string, options: WalkOptions = {}): Promise<string[]> {
  const files: string[] = [];
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const skip = options.shouldSkip ?? ((name: string) => IGNORED.has(name));
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (skip(entry.name)) continue;
        if (options.includeDirectories) files.push(full);
        await visit(full, depth + 1);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  await visit(root, 0);
  return files;
}

export function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_000));
  return sample.includes(0);
}

export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
