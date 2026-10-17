import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative } from "node:path";
import type { JsonSchema, SandboxResolver, Tool, ToolContext } from "@kestrel/agent";
import { displayPath, isProbablyBinary, matchesGlob, resolveWorkspacePath, walkFiles } from "./fs-utils.js";

export interface CoreToolsConfig {
  restrictToWorkspace?: boolean;
  maxReadBytes?: number;
  maxReadLines?: number;
  maxGlobResults?: number;
  maxGrepResults?: number;
  shellPermission?: "ask" | "auto";
  shellTimeoutMs?: number;
  webPermission?: "ask" | "auto";
  fetchTimeoutMs?: number;
  maxOutputChars?: number;
}

type ResolvedConfig = Required<CoreToolsConfig>;

const DEFAULTS: ResolvedConfig = {
  restrictToWorkspace: true,
  maxReadBytes: 2_000_000,
  maxReadLines: 2_000,
  maxGlobResults: 300,
  maxGrepResults: 150,
  shellPermission: "ask",
  shellTimeoutMs: 120_000,
  webPermission: "ask",
  fetchTimeoutMs: 30_000,
  maxOutputChars: 100_000,
};

function objectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`"${name}" must be a string.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? Math.floor(value) : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function cap(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[... ${text.length - limit} characters truncated ...]`;
}

export interface CoreToolDependencies {
  /** Called per shell execution so a sandbox can be enabled or removed at runtime. */
  sandbox?: SandboxResolver;
}

