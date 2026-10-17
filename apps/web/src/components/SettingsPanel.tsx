import { useEffect, useState } from "react";
import type { BootstrapResponse, SessionDetail } from "@kestrel/protocol";
import type { Connection, KestrelActions } from "../state.js";
import { CloseIcon, PluginIcon, ShieldIcon, TerminalIcon } from "./icons.js";
import { normalizeEndpoint } from "../api.js";

export function SettingsPanel({
  open,
  bootstrap,
  detail,
  connection,
  hasToken,
  endpoint,
  onClose,
  onSaveToken,
  onSaveEndpoint,
  onSignOut,
  actions,
}: {
  open: boolean;
  bootstrap?: BootstrapResponse;
  detail?: SessionDetail;
  connection: Connection;
  hasToken: boolean;
  endpoint: string;
  onClose: () => void;
  onSaveToken: (token: string) => void;
  onSaveEndpoint: (endpoint: string) => void;
  onSignOut: () => void;
  actions: KestrelActions;
}) {
  const [prompt, setPrompt] = useState(detail?.systemPrompt ?? "");
  const [token, setToken] = useState("");
  const [endpointValue, setEndpointValue] = useState(endpoint);
  const [endpointError, setEndpointError] = useState<string>();
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setPrompt(detail?.systemPrompt ?? "");
    setDirty(false);
  }, [detail?.id, detail?.systemPrompt]);

  if (!open) return null;

  const models = bootstrap?.models ?? [];
  const plugins = bootstrap?.plugins ?? [];
  const tools = bootstrap?.tools ?? [];
  const active = plugins.filter((plugin) => plugin.state === "active").length;

  return (
    <div className="drawer-backdrop" onClick={onClose} role="presentation">
      <aside className="drawer" onClick={(event) => event.stopPropagation()} aria-label="Settings">
        <header className="drawer-head">
          <div>
            <h2>Settings</h2>
            <p>Runtime, model and extension surface</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close settings">
            <CloseIcon size={18} />
          </button>
        </header>

        <div className="drawer-body">
          {bootstrap?.principal && (
            <section className="settings-section">
              <h3>Account</h3>
              <dl className="kv">
                <dt>User</dt>
                <dd>{bootstrap.principal.name}</dd>
                <dt>Role</dt>
                <dd>{bootstrap.principal.role}</dd>
                <dt>Tenant</dt>
                <dd>{bootstrap.tenant?.name ?? bootstrap.principal.tenantId}</dd>
              </dl>
              {hasToken && (
                <button type="button" className="button small" onClick={onSignOut}>
                  Sign out
                </button>
              )}
            </section>
          )}

          <section className="settings-section">
            <h3>Server</h3>
            <dl className="kv">
              <dt>Protocol</dt>
              <dd>{bootstrap?.protocol ?? "—"}</dd>
              <dt>Version</dt>
              <dd>{bootstrap?.version ?? "—"}</dd>
              <dt>Stream</dt>
              <dd className={`inline-state ${connection}`}>{connection}</dd>
            </dl>
            <label className="field">
              <span>API endpoint</span>
              <div className="field-row">
                <input
                  value={endpointValue}
                  onChange={(event) => {
                    setEndpointValue(event.target.value);
                    setEndpointError(undefined);
                  }}
                  placeholder={window.location.origin}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="button small"
                  onClick={() => {
                    try {
                      onSaveEndpoint(normalizeEndpoint(endpointValue || window.location.origin));
                    } catch (error) {
                      setEndpointError(error instanceof Error ? error.message : String(error));
                    }
                  }}
                >
                  Connect
                </button>
              </div>
            </label>
            {endpointError && <p className="settings-note">Invalid endpoint: {endpointError}</p>}
            <p className="settings-note">
              Use the server origin, or a path when both tiers share a reverse proxy. The page reloads with the new
              endpoint.
            </p>
            <label className="field">
              <span>Access token</span>
              <div className="field-row">
                <input
                  type="password"
                  value={token}
                  placeholder={hasToken ? "•••••••• (saved)" : "optional bearer token"}
                  onChange={(event) => setToken(event.target.value)}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="button small"
                  onClick={() => {
                    onSaveToken(token);
                    setToken("");
                  }}
                >
                  Save
                </button>
              </div>
            </label>
            <p className="settings-note">The token is stored in this browser only and sent as a bearer header.</p>
          </section>

          {detail && (
            <section className="settings-section">
              <h3>Session</h3>
              <label className="field">
                <span>Model</span>
                <select
                  value={detail.model}
                  disabled={detail.status === "running"}
                  onChange={(event) => void actions.setModel(event.target.value)}
                >
                  {models.length === 0 && <option value={detail.model}>{detail.model}</option>}
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label ? `${model.label} · ${model.provider}` : `${model.id} · ${model.provider}`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Workspace</span>
                <input value={detail.workspace} readOnly />
              </label>
              <label className="field">
                <span>System prompt</span>
                <textarea
                  rows={8}
                  value={prompt}
                  onChange={(event) => {
                    setPrompt(event.target.value);
                    setDirty(true);
                  }}
                />
              </label>
              <div className="field-actions">
                <button
                  type="button"
                  className="button small primary"
                  disabled={!dirty}
                  onClick={() => {
                    void actions.setSystemPrompt(prompt).then(() => setDirty(false));
                  }}
                >
                  Save prompt
                </button>
                <button
                  type="button"
                  className="button small ghost"
                  disabled={!dirty}
                  onClick={() => {
                    setPrompt(detail.systemPrompt ?? "");
                    setDirty(false);
                  }}
                >
                  Reset
                </button>
              </div>
            </section>
          )}

          <section className="settings-section">
            <h3>
              <PluginIcon size={15} /> Plugins <span className="muted">{active}/{plugins.length} active</span>
            </h3>
            <ul className="plugin-list">
              {plugins.map((plugin) => (
                <li key={plugin.id}>
                  <span className={`dot ${plugin.state === "active" ? "live" : plugin.state === "error" ? "error" : ""}`} />
                  <div className="plugin-body">
                    <div className="plugin-title">
                      <strong>{plugin.name}</strong>
                      <span className="badge ghost">v{plugin.version}</span>
                    </div>
                    <span className="plugin-desc">
                      {plugin.description ?? "No description."}
                      {plugin.error ? ` — ${plugin.error}` : ""}
                    </span>
                  </div>
                </li>
              ))}
              {plugins.length === 0 && <li className="muted">No plugins reported.</li>}
            </ul>
          </section>

          <section className="settings-section">
            <h3>
              <TerminalIcon size={15} /> Tools <span className="muted">{tools.length}</span>
            </h3>
            <div className="chip-list">
              {tools.map((tool) => (
                <span key={tool.name} className={`chip${tool.permission === "ask" ? " warn" : ""}`} title={tool.description}>
                  {tool.name}
                </span>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <h3>
              <ShieldIcon size={15} /> Safety
            </h3>
            <p className="settings-note">
              Tools marked <span className="badge warn">ask</span> pause the run and wait for an explicit approval.
              Shell commands, network access and file writes are subject to this policy.
            </p>
          </section>
        </div>
      </aside>
    </div>
  );
}
