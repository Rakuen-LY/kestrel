import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { WebSocket } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface BrowserElement {
  ref: number;
  tag: string;
  text: string;
  type?: string;
  href?: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
}

export interface BrowserSnapshot {
  title: string;
  url: string;
  text: string;
  elements: BrowserElement[];
  truncated: boolean;
}

export interface BrowserStatus {
  open: boolean;
  url?: string;
  title?: string;
  executable?: string;
}

export interface ScreenshotOptions {
  format?: "png" | "jpeg";
  /** JPEG quality, 1–100. Ignored for PNG. */
  quality?: number;
  /** Include base64 data so the image can be returned to a vision model. */
  includeData?: boolean;
}

export interface BrowserScreenshot {
  path: string;
  bytes: number;
  mimeType: string;
  /** Base64 without the `data:` prefix; present when `includeData` is set. */
  data?: string;
}

/** One page, bound to one session. */
export interface BrowserPage {
  open(url: string): Promise<BrowserSnapshot>;
  snapshot(): Promise<BrowserSnapshot>;
  click(ref: number): Promise<BrowserSnapshot>;
  type(ref: number, text: string, submit?: boolean): Promise<BrowserSnapshot>;
  scroll(direction: "up" | "down", amount?: number): Promise<BrowserSnapshot>;
  back(): Promise<BrowserSnapshot>;
  waitFor(condition: { text?: string; selector?: string; timeoutMs?: number }): Promise<BrowserSnapshot>;
  screenshot(workspace: string, path?: string, options?: ScreenshotOptions): Promise<BrowserScreenshot>;
  status(): BrowserStatus;
  close(): Promise<void>;
}

/** Per-session pages, so concurrent sessions never share cookies or refs. */
export interface BrowserService {
  page(sessionId: string): BrowserPage;
  status(sessionId: string): BrowserStatus;
  close(sessionId: string): Promise<void>;
  closeAll(): Promise<void>;
}

export interface BrowserOptions {
  /** Chromium-compatible executable. Auto-detected when omitted. */
  executable?: string;
  /** Extra command-line flags. */
  args?: string[];
  /** Run without a window. Default true; the server usually has no display. */
  headless?: boolean;
  /** Navigation and launch timeout. */
  timeoutMs?: number;
  /** Time allowed for client-side rendering after `load`. */
  settleMs?: number;
  /** Chromium's own sandbox needs privileges containers often lack. */
  noSandbox?: boolean;
  /** Body text retained in a snapshot. */
  maxTextChars?: number;
  /** Interactive elements retained in a snapshot. */
  maxElements?: number;
}

interface ResolvedOptions {
  executable?: string;
  args: string[];
  headless: boolean;
  timeoutMs: number;
  settleMs: number;
  noSandbox: boolean;
  maxTextChars: number;
  maxElements: number;
}

const DEFAULTS: ResolvedOptions = {
  args: [],
  headless: true,
  timeoutMs: 30_000,
  settleMs: 250,
  noSandbox: containerWithoutUserNamespaces(),
  maxTextChars: 12_000,
  maxElements: 120,
};

const BROWSER_NAMES = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "chrome",
  "microsoft-edge",
  "msedge",
];

/** Finds a Chromium-compatible binary without requiring Playwright or Puppeteer. */
function containerWithoutUserNamespaces(): boolean {
  if (process.platform !== "linux") return false;
  return (
    process.getuid?.() === 0 ||
    existsSync("/.dockerenv") ||
    Boolean(process.env.KUBERNETES_SERVICE_HOST) ||
    Boolean(process.env.container)
  );
}

