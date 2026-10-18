import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { normalizeName, parseSkill, SKILL_DEFAULTS, type SkillCatalogOptions } from "./catalog.js";

export type LintLevel = "error" | "warning";

export interface LintIssue {
  level: LintLevel;
  code: string;
  message: string;
}

export interface SkillLintReport {
  /** Workspace-relative path, so output is stable across machines. */
  path: string;
  name?: string;
  issues: LintIssue[];
}

export interface LintResult {
  workspace: string;
  reports: SkillLintReport[];
  errors: number;
  warnings: number;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const DESCRIPTION_LIMIT = 240;

interface Candidate {
  path: string;
  expectedName: string;
}

/**
 * Checks skills without loading `SkillCatalog`'s forgiving view: files that the
 * runtime would silently skip are errors here. Lint never mutates the workspace.
 */
export function lintSkills(workspace: string, options: SkillCatalogOptions = {}): LintResult {
  const directories = options.directories ?? SKILL_DEFAULTS.directories;
  const maxSkillBytes = options.maxSkillBytes ?? SKILL_DEFAULTS.maxSkillBytes;
  const maxSkills = options.maxSkills ?? SKILL_DEFAULTS.maxSkills;
  const root = safeRealpath(resolve(workspace));
  const reports: SkillLintReport[] = [];

  if (!root) {
    return {
      workspace,
      reports: [{ path: ".", issues: [{ level: "error", code: "workspace-missing", message: "Workspace does not exist." }] }],
      errors: 1,
      warnings: 0,
    };
  }

  const candidates: Candidate[] = [];
  for (const directory of directories) {
    const base = resolve(root, directory);
    if (!inside(root, base)) {
      reports.push({
        path: directory,
        issues: [{ level: "error", code: "directory-escape", message: "Skill directory escapes the workspace." }],
      });
      continue;
    }
    let entries;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      if (entry.isDirectory()) {
        candidates.push({ path: join(base, entry.name, "SKILL.md"), expectedName: entry.name });
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        candidates.push({ path: join(base, entry.name), expectedName: basename(entry.name, extname(entry.name)) });
      }
    }
    if (candidates.length > maxSkills) break;
  }

  const names = new Map<string, string>();
  for (const candidate of candidates.slice(0, maxSkills)) {
    const relativePath = relative(root, candidate.path) || candidate.path;
    const issues: LintIssue[] = [];
    let name: string | undefined;

    let stat;
    try {
      stat = statSync(candidate.path);
    } catch {
      reports.push({
        path: relativePath,
        issues: [{ level: "error", code: "file-missing", message: "SKILL.md is missing in this directory." }],
      });
      continue;
    }
    if (!stat.isFile()) {
      reports.push({
        path: relativePath,
        issues: [{ level: "error", code: "not-a-file", message: "Skill path is not a file." }],
      });
      continue;
    }
    if (!insideWorkspace(root, candidate.path)) {
      reports.push({
        path: relativePath,
        issues: [{ level: "error", code: "path-escape", message: "Skill resolves outside the workspace." }],
      });
      continue;
    }
    if (stat.size > maxSkillBytes) {
      issues.push({
        level: "warning",
        code: "too-large",
        message: `File is ${stat.size} bytes; the runtime reads only ${maxSkillBytes}.`,
      });
    }

    let source: string;
    try {
      source = readFileSync(candidate.path, "utf8");
    } catch (error) {
      reports.push({
        path: relativePath,
        issues: [{ level: "error", code: "unreadable", message: `Cannot read file: ${String(error)}` }],
      });
      continue;
    }

    const header = frontmatter(source);
    if (!header) {
      issues.push({
        level: "warning",
        code: "no-frontmatter",
        message: "Missing `---` frontmatter; name and description are inferred.",
      });
    }
    const rawName = header?.name;
    const rawDescription = header?.description;
    const parsed = parseSkill(source, candidate.expectedName);
    if (!parsed) {
      issues.push({ level: "error", code: "empty-body", message: "Skill has no body after the frontmatter." });
      reports.push({ path: relativePath, name, issues });
      continue;
    }
    name = parsed.name;

    if (rawName && rawName !== parsed.name) {
      issues.push({
        level: "warning",
        code: "name-normalized",
        message: `Frontmatter name "${rawName}" is normalized to "${parsed.name}".`,
      });
    }
    if (!NAME_PATTERN.test(parsed.name)) {
      issues.push({
        level: "error",
        code: "name-invalid",
        message: `"${parsed.name}" must match ${NAME_PATTERN}; lowercase letters, digits, dot, dash or underscore.`,
      });
    }
    if (normalizeName(candidate.expectedName) !== parsed.name) {
      issues.push({
        level: "warning",
        code: "name-mismatch",
        message: `Directory/file is "${candidate.expectedName}" but the skill is named "${parsed.name}".`,
      });
    }
    if (!rawDescription) {
      issues.push({
        level: "warning",
        code: "no-description",
        message: "Frontmatter has no `description`; the first body line is used in the prompt.",
      });
    } else if (rawDescription.length > DESCRIPTION_LIMIT) {
      issues.push({
        level: "warning",
        code: "description-long",
        message: `Description is ${rawDescription.length} characters; the prompt keeps ${DESCRIPTION_LIMIT}.`,
      });
    }
    const first = names.get(parsed.name);
    if (first) {
      issues.push({
        level: "error",
        code: "duplicate-name",
        message: `Another skill already uses "${parsed.name}" (${first}); only the first is loaded.`,
      });
    } else {
      names.set(parsed.name, relativePath);
    }

    reports.push({ path: relativePath, name, issues });
  }

  const errors = reports.reduce((total, report) => total + report.issues.filter((issue) => issue.level === "error").length, 0);
  const warnings = reports.reduce(
    (total, report) => total + report.issues.filter((issue) => issue.level === "warning").length,
    0,
  );
  return { workspace: root, reports, errors, warnings };
}

/** Markdown scaffold placed at `skills/<name>/SKILL.md` by `kestrel skills new`. */
export function scaffoldSkill(name: string, description: string, whenToUse?: string): string {
  const normalized = normalizeName(name);
  if (!normalized || !NAME_PATTERN.test(normalized)) {
    throw new Error(`Skill name "${name}" must normalize to lowercase letters, digits, dot, dash or underscore.`);
  }
  const lines = ["---", `name: ${normalized}`, `description: ${description.trim() || `Describe ${normalized}.`}`];
  if (whenToUse?.trim()) lines.push(`whenToUse: ${whenToUse.trim()}`);
  lines.push(
    "---",
    "",
    `# ${normalized}`,
    "",
    "State when this procedure applies, then list the steps the agent should follow.",
    "",
    "1. First step.",
    "2. Second step.",
    "",
    "Add examples, commands and failure handling. The body is only sent to the model after",
    "`use_skill` is called.",
    "",
  );
  return lines.join("\n");
}

function frontmatter(source: string): { name?: string; description?: string } | undefined {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const result: { name?: string; description?: string } = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = /^(name|description)\s*:\s*(.*)$/i.exec(line.trim());
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (match[1].toLowerCase() === "name") result.name = value;
    else result.description = value;
  }
  return result;
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
