import type { SessionSummary } from "@kestrel/protocol";
import { formatTokens } from "../format.js";
import type { Connection } from "../state.js";
import type { ReactNode } from "react";
import { BoltIcon, MenuIcon, PluginIcon, PlusIcon, TrashIcon } from "./icons.js";

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((then - Date.now()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

export function Sidebar({
  sessions,
  activeId,
  open,
  connection,
  pluginCount,
  modelCount,
  onClose,
  onSelect,
  onCreate,
  onDelete,
  onOpenSettings,
  footer,
}: {
  sessions: SessionSummary[];
  activeId?: string;
  open: boolean;
  connection: Connection;
  pluginCount: number;
  modelCount: number;
  onClose: () => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
  footer?: ReactNode;
}) {
  return (
    <>
      {open && <div className="sidebar-scrim" onClick={onClose} role="presentation" />}
      <aside className={`sidebar${open ? " open" : ""}`}>
        <div className="brand">
          <span className="brand-mark">K</span>
          <div className="brand-text">
            <strong>Kestrel</strong>
            <span>plugin-first agents</span>
          </div>
          <button type="button" className="icon-button subtle mobile-only" onClick={onClose} aria-label="Close menu">
            <MenuIcon size={18} />
          </button>
        </div>

        <button type="button" className="new-session" onClick={onCreate}>
          <PlusIcon size={16} />
          New session
        </button>

        <div className="sidebar-label">
          <span>Sessions</span>
          <span className="count">{sessions.length}</span>
        </div>

        <nav className="session-list" aria-label="Sessions">
          {sessions.length === 0 && (
            <div className="session-empty">
              No sessions yet.
              <br />
              Start one with <strong>New session</strong>.
            </div>
          )}
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`session-item${session.id === activeId ? " active" : ""}${session.parentId ? " subagent" : ""}`}
              onClick={() => onSelect(session.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") onSelect(session.id);
              }}
            >
              <div className="session-main">
                <span className="session-title">
                  {session.parentId && <span className="subagent-mark" aria-label="subagent">↳</span>}
                  {session.title}
                </span>
                <span className="session-meta">
                  {session.role && <span className="role-chip">{session.role}</span>}
                  {session.status === "running"
                    ? "running"
                    : session.status === "interrupted"
                      ? "interrupted"
                      : ago(session.updatedAt)}{" "}
                  · {session.messageCount} msg
                  {session.usage ? ` · ${formatTokens(session.usage.totalTokens)} tok` : ""}
                </span>
              </div>
              {session.status === "running" && <span className="dot live" />}
              <button
                type="button"
                className="icon-button subtle session-delete"
                aria-label={`Delete ${session.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(session.id);
                }}
              >
                <TrashIcon size={14} />
              </button>
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className={`connection ${connection}`}>
            <span className="dot" />
            {connection === "online" ? "Connected" : connection === "connecting" ? "Connecting…" : "Reconnecting…"}
          </div>
          <div className="sidebar-stats">
            <span>
              <BoltIcon size={13} /> {modelCount} models
            </span>
            <span>
              <PluginIcon size={13} /> {pluginCount} plugins
            </span>
          </div>
          {footer}
          <button type="button" className="settings-link" onClick={onOpenSettings}>
            Settings &amp; plugins
          </button>
        </div>
      </aside>
    </>
  );
}
