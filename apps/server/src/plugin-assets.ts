import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@kestrel/kernel";
import type { PluginAssetChange, PluginInfo } from "@kestrel/protocol";

/** Depth cap keeps a malformed tree from turning one scan into a crawl. */
const MAX_DEPTH = 8;
const MAX_FILES = 2_000;
const DEFAULT_INTERVAL_MS = 1_000;

export type AssetChangeListener = (change: PluginAssetChange) => void;

/**
 * Fingerprints every active plugin's `web/` directory and reports changes.
 *
 * Polling rather than `fs.watch` is deliberate: inotify does not cross the
 * bind-mount boundary used by Docker Desktop on macOS and Windows, which is
 * exactly where a developer edits plugin code. A stat sweep of a handful of
 * small directories once a second costs little and works on every target.
 *
 * Only `web/` is tracked. Manifest edits change grants and the entry path, so
 * they still require a restart — reloading those silently would let a file
 * change widen a bundle's API access.
 */
export class PluginAssetWatcher {
  private readonly revisions = new Map<string, string>();
  private readonly listeners = new Set<AssetChangeListener>();
  private timer?: NodeJS.Timeout;
  private scanning = false;
  private baseline = false;

  constructor(
    private readonly options: {
      /** Plugins to track; called on every scan so late loads are picked up. */
      plugins: () => PluginInfo[];
      logger: Logger;
      intervalMs?: number;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    void this.scan();
    const interval = this.options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => void this.scan(), Math.max(250, interval));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  subscribe(listener: AssetChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Current fingerprint per plugin, for decorating API responses. */
  snapshot(): PluginAssetChange[] {
    return [...this.revisions].map(([id, revision]) => ({ id, revision }));
  }

  revisionFor(id: string): string | undefined {
    return this.revisions.get(id);
  }

  /**
   * One sweep. The first call establishes a baseline and reports nothing:
   * a console that connects after startup must not see every bundle reload.
   */
  async scan(): Promise<PluginAssetChange[]> {
    if (this.scanning) return [];
    this.scanning = true;
    try {
      const seen = new Set<string>();
      const changed: PluginAssetChange[] = [];
      for (const plugin of this.options.plugins()) {
        if (plugin.state !== "active" || !plugin.web || !plugin.path) continue;
        const revision = await fingerprint(join(plugin.path, "web"));
        if (!revision) continue;
        seen.add(plugin.id);
        const previous = this.revisions.get(plugin.id);
        this.revisions.set(plugin.id, revision);
        if (this.baseline && previous !== undefined && previous !== revision) {
          changed.push({ id: plugin.id, revision });
        }
      }
      for (const id of this.revisions.keys()) {
        if (!seen.has(id)) this.revisions.delete(id);
      }
      this.baseline = true;
      if (changed.length > 0) {
        this.options.logger.info("plugin assets changed", {
          plugins: changed.map((change) => change.id),
        });
        for (const change of changed) {
          for (const listener of this.listeners) listener(change);
        }
      }
      return changed;
    } finally {
      this.scanning = false;
    }
  }
}

/**
 * Hash of relative path, size and mtime for every file under `root`.
 * Content hashing every second would be more precise but read megabytes for no
 * practical gain: editors change mtime, and a save that preserves both size and
 * mtime is indistinguishable from an unchanged file anyway.
 */
export async function fingerprint(root: string): Promise<string | undefined> {
  const info = await stat(root).catch(() => undefined);
  if (!info?.isDirectory()) return undefined;

  const entries: string[] = [];
  await walk(root, "", 0, entries);
  if (entries.length === 0) return undefined;
  entries.sort();
  const hash = createHash("sha1");
  for (const entry of entries) hash.update(`${entry}\n`);
  return hash.digest("hex").slice(0, 16);
}

async function walk(root: string, prefix: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  const listing = await readdir(join(root, prefix), { withFileTypes: true }).catch(() => []);
  for (const entry of listing) {
    if (out.length >= MAX_FILES) return;
    if (entry.name.startsWith(".")) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(root, relative, depth + 1, out);
    } else if (entry.isFile()) {
      const item = await stat(join(root, relative)).catch(() => undefined);
      if (item) out.push(`${relative}:${item.size}:${Math.floor(item.mtimeMs)}`);
    }
  }
}
