import { useEffect, useRef, useState } from "react";
import type { BootstrapResponse, PluginInfo } from "@kestrel/protocol";
import type { KestrelApi } from "./api.js";

/**
 * Where a plugin may render. Slots are deliberately few and stable: a plugin
 * contributes a self-contained island of DOM, not a React tree, so plugin
 * code cannot depend on the console's component internals or React version.
 */
export type SlotName = "sidebar.footer" | "settings.section" | "session.header";

export interface ConsoleContext {
  plugin: { id: string; name: string; version: string };
  /** Absolute API origin, useful for links and streams. */
  endpoint: string;
  /** Active session, when the slot is session-scoped. */
  sessionId?: string;
  /** Authenticated JSON request against the Kestrel API. */
  request<T = unknown>(path: string, init?: RequestInit): Promise<T>;
}

export interface ConsoleExtension {
  /** Unique within the plugin. */
  id: string;
  slot: SlotName;
  order?: number;
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
}

/** Everything the console needs to load a contribution in its own iframe. */
export interface LoadedExtension extends ExtensionContribution {
  plugin: ConsoleContext["plugin"];
  endpoint: string;
  entry: string;
  css: string[];
  /** API routes this bundle may call through the proxy. */
  api?: string[];
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
const SLOTS = new Set<SlotName>(["sidebar.footer", "settings.section", "session.header"]);

/**
 * Runs every active bundle in a sandboxed iframe and records what it registers.
 * Bundles never execute in the console's origin: the iframe has an opaque
 * origin, no access to storage or cookies, and no direct network access.
 */
export async function loadConsoleExtensions(
  plugins: PluginInfo[],
  api: KestrelApi,
): Promise<{ extensions: LoadedExtension[]; errors: ExtensionError[] }> {
  const extensions: LoadedExtension[] = [];
  const errors: ExtensionError[] = [];

  for (const plugin of plugins) {
    if (plugin.state !== "active" || !plugin.web) continue;
    const identity = { id: plugin.id, name: plugin.name, version: plugin.version };
    const base = `${api.endpoint}/plugins/${encodeURIComponent(plugin.id)}/`;
    const entry = base + plugin.web.entry;
    const css = (plugin.web.css ?? []).map((href) => base + href);

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
    const record = item as { id?: unknown; slot?: unknown; order?: unknown };
    if (typeof record.id !== "string" || !record.id || seen.has(record.id)) continue;
    if (typeof record.slot !== "string" || !SLOTS.has(record.slot as SlotName)) continue;
    seen.add(record.id);
    contributions.push({
      id: record.id,
      slot: record.slot as SlotName,
      ...(typeof record.order === "number" ? { order: record.order } : {}),
    });
  }
  return contributions;
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

/** Loads extensions once per plugin set and exposes them to the app. */
export function usePluginExtensions(
  bootstrap: BootstrapResponse | undefined,
  api: KestrelApi,
): { extensions: LoadedExtension[]; errors: ExtensionError[] } {
  const [result, setResult] = useState<{ extensions: LoadedExtension[]; errors: ExtensionError[] }>({
    extensions: [],
    errors: [],
  });
  const loaded = useRef("");

  const key = (bootstrap?.plugins ?? [])
    .map((plugin) => `${plugin.id}@${plugin.version}:${plugin.state}`)
    .join("|");

  useEffect(() => {
    if (!bootstrap || !key || key === loaded.current) return;
    loaded.current = key;
    let cancelled = false;
    void loadConsoleExtensions(bootstrap.plugins, api).then((loadedResult) => {
      if (!cancelled) setResult(loadedResult);
    });
    return () => {
      cancelled = true;
    };
  }, [api, bootstrap, key]);

  return result;
}
