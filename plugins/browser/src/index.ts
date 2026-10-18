import type { JsonSchema, Tool } from "@kestrel/agent";
import type { Context, PluginDefinition } from "@kestrel/kernel";
import {
  BrowserController,
  formatSnapshot,
  type BrowserOptions,
  type BrowserService,
  type BrowserSnapshot,
} from "./browser.js";

export type { BrowserElement, BrowserOptions, BrowserService, BrowserSnapshot } from "./browser.js";
export { BrowserController, findBrowser, formatSnapshot, resolveScreenshotPath } from "./browser.js";

export interface BrowserConfig extends BrowserOptions {
  /** Permission for opening a URL. Interactions on an approved page stay automatic. */
  permission?: "ask" | "auto";
}

const plugin: PluginDefinition<BrowserConfig> = {
  name: "@kestrel/plugin-browser",
  version: "0.1.0",
  description: "Browse the web with a headless Chromium page: snapshots, clicks, typing and screenshots.",
  inject: ["tools"],
  apply(context: Context, config: BrowserConfig = {}) {
    const tools = context.get("tools");
    const controller = new BrowserController(config);
    const permission = config.permission ?? "ask";

    const service: BrowserService = {
      open: (url) => controller.open(url),
      snapshot: () => controller.snapshot(),
      click: (ref) => controller.click(ref),
      type: (ref, text, submit) => controller.type(ref, text, submit),
      scroll: (direction, amount) => controller.scroll(direction, amount),
      back: () => controller.back(),
      screenshot: (workspace, path) => controller.screenshot(workspace, path),
      status: () => controller.status(),
      close: () => controller.close(),
    };

    for (const tool of createBrowserTools(service, permission)) {
      context.effect(() => tools.register(tool));
    }
    context.provide("browser", service);
    context.effect(() => () => {
      void controller.close();
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
      async execute(args) {
        return result(await service.open(text(args, "url")));
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
      async execute() {
        return result(await service.snapshot());
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
      async execute(args) {
        return result(await service.click(positive(args, "ref")));
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
      async execute(args) {
        return result(
          await service.type(positive(args, "ref"), text(args, "text", true), args.submit === true),
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
      async execute(args) {
        const direction = args.direction === "up" ? "up" : "down";
        const amount = typeof args.amount === "number" ? Math.min(5_000, Math.max(50, Math.floor(args.amount))) : 700;
        return result(await service.scroll(direction, amount));
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
      async execute() {
        return result(await service.back());
      },
    },
    {
      schema: {
        name: "browser_screenshot",
        description:
          "Save a PNG screenshot of the visible page inside the workspace. Useful for visual checks; the image itself is not returned to the model.",
        category: "browser",
        permission: "auto",
        parameters: schema({
          path: {
            type: "string",
            description: "Workspace-relative path, default screenshots/browser-<timestamp>.png.",
          },
        }),
      },
      async execute(args, toolContext) {
        const shot = await service.screenshot(
          toolContext.session.workspace,
          typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined,
        );
        return {
          content: `Saved screenshot to ${shot.path} (${shot.bytes} bytes).`,
          data: shot,
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
      async execute() {
        await service.close();
        return { content: "Browser closed." };
      },
    },
  ];
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
