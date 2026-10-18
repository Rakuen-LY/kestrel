import { useEffect, useRef, useState } from "react";
import type { BootstrapResponse, ChatMessage, PluginInfo, ToolCall, WorkspaceFile } from "@kestrel/protocol";
import type { KestrelApi } from "./api.js";

/**
 * Where a plugin may render. Slots are deliberately few and stable: a plugin
 * contributes a self-contained island of DOM, not a React tree, so plugin
 * code cannot depend on the console's component internals or React version.
 */
export type SlotName =
  | "sidebar.footer"
  | "settings.section"
  | "session.header"
  | "message.after"
  | "composer.actions"
  | "file.viewer";

/** Declarative narrowing for slots that render once per item. */
export interface SlotMatch {
  /** Roles the extension renders for; omitted means user and assistant. */
  roles?: Array<"user" | "assistant">;
  /** Render only when the message issued one of these tool calls. */
  toolNames?: string[];
  /** File extensions (without the dot) a `file.viewer` accepts; empty means any file. */
  extensions?: string[];
}

/** Message projection sent to a sandbox: base64 image data stays in the console. */
export interface RenderableMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  reasoning?: string;
  model?: string;
  toolCalls?: ToolCall[];
  images?: Array<{ mimeType: string; name?: string }>;
}

/** A file projection for `file.viewer`; oversized text is clipped before it reaches the sandbox. */
export interface RenderableFile {
  path: string;
  name: string;
  size: number;
  mimeType: string;
  encoding: "utf8" | "base64";
  content: string;
  truncated: boolean;
  binary: boolean;
  lines?: number;
}

export interface ConsoleContext {
  plugin: { id: string; name: string; version: string };
  /** Absolute API origin, useful for links and streams. */
  endpoint: string;
  /** Active session, when the slot is session-scoped. */
  sessionId?: string;
  /** Slot-specific input; `message`, `file` or `composer` depending on the slot. */
  payload: Record<string, unknown>;
  /** Current message for `message.after`. */
  message?: RenderableMessage;
  /** Current file for `file.viewer`. */
  file?: RenderableFile;
  /** Authenticated JSON request against the Kestrel API. */
  request<T = unknown>(path: string, init?: RequestInit): Promise<T>;
}

export interface ConsoleExtension {
  /** Unique within the plugin. */
  id: string;
  slot: SlotName;
  order?: number;
  /** Narrows per-message slots without a mounted iframe per message. */
  match?: SlotMatch;
  /** Receives an empty element; return a cleanup function if needed. */
  mount(element: HTMLElement, context: ConsoleContext): void | (() => void);
}

export interface ConsoleModuleApi {
  register(extension: ConsoleExtension): void;
  context: ConsoleContext;
}

/** A contribution discovered by running a bundle in a throwaway sandbox. */
export interface ExtensionContribution {
  id: string;
  slot: SlotName;
  order?: number;
  match?: SlotMatch;
}

/** Everything the console needs to load a contribution in its own iframe. */
export interface LoadedExtension extends ExtensionContribution {
  plugin: ConsoleContext["plugin"];
  endpoint: string;
  entry: string;
  css: string[];
  /** API routes this bundle may call through the proxy. */
  api?: string[];
  /** Console capabilities from the manifest. */
  capabilities?: string[];
  /** Asset fingerprint the bundle was loaded with; changes force a remount. */
  revision?: string;
}

export interface ExtensionError {
  plugin: string;
  message: string;
}

interface DiscoveryInput {
  plugin: ConsoleContext["plugin"];
  endpoint: string;
  entry: string;
  css: string[];
}

const DISCOVERY_TIMEOUT_MS = 5_000;
const SLOTS = new Set<SlotName>([
  "sidebar.footer",
  "settings.section",
  "session.header",
  "message.after",
  "composer.actions",
  "file.viewer",
]);

/** Plugins receive at most this much file text; larger previews stay in the console. */
const MAX_PLUGIN_FILE_CHARS = 512_000;

export function filePayload(file: WorkspaceFile): RenderableFile {
  const clipped = file.content.length > MAX_PLUGIN_FILE_CHARS;
  return {
    path: file.path,
    name: file.name,
    size: file.size,
    mimeType: file.mimeType,
    encoding: file.encoding,
    content: clipped ? file.content.slice(0, MAX_PLUGIN_FILE_CHARS) : file.content,
    truncated: file.truncated || clipped,
    binary: file.binary,
    ...(file.lines !== undefined ? { lines: file.lines } : {}),
  };
}

export function fileExtension(path: string): string {
  const name = path.split("/").pop() ?? path;
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toLowerCase() : "";
}

