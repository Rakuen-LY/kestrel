import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type {
  ApprovalRequest,
  BootstrapResponse,
  ChatMessage,
  SessionDetail,
  SessionEvent,
  SessionSummary,
  ToolCall,
  ToolResult,
} from "@kestrel/protocol";
import { ApiError, KestrelApi } from "./api.js";

export type Connection = "connecting" | "online" | "offline";

export interface StreamingMessage {
  messageId: string;
  content: string;
  reasoning: string;
}

export interface UiState {
  bootstrap?: BootstrapResponse;
  sessions: SessionSummary[];
  activeId?: string;
  detail?: SessionDetail;
  streaming?: StreamingMessage;
  runningCalls: Record<string, ToolCall>;
  toolRuns: Record<string, ToolResult>;
  approvals: ApprovalRequest[];
  busy: boolean;
  connection: Connection;
  loading: boolean;
  error?: { message: string; code?: string };
}

const initialState: UiState = {
  sessions: [],
  runningCalls: {},
  toolRuns: {},
  approvals: [],
  busy: false,
  connection: "connecting",
  loading: true,
};

type Action =
  | { type: "bootstrap"; bootstrap: BootstrapResponse }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "select"; id?: string }
  | { type: "detail"; detail: SessionDetail }
  | { type: "event"; event: SessionEvent }
  | { type: "connection"; connection: Connection }
  | { type: "loading"; loading: boolean }
  | { type: "error"; error?: { message: string; code?: string } }
  | { type: "reset" };

function withMessage(detail: SessionDetail | undefined, message: ChatMessage): SessionDetail | undefined {
  if (!detail) return detail;
  if (detail.messages.some((existing) => existing.id === message.id)) return detail;
  return { ...detail, messages: [...detail.messages, message], messageCount: detail.messageCount + 1 };
}

function reducer(state: UiState, action: Action): UiState {
  switch (action.type) {
    case "bootstrap":
      return { ...state, bootstrap: action.bootstrap };
    case "sessions":
      return { ...state, sessions: action.sessions };
    case "select":
      return {
        ...state,
        activeId: action.id,
        detail: action.id && action.id === state.activeId ? state.detail : undefined,
        streaming: undefined,
        runningCalls: {},
        toolRuns: {},
        approvals: [],
        busy: false,
      };
    case "detail":
      return {
        ...state,
        detail: action.detail,
        busy: action.detail.status === "running",
      };
    case "connection":
      return { ...state, connection: action.connection };
    case "loading":
      return { ...state, loading: action.loading };
    case "error":
      return { ...state, error: action.error };
    case "reset":
      return { ...initialState, bootstrap: state.bootstrap };
    case "event":
      return applyEvent(state, action.event);
    default:
      return state;
  }
}

function applyEvent(state: UiState, event: SessionEvent): UiState {
  const isActive = "sessionId" in event && event.sessionId === state.activeId;
  switch (event.type) {
    case "session.updated": {
      const nextSummary = event.session;
      const exists = state.sessions.some((session) => session.id === nextSummary.id);
      const sessions = exists
        ? state.sessions.map((session) => (session.id === nextSummary.id ? nextSummary : session))
        : [nextSummary, ...state.sessions];
      sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const detail =
        state.detail && state.detail.id === nextSummary.id
          ? {
              ...state.detail,
              ...nextSummary,
              messages: state.detail.messages,
              systemPrompt: state.detail.systemPrompt,
            }
          : state.detail;
      return { ...state, sessions, detail, busy: isActive ? nextSummary.status === "running" : state.busy };
    }
    case "session.deleted": {
      return {
        ...state,
        sessions: state.sessions.filter((session) => session.id !== event.sessionId),
        activeId: state.activeId === event.sessionId ? undefined : state.activeId,
        detail: state.activeId === event.sessionId ? undefined : state.detail,
      };
    }
    case "run.started":
      return isActive ? { ...state, busy: true, error: undefined } : state;
    case "run.finished":
      return isActive ? { ...state, busy: false, streaming: undefined, runningCalls: {} } : state;
    case "run.failed":
      return isActive ? { ...state, busy: false, streaming: undefined, error: { message: event.error } } : state;
    case "message.started": {
      if (!isActive) return state;
      const message = event.message;
      return { ...state, streaming: { messageId: message.id, content: "", reasoning: "" } };
    }
    case "message.delta": {
      if (!isActive || !state.streaming || state.streaming.messageId !== event.messageId) return state;
      const streaming = { ...state.streaming };
      if (event.channel === "text") streaming.content += event.delta;
      else streaming.reasoning += event.delta;
      return { ...state, streaming };
    }
    case "message.completed": {
      if (!isActive) return state;
      const detail = withMessage(state.detail, event.message);
      const streaming =
        state.streaming?.messageId === event.message.id ? undefined : state.streaming;
      return { ...state, detail, streaming };
    }
    case "tool.started": {
      if (!isActive) return state;
      return { ...state, runningCalls: { ...state.runningCalls, [event.call.id]: event.call } };
    }
    case "tool.finished": {
      if (!isActive) return state;
      const runningCalls = { ...state.runningCalls };
      delete runningCalls[event.result.callId];
      return { ...state, runningCalls, toolRuns: { ...state.toolRuns, [event.result.callId]: event.result } };
    }
    case "approval.requested": {
      if (!isActive) return state;
      return { ...state, approvals: [...state.approvals.filter((item) => item.id !== event.approval.id), event.approval] };
    }
    case "approval.resolved": {
      if (!isActive) return state;
      return { ...state, approvals: state.approvals.filter((item) => item.id !== event.approvalId) };
    }
    case "notice":
      return state;
    default:
      return state;
  }
}

