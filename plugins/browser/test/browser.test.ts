import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserController, BrowserPool, findBrowser, formatSnapshot, resolveScreenshotPath } from "../src/browser.js";

const executable = findBrowser();
const browser = executable
  ? new BrowserController({ executable, headless: true, timeoutMs: 20_000, settleMs: 100 })
  : undefined;
let server: Server;
let origin: string;

const fixture = `<!doctype html>
<html>
  <head><title>Browser fixture</title></head>
  <body>
    <h1>Hello</h1>
    <a href="/next">Next page</a>
    <button id="press" onclick="document.getElementById('out').textContent = 'pressed'">Press me</button>
    <label for="name">Name</label>
    <input id="name" placeholder="Your name" oninput="document.getElementById('echo').textContent = this.value" />
    <div id="out"></div>
    <div id="echo"></div>
    <input id="secret" type="password" value="hunter2" />
    <div id="delayed"></div>
    <script>setTimeout(() => { document.getElementById('delayed').textContent = 'Loaded late'; }, 250);</script>
  </body>
</html>`;

describe.skipIf(!browser)("browser controller", () => {
  beforeAll(async () => {
    server = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (request.url === "/next") {
        response.end("<!doctype html><title>Second page</title><h1>Second</h1>");
        return;
      }
      response.end(fixture);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port.");
    origin = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("opens, reads, clicks, types, scrolls, navigates and screenshots", async () => {
    expect(executable).toBeTruthy();
    const first = await browser!.open(origin);
    expect(first.title).toBe("Browser fixture");
    expect(first.text).toContain("Hello");
    expect(first.elements.length).toBeGreaterThanOrEqual(4);

    const button = first.elements.find((element) => element.text === "Press me");
    expect(button).toBeTruthy();
    const pressed = await browser!.click(button!.ref);
    expect(pressed.text).toContain("pressed");

    const name = pressed.elements.find((element) => element.tag === "input" && element.text === "Your name");
    expect(name).toBeTruthy();
    const typed = await browser!.type(name!.ref, "Ada");
    expect(typed.text).toContain("Ada");
    expect(typed.elements.find((element) => element.ref === name!.ref)?.value).toBe("Ada");

    const secret = typed.elements.find((element) => element.type === "password");
    expect(secret?.value).toBeUndefined();

    const scrolled = await browser!.scroll("down");
    expect(scrolled.url).toBe(`${origin}/`);

    const link = scrolled.elements.find((element) => element.tag === "a");
    expect(link).toBeTruthy();
    const second = await browser!.click(link!.ref);
    expect(second.url).toBe(`${origin}/next`);
    expect(second.title).toBe("Second page");

    const back = await browser!.back();
    expect(back.title).toBe("Browser fixture");

    const workspace = await mkdtemp(join(tmpdir(), "kestrel-screenshot-"));
    try {
      const shot = await browser!.screenshot(workspace, "nested/page.png");
      expect(shot.bytes).toBeGreaterThan(1000);
      expect(shot.mimeType).toBe("image/png");
      expect(shot.data).toBeUndefined();
      const png = await readFile(shot.path);
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

      const jpeg = await browser!.screenshot(workspace, "nested/page.jpg", {
        format: "jpeg",
        quality: 60,
        includeData: true,
      });
      expect(jpeg.mimeType).toBe("image/jpeg");
      expect(jpeg.data).toBeTruthy();
      expect(Buffer.from(jpeg.data!, "base64").subarray(0, 3).toString("hex")).toBe("ffd8ff");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 60_000);

  it("waits for text or a selector", async () => {
    await browser!.open(origin);
    const byText = await browser!.waitFor({ text: "Loaded late", timeoutMs: 5_000 });
    expect(byText.text).toContain("Loaded late");
    const bySelector = await browser!.waitFor({ selector: "#delayed", timeoutMs: 1_000 });
    expect(bySelector.url).toBe(`${origin}/`);
    await expect(browser!.waitFor({ text: "never appears", timeoutMs: 300 })).rejects.toThrow(
      "Timed out after 300ms waiting for text \"never appears\"",
    );
  }, 30_000);

  it("gives each session its own page", async () => {
    const pool = new BrowserPool({ executable, headless: true, timeoutMs: 20_000, settleMs: 100 }, 5_000);
    try {
      await pool.page("alpha").open(origin);
      await pool.page("beta").open(`${origin}/next`);
      expect((await pool.page("alpha").snapshot()).title).toBe("Browser fixture");
      expect((await pool.page("beta").snapshot()).title).toBe("Second page");
      await pool.close("alpha");
      expect(pool.status("alpha").open).toBe(false);
      expect(pool.status("beta").open).toBe(true);
    } finally {
      await pool.closeAll();
    }
  }, 30_000);

  it("evicts an idle page", async () => {
    const pool = new BrowserPool({ executable }, 50);
    pool.page("idle");
    expect(pool.status("idle").open).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(pool.status("idle").open).toBe(false);
  });

  it("rejects non-web URLs and stale refs", async () => {
    await expect(browser!.open("file:///etc/passwd")).rejects.toThrow("Only http and https");
    await expect(browser!.click(9_999)).rejects.toThrow("Unknown element ref");
  });

  it("closes and reopens", async () => {
    await browser!.close();
    expect(browser!.status().open).toBe(false);
    const reopened = await browser!.open(origin);
    expect(reopened.title).toBe("Browser fixture");
  }, 30_000);
});

describe("browser helpers", () => {
  it("keeps screenshots inside the workspace", () => {
    expect(resolveScreenshotPath("/tmp/work", "shots/a.png")).toBe("/tmp/work/shots/a.png");
    expect(() => resolveScreenshotPath("/tmp/work", "../escape.png")).toThrow("escapes the workspace");
    expect(() => resolveScreenshotPath("/tmp/work", "/etc/passwd")).toThrow("escapes the workspace");
  });

  it("renders snapshots for the model", () => {
    const text = formatSnapshot({
      title: "Example",
      url: "https://example.com/",
      text: "Hello",
      truncated: false,
      elements: [
        { ref: 1, tag: "a", text: "Docs", href: "https://example.com/docs" },
        { ref: 2, tag: "input", type: "text", text: "Name", value: "Ada" },
      ],
    });
    expect(text).toContain("Title: Example");
    expect(text).toContain('[1] a href=https://example.com/docs "Docs"');
    expect(text).toContain('[2] input type=text value="Ada" "Name"');
  });
});
