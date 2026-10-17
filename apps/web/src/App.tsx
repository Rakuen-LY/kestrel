import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, SessionDetail } from "@kestrel/protocol";
import { ApprovalDialog } from "./components/ApprovalDialog.js";
import { Composer } from "./components/Composer.js";
import { MessageBubble } from "./components/MessageBubble.js";
import { LoginScreen } from "./components/LoginScreen.js";
import { PluginSlot } from "./components/PluginSlot.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { CheckpointsPanel } from "./components/CheckpointsPanel.js";
import { Sidebar } from "./components/Sidebar.js";
import { ToolCallCard } from "./components/ToolCall.js";
import { BoltIcon, HistoryIcon, MenuIcon, PenIcon, SettingsIcon } from "./components/icons.js";
import { usePluginExtensions } from "./extensions.js";
import { useKestrel } from "./state.js";
import { readToken, writeEndpoint, writeToken } from "./api.js";

const SUGGESTIONS = [
  "Map this repository and explain its architecture.",
  "Find and fix the failing tests.",
  "Add a new plugin that exposes a tool for querying the database.",
  "Review the last commit for security regressions.",
];

function sessionMessages(detail: SessionDetail | undefined): ChatMessage[] {
  return (detail?.messages ?? []).filter((message) => message.role !== "tool" && !message.hidden);
}