export function createCoreTools(config: CoreToolsConfig = {}, dependencies: CoreToolDependencies = {}): Tool[] {
  const cfg: ResolvedConfig = { ...DEFAULTS, ...config };

  const readFileTool: Tool = {
    schema: {
      name: "read_file",
      description:
        "Read a UTF-8 text file. Supports line offsets for large files. Always read a file before editing it.",
      category: "filesystem",
      permission: "auto",
      parameters: objectSchema(
        {
          path: { type: "string", description: "File path, absolute or relative to the workspace." },
          offset: { type: "integer", description: "1-based first line to return.", default: 1 },
          limit: { type: "integer", description: "Maximum number of lines to return." },
        },
        ["path"],
      ),
    },
    async execute(args, ctx) {
      const target = resolveWorkspacePath(ctx.session.workspace, string(args.path, "path"), cfg.restrictToWorkspace);
      const info = await stat(target);
      if (info.isDirectory()) throw new Error(`"${args.path}" is a directory; use list_dir.`);
      if (info.size > cfg.maxReadBytes) {
        throw new Error(`File is ${info.size} bytes, larger than the ${cfg.maxReadBytes} byte read limit.`);
      }
      const buffer = await readFile(target);
      if (isProbablyBinary(buffer)) throw new Error(`"${args.path}" appears to be binary.`);
      const text = buffer.toString("utf8");
      const lines = text.split("\n");
      const offset = integer(args.offset, 1, 1, Math.max(1, lines.length));
      const limit = integer(args.limit, cfg.maxReadLines, 1, cfg.maxReadLines);
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      const last = offset - 1 + selected.length;
      const suffix =
        last < lines.length ? `\n\n[showing lines ${offset}-${last} of ${lines.length}]` : "";
      return {
        content: `# ${displayPath(ctx.session.workspace, target)}\n${selected.join("\n")}${suffix}`,
        data: { path: target, lines: lines.length, offset, returned: selected.length },
      };
    },
  };

  const writeFileTool: Tool = {
    schema: {
      name: "write_file",
      description: "Create or overwrite a text file. Parent directories are created automatically.",
      category: "filesystem",
      permission: "auto",
      parameters: objectSchema(
        {
          path: { type: "string", description: "File path, absolute or relative to the workspace." },
          content: { type: "string", description: "Complete file contents." },
        },
        ["path", "content"],
      ),
    },
    async execute(args, ctx) {
      const target = resolveWorkspacePath(ctx.session.workspace, string(args.path, "path"), cfg.restrictToWorkspace);
      const content = string(args.content, "content");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      const lines = content ? content.split("\n").length : 0;
      return {
        content: `Wrote ${Buffer.byteLength(content)} bytes (${lines} lines) to ${displayPath(ctx.session.workspace, target)}.`,
        data: { path: target, bytes: Buffer.byteLength(content) },
      };
    },
  };

  const editFileTool: Tool = {
    schema: {
      name: "edit_file",
      description:
        "Replace an exact string in a file. Fails when the old string is missing or ambiguous, which prevents accidental edits.",
      category: "filesystem",
      permission: "auto",
      parameters: objectSchema(
        {
          path: { type: "string", description: "File to edit." },
          old_string: { type: "string", description: "Exact text to replace, including indentation." },
          new_string: { type: "string", description: "Replacement text." },
          replace_all: { type: "boolean", description: "Replace every occurrence.", default: false },
        },
        ["path", "old_string", "new_string"],
      ),
    },
    async execute(args, ctx) {
      const target = resolveWorkspacePath(ctx.session.workspace, string(args.path, "path"), cfg.restrictToWorkspace);
      const oldString = string(args.old_string, "old_string");
      const newString = string(args.new_string, "new_string");
      if (oldString === newString) throw new Error("old_string and new_string are identical.");
      const original = await readFile(target, "utf8");
      const occurrences = countOccurrences(original, oldString);
      if (occurrences === 0) throw new Error("old_string was not found in the file.");
      const replaceAll = args.replace_all === true;
      if (occurrences > 1 && !replaceAll) {
        throw new Error(
          `old_string occurs ${occurrences} times. Add surrounding context to make it unique, or set replace_all.`,
        );
      }
      const updated = replaceAll ? original.split(oldString).join(newString) : original.replace(oldString, newString);
      await writeFile(target, updated, "utf8");
      return {
        content: `Edited ${displayPath(ctx.session.workspace, target)} (${replaceAll ? occurrences : 1} replacement${
          occurrences === 1 || !replaceAll ? "" : "s"
        }).`,
        data: { path: target, replacements: replaceAll ? occurrences : 1 },
      };
    },
  };

  const listDirTool: Tool = {
    schema: {
      name: "list_dir",
      description: "List direct children of a directory with type and size. Prefer glob for recursive searches.",
      category: "filesystem",
      permission: "auto",
      parameters: objectSchema({
        path: { type: "string", description: "Directory path; defaults to the workspace root." },
      }),
    },
    async execute(args, ctx) {
      const target = resolveWorkspacePath(ctx.session.workspace, optionalString(args.path) ?? ".", cfg.restrictToWorkspace);
      const info = await stat(target);
      if (!info.isDirectory()) throw new Error(`"${args.path}" is not a directory.`);
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(target, { withFileTypes: true });
      const rows = await Promise.all(
        entries
          .filter((entry) => !entry.name.startsWith(".git"))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .slice(0, 500)
          .map(async (entry) => {
            if (entry.isDirectory()) return `dir  ${entry.name}/`;
            const size = await stat(`${target}/${entry.name}`)
              .then((value) => value.size)
              .catch(() => 0);
            return `file ${size.toString().padStart(9)}  ${entry.name}`;
          }),
      );
      return {
        content: `# ${displayPath(ctx.session.workspace, target) || "."}\n${rows.join("\n") || "(empty directory)"}`,
        data: { path: target, entries: entries.length },
      };
    },
  };

  const globTool: Tool = {
    schema: {
      name: "glob",
      description: "Find files by glob pattern (`**/*.ts`, `src/**/test/*.js`). Returns workspace-relative paths.",
      category: "filesystem",
      permission: "auto",
      parameters: objectSchema(
        {
          pattern: { type: "string", description: "Glob pattern." },
          path: { type: "string", description: "Directory to search; defaults to the workspace." },
        },
        ["pattern"],
      ),
    },
    async execute(args, ctx) {
      const root = resolveWorkspacePath(ctx.session.workspace, optionalString(args.path) ?? ".", cfg.restrictToWorkspace);
      const pattern = string(args.pattern, "pattern");
      const files = await walkFiles(root);
      const matches = files
        .map((file) => relative(root, file).replaceAll("\\", "/"))
        .filter((file) => matchesGlob(file, pattern))
        .sort()
        .slice(0, cfg.maxGlobResults);
      const suffix = matches.length === cfg.maxGlobResults ? `\n[results capped at ${cfg.maxGlobResults}]` : "";
      return {
        content: `${matches.join("\n") || "(no matches)"}${suffix}`,
        data: { matches: matches.length, pattern },
      };
    },
  };

  const grepTool: Tool = {
    schema: {
      name: "grep",
      description: "Search file contents with a JavaScript regular expression. Returns file:line:match.",
      category: "filesystem",
      permission: "auto",
      parameters: objectSchema(
        {
          pattern: { type: "string", description: "Regular expression source." },
          path: { type: "string", description: "File or directory to search." },
          include: { type: "string", description: "Glob filter such as `*.ts` or `src/**/*.ts`." },
          case_sensitive: { type: "boolean", description: "Default is case-sensitive.", default: true },
        },
        ["pattern"],
      ),
    },
    async execute(args, ctx) {
      const root = resolveWorkspacePath(ctx.session.workspace, optionalString(args.path) ?? ".", cfg.restrictToWorkspace);
      const source = string(args.pattern, "pattern");
      const flags = args.case_sensitive === false ? "i" : "";
      let regex: RegExp;
      try {
        regex = new RegExp(source, flags);
      } catch (error) {
        throw new Error(`Invalid regular expression: ${(error as Error).message}`);
      }
      const include = optionalString(args.include);
      const info = await stat(root);
      const files = info.isDirectory() ? await walkFiles(root) : [root];
      const results: string[] = [];
      for (const file of files) {
        if (results.length >= cfg.maxGrepResults) break;
        const relativePath = displayPath(ctx.session.workspace, file);
        if (include) {
          const subject = include.includes("/") ? relativePath : basename(file);
          if (!matchesGlob(subject, include)) continue;
        }
        let buffer: Buffer;
        try {
          const fileInfo = await stat(file);
          if (fileInfo.size > 1_000_000) continue;
          buffer = await readFile(file);
        } catch {
          continue;
        }
        if (isProbablyBinary(buffer)) continue;
        const lines = buffer.toString("utf8").split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          regex.lastIndex = 0;
          if (!regex.test(lines[index])) continue;
          results.push(`${relativePath}:${index + 1}:${lines[index].slice(0, 500)}`);
          if (results.length >= cfg.maxGrepResults) break;
        }
      }
      const suffix = results.length >= cfg.maxGrepResults ? `\n[results capped at ${cfg.maxGrepResults}]` : "";
      return {
        content: `${results.join("\n") || "(no matches)"}${suffix}`,
        data: { matches: results.length },
      };
    },
  };

  const shellTool: Tool = {
    schema: {
      name: "shell",
      description:
        "Run a shell command in the workspace. Use for builds, tests, git and package managers. Returns exit code, stdout and stderr.",
      category: "process",
      permission: cfg.shellPermission,
      parameters: objectSchema(
        {
          command: { type: "string", description: "Command line to execute." },
          cwd: { type: "string", description: "Working directory; defaults to the workspace." },
          timeout_ms: { type: "integer", description: "Timeout in milliseconds." },
        },
        ["command"],
      ),
    },
    async execute(args, ctx) {
      const command = string(args.command, "command");
      const cwd = resolveWorkspacePath(
        ctx.session.workspace,
        optionalString(args.cwd) ?? ".",
        cfg.restrictToWorkspace,
      );
      const timeout = integer(args.timeout_ms, cfg.shellTimeoutMs, 1_000, 30 * 60_000);
      const started = Date.now();
      const sandbox = dependencies.sandbox?.();
      const outcome = sandbox
        ? await runInSandbox(sandbox, command, ctx.session.workspace, cwd, timeout, ctx)
        : await runShell(command, cwd, timeout, ctx);
      const stdout = cap(outcome.stdout, cfg.maxOutputChars);
      const stderr = cap(outcome.stderr, cfg.maxOutputChars);
      const body = [`exit_code: ${outcome.code ?? "null"}`, `duration_ms: ${Date.now() - started}`];
      if (stdout) body.push("", "stdout:", stdout);
      if (stderr) body.push("", "stderr:", stderr);
      if (outcome.timedOut) body.push("", `[command timed out after ${timeout}ms]`);
      return {
        content: body.join("\n"),
        isError: outcome.timedOut || (outcome.code !== 0 && outcome.code !== null),
        data: sandbox
          ? { code: outcome.code, timedOut: outcome.timedOut, sandbox: sandbox.name }
          : { code: outcome.code, timedOut: outcome.timedOut },
      };
    },
  };

  const fetchTool: Tool = {
    schema: {
      name: "web_fetch",
      description:
        "Fetch an HTTP(S) URL and return readable text. HTML is converted to plain text; responses are truncated.",
      category: "network",
      permission: cfg.webPermission,
      parameters: objectSchema(
        {
          url: { type: "string", description: "Absolute HTTP or HTTPS URL." },
          max_chars: { type: "integer", description: "Maximum characters to return." },
        },
        ["url"],
      ),
    },
    async execute(args, ctx) {
      const url = new URL(string(args.url, "url"));
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Only http and https URLs are supported.");
      }
      const timeout = AbortSignal.timeout(cfg.fetchTimeoutMs);
      const signal = AbortSignal.any([ctx.signal, timeout]);
      const response = await fetch(url, {
        headers: { "user-agent": "Kestrel-Agent/0.1 (+https://kestrel.dev)" },
        signal,
        redirect: "follow",
      });
      const contentType = response.headers.get("content-type") ?? "";
      const raw = await response.text();
      const text = contentType.includes("html") ? htmlToText(raw) : raw;
      const limit = integer(args.max_chars, 100_000, 1_000, 400_000);
      return {
        content: `# ${url.href}\nstatus: ${response.status}\n\n${cap(text, limit)}`,
        isError: !response.ok,
        data: { url: url.href, status: response.status, contentType },
      };
    },
  };

  const todoTool: Tool = {
    schema: {
      name: "todo_write",
      description:
        "Maintain a short task list for the current run. Use it for multi-step work and update statuses as you go.",
      category: "planning",
      permission: "auto",
      parameters: objectSchema(
        {
          todos: {
            type: "array",
            description: "The complete task list, not a delta.",
            items: objectSchema(
              {
                content: { type: "string", description: "Task description." },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                  description: "Current task state.",
                },
              },
              ["content", "status"],
            ),
          },
        },
        ["todos"],
      ),
    },
    execute(args, ctx) {
      const todos = Array.isArray(args.todos) ? (args.todos as Array<{ content: string; status: string }>) : [];
      ctx.session.metadata.set("todos", todos);
      const mark = (status: string) => (status === "completed" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]");
      return {
        content: todos.map((todo) => `${mark(todo.status)} ${todo.content}`).join("\n") || "(no tasks)",
        data: { todos },
      };
    },
  };

  const finishTool: Tool = {
    schema: {
      name: "finish",
      description: "End the run with a final summary once the task is complete and verified.",
      category: "planning",
      permission: "auto",
      parameters: objectSchema(
        {
          summary: { type: "string", description: "What was accomplished, how it was verified, and anything left." },
        },
        ["summary"],
      ),
    },
    execute(args) {
      return { content: string(args.summary, "summary"), terminate: true };
    },
  };

  return [readFileTool, writeFileTool, editFileTool, listDirTool, globTool, grepTool, shellTool, fetchTool, todoTool, finishTool];
}

interface ShellOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runInSandbox(
  sandbox: NonNullable<ReturnType<SandboxResolver>>,
  command: string,
  workspace: string,
  cwd: string,
  timeoutMs: number,
  ctx: ToolContext,
): Promise<ShellOutcome> {
  const result = await sandbox.exec({
    command,
    cwd,
    workspace,
    timeoutMs,
    signal: ctx.signal,
    env: { KESTREL_SESSION_ID: ctx.session.id },
  });
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  };
}

function runShell(command: string, cwd: string, timeoutMs: number, ctx: ToolContext): Promise<ShellOutcome> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, KESTREL_SESSION_ID: ctx.session.id },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => child.kill("SIGKILL");
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 1_000_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      resolvePromise({ code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), timedOut });
    });
  });
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function stripAnsi(text: string): string {
  // Intentional control character: matches ANSI colour escapes in command output.
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return title ? `# ${title}\n\n${text}` : text;
}
