import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context, PluginDefinition, PluginHandle, Logger } from "@kestrel/kernel";
import type { PluginInfo, PluginManifest, PluginWeb } from "@kestrel/protocol";

interface DiscoveredPlugin {
  manifest: PluginManifest;
  directory: string;
  entry: string;
  source: PluginInfo["source"];
  info: PluginInfo;
}

export interface PluginHostOptions {
  context: Context;
  logger: Logger;
  /** Directories scanned for plugin packages. */
  directories?: string[];
  /** Explicit plugin entry points, loaded before discovered plugins. */
  entries?: Array<{ manifest: PluginManifest; entry: string; source?: PluginInfo["source"] }>;
  /** Per-plugin configuration, keyed by manifest name. */
  config?: Record<string, Record<string, unknown>>;
  /** Reject plugins not present in this allow-list. */
  allow?: string[];
  /** Milliseconds to wait for a plugin's `apply` to finish. */
  applyTimeoutMs?: number;
}

export interface PluginService {
  list(): PluginInfo[];
  get(name: string): PluginInfo | undefined;
  directories(): string[];
}

const MANIFEST_FILE = "kestrel.plugin.json";
const DEFAULT_ENTRY = "dist/index.js";
const SOURCE_ENTRY = "src/index.ts";

/**
 * Discovers, orders and activates plugins. A plugin is a directory with a
 * manifest and an ESM entry; the host is deliberately ignorant of what the
 * plugin does, which is what keeps the surface open-ended.
 */
export class PluginHost implements PluginService {
  private readonly plugins = new Map<string, DiscoveredPlugin>();
  private readonly handles = new Map<string, PluginHandle>();
  private readonly order: string[] = [];

  constructor(private readonly options: PluginHostOptions) {}

  directories(): string[] {
    return [...(this.options.directories ?? [])];
  }

