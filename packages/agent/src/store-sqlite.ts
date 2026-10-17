import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionDetail, SessionSummary } from "@kestrel/protocol";
import type { SessionStore } from "./store.js";

interface Row {
  id: string;
  tenant_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  status: string;
  model: string;
  message_count: number;
  workspace: string;
  parent_id: string | null;
  depth: number | null;
  role: string | null;
  data: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  workspace TEXT NOT NULL,
  parent_id TEXT,
  depth INTEGER,
  role TEXT,
  data TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions (updated_at DESC);
`;

/**
 * Session storage in a single SQLite file (Node's built-in `node:sqlite`, no
 * native build step). Summary columns are duplicated out of the JSON document
 * so listing never parses a transcript, while the document itself stays the
 * source of truth for everything a session holds.
 *
 * Writes are synchronous, so they are inherently serialized in this process;
 * WAL plus a busy timeout lets a second process read while one writes. Like
 * the file store, it is not a multi-writer coordinator.
 */
export class SqliteSessionStore implements SessionStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  async list(): Promise<SessionSummary[]> {
    const rows = this.db
      .prepare("SELECT id, tenant_id, title, created_at, updated_at, status, model, message_count, workspace, parent_id, depth, role FROM sessions ORDER BY updated_at DESC")
      .all() as unknown as Row[];
    return rows.map((row) => this.summary(row));
  }

  async load(id: string, tenantId?: string): Promise<SessionDetail | undefined> {
    const row = this.db
      .prepare("SELECT data FROM sessions WHERE id = ? AND tenant_id = ?")
      .get(id, tenantId ?? "default") as { data?: string } | undefined;
    if (!row?.data) return undefined;
    return JSON.parse(row.data) as SessionDetail;
  }

  async save(detail: SessionDetail): Promise<void> {
    const tenantId = detail.tenantId ?? "default";
    this.db
      .prepare(
        `INSERT INTO sessions (id, tenant_id, title, created_at, updated_at, status, model, message_count, workspace, parent_id, depth, role, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           title = excluded.title,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           status = excluded.status,
           model = excluded.model,
           message_count = excluded.message_count,
           workspace = excluded.workspace,
           parent_id = excluded.parent_id,
           depth = excluded.depth,
           role = excluded.role,
           data = excluded.data`,
      )
      .run(
        detail.id,
        tenantId,
        detail.title,
        detail.createdAt,
        detail.updatedAt,
        detail.status,
        detail.model,
        detail.messageCount,
        detail.workspace,
        detail.parentId ?? null,
        detail.depth ?? null,
        detail.role ?? null,
        JSON.stringify(detail),
      );
  }

  async delete(id: string, tenantId?: string): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE id = ? AND tenant_id = ?").run(id, tenantId ?? "default");
  }

  /** Writes are durable when `save` resolves, so there is nothing to drain. */
  async flush(): Promise<void> {}

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private summary(row: Row): SessionSummary {
    const summary: SessionSummary = {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: row.status as SessionSummary["status"],
      model: row.model,
      messageCount: row.message_count,
      workspace: row.workspace,
    };
    if (row.parent_id) summary.parentId = row.parent_id;
    if (row.depth !== null) summary.depth = row.depth;
    if (row.role) summary.role = row.role;
    if (row.tenant_id !== "default") summary.tenantId = row.tenant_id;
    return summary;
  }
}