export interface KestrelActions {
  select(id?: string): void;
  createSession(input?: { title?: string }): Promise<string | undefined>;
  send(content: string): Promise<void>;
  cancel(): Promise<void>;
  remove(id: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  setModel(model: string): Promise<void>;
  setSystemPrompt(prompt: string): Promise<void>;
  approve(approvalId: string, approved: boolean): Promise<void>;
  refresh(): Promise<void>;
  dismissError(): void;
}

export function useKestrel(): { state: UiState; actions: KestrelActions; api: KestrelApi } {
  const [state, dispatch] = useReducer(reducer, initialState);
  const api = useMemo(() => new KestrelApi(), []);
  const activeRef = useRef<string | undefined>(undefined);
  activeRef.current = state.activeId;

  const fail = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof ApiError ? error.code : undefined;
    dispatch({ type: "error", error: { message, code } });
  }, []);

  const refreshSessions = useCallback(async () => {
    const { sessions } = await api.listSessions();
    dispatch({ type: "sessions", sessions });
  }, [api]);

  const refresh = useCallback(async () => {
    try {
      const [{ sessions }, bootstrap] = await Promise.all([api.listSessions(), api.bootstrap()]);
      dispatch({ type: "sessions", sessions });
      dispatch({ type: "bootstrap", bootstrap });
      const id = activeRef.current ?? sessions[0]?.id;
      if (id) {
        dispatch({ type: "select", id });
        const { session } = await api.getSession(id);
        dispatch({ type: "detail", detail: session });
      } else {
        dispatch({ type: "select", id: undefined });
      }
      dispatch({ type: "loading", loading: false });
    } catch (error) {
      dispatch({ type: "loading", loading: false });
      fail(error);
    }
  }, [api, fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Load the transcript when the active session changes.
  useEffect(() => {
    if (!state.activeId) return;
    let cancelled = false;
    void api
      .getSession(state.activeId)
      .then(({ session }) => {
        if (!cancelled) dispatch({ type: "detail", detail: session });
      })
      .catch((error: unknown) => {
        if (!cancelled) fail(error);
      });
    return () => {
      cancelled = true;
    };
  }, [api, state.activeId, fail]);

  // One live stream per active session.
  useEffect(() => {
    if (!state.activeId) return;
    const close = api.stream(state.activeId, {
      onEvent: (event) => dispatch({ type: "event", event }),
      onStatus: (connection) => dispatch({ type: "connection", connection }),
    });
    return close;
  }, [api, state.activeId]);

  const actions = useMemo<KestrelActions>(
    () => ({
      select(id) {
        if (id === activeRef.current) return;
        dispatch({ type: "select", id });
      },
      async createSession(input = {}) {
        try {
          const { session } = await api.createSession(input);
          await refreshSessions();
          dispatch({ type: "select", id: session.id });
          dispatch({ type: "detail", detail: session });
          return session.id;
        } catch (error) {
          fail(error);
          return undefined;
        }
      },
      async send(content) {
        const text = content.trim();
        if (!text) return;
        try {
          let id = activeRef.current;
          if (!id) {
            const { session } = await api.createSession({ title: text.slice(0, 60) });
            id = session.id;
            dispatch({ type: "select", id });
            await refreshSessions();
          }
          await api.sendMessage(id, text);
        } catch (error) {
          fail(error);
        }
      },
      async cancel() {
        if (!activeRef.current) return;
        try {
          await api.cancel(activeRef.current);
        } catch (error) {
          fail(error);
        }
      },
      async remove(id) {
        try {
          await api.deleteSession(id);
          dispatch({ type: "sessions", sessions: state.sessions.filter((session) => session.id !== id) });
          if (activeRef.current === id) dispatch({ type: "select", id: undefined });
        } catch (error) {
          fail(error);
        }
      },
      async rename(id, title) {
        try {
          const { session } = await api.updateSession(id, { title });
          dispatch({ type: "sessions", sessions: state.sessions.map((item) => (item.id === id ? session : item)) });
          if (activeRef.current === id) dispatch({ type: "detail", detail: session });
        } catch (error) {
          fail(error);
        }
      },
      async setModel(model) {
        const id = activeRef.current;
        if (!id || !state.detail) return;
        try {
          const { session } = await api.updateSession(id, { model });
          dispatch({ type: "detail", detail: { ...state.detail, ...session, messages: state.detail.messages } });
        } catch (error) {
          fail(error);
        }
      },
      async setSystemPrompt(prompt) {
        const id = activeRef.current;
        if (!id || !state.detail) return;
        try {
          await api.updateSession(id, { systemPrompt: prompt });
          dispatch({ type: "detail", detail: { ...state.detail, systemPrompt: prompt } });
        } catch (error) {
          fail(error);
        }
      },
      async approve(approvalId, approved) {
        const id = activeRef.current;
        if (!id) return;
        try {
          await api.decideApproval(id, approvalId, { approved });
          dispatch({ type: "event", event: { type: "approval.resolved", sessionId: id, approvalId, approved } });
        } catch (error) {
          fail(error);
        }
      },
      refresh,
      dismissError() {
        dispatch({ type: "error", error: undefined });
      },
    }),
    [api, fail, refresh, refreshSessions, state.sessions, state.detail],
  );

  return { state, actions, api };
}

export function deriveTitle(state: UiState): string {
  if (state.detail) return state.detail.title;
  return "Kestrel";
}
