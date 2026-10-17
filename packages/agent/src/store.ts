import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionDetail, SessionSummary } from "@kestrel/protocol";

export interface SessionStore {
  list(): Promise<SessionSummary[]>;
  load(id: string): Promise<SessionDetail | undefined>;
  save(detail: SessionDetail): Promise<void>;
  delete(id: string): Promise<void>;
  /** Awaits writes already accepted. Implementations may omit it. */
  flush?(): Promise<void>;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionDetail>();

  async list(): Promise<SessionSummary[]> {
    return [...this.sessions.values()].map(({ messages: _messages, systemPrompt: _prompt, ...summary }) => summary);
  }

  async load(id: string): Promise<SessionDetail | undefined> {
    const found = this.sessions.get(id);
    return found ? structuredClone(found) : undefined;
  }

  async save(detail: SessionDetail): Promise<void> {
    this.sessions.set(detail.id, structuredClone(detail));
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}

/**
 * One JSON document per session, written atomically. The format favours
 * inspectability and portability over throughput; export/migration tooling and
 * alternative stores can implement the same interface.
 */
export class FileSessionStore implements SessionStore {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  private directory(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid session id "${id}".`);
    return join(this.root, "sessions", id);
  }

  async list(): Promise<SessionSummary[]> {
    let entries;
    try {
      entries = await readdir(join(this.root, "sessions"), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const summaries = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            const raw = await readFile(join(this.root, "sessions", entry.name, "session.json"), "utf8");
            const detail = JSON.parse(raw) as SessionDetail;
            const { messages: _messages, systemPrompt: _prompt, ...summary } = detail;
            return summary;
          } catch {
            return undefined;
          }
        }),
    );
    return summaries
      .filter((summary): summary is SessionSummary => summary !== undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async load(id: string): Promise<SessionDetail | undefined> {
    try {
      const raw = await readFile(join(this.directory(id), "session.json"), "utf8");
      return JSON.parse(raw) as SessionDetail;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(detail: SessionDetail): Promise<void> {
    const previous = this.pending.get(detail.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const file = join(this.directory(detail.id), "session.json");
        await mkdir(dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temp, `${JSON.stringify(detail, null, 2)}\n`, "utf8");
        await rename(temp, file);
      });
    this.pending.set(detail.id, next);
    try {
      await next;
    } finally {
      if (this.pending.get(detail.id) === next) this.pending.delete(detail.id);
    }
  }

  async delete(id: string): Promise<void> {
    await this.pending.get(id)?.catch(() => undefined);
    await rm(this.directory(id), { recursive: true, force: true });
  }

  /** Durability barrier: shutdown must not race an in-flight write. */
  async flush(): Promise<void> {
    await Promise.allSettled(this.pending.values());
  }
}
