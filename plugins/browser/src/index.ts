import type { JsonSchema, Tool, ToolContext } from "@kestrel/agent";
import type { Context, PluginDefinition } from "@kestrel/kernel";
import {
  BrowserPool,
  formatSnapshot,
  type BrowserOptions,
  type BrowserPage,
  type BrowserService,
  type BrowserSnapshot,
} from "./browser.js";

export type {
  BrowserElement,
  BrowserOptions,
  BrowserPage,
  BrowserScreenshot,
  BrowserService,
  BrowserSnapshot,
  ScreenshotOptions,
} from "./browser.js";
export { BrowserController, BrowserPool, findBrowser, formatSnapshot, resolveScreenshotPath } from "./browser.js";

export interface BrowserConfig extends BrowserOptions {
  /** Permission for opening a URL. Interactions on an approved page stay automatic. */
  permission?: "ask" | "auto";
  /** Close an unused page after this many milliseconds; 0 disables eviction. */
  idleMs?: number;
}

const plugin: PluginDefinition<BrowserConfig> = {
  name: "@kestrel/plugin-browser",
  version: "0.1.0",
  description: "Browse the web with a headless Chromium page: snapshots, clicks, typing and screenshots.",
  inject: ["tools"],
  apply(context: Context, config: BrowserConfig = {}) {
    const tools = context.get("tools");
    const service = new BrowserPool(config, config.idleMs ?? 15 * 60_000);
    const permission = config.permission ?? "ask";

    for (const tool of createBrowserTools(service, permission)) {
      context.effect(() => tools.register(tool));
    }
    context.provide("browser", service);
    context.effect(() => () => {
      void service.closeAll();
    });
    context.logger.info("browser tools registered", {
      permission,
      headless: config.headless ?? true,
      noSandbox: config.noSandbox ?? undefined,
    });
  },
};

export default plugin;