export function findBrowser(): string | undefined {
  const explicit = process.env.KESTREL_BROWSER_PATH ?? process.env.CHROME_PATH;
  if (explicit && existsSync(explicit)) return explicit;

  const names = process.platform === "win32" ? BROWSER_NAMES.map((name) => `${name}.exe`) : BROWSER_NAMES;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  const absolute: string[] = [];
  if (process.platform === "darwin") {
    absolute.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  } else if (process.platform === "win32") {
    for (const root of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (!root) continue;
      absolute.push(
        join(root, "Google/Chrome/Application/chrome.exe"),
        join(root, "Microsoft/Edge/Application/msedge.exe"),
        join(root, "Chromium/Application/chrome.exe"),
      );
    }
  } else {
    absolute.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/snap/bin/chromium");
  }
  return absolute.find((candidate) => existsSync(candidate));
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** Minimal flat-session CDP client over the DevTools WebSocket. */
class CdpConnection {
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private closed?: Error;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event: MessageEvent) => this.onMessage(event));
    socket.addEventListener("close", () => this.fail(new Error("The browser connection closed.")));
    socket.addEventListener("error", () => this.fail(new Error("The browser connection failed.")));
  }

  static connect(url: string, timeoutMs: number): Promise<CdpConnection> {
    return new Promise((resolveConnection, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Timed out connecting to the browser debug port."));
      }, timeoutMs);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolveConnection(new CdpConnection(socket));
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("Could not connect to the browser debug port."));
        },
        { once: true },
      );
    });
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<T>((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new Error(`Browser command ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolveCall(value as T),
        reject: rejectCall,
        timer,
      });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(reason = "The browser was closed."): void {
    this.fail(new Error(reason));
    try {
      this.socket.close();
    } catch {
      // The socket may already be gone.
    }
  }

  private onMessage(event: MessageEvent): void {
    const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString();
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message ?? "Browser command failed."));
    else pending.resolve(message.result ?? {});
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

interface BrowserProcess {
  process: ChildProcess;
  connection: CdpConnection;
  sessionId: string;
  targetId: string;
  userDataDir: string;
  executable: string;
}

/**
 * One browser and one page, started lazily on the first navigation. Every public
 * method is serialised: parallel tool calls share a page, and interleaving them
 * would make refs and navigation races unpredictable.
 */
export class BrowserController implements BrowserPage {
  private readonly options: ResolvedOptions;
  private browser?: BrowserProcess;
  private launch?: Promise<BrowserProcess>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: BrowserOptions = {}) {
    this.options = { ...DEFAULTS, ...options, args: options.args ?? DEFAULTS.args };
  }

  open(url: string): Promise<BrowserSnapshot> {
    return this.exclusive(async () => {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Only http and https URLs are supported.");
      }
      const browser = await this.ensure();
      const result = await browser.connection.send<{ errorText?: string }>(
        "Page.navigate",
        { url: parsed.toString() },
        browser.sessionId,
        this.options.timeoutMs,
      );
      if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
      await this.settle(browser);
      return this.snapshotInternal(browser);
    });
  }

  snapshot(): Promise<BrowserSnapshot> {
    return this.exclusive(async () => {
      const browser = await this.require();
      return this.snapshotInternal(browser);
    });
  }

  click(ref: number): Promise<BrowserSnapshot> {
    return this.exclusive(async () => {
      const browser = await this.require();
      const clicked = await this.evaluate<boolean>(
        browser,
        `(() => {
          const element = globalThis.__kestrelRefs?.[${Math.max(0, ref - 1)}];
          if (!element) return false;
          element.scrollIntoView({ block: "center", inline: "center" });
          if (typeof element.focus === "function") element.focus();
          element.click();
          return true;
        })()`,
      );
      if (!clicked) throw new Error(`Unknown element ref ${ref}. Take a new snapshot first.`);
      await this.settle(browser);
      return this.snapshotInternal(browser);
    });
  }

  type(ref: number, text: string, submit = false): Promise<BrowserSnapshot> {
    return this.exclusive(async () => {
      const browser = await this.require();
      const typed = await this.evaluate<boolean>(
        browser,
        `(() => {
          const element = globalThis.__kestrelRefs?.[${Math.max(0, ref - 1)}];
          if (!element) return false;
          const value = ${JSON.stringify(text)};
          element.scrollIntoView({ block: "center", inline: "center" });
          element.focus();
          if (element.isContentEditable) {
            element.textContent = value;
            element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
          } else {
            const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
            if (setter) setter.call(element, value);
            else element.value = value;
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
          }
          if (${submit ? "true" : "false"}) {
            if (element.form && typeof element.form.requestSubmit === "function") element.form.requestSubmit();
            else element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
          }
          return true;
        })()`,
      );
      if (!typed) throw new Error(`Unknown element ref ${ref}. Take a new snapshot first.`);
      await this.settle(browser);
      return this.snapshotInternal(browser);
    });
  }

  scroll(direction: "up" | "down", amount = 700): Promise<BrowserSnapshot> {
    return this.exclusive(async () => {
      const browser = await this.require();
      const delta = direction === "up" ? -Math.abs(amount) : Math.abs(amount);
      await this.evaluate(browser, `window.scrollBy({ top: ${delta}, behavior: "instant" }); true`);
      await delay(this.options.settleMs);
      return this.snapshotInternal(browser);
    });
  }

  waitFor(condition: { text?: string; selector?: string; timeoutMs?: number }): Promise<BrowserSnapshot> {
    return this.exclusive(async () => {
      const browser = await this.require();
      if (!condition.text && !condition.selector) {
        throw new Error("Provide `text` or `selector` to wait for.");
      }
      const timeoutMs = Math.min(condition.timeoutMs ?? 10_000, this.options.timeoutMs);
      const deadline = Date.now() + timeoutMs;
      const expression = condition.text
        ? `Boolean((document.body?.innerText || "").includes(${JSON.stringify(condition.text)}))`
        : `Boolean(document.querySelector(${JSON.stringify(condition.selector)}))`;
      const wanted = condition.text ? `text ${JSON.stringify(condition.text)}` : `selector ${condition.selector}`;
      while (Date.now() < deadline) {
        try {
          if (await this.evaluate<boolean>(browser, expression)) {
            await delay(this.options.settleMs);
            return this.snapshotInternal(browser);
          }
        } catch {
          // The document may be navigating; retry until the deadline.
        }
        await delay(200);
      }
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${wanted}. Take a snapshot to see the page.`);
    });
  }

  back(): Promise<BrowserSnapshot> {
    return this.exclusive(async () => {
      const browser = await this.require();
      await this.evaluate(browser, "history.back(); true");
      await this.settle(browser);
      return this.snapshotInternal(browser);
    });
  }

  async screenshot(workspace: string, path?: string, options: ScreenshotOptions = {}): Promise<BrowserScreenshot> {
    return this.exclusive(async () => {
      const browser = await this.require();
      const format = options.format ?? "png";
      const extension = format === "jpeg" ? "jpg" : "png";
      const target = resolveScreenshotPath(
        workspace,
        path ?? `screenshots/browser-${Date.now()}.${extension}`,
      );
      const quality = Math.min(100, Math.max(1, Math.round(options.quality ?? 80)));
      const { data } = await browser.connection.send<{ data: string }>(
        "Page.captureScreenshot",
        { format, fromSurface: true, ...(format === "jpeg" ? { quality } : {}) },
        browser.sessionId,
      );
      const image = Buffer.from(data, "base64");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, image);
      return {
        path: target,
        bytes: image.byteLength,
        mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
        ...(options.includeData ? { data } : {}),
      };
    });
  }

  status(): BrowserStatus {
    if (!this.browser) return { open: false };
    return { open: true, executable: this.browser.executable };
  }

  close(): Promise<void> {
    return this.exclusive(async () => {
      await this.shutdown();
    });
  }

  private async ensure(): Promise<BrowserProcess> {
    if (this.browser) return this.browser;
    if (this.launch) return this.launch;
    this.launch = this.launchBrowser();
    try {
      this.browser = await this.launch;
      return this.browser;
    } finally {
      this.launch = undefined;
    }
  }

  private async require(): Promise<BrowserProcess> {
    if (!this.browser) throw new Error("No page is open. Call browser_open first.");
    return this.browser;
  }

  private async launchBrowser(): Promise<BrowserProcess> {
    const executable = this.options.executable ?? findBrowser();
    if (!executable) {
      throw new Error(
        "No Chromium-compatible browser found. Install Chrome/Chromium or set browser.executable (KESTREL_BROWSER_PATH).",
      );
    }
    const userDataDir = await mkdtemp(join(tmpdir(), "kestrel-browser-"));
    const args = [
      ...(this.options.headless ? ["--headless=new"] : []),
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--hide-scrollbars",
      "--mute-audio",
      "--window-size=1280,800",
      ...(this.options.noSandbox ? ["--no-sandbox"] : []),
      ...this.options.args,
      "about:blank",
    ];

    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    const recent: string[] = [];
    const endpoint = await new Promise<string>((resolveEndpoint, rejectEndpoint) => {
      const timer = setTimeout(() => {
        cleanup();
        child.kill();
        rejectEndpoint(new Error("Timed out starting the browser."));
      }, this.options.timeoutMs);
      const onData = (chunk: Buffer | string): void => {
        const text = String(chunk);
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          recent.push(line.trim());
          if (recent.length > 12) recent.shift();
          const match = /DevTools listening on (ws:\/\/\S+)/.exec(line);
          if (match) {
            cleanup();
            resolveEndpoint(match[1]);
          }
        }
      };
      const onExit = (code: number | null): void => {
        cleanup();
        rejectEndpoint(new Error(`The browser exited during startup (code ${code ?? "null"}). ${recent.join(" ")}`));
      };
      const onError = (error: Error): void => {
        cleanup();
        rejectEndpoint(new Error(`Could not start ${executable}: ${error.message}`));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        child.stderr?.off("data", onData);
        child.off("exit", onExit);
        child.off("error", onError);
      };
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", onData);
      child.once("exit", onExit);
      child.once("error", onError);
    });

    let connection: CdpConnection | undefined;
    try {
      connection = await CdpConnection.connect(endpoint, this.options.timeoutMs);
      const { targetId } = await connection.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      await connection.send("Page.enable", {}, sessionId);
      await connection.send("Runtime.enable", {}, sessionId);
      const browser: BrowserProcess = { process: child, connection, sessionId, targetId, userDataDir, executable };
      child.once("exit", () => {
        if (this.browser === browser) this.browser = undefined;
        connection?.close("The browser process exited.");
      });
      return browser;
    } catch (error) {
      connection?.close("Browser startup failed.");
      child.kill();
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async snapshotInternal(browser: BrowserProcess): Promise<BrowserSnapshot> {
    return this.evaluate<BrowserSnapshot>(
      browser,
      `(() => {
        const selector = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]';
        const visible = Array.from(document.querySelectorAll(selector)).filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        }).slice(0, ${this.options.maxElements});
        globalThis.__kestrelRefs = visible;
        const elements = visible.map((element, index) => {
          const tag = element.tagName.toLowerCase();
          const label = (element.getAttribute("aria-label") || element.innerText || element.getAttribute("placeholder") || element.getAttribute("alt") || element.getAttribute("title") || "").trim().replace(/\\s+/g, " ").slice(0, 160);
          const item = { ref: index + 1, tag, text: label };
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
            item.type = element instanceof HTMLInputElement ? element.type : tag;
            if (!(element instanceof HTMLInputElement) || element.type !== "password") item.value = String(element.value ?? "").slice(0, 160);
            if (element instanceof HTMLInputElement) item.checked = element.checked;
          }
          if (element instanceof HTMLAnchorElement) item.href = element.href;
          if (element.disabled) item.disabled = true;
          return item;
        });
        const body = (document.body?.innerText || "").trim();
        return {
          title: document.title,
          url: location.href,
          text: body.slice(0, ${this.options.maxTextChars}),
          elements,
          truncated: body.length > ${this.options.maxTextChars},
        };
      })()`,
    );
  }

  private async evaluate<T>(browser: BrowserProcess, expression: string): Promise<T> {
    const result = await browser.connection.send<{
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, browser.sessionId, this.options.timeoutMs);
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Page evaluation failed.",
      );
    }
    return result.result?.value as T;
  }

  /** Waits for `readyState`, then gives client-side frameworks a moment to render. */
  private async settle(browser: BrowserProcess): Promise<void> {
    const deadline = Date.now() + this.options.timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate<string>(browser, "document.readyState");
        if (state === "complete") break;
      } catch {
        // A navigation replaced the context; the next poll uses the new document.
      }
      await delay(100);
    }
    await delay(this.options.settleMs);
  }

  private async shutdown(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    if (!browser) return;
    try {
      await browser.connection.send("Target.closeTarget", { targetId: browser.targetId }, undefined, 5_000);
    } catch {
      // The target or socket may already be gone.
    }
    browser.connection.close();
    browser.process.kill();
    await rm(browser.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

interface PooledPage {
  controller: BrowserController;
  idleTimer?: NodeJS.Timeout;
}

/**
 * Browsers are expensive to start and hold session cookies, so each session gets
 * its own lazily created page. Idle pages are closed after `idleMs`; `closeAll`
 * runs on plugin disposal.
 */
export class BrowserPool implements BrowserService {
  private readonly pages = new Map<string, PooledPage>();

  constructor(
    private readonly options: BrowserOptions = {},
    private readonly idleMs = 15 * 60_000,
  ) {}

  page(sessionId: string): BrowserPage {
    const existing = this.pages.get(sessionId);
    if (existing) {
      this.touch(sessionId, existing);
      return existing.controller;
    }
    const entry: PooledPage = { controller: new BrowserController(this.options) };
    this.pages.set(sessionId, entry);
    this.touch(sessionId, entry);
    return entry.controller;
  }

  status(sessionId: string): BrowserStatus {
    return this.pages.get(sessionId)?.controller.status() ?? { open: false };
  }

  async close(sessionId: string): Promise<void> {
    const entry = this.pages.get(sessionId);
    if (!entry) return;
    this.pages.delete(sessionId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    await entry.controller.close();
  }

  async closeAll(): Promise<void> {
    const entries = [...this.pages.values()];
    this.pages.clear();
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        await entry.controller.close();
      }),
    );
  }

  private touch(sessionId: string, entry: PooledPage): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (this.idleMs <= 0) return;
    entry.idleTimer = setTimeout(() => {
      void this.close(sessionId);
    }, this.idleMs);
    entry.idleTimer.unref?.();
  }
}