function TitleEditor({ title, onRename }: { title: string; onRename: (value: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);

  useEffect(() => {
    setValue(title);
    setEditing(false);
  }, [title]);

  if (editing) {
    return (
      <input
        className="title-input"
        value={value}
        autoFocus
        maxLength={200}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          setEditing(false);
          if (value.trim() && value.trim() !== title) onRename(value.trim());
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setValue(title);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button type="button" className="title-button" onClick={() => setEditing(true)} title="Rename session">
      <span>{title}</span>
      <PenIcon size={13} />
    </button>
  );
}

export default function App() {
  const { state, actions, api } = useKestrel();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);
  const [hasToken, setHasToken] = useState(() => Boolean(readToken()));
  const bottom = useRef<HTMLDivElement>(null);

  const messages = useMemo(() => sessionMessages(state.detail), [state.detail]);
  const calls = Object.values(state.runningCalls);
  const streamingMessage: ChatMessage | undefined = state.streaming
    ? {
        id: state.streaming.messageId,
        role: "assistant",
        content: state.streaming.content,
        reasoning: state.streaming.reasoning || undefined,
        createdAt: new Date().toISOString(),
        model: state.detail?.model,
      }
    : undefined;

  useEffect(() => {
    const element = bottom.current;
    if (!element) return;
    const nearBottom = element.getBoundingClientRect().bottom < window.innerHeight + 160;
    if (nearBottom || state.busy) element.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [state.busy, state.detail?.messages.length, state.streaming?.content.length, calls.length]);

  const { extensions, errors: extensionErrors } = usePluginExtensions(state.bootstrap, api);
  const modelOptions = state.bootstrap?.models ?? [];
  const pluginCount = state.bootstrap?.plugins.length ?? 0;
  const approval = state.approvals[0];

  if (state.unauthorized) {
    return <LoginScreen endpoint={api.endpoint} onSubmit={(token) => actions.signIn(token)} />;
  }

  return (
    <div className="app">
      <Sidebar
        sessions={state.sessions}
        activeId={state.activeId}
        open={sidebarOpen}
        connection={state.connection}
        pluginCount={pluginCount}
        modelCount={modelOptions.length}
        onClose={() => setSidebarOpen(false)}
        onSelect={(id) => {
          actions.select(id);
          setSidebarOpen(false);
        }}
        onCreate={() => {
          void actions.createSession();
          setSidebarOpen(false);
        }}
        onDelete={(id) => {
          if (window.confirm("Delete this session? This cannot be undone.")) void actions.remove(id);
        }}
        onOpenSettings={() => {
          setSettingsOpen(true);
          setSidebarOpen(false);
        }}
        footer={<PluginSlot slot="sidebar.footer" extensions={extensions} api={api} />}
      />

      <main className="main">
        <header className="topbar">
          <button type="button" className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
            <MenuIcon size={18} />
          </button>
          <div className="topbar-title">
            <TitleEditor
              title={state.detail?.title ?? "Kestrel"}
              onRename={(value) => {
                if (state.activeId) void actions.rename(state.activeId, value);
              }}
            />
            {state.detail && (
              <span className="topbar-meta">
                {state.detail.status === "running" ? (
                  <span className="running-state">
                    <span className="dot live" /> running
                  </span>
                ) : (
                  state.detail.messageCount + " messages"
                )}
              </span>
            )}
          </div>
          <div className="topbar-actions">
            <PluginSlot slot="session.header" extensions={extensions} api={api} sessionId={state.activeId} />
            {state.detail && modelOptions.length > 0 && (
              <label className="model-picker" title="Model for this session">
                <BoltIcon size={14} />
                <select
                  value={state.detail.model}
                  disabled={state.busy}
                  onChange={(event) => void actions.setModel(event.target.value)}
                >
                  {modelOptions.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.id}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              type="button"
              className="icon-button"
              onClick={() => setCheckpointsOpen(true)}
              aria-label="Workspace checkpoints"
              title="Workspace checkpoints"
              disabled={!state.activeId}
            >
              <HistoryIcon size={17} />
            </button>
            <button type="button" className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Settings">
              <SettingsIcon size={17} />
            </button>
          </div>
        </header>

        <section className="transcript" aria-live="polite">
          {state.loading && (
            <div className="center-state">
              <div className="spinner" />
              <span>Connecting to Kestrel…</span>
            </div>
          )}

          {!state.loading && !state.detail && (
            <div className="welcome">
              <div className="welcome-mark">K</div>
              <h1>What should we build?</h1>
              <p>
                Kestrel is an autonomous agent that reads, edits and runs code in your workspace. Everything you see —
                models, tools, plugins — is an extension.
              </p>
              <div className="suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion} type="button" onClick={() => void actions.send(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </div>
              <div className="welcome-footnote">
                {pluginCount > 0
                  ? `${pluginCount} plugins loaded · ${modelOptions.length} models available`
                  : "Starting the plugin host…"}
              </div>
            </div>
          )}

          {!state.loading && state.detail && (
            <div className="thread">
              {messages.length === 0 && !state.streaming && (
                <div className="thread-empty">
                  <h2>New session</h2>
                  <p>Send a message to start. Kestrel will plan, call tools and report back with diffs and commands.</p>
                </div>
              )}
              {messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  calls={message.toolCalls}
                  results={state.toolRuns}
                />
              ))}

              {calls.length > 0 && (
                <div className="live-tools">
                  <div className="live-tools-label">Live tool activity</div>
                  {calls.map((call) => (
                    <ToolCallCard key={call.id} call={call} pending />
                  ))}
                </div>
              )}

              {streamingMessage && (
                <MessageBubble message={streamingMessage} streaming results={state.toolRuns} />
              )}

              {state.error && (
                <div className="inline-error">
                  <strong>{state.error.code ?? "Error"}</strong>
                  <span>{state.error.message}</span>
                  <button type="button" className="button small ghost" onClick={actions.dismissError}>
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          )}
          <div ref={bottom} />
        </section>

        <Composer
          busy={state.busy}
          disabled={state.loading}
          placeholder={
            state.activeId
              ? "Ask Kestrel to inspect, change or run something…"
              : "Start a new session by describing a task…"
          }
          onSend={(value) => actions.send(value)}
          onCancel={() => actions.cancel()}
        />
      </main>

      <CheckpointsPanel
        open={checkpointsOpen}
        api={api}
        sessionId={state.activeId}
        onClose={() => setCheckpointsOpen(false)}
      />

      <SettingsPanel
        open={settingsOpen}
        bootstrap={state.bootstrap}
        detail={state.detail}
        connection={state.connection}
        hasToken={hasToken}
        endpoint={api.endpoint}
        onClose={() => setSettingsOpen(false)}
        onSaveEndpoint={(endpoint) => {
          writeEndpoint(endpoint);
          window.location.reload();
        }}
        extensionSlot={<PluginSlot slot="settings.section" extensions={extensions} api={api} />}
        extensionErrors={extensionErrors}
        onSignOut={() => {
          actions.signOut();
          setSettingsOpen(false);
        }}
        onSaveToken={(token) => {
          api.setToken(token);
          writeToken(token);
          setHasToken(Boolean(token));
          window.location.reload();
        }}
        actions={actions}
      />

      {approval && (
        <ApprovalDialog
          approval={approval}
          onDecide={(approved) => actions.approve(approval.id, approved)}
        />
      )}
    </div>
  );
}
