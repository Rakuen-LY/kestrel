import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { SessionManager } from "@kestrel/agent";
import type { Context, Logger } from "@kestrel/kernel";
import type {
  HttpRouteService,
  PluginHttpRequest,
  PluginHttpResult,
  SessionEvent,
  Usage,
} from "@kestrel/protocol";

export interface StorageService {
  /** Root data directory owned by the server. */
  directory: string;
  resolve(...parts: string[]): string;
}

export interface AuditConfig {
  enabled?: boolean;
  /** Relative to the server data directory; defaults to `audit`. */
  directory?: string;
  includeTools?: boolean;
  includeRuns?: boolean;
  includeApprovals?: boolean;
  /** Rotate the active file once it grows beyond this size. */
  maxBytes?: number;
  /** Number of rotated files to keep. */
  maxFiles?: number;
}

export type AuditKind = "tool" | "run" | "approval";

export interface AuditRecord {
  at: string;
  kind: AuditKind;
  phase: "started" | "finished" | "requested" | "resolved";
  sessionId: string;
  tenantId?: string;
  tool?: string;
  callId?: string;
  argsHash?: string;
  ok?: boolean;
  durationMs?: number;
  error?: string;
  runId?: string;
  status?: string;
  usage?: Usage;
  approvalId?: string;
}

export interface AuditQuery {
  limit?: number;
  kind?: AuditKind;
  sessionId?: string;
}

export interface AuditPage {
  entries: AuditRecord[];
  total: number;
  file: string;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
const MAX_LIMIT = 1_000;
const MAX_ERROR_CHARS = 400;

/**
 * Append-only JSONL log. Writes are serialised through one promise chain so
 * concurrent sessions cannot interleave bytes; reads wait for the chain so a
 * client that just observed an event sees its record.
 */
export class AuditLog {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    readonly directory: string,
    private readonly options: { maxBytes?: number; maxFiles?: number } = {},
    private readonly logger?: Logger,
  ) {}

  get file(): string {
    return join(this.directory, "audit.jsonl");
  }

  append(entry: AuditRecord): void {
    const line = `${JSON.stringify(entry)}\n`;
    this.pending = this.pending
      .then(() => this.writeLine(line))
      .catch((error: unknown) => {
        this.logger?.warn("audit write failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  async read(query: AuditQuery = {}): Promise<AuditPage> {
    await this.pending;
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), MAX_LIMIT);
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { entries: [], total: 0, file: "audit.jsonl" };
      }
      throw error;
    }
    const entries: AuditRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let record: AuditRecord;
      try {
        record = JSON.parse(line) as AuditRecord;
      } catch {
        continue;
      }
      if (query.kind && record.kind !== query.kind) continue;
      if (query.sessionId && record.sessionId !== query.sessionId) continue;
      entries.push(record);
    }
    return {
      entries: entries.slice(-limit),
      total: entries.length,
      file: "audit.jsonl",
    };
  }

  private async writeLine(line: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
    const size = (await stat(this.file).catch(() => undefined))?.size ?? 0;
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) await this.rotate();
    await appendFile(this.file, line, "utf8");
  }

  private async rotate(): Promise<void> {
    const maxFiles = Math.max(this.options.maxFiles ?? DEFAULT_MAX_FILES, 1);
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      await rename(`${this.file}.${index}`, `${this.file}.${index + 1}`).catch(ignoreMissing);
    }
    await rename(this.file, `${this.file}.1`).catch(ignoreMissing);
  }
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