  async discover(): Promise<PluginInfo[]> {
    const roots = this.options.directories ?? [];
    for (const rawRoot of roots) {
      const root = isAbsolute(rawRoot) ? rawRoot : resolve(process.cwd(), rawRoot);
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          this.options.logger.warn("plugin directory not found", { directory: root });
          continue;
        }
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const directory = join(root, entry.name);
        const discovered = await this.readManifest(directory);
        if (!discovered) continue;
        this.add(discovered);
      }
    }

    for (const explicit of this.options.entries ?? []) {
      const directory = resolve(explicit.entry, "..");
      const web = await this.webFor(explicit.manifest, directory);
      this.add({
        manifest: explicit.manifest,
        directory,
        entry: resolve(explicit.entry),
        source: explicit.source ?? "local",
        info: {
          id: explicit.manifest.name,
          name: explicit.manifest.name,
          version: explicit.manifest.version,
          description: explicit.manifest.description,
          state: "waiting",
          dependencies: [...(explicit.manifest.requires ?? [])],
          source: explicit.source ?? "local",
          path: explicit.entry,
          web,
        },
      });
    }

    this.checkAllowed();
    this.resolveOrder();
    this.options.logger.info("plugins discovered", { count: this.plugins.size });
    return this.list();
  }

  /** Activates plugins in dependency order and returns their final state. */
  async loadAll(): Promise<PluginInfo[]> {
    for (const name of this.order) {
      const plugin = this.plugins.get(name);
      if (!plugin || this.handles.has(name) || plugin.info.state === "error") continue;
      try {
        await this.load(name);
      } catch (error) {
        this.options.logger.error("plugin skipped", {
          plugin: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return this.list();
  }

  async load(name: string): Promise<PluginInfo> {
    const plugin = this.plugins.get(name);
    if (!plugin) throw new Error(`Unknown plugin "${name}".`);
    const existing = this.handles.get(name);
    if (existing) return this.infoFor(name, existing.snapshot().state);

    const required = plugin.manifest.requires ?? [];
    for (const dependency of required) {
      if (!this.handles.has(dependency)) await this.load(dependency);
    }

    this.setStatus(name, "loading");
    try {
      const module = await import(pathToFileURL(plugin.entry).href);
      const definition = toDefinition(module, plugin.manifest);
      const config = { ...plugin.manifest.config, ...this.options.config?.[name] };
      const handle = this.options.context.plugin(definition, config);
      this.handles.set(name, handle);
      const timeout = this.options.applyTimeoutMs ?? 20_000;
      await withTimeout(handle.ready(), timeout, `Plugin "${name}" did not become active within ${timeout}ms.`);
      this.setStatus(name, "active");
      this.options.logger.info("plugin active", { plugin: name, version: plugin.manifest.version });
      return this.infoFor(name, "active");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(name, "error", message);
      this.options.logger.error("plugin failed to load", { plugin: name, error: message });
      throw error;
    }
  }

  list(): PluginInfo[] {
    const ordered = [...this.order, ...[...this.plugins.keys()].filter((name) => !this.order.includes(name))];
    return ordered
      .map((name) => this.plugins.get(name))
      .filter((item): item is DiscoveredPlugin => Boolean(item))
      .map((item) => {
        const handle = this.handles.get(item.manifest.name);
        return this.infoFor(item.manifest.name, handle?.snapshot().state ?? item.info.state);
      });
  }

  get(name: string): PluginInfo | undefined {
    return this.list().find((info) => info.name === name);
  }

  async dispose(): Promise<void> {
    for (const [name, handle] of [...this.handles].reverse()) {
      try {
        await handle.dispose();
        this.options.logger.debug("plugin disposed", { plugin: name });
      } catch (error) {
        this.options.logger.warn("plugin disposal failed", { plugin: name, error: String(error) });
      } finally {
        this.setStatus(name, "disposed");
        this.handles.delete(name);
      }
    }
    this.handles.clear();
  }

  private add(plugin: DiscoveredPlugin): void {
    if (this.plugins.has(plugin.manifest.name)) {
      this.options.logger.warn("duplicate plugin ignored", { plugin: plugin.manifest.name, path: plugin.directory });
      return;
    }
    this.plugins.set(plugin.manifest.name, plugin);
  }

  private async readManifest(directory: string): Promise<DiscoveredPlugin | undefined> {
    let manifest: PluginManifest | undefined;
    try {
      const raw = await readFile(join(directory, MANIFEST_FILE), "utf8");
      manifest = JSON.parse(raw) as PluginManifest;
    } catch {
      try {
        const raw = await readFile(join(directory, "package.json"), "utf8");
        const pkg = JSON.parse(raw) as { name?: string; version?: string; description?: string; kestrel?: PluginManifest; main?: string };
        if (pkg.kestrel) {
          manifest = {
            ...pkg.kestrel,
            name: pkg.kestrel.name ?? pkg.name,
            version: pkg.kestrel.version ?? pkg.version ?? "0.0.0",
            description: pkg.kestrel.description ?? pkg.description,
            entry: pkg.kestrel.entry ?? pkg.main,
          };
        }
      } catch {
        return undefined;
      }
    }
    if (!manifest) return undefined;
    if (!manifest.name || !manifest.version) {
      this.options.logger.warn("plugin manifest missing name or version", { directory });
      return undefined;
    }

    let entry = manifest.entry ?? DEFAULT_ENTRY;
    if (!(await exists(join(directory, entry)))) {
      if (await exists(join(directory, SOURCE_ENTRY))) entry = SOURCE_ENTRY;
      else if (await exists(join(directory, "index.js"))) entry = "index.js";
      else {
        this.options.logger.warn("plugin entry not found", { plugin: manifest.name, directory, entry });
        return undefined;
      }
    }

    const source: PluginInfo["source"] = "local";
    return {
      manifest,
      directory,
      entry: join(directory, entry),
      source,
      info: {
        id: manifest.name,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        state: "waiting",
        dependencies: [...(manifest.requires ?? [])],
        source,
        path: directory,
        web: await this.webFor(manifest, directory),
      },
    };
  }

  /**
   * Resolves `web` against `<directory>/web`, dropping entries that escape the
   * directory or do not exist. A broken browser bundle must not fail the
   * plugin: the server side is still useful without it.
   */
  private async webFor(manifest: PluginManifest, directory: string): Promise<PluginWeb | undefined> {
    if (!manifest.web) return undefined;
    const declared = typeof manifest.web === "string" ? { entry: manifest.web } : manifest.web;
    const root = join(directory, "web");
    const entry = relativeAsset(declared.entry);
    if (!entry) {
      this.options.logger.warn("plugin web entry is not inside web/", { plugin: manifest.name });
      return undefined;
    }
    if (!(await exists(join(root, entry)))) {
      this.options.logger.warn("plugin web entry not found", { plugin: manifest.name, entry });
      return undefined;
    }
    const css: string[] = [];
    for (const candidate of declared.css ?? []) {
      const asset = relativeAsset(candidate);
      if (!asset || !(await exists(join(root, asset)))) {
        this.options.logger.warn("plugin web asset not found", { plugin: manifest.name, asset: candidate });
        continue;
      }
      css.push(asset);
    }
    const api = Array.isArray(declared.api)
      ? declared.api.filter((grant): grant is string => {
          if (typeof grant !== "string") return false;
          const parts = grant.trim().split(/\s+/);
          if (parts.length !== 2) return false;
          const [method, path] = parts;
          const valid = method === "*" || /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(method);
          return valid && path.startsWith("/api/");
        })
      : undefined;
    if (Array.isArray(declared.api) && api && api.length !== declared.api.length) {
      this.options.logger.warn("plugin web api grant ignored", { plugin: manifest.name });
    }
    const capabilities = Array.isArray(declared.capabilities)
      ? declared.capabilities.filter(
          (capability): capability is "composer.submit" => capability === "composer.submit",
        )
      : undefined;
    if (
      Array.isArray(declared.capabilities) &&
      capabilities &&
      capabilities.length !== declared.capabilities.length
    ) {
      this.options.logger.warn("plugin web capability ignored", { plugin: manifest.name });
    }
    return {
      entry,
      ...(css.length > 0 ? { css } : {}),
      ...(api ? { api } : {}),
      ...(capabilities ? { capabilities } : {}),
    };
  }

  private checkAllowed(): void {
    if (!this.options.allow?.length) return;
    const allowed = new Set(this.options.allow);
    for (const name of this.plugins.keys()) {
      if (!allowed.has(name)) {
        this.plugins.delete(name);
        this.options.logger.info("plugin disabled by allow-list", { plugin: name });
      }
    }
  }

  /**
   * Stable topological order. Unresolvable or circular dependency chains are
   * marked as errors and excluded, so one bad plugin cannot block the host.
   */
  private resolveOrder(): void {
    const visited = new Map<string, "visiting" | "done">();
    const order: string[] = [];
    const visit = (name: string, trail: string[]): boolean => {
      const state = visited.get(name);
      if (state === "done") return true;
      if (state === "visiting") {
        const cycle = [...trail, name].join(" -> ");
        this.setStatus(name, "error", `Circular plugin dependency: ${cycle}`);
        this.options.logger.error("circular plugin dependency", { cycle });
        return false;
      }
      const plugin = this.plugins.get(name);
      if (!plugin) {
        this.setStatus(trail.at(-1) ?? name, "error", `Missing plugin dependency "${name}".`);
        return false;
      }
      visited.set(name, "visiting");
      let resolved = true;
      for (const dependency of plugin.manifest.requires ?? []) {
        if (!this.plugins.has(dependency)) {
          this.setStatus(name, "error", `Missing plugin dependency "${dependency}".`);
          resolved = false;
          continue;
        }
        if (!visit(dependency, [...trail, name])) resolved = false;
      }
      visited.set(name, resolved ? "done" : "visiting");
      if (resolved) order.push(name);
      return resolved;
    };
    for (const name of this.plugins.keys()) visit(name, []);
    this.order.splice(0, this.order.length, ...order);
  }

  private setStatus(name: string, state: PluginInfo["state"], error?: string): void {
    const plugin = this.plugins.get(name);
    if (!plugin) return;
    plugin.info = { ...plugin.info, state, error };
  }

  private infoFor(name: string, state: PluginInfo["state"]): PluginInfo {
    const plugin = this.plugins.get(name);
    if (!plugin) throw new Error(`Unknown plugin "${name}".`);
    const handle = this.handles.get(name);
    const error = handle?.snapshot().error ?? plugin.info.error;
    return { ...plugin.info, state, error };
  }
}

function relativeAsset(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return undefined;
  if (normalized.split("/").includes("..")) return undefined;
  return normalized;
}

function toDefinition(module: Record<string, unknown>, manifest: PluginManifest): PluginDefinition {
  const candidate = module.default ?? module.plugin ?? module.kestrelPlugin;
  if (candidate && typeof candidate === "object" && typeof (candidate as PluginDefinition).apply === "function") {
    const definition = candidate as PluginDefinition;
    return {
      ...definition,
      name: definition.name || manifest.name,
      version: definition.version ?? manifest.version,
      description: definition.description ?? manifest.description,
      inject: definition.inject ?? manifest.inject,
    };
  }
  if (typeof candidate === "function") {
    return {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      inject: manifest.inject,
      apply: candidate as PluginDefinition["apply"],
    };
  }
  throw new Error(`Plugin "${manifest.name}" must export a plugin object or apply function.`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

declare module "@kestrel/kernel" {
  interface ServiceMap {
    plugins: PluginService;
  }
  interface EventMap {
    "plugin/discovered": (plugin: PluginInfo) => void;
  }
}