/** Writes screenshots inside the session workspace unless the path is absolute. */
export function resolveScreenshotPath(workspace: string, input: string): string {
  const target = isAbsolute(input) ? resolve(input) : resolve(workspace, input);
  const path = relative(resolve(workspace), target);
  if (path.startsWith("..") || isAbsolute(path)) {
    throw new Error(`Screenshot path "${input}" escapes the workspace.`);
  }
  return target;
}

/** Human- and model-readable rendering of a snapshot. */
export function formatSnapshot(snapshot: BrowserSnapshot): string {
  const lines = [`Title: ${snapshot.title || "(untitled)"}`, `URL: ${snapshot.url}`, "", "Text:", snapshot.text || "(empty)"];
  if (snapshot.truncated) lines.push("[text truncated]");
  lines.push("", "Interactive elements:");
  if (snapshot.elements.length === 0) {
    lines.push("(none)");
  } else {
    for (const element of snapshot.elements) {
      const details: string[] = [element.tag];
      if (element.type) details.push(`type=${element.type}`);
      if (element.disabled) details.push("disabled");
      if (element.checked !== undefined) details.push(`checked=${element.checked}`);
      if (element.href) details.push(`href=${element.href}`);
      if (element.value) details.push(`value=${JSON.stringify(element.value)}`);
      lines.push(`[${element.ref}] ${details.join(" ")} ${JSON.stringify(element.text)}`);
    }
  }
  return lines.join("\n");
}