function hashArguments(args: Record<string, unknown>): string {
  return createHash("sha256").update(stableJson(args)).digest("hex").slice(0, 16);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function truncate(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

function describe(sessions: SessionManager, sessionId: string): { tenantId?: string } {
  try {
    const tenantId = sessions.get(sessionId).tenantId;
    return tenantId && tenantId !== "default" ? { tenantId } : {};
  } catch {
    return {};
  }
}

export function toRecord(
  sessions: SessionManager,
  event: SessionEvent,
  tools: Map<string, string>,
): AuditRecord | undefined {
  if (!("sessionId" in event)) return undefined;
  const base = { at: new Date().toISOString(), sessionId: event.sessionId, ...describe(sessions, event.sessionId) };
  switch (event.type) {
    case "tool.started":
      tools.set(event.call.id, event.call.name);
      return {
        ...base,
        kind: "tool",
        phase: "started",
        tool: event.call.name,
        callId: event.call.id,
        argsHash: hashArguments(event.call.arguments),
      };
    case "tool.finished":
      return {
        ...base,
        kind: "tool",
        phase: "finished",
        tool: event.result.name,
        callId: event.result.callId,
        ok: event.result.ok,
        durationMs: event.result.durationMs,
        error: truncate(event.result.error),
      };
    case "run.finished":
      return {
        ...base,
        kind: "run",
        phase: "finished",
        runId: event.runId,
        status: event.status,
        usage: event.usage,
      };
    case "run.failed":
      return {
        ...base,
        kind: "run",
        phase: "finished",
        runId: event.runId,
        status: "error",
        error: truncate(event.error),
      };
    case "approval.requested":
      return {
        ...base,
        kind: "approval",
        phase: "requested",
        approvalId: event.approval.id,
        callId: event.approval.call.id,
        tool: event.approval.call.name,
      };
    case "approval.resolved":
      return {
        ...base,
        kind: "approval",
        phase: "resolved",
        approvalId: event.approvalId,
        tool: tools.get(event.approvalId) ?? "unknown",
        ok: event.approved,
      };
    default:
      return undefined;
  }
}

function parseKind(value: string | undefined): AuditKind | undefined {
  return value === "tool" || value === "run" || value === "approval" ? value : undefined;
}

async function handleRead(log: AuditLog, request: PluginHttpRequest): Promise<PluginHttpResult> {
  if (request.principal?.role !== "admin") {
    return { status: 403, body: { error: "The audit log is available to administrators only." } };
  }
  const limit = Number(request.query.limit ?? 100);
  const page = await log.read({
    limit: Number.isFinite(limit) ? limit : 100,
    kind: parseKind(request.query.kind),
    sessionId: request.query.sessionId,
  });
  return { status: 200, body: page };
}

export default {
  name: "@kestrel/plugin-audit",
  version: "0.1.0",
  description: "Append-only JSONL audit trail for tool calls, runs and approvals.",
  inject: ["sessions", "http.routes", "storage"],
  apply(context: Context, config: AuditConfig = {}) {
    if (config.enabled === false) return;
    const sessions: SessionManager = context.get("sessions");
    const routes: HttpRouteService = context.get("http.routes");
    const storage: StorageService = context.get("storage");
    const directory = config.directory
      ? isAbsolute(config.directory)
        ? config.directory
        : resolve(storage.directory, config.directory)
      : storage.resolve("audit");
    const log = new AuditLog(directory, config, context.logger.child({ component: "audit" }));
    const tools = new Map<string, string>();
    const includeTools = config.includeTools !== false;
    const includeRuns = config.includeRuns !== false;
    const includeApprovals = config.includeApprovals !== false;

    context.effect(() => {
      const unsubscribe = sessions.subscribe((event) => {
        if (event.type === "tool.started" || event.type === "tool.finished") {
          if (!includeTools) return;
        } else if (event.type === "run.finished" || event.type === "run.failed") {
          if (!includeRuns) return;
        } else if (event.type !== "approval.requested" && event.type !== "approval.resolved") {
          return;
        } else if (!includeApprovals) {
          return;
        }
        if (event.type === "approval.requested") {
          tools.set(event.approval.id, event.approval.call.name);
        }
        const record = toRecord(sessions, event, tools);
        if (event.type === "approval.resolved") tools.delete(event.approvalId);
        if (record) log.append(record);
      });
      const offRoute = routes.route({
        method: "GET",
        path: "/api/audit",
        handler: (request) => handleRead(log, request),
      });
      return () => {
        unsubscribe();
        offRoute();
      };
    });
  },
};

declare module "@kestrel/kernel" {
  interface ServiceMap {
    storage: StorageService;
    "http.routes": HttpRouteService;
  }
}
