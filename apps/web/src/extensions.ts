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

export interface LoadedExtension extends ConsoleExtension {
  plugin: ConsoleContext["plugin"];
}

export interface ExtensionError {
  plugin: string;
  message: string;
}

/**
 * Imports every active plugin's browser bundle and collects what it registers.
 * One broken bundle never blocks the others or the console itself.
 */
export async function loadConsoleExtensions(
  plugins: PluginInfo[],
  api: KestrelApi,
): Promise<{ extensions: LoadedExtension[]; errors: ExtensionError[] }> {
  const extensions: LoadedExtension[] = [];
  const errors: ExtensionError[] = [];

  for (const plugin of plugins) {
    if (plugin.state !== "active" || !plugin.web) continue;
    const base = `${api.endpoint}/plugins/${encodeURIComponent(plugin.id)}/`;
    const identity = { id: plugin.id, name: plugin.name, version: plugin.version };

    try {
      for (const href of plugin.web.css ?? []) injectStylesheet(base + href);
      const module = (await import(/* @vite-ignore */ base + plugin.web.entry)) as { default?: unknown };
      const activate = module.default;
      if (typeof activate !== "function") {
        throw new Error("The bundle must export default (api) => void.");
      }
      const context: ConsoleContext = {
        plugin: identity,
        endpoint: api.endpoint,
        request: (path, init) => api.request(path, init),
      };
      await (activate as (api: ConsoleModuleApi) => unknown)({
        context,
        register(extension) {
          if (!extension?.id || typeof extension.mount !== "function" || !isSlot(extension.slot)) {
            throw new Error("register() needs { id, slot, mount }.");
          }
          if (extensions.some((item) => item.plugin.id === plugin.id && item.id === extension.id)) {
            throw new Error(`Duplicate extension id "${extension.id}".`);
          }
          extensions.push({ ...extension, plugin: identity });
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ plugin: plugin.name, message });
      console.warn(`[kestrel] plugin UI failed: ${plugin.name}: ${message}`);
    }
  }

  return { extensions, errors };
}

function isSlot(value: unknown): value is SlotName {
  return value === "sidebar.footer" || value === "settings.section" || value === "session.header";
}

const injected = new Set<string>();

function injectStylesheet(href: string): void {
  if (injected.has(href)) return;
  injected.add(href);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.kestrelPlugin = href;
  document.head.append(link);
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