export function matchesFile(match: SlotMatch | undefined, file: Pick<WorkspaceFile, "path">): boolean {
  if (!match?.extensions?.length) return true;
  return match.extensions.includes(fileExtension(file.path));
}

export function messagePayload(message: ChatMessage): RenderableMessage {
  return {
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    content: message.content,
    createdAt: message.createdAt,
    ...(message.reasoning ? { reasoning: message.reasoning } : {}),
    ...(message.model ? { model: message.model } : {}),
    ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
    ...(message.images?.length
      ? { images: message.images.map(({ mimeType, name }) => ({ mimeType, ...(name ? { name } : {}) })) }
      : {}),
  };
}

export function matchesMessage(match: SlotMatch | undefined, message: ChatMessage): boolean {
  if (message.role !== "user" && message.role !== "assistant") return false;
  if (!match) return true;
  if (match.roles?.length && !match.roles.includes(message.role)) return false;
  if (match.toolNames?.length) {
    const names = new Set((message.toolCalls ?? []).map((call) => call.name));
    if (!match.toolNames.some((name) => names.has(name))) return false;
  }
  return true;
}

/**
 * Runs every active bundle in a sandboxed iframe and records what it registers.
 * Bundles never execute in the console's origin: the iframe has an opaque
 * origin, no access to storage or cookies, and no direct network access.
 *
 * `revisions` carries asset fingerprints from the hot-reload channel. A
 * fingerprint is appended to the module URL so a changed bundle is a different
 * specifier to the browser's module map, which would otherwise keep serving
 * the first import for the lifetime of the page.
 */