export function createBrowserTools(service: BrowserService, permission: "ask" | "auto" = "ask"): Tool[] {
  return [
    {
      schema: {
        name: "browser_open",
        description:
          "Open an HTTP(S) URL in a headless browser. Returns the page title, visible text and numbered interactive elements. Use the refs with browser_click and browser_type; take a snapshot again after changes.",
        category: "browser",
        permission,
        parameters: schema({ url: { type: "string", description: "Absolute HTTP or HTTPS URL." } }, ["url"]),
      },
      async execute(args, toolContext) {
        return result(await page(service, toolContext).open(text(args, "url")));
      },
    },
    {
      schema: {
        name: "browser_snapshot",
        description:
          "Read the current page again: title, URL, visible text and numbered interactive elements. Call this after a page changes on its own or when refs may be stale.",
        category: "browser",
        permission: "auto",
        parameters: schema({}),
      },
      async execute(_args, toolContext) {
        return result(await page(service, toolContext).snapshot());
      },
    },
    {
      schema: {
        name: "browser_click",
        description:
          "Click an interactive element by its ref from the latest snapshot. Returns a fresh snapshot after the page settles.",
        category: "browser",
        permission: "auto",
        parameters: schema(
          {
            ref: { type: "integer", description: "Element ref from the latest snapshot." },
          },
          ["ref"],
        ),
      },
      async execute(args, toolContext) {
        return result(await page(service, toolContext).click(positive(args, "ref")));
      },
    },
    {
      schema: {
        name: "browser_type",
        description:
          "Focus an input, textarea or contenteditable element by ref, replace its value and optionally submit the form. Returns a fresh snapshot.",
        category: "browser",
        permission: "auto",
        parameters: schema(
          {
            ref: { type: "integer", description: "Element ref from the latest snapshot." },
            text: { type: "string", description: "Replacement text." },
            submit: { type: "boolean", description: "Submit the surrounding form after typing." },
          },
          ["ref", "text"],
        ),
      },
      async execute(args, toolContext) {
        return result(
          await page(service, toolContext).type(positive(args, "ref"), text(args, "text", true), args.submit === true),
        );
      },
    },
    {
      schema: {
        name: "browser_scroll",
        description: "Scroll the page up or down and return a fresh snapshot. Use this to reach content below the fold.",
        category: "browser",
        permission: "auto",
        parameters: schema({
          direction: { type: "string", enum: ["up", "down"], description: "Scroll direction." },
          amount: { type: "integer", description: "Pixels to scroll, default 700." },
        }),
      },
      async execute(args, toolContext) {
        const direction = args.direction === "up" ? "up" : "down";
        const amount = typeof args.amount === "number" ? Math.min(5_000, Math.max(50, Math.floor(args.amount))) : 700;
        return result(await page(service, toolContext).scroll(direction, amount));
      },
    },
    {
      schema: {
        name: "browser_wait_for",
        description:
          "Wait until the page contains specific text or matches a CSS selector, then return a snapshot. Use this instead of guessing how long a single-page app needs to render.",
        category: "browser",
        permission: "auto",
        parameters: schema({
          text: { type: "string", description: "Substring of visible body text." },
          selector: { type: "string", description: "CSS selector that must exist." },
          timeoutMs: { type: "integer", description: "Maximum wait, default 10000." },
        }),
      },
      async execute(args, toolContext) {
        const text = typeof args.text === "string" && args.text ? args.text : undefined;
        const selector = typeof args.selector === "string" && args.selector ? args.selector : undefined;
        if (!text && !selector) throw new Error("Provide `text` or `selector` to wait for.");
        const timeoutMs =
          typeof args.timeoutMs === "number" ? Math.min(60_000, Math.max(100, Math.floor(args.timeoutMs))) : undefined;
        return result(await page(service, toolContext).waitFor({ text, selector, timeoutMs }));
      },
    },
    {
      schema: {
        name: "browser_back",
        description: "Go back in browser history and return a fresh snapshot.",
        category: "browser",
        permission: "auto",
        parameters: schema({}),
      },
      async execute(_args, toolContext) {
        return result(await page(service, toolContext).back());
      },
    },
    {
      schema: {
        name: "browser_screenshot",
        description:
          "Save a screenshot of the visible page inside the workspace. Set include_image to return it to you as an image; that requires a vision model.",
        category: "browser",
        permission: "auto",
        parameters: schema({
          path: {
            type: "string",
            description: "Workspace-relative path; the extension defaults to the chosen format.",
          },
          include_image: {
            type: "boolean",
            description: "Return the image itself so you can inspect it. Default false, because it costs tokens.",
          },
          format: {
            type: "string",
            enum: ["png", "jpeg"],
            description: "Image format, default png.",
          },
          quality: {
            type: "integer",
            description: "JPEG quality from 1 to 100, default 80. Ignored for PNG.",
          },
        }),
      },
      async execute(args, toolContext) {
        const format = args.format === "jpeg" ? "jpeg" : "png";
        const includeImage = args.include_image === true;
        const shot = await page(service, toolContext).screenshot(
          toolContext.session.workspace,
          typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined,
          {
            format,
            quality: typeof args.quality === "number" ? args.quality : undefined,
            includeData: includeImage,
          },
        );
        const note = includeImage ? " The image is attached to this result." : "";
        return {
          content: `Saved screenshot to ${shot.path} (${shot.bytes} bytes).${note}`,
          data: { path: shot.path, bytes: shot.bytes, mimeType: shot.mimeType },
          ...(includeImage && shot.data
            ? {
                images: [
                  {
                    mimeType: shot.mimeType,
                    data: shot.data,
                    name: shot.path.split(/[\\/]/).pop(),
                  },
                ],
              }
            : {}),
        };
      },
    },
    {
      schema: {
        name: "browser_close",
        description: "Close the browser and release its temporary profile. A later browser_open starts a new browser.",
        category: "browser",
        permission: "auto",
        parameters: schema({}),
      },
      async execute(_args, toolContext) {
        await service.close(toolContext.session.id);
        return { content: "Browser closed." };
      },
    },
  ];
}

function page(service: BrowserService, context: ToolContext): BrowserPage {
  return service.page(context.session.id);
}

function result(snapshot: BrowserSnapshot) {
  return { content: formatSnapshot(snapshot), data: snapshot };
}

function schema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function text(args: Record<string, unknown>, name: string, allowEmpty = false): string {
  const value = args[name];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`"${name}" must be a non-empty string.`);
  }
  return value;
}

function positive(args: Record<string, unknown>, name: string): number {
  const value = typeof args[name] === "number" ? args[name] : Number.parseInt(String(args[name] ?? ""), 10);
  if (!Number.isFinite(value) || value < 1) throw new Error(`"${name}" must be a positive integer.`);
  return Math.floor(value);
}

declare module "@kestrel/kernel" {
  interface ServiceMap {
    browser: BrowserService;
  }
}
