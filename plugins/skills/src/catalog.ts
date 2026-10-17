import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { Logger } from "@kestrel/kernel";

export interface SkillSummary {
  name: string;
  description: string;
  whenToUse?: string;
  /** Absolute path to the markdown file, inside the session workspace. */
  path: string;
  bytes: number;
}

export interface Skill extends SkillSummary {
  body: string;
  truncated: boolean;
}

/** The `skills` service. Other plugins consume this instead of re-scanning the disk. */
export interface SkillService {
  list(workspace: string): SkillSummary[];
  load(workspace: string, name: string): Skill | undefined;
}

export interface SkillCatalogOptions {
  /** Directories scanned inside each session workspace, in priority order. */
  directories?: string[];
  /** Bytes read per skill. Larger files are truncated, never dropped. */
  maxSkillBytes?: number;
  maxSkills?: number;
  logger?: Logger;
}

const DEFAULTS = {
  directories: [".kestrel/skills", "skills"],
  maxSkillBytes: 64_000,
  maxSkills: 100,
};

const SKILL_FILE = "SKILL.md";
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const DESCRIPTION_LIMIT = 240;

interface CachedSkill {
  mtimeMs: number;
  size: number;
  skill: Skill;
}

/**
 * Discovers `SKILL.md` directories (and flat `.md` files) inside a workspace.
 *
 * Reading is synchronous because prompt layers run synchronously when a
 * session is created. Results are cached by mtime and size, so starting many
 * sessions does not re-parse unchanged files.
 */
export class SkillCatalog implements SkillService {
  private readonly directories: string[];
  private readonly maxSkillBytes: number;
  private readonly maxSkills: number;
  private readonly logger?: Logger;
  private readonly cache = new Map<string, CachedSkill>();

  constructor(options: SkillCatalogOptions = {}) {
    this.directories = options.directories ?? DEFAULTS.directories;
    this.maxSkillBytes = options.maxSkillBytes ?? DEFAULTS.maxSkillBytes;
    this.maxSkills = options.maxSkills ?? DEFAULTS.maxSkills;
    this.logger = options.logger;
  }

  list(workspace: string): SkillSummary[] {
    return this.discover(workspace).map(({ body: _body, truncated: _truncated, ...summary }) => summary);
  }

  load(workspace: string, name: string): Skill | undefined {
    const wanted = normalizeName(name);
    return this.discover(workspace).find((skill) => skill.name === wanted);
  }

  private discover(workspace: string): Skill[] {
    const root = safeRealpath(resolve(workspace));
    if (!root) return [];

    const found = new Map<string, Skill>();
    for (const raw of this.directories) {
      if (found.size >= this.maxSkills) break;
      const directory = resolve(root, raw);
      if (!inside(root, directory)) {
        this.logger?.warn("skill directory escapes the workspace", { directory: raw });
        continue;
      }
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        if (found.size >= this.maxSkills) break;
        if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;

        let path: string | undefined;
        let fallback: string;
        if (entry.isDirectory()) {
          path = join(directory, entry.name, SKILL_FILE);
          fallback = entry.name;
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          path = join(directory, entry.name);
          fallback = basename(entry.name, extname(entry.name));
        } else {
          continue;
        }

        if (!inside(root, path) || !insideWorkspace(root, path)) {
          this.logger?.warn("skill escapes the workspace", { path });
          continue;
        }
        const skill = this.read(path, fallback);
        if (!skill) continue;
        if (!NAME_PATTERN.test(skill.name)) {
          this.logger?.warn("skill name is not addressable", { path, name: skill.name });
          continue;
        }
        if (found.has(skill.name)) {
          this.logger?.warn("duplicate skill ignored", { skill: skill.name, path });
          continue;
        }
        found.set(skill.name, skill);
      }
    }

    return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  private read(path: string, fallback: string): Skill | undefined {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return undefined;
    }
    if (!stat.isFile()) return undefined;

    const cached = this.cache.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.skill;

    const truncated = stat.size > this.maxSkillBytes;
    let raw: string;
    try {
      raw = truncated ? readBounded(path, this.maxSkillBytes) : readFileSync(path, "utf8");
    } catch (error) {
      this.logger?.warn("skill unreadable", { path, error: String(error) });
      return undefined;
    }

    const parsed = parseSkill(raw, fallback);
    if (!parsed) return undefined;
    const skill: Skill = { ...parsed, path, bytes: stat.size, truncated };
    this.cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, skill });
    return skill;
  }
}

export interface ParsedSkill {
  name: string;
  description: string;
  whenToUse?: string;
  body: string;
}

/**
 * Parses the small frontmatter subset skills need: `key: value` lines between
 * `---` fences. Values may be quoted. Everything after the closing fence is the
 * skill body, which is only sent to the model after `use_skill` is called.
 */
export function parseSkill(source: string, fallbackName: string): ParsedSkill | undefined {
  const normalized = source.replace(/\r\n/g, "\n");
  let name = fallbackName;
  let description = "";
  let whenToUse: string | undefined;
  let body = normalized;

  if (normalized.startsWith("---\n")) {
    const end = normalized.indexOf("\n---", 3);
    if (end !== -1) {
      const header = normalized.slice(4, end);
      body = normalized.slice(end + 4).replace(/^\n+/, "");
      for (const line of header.split("\n")) {
        const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
        if (!match) continue;
        const key = match[1].toLowerCase().replace(/[_-]/g, "");
        const value = unquote(match[2].trim());
        if (!value) continue;
        if (key === "name") name = value;
        else if (key === "description") description = value;
        else if (key === "whentouse") whenToUse = value;
      }
    }
  }

  const trimmed = body.trim();
  if (!trimmed) return undefined;
  if (!description) description = firstSentence(trimmed);
  return {
    name: normalizeName(name),
    description: truncate(description, DESCRIPTION_LIMIT),
    whenToUse: whenToUse ? truncate(whenToUse, DESCRIPTION_LIMIT) : undefined,
    body: trimmed,
  };
}

/** Lower-cases a skill name and collapses separators to kebab-case. */
export function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
  }
  return value;
}

function firstSentence(body: string): string {
  const line = body
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0 && !candidate.startsWith("#"));
  return line ?? body.slice(0, DESCRIPTION_LIMIT);
}

function truncate(value: string, limit: number): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

function readBounded(path: string, limit: number): string {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const bytes = readSync(descriptor, buffer, 0, limit, 0);
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function insideWorkspace(root: string, candidate: string): boolean {
  const real = safeRealpath(candidate);
  return real !== undefined && inside(root, real);
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export { DEFAULTS as SKILL_DEFAULTS };