export async function loadConsoleExtensions(
  plugins: PluginInfo[],
  api: KestrelApi,
  revisions: Record<string, string | undefined> = {},
): Promise<{ extensions: LoadedExtension[]; errors: ExtensionError[] }> {
  const extensions: LoadedExtension[] = [];
  const errors: ExtensionError[] = [];

  for (const plugin of plugins) {
    if (plugin.state !== "active" || !plugin.web) continue;
    const identity = { id: plugin.id, name: plugin.name, version: plugin.version };
    const revision = revisions[plugin.id] ?? plugin.web.revision;
    const base = `${api.endpoint}/plugins/${encodeURIComponent(plugin.id)}/`;
    const entry = pluginAssetUrl(base + plugin.web.entry, revision);
    const css = (plugin.web.css ?? []).map((href) => pluginAssetUrl(base + href, revision));

    try {
      const contributions = await discover({
        plugin: identity,
        endpoint: api.endpoint,
        entry,
        css,
      });
      for (const contribution of contributions) {
        if (extensions.some((item) => item.plugin.id === plugin.id && item.id === contribution.id)) {
          throw new Error(`Duplicate extension id "${contribution.id}".`);
        }
        extensions.push({
          ...contribution,
          plugin: identity,
          endpoint: api.endpoint,
          entry,
          css,
          ...(plugin.web.api ? { api: plugin.web.api } : {}),
          ...(plugin.web.capabilities ? { capabilities: plugin.web.capabilities } : {}),
          ...(revision ? { revision } : {}),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ plugin: plugin.name, message });
      console.warn(`[kestrel] plugin UI failed: ${plugin.name}: ${message}`);
    }
  }

  return { extensions, errors };
}

/** Appends `?v=<revision>` without disturbing existing query parameters. */
export function pluginAssetUrl(url: string, revision: string | undefined): string {
  if (!revision) return url;
  return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(revision)}`;
}

async function discover(input: DiscoveryInput): Promise<ExtensionContribution[]> {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  Object.assign(frame.style, {
    position: "fixed",
    width: "0",
    height: "0",
    border: "0",
    opacity: "0",
    pointerEvents: "none",
  });
  document.body.append(frame);
  frame.src = `${input.endpoint}/plugin-sandbox.html`;

  return new Promise<ExtensionContribution[]>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: ExtensionContribution[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      frame.remove();
      if (error) reject(error);
      else resolve(value ?? []);
    };
    const timer = setTimeout(
      () => finish(new Error("The bundle did not register an extension in time.")),
      DISCOVERY_TIMEOUT_MS,
    );
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== frame.contentWindow) return;
      const data = event.data as
        | { type?: string; extensions?: unknown; message?: unknown; id?: unknown }
        | undefined;
      if (!data || typeof data !== "object") return;
      if (data.type === "kestrel:ready") {
        frame.contentWindow?.postMessage(
          {
            type: "kestrel:init",
            mode: "discover",
            plugin: input.plugin,
            endpoint: input.endpoint,
            entry: input.entry,
            css: input.css,
            theme: themeVariables(),
          },
          "*",
        );
      } else if (data.type === "kestrel:request" && typeof data.id === "number") {
        frame.contentWindow?.postMessage(
          {
            type: "kestrel:response",
            id: data.id,
            ok: false,
            error: "The API is not available while the bundle is being discovered.",
          },
          "*",
        );
      } else if (data.type === "kestrel:registered") {
        finish(undefined, normalizeContributions(data.extensions));
      } else if (data.type === "kestrel:error") {
        finish(new Error(typeof data.message === "string" ? data.message : "The bundle failed to load."));
      }
    };
    window.addEventListener("message", onMessage);
  });
}

function normalizeContributions(value: unknown): ExtensionContribution[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const contributions: ExtensionContribution[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as { id?: unknown; slot?: unknown; order?: unknown; match?: unknown };
    if (typeof record.id !== "string" || !record.id || seen.has(record.id)) continue;
    if (typeof record.slot !== "string" || !SLOTS.has(record.slot as SlotName)) continue;
    seen.add(record.id);
    const match = normalizeMatch(record.match);
    contributions.push({
      id: record.id,
      slot: record.slot as SlotName,
      ...(typeof record.order === "number" ? { order: record.order } : {}),
      ...(match ? { match } : {}),
    });
  }
  return contributions;
}

function normalizeMatch(value: unknown): SlotMatch | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { roles?: unknown; toolNames?: unknown; extensions?: unknown };
  const roles = Array.isArray(record.roles)
    ? record.roles.filter((role): role is "user" | "assistant" => role === "user" || role === "assistant")
    : [];
  const toolNames = Array.isArray(record.toolNames)
    ? record.toolNames.filter((name): name is string => typeof name === "string" && name.length > 0)
    : [];
  const extensions = Array.isArray(record.extensions)
    ? record.extensions
        .filter((extension): extension is string => typeof extension === "string" && extension.length > 0)
        .map((extension) => extension.replace(/^\./, "").toLowerCase())
    : [];
  if (roles.length === 0 && toolNames.length === 0 && extensions.length === 0) return undefined;
  return {
    ...(roles.length ? { roles } : {}),
    ...(toolNames.length ? { toolNames } : {}),
    ...(extensions.length ? { extensions } : {}),
  };
}

/** Copies the console's CSS custom properties so plugin DOM inherits the theme. */
export function themeVariables(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const element of [document.documentElement, document.body]) {
    const style = getComputedStyle(element);
    for (let index = 0; index < style.length; index += 1) {
      const name = style[index];
      if (name.startsWith("--")) vars[name] = style.getPropertyValue(name);
    }
  }
  return vars;
}

/**
 * Tracks plugin asset fingerprints. The server publishes them on an SSE
 * channel; when the feature is off the stream connects and stays silent, so
 * this hook costs one idle connection and returns `{}`.
 */
export function usePluginAssetRevisions(api: KestrelApi): Record<string, string> {
  const [revisions, setRevisions] = useState<Record<string, string>>({});

  useEffect(() => {
    return api.pluginAssets({
      onReady: (state) => setRevisions(toRevisionMap(state.plugins)),
      onChanged: (event) =>
        setRevisions((current) => {
          const next = { ...current };
          let changed = false;
          for (const plugin of event.plugins) {
            if (next[plugin.id] === plugin.revision) continue;
            next[plugin.id] = plugin.revision;
            changed = true;
          }
          return changed ? next : current;
        }),
    });
  }, [api]);

  return revisions;
}

function toRevisionMap(plugins: Array<{ id: string; revision: string }>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const plugin of plugins) map[plugin.id] = plugin.revision;
  return map;
}

/** Loads extensions once per plugin set and exposes them to the app. */
export function usePluginExtensions(
  bootstrap: BootstrapResponse | undefined,
  api: KestrelApi,
  revisions: Record<string, string> = {},
): { extensions: LoadedExtension[]; errors: ExtensionError[] } {
  const [result, setResult] = useState<{ extensions: LoadedExtension[]; errors: ExtensionError[] }>({
    extensions: [],
    errors: [],
  });
  const loaded = useRef("");

  const key = [
    (bootstrap?.plugins ?? [])
      .map((plugin) => `${plugin.id}@${plugin.version}:${plugin.state}`)
      .join("|"),
    Object.entries(revisions)
      .map(([id, revision]) => `${id}=${revision}`)
      .sort()
      .join(","),
  ].join("#");

  useEffect(() => {
    if (!bootstrap || !key || key === loaded.current) return;
    loaded.current = key;
    let cancelled = false;
    void loadConsoleExtensions(bootstrap.plugins, api, revisions).then((loadedResult) => {
      if (!cancelled) setResult(loadedResult);
    });
    return () => {
      cancelled = true;
    };
    // `revisions` is read through `key`, which is stable across renders.
  }, [api, bootstrap, key]);

  return result;
}
