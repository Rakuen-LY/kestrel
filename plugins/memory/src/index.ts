import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { JsonSchema, Tool } from "@kestrel/agent";
import type { Context } from "@kestrel/kernel";

interface MemoryEntry {
  id: string;
  key?: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface MemoryFile {
  version: 1;
  entries: MemoryEntry[];
}

export interface MemoryConfig {
  /** File path, absolute or relative to each session workspace. */
  path?: string;
  maxEntries?: number;
}

export interface MemorySearchResult {
  id: string;
  key?: string;
  content: string;
  tags: string[];
  updatedAt: string;
  score: number;
}

export interface MemoryService {
  save(workspace: string, input: { content: string; key?: string; tags?: string[] }): Promise<MemoryEntry>;
  search(workspace: string, query: string, limit?: number): Promise<MemorySearchResult[]>;
  list(workspace: string, limit?: number): Promise<MemoryEntry[]>;
  forget(workspace: string, idOrKey: string): Promise<boolean>;
}

const DEFAULTS = { path: ".kestrel/memory.json", maxEntries: 2_000 };

export class FileMemoryService implements MemoryService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly config: MemoryConfig = {}) {}

  private fileFor(workspace: string): string {
    const path = this.config.path ?? DEFAULTS.path;
    return isAbsolute(path) ? path : resolve(workspace, path);
  }

  async save(workspace: string, input: { content: string; key?: string; tags?: string[] }): Promise<MemoryEntry> {
    return this.mutate(workspace, (data) => {
      const now = new Date().toISOString();
      const existing = input.key ? data.entries.find((entry) => entry.key === input.key) : undefined;
      if (existing) {
        existing.content = input.content;
        existing.tags = input.tags ?? existing.tags;
        existing.updatedAt = now;
        return existing;
      }
      const entry: MemoryEntry = {
        id: randomUUID(),
        key: input.key,
        content: input.content,
        tags: input.tags ?? [],
        createdAt: now,
        updatedAt: now,
      };
      data.entries.unshift(entry);
      data.entries = data.entries.slice(0, this.config.maxEntries ?? DEFAULTS.maxEntries);
      return entry;
    });
  }

  async search(workspace: string, query: string, limit = 10): Promise<MemorySearchResult[]> {
    const data = await this.read(workspace);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    return data.entries
      .map((entry) => {
        const haystack = `${entry.key ?? ""} ${entry.content} ${entry.tags.join(" ")}`.toLowerCase();
        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        return { ...entry, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async list(workspace: string, limit = 50): Promise<MemoryEntry[]> {
    return (await this.read(workspace)).entries.slice(0, limit);
  }

  async forget(workspace: string, idOrKey: string): Promise<boolean> {
    return this.mutate(workspace, (data) => {
      const index = data.entries.findIndex((entry) => entry.id === idOrKey || entry.key === idOrKey);
      if (index < 0) return false;
      data.entries.splice(index, 1);
      return true;
    });
  }

  private async read(workspace: string): Promise<MemoryFile> {
    try {
      const raw = await readFile(this.fileFor(workspace), "utf8");
      const parsed = JSON.parse(raw) as MemoryFile;
      if (!Array.isArray(parsed.entries)) throw new Error("Malformed memory file.");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [] };
      if (error instanceof SyntaxError) return { version: 1, entries: [] };
      throw error;
    }
  }

  private async mutate<T>(workspace: string, change: (data: MemoryFile) => T): Promise<T> {
    const file = this.fileFor(workspace);
    const previous = this.queues.get(file) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const data = await this.read(workspace);
      const result = change(data);
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(temp, file);
      return result;
    });
    this.queues.set(file, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(file) === next) this.queues.delete(file);
    }
  }
}

function objectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function memoryTools(memory: MemoryService): Tool[] {
  return [
    {
      schema: {
        name: "memory_save",
        description:
          "Persist a durable note (preference, project fact, decision). Reusing a key updates the existing note.",
        category: "memory",
        permission: "auto",
        parameters: objectSchema(
          {
            content: { type: "string", description: "The fact or note to remember." },
            key: { type: "string", description: "Optional stable key for upserts." },
            tags: { type: "array", items: { type: "string" }, description: "Optional labels." },
          },
          ["content"],
        ),
      },
      async execute(args, context) {
        const entry = await memory.save(context.session.workspace, {
          content: String(args.content ?? ""),
          key: typeof args.key === "string" ? args.key : undefined,
          tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
        });
        return {
          content: `Saved memory ${entry.id}${entry.key ? ` (key: ${entry.key})` : ""}.`,
          data: entry,
        };
      },
    },
    {
      schema: {
        name: "memory_search",
        description: "Search durable notes for relevant context before starting a task.",
        category: "memory",
        permission: "auto",
        parameters: objectSchema(
          {
            query: { type: "string", description: "Words to match." },
            limit: { type: "integer", description: "Maximum results, default 10." },
          },
          ["query"],
        ),
      },
      async execute(args, context) {
        const results = await memory.search(
          context.session.workspace,
          String(args.query ?? ""),
          Number(args.limit) || 10,
        );
        return {
          content:
            results
              .map(
                (entry) =>
                  `- ${entry.key ? `[${entry.key}] ` : ""}${entry.content}${entry.tags.length ? ` (tags: ${entry.tags.join(", ")})` : ""}`,
              )
              .join("\n") || "(no matching memories)",
          data: results,
        };
      },
    },
    {
      schema: {
        name: "memory_list",
        description: "List the most recent durable notes.",
        category: "memory",
        permission: "auto",
        parameters: objectSchema({
          limit: { type: "integer", description: "Maximum entries, default 50." },
        }),
      },
      async execute(args, context) {
        const entries = await memory.list(context.session.workspace, Number(args.limit) || 50);
        return {
          content:
            entries
              .map(
                (entry) =>
                  `- ${entry.id}${entry.key ? ` [${entry.key}]` : ""}: ${entry.content.slice(0, 200).replace(/\s+/g, " ")}`,
              )
              .join("\n") || "(no memories)",
          data: entries,
        };
      },
    },
    {
      schema: {
        name: "memory_forget",
        description: "Delete a durable note by id or key.",
        category: "memory",
        permission: "auto",
        parameters: objectSchema({ id_or_key: { type: "string", description: "Memory id or key." } }, ["id_or_key"]),
      },
      async execute(args, context) {
        const removed = await memory.forget(context.session.workspace, String(args.id_or_key ?? ""));
        return { content: removed ? "Memory deleted." : "No matching memory found.", isError: !removed };
      },
    },
  ];
}

export default {
  name: "@kestrel/plugin-memory",
  version: "0.1.0",
  description: "Workspace-scoped durable memory with save, search, list and forget tools.",
  inject: ["tools"],
  apply(context: Context, config: MemoryConfig = {}) {
    const memory = new FileMemoryService(config);
    context.provide("memory", memory);
    const registry = context.get("tools");
    for (const tool of memoryTools(memory)) context.effect(() => registry.register(tool));
    context.logger.info("memory tools registered", { path: config.path ?? DEFAULTS.path });
  },
};

declare module "@kestrel/kernel" {
  interface ServiceMap {
    memory: MemoryService;
  }
}
