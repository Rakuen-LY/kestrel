import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { CheckpointInfo } from "@kestrel/protocol";
import type { KestrelApi } from "../api";
import { CloseIcon, HistoryIcon } from "./icons";

interface Props {
  open: boolean;
  api: KestrelApi;
  sessionId?: string;
  onClose: () => void;
}

/**
 * Lists workspace snapshots for the active session and restores them. A
 * restore overwrites files changed since the snapshot, so it always asks first
 * and the server takes a safety snapshot of its own.
 */
export function CheckpointsPanel({ open, api, sessionId, onClose }: Props) {
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [reason, setReason] = useState<string>();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async () => {
    if (!sessionId) return;
    setError(undefined);
    try {
      const response = await api.checkpoints(sessionId);
      setCheckpoints(response.checkpoints);
      setEnabled(response.enabled);
      setReason(response.reason);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api, sessionId]);

  useEffect(() => {
    if (open && sessionId) void load();
  }, [open, sessionId, load]);

  if (!open) return null;

  const snapshot = async (event: FormEvent) => {
    event.preventDefault();
    if (!sessionId) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const { checkpoint } = await api.createCheckpoint(sessionId, label.trim() || undefined);
      setLabel("");
      setNotice(`Snapshot ${checkpoint.id} captured ${checkpoint.files} files.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (checkpoint: CheckpointInfo) => {
    if (!sessionId) return;
    const confirmed = window.confirm(
      `Restore "${checkpoint.label}"?\n\nFiles changed since this snapshot are replaced. ` +
        `A safety snapshot of the current state is taken first.`,
    );
    if (!confirmed) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await api.restoreCheckpoint(sessionId, checkpoint.id);
      setNotice(`Restored "${result.restored.label}". Undo it from ${result.safety.id}.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawer-backdrop" onClick={onClose} role="presentation">
      <aside className="drawer" onClick={(event) => event.stopPropagation()} aria-label="Checkpoints">
        <header className="drawer-head">
          <div>
            <h2>Checkpoints</h2>
            <p>Workspace snapshots, taken before every turn</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close checkpoints">
            <CloseIcon size={18} />
          </button>
        </header>

        <div className="drawer-body">
          {!enabled && (
            <section className="settings-section">
              <h3>
                <HistoryIcon size={15} /> Unavailable
              </h3>
              <p className="settings-note">{reason ?? "Checkpoints are disabled on this host."}</p>
            </section>
          )}

          {enabled && (
            <section className="settings-section">
              <h3>
                <HistoryIcon size={15} /> Snapshot now
              </h3>
              <form onSubmit={snapshot}>
                <label className="field">
                  <span>Label</span>
                  <div className="field-row">
                    <input
                      value={label}
                      onChange={(event) => setLabel(event.target.value)}
                      placeholder="Optional, for example “before refactor”"
                      maxLength={120}
                    />
                    <button type="submit" className="button small primary" disabled={busy || !sessionId}>
                      Capture
                    </button>
                  </div>
                </label>
              </form>
              <p className="settings-note">
                Snapshots honour <code>.gitignore</code> and skip dependency directories. The workspace is
                shared, so a restore affects every session using it.
              </p>
            </section>
          )}

          {error && <p className="settings-note error">{error}</p>}
          {notice && <p className="settings-note">{notice}</p>}

          <section className="settings-section">
            <h3>
              History <span className="muted">{checkpoints.length}</span>
            </h3>
            {checkpoints.length === 0 && <p className="settings-note">No snapshots yet.</p>}
            <ul className="checkpoint-list">
              {[...checkpoints].reverse().map((checkpoint) => (
                <li key={checkpoint.id} className="checkpoint-row">
                  <div className="checkpoint-body">
                    <span className="checkpoint-label">{checkpoint.label}</span>
                    <span className="checkpoint-meta">
                      {new Date(checkpoint.createdAt).toLocaleString()} · {checkpoint.files} files ·{" "}
                      <span className="muted">
                        +{checkpoint.changes.added} ~{checkpoint.changes.modified} -{checkpoint.changes.deleted}
                      </span>
                    </span>
                  </div>
                  <button
                    type="button"
                    className="button small ghost"
                    disabled={busy}
                    onClick={() => void restore(checkpoint)}
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </aside>
    </div>
  );
}
