import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tool, ToolContext } from "@kestrel/agent";
import { createCoreTools, htmlToText } from "../src/index.js";

let workspace: string;
let tools: Map<string, Tool>;
let context: ToolContext;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "kestrel-tools-"));
  tools = new Map(createCoreTools({ shellPermission: "auto" }).map((tool) => [tool.schema.name, tool]));
  context = {
    callId: "call_1",
    session: { id: "session_1", workspace, metadata: new Map() },
    signal: new AbortController().signal,
  };
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function tool(name: string): Tool {
  const found = tools.get(name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

async function run(name: string, args: Record<string, unknown>) {
  return tool(name).execute(args, context);
}

describe("core filesystem tools", () => {
  it("writes, reads and edits a file", async () => {
    const written = await run("write_file", { path: "src/hello.ts", content: "export const value = 1;\n" });
    expect(written.isError).toBeFalsy();
    expect(await readFile(join(workspace, "src/hello.ts"), "utf8")).toContain("value = 1");

    const read = await run("read_file", { path: "src/hello.ts" });
    expect(read.content).toContain("# src/hello.ts");
    expect(read.content).toContain("export const value = 1;");

    const edited = await run("edit_file", {
      path: "src/hello.ts",
      old_string: "value = 1",
      new_string: "value = 2",
    });
    expect(edited.content).toContain("1 replacement");
    expect(await readFile(join(workspace, "src/hello.ts"), "utf8")).toContain("value = 2");
  });

  it("refuses ambiguous or missing edits", async () => {
    await run("write_file", { path: "a.txt", content: "same\nsame\n" });
    await expect(run("edit_file", { path: "a.txt", old_string: "same", new_string: "other" })).rejects.toThrow(
      /occurs 2 times/,
    );
    await expect(run("edit_file", { path: "a.txt", old_string: "absent", new_string: "other" })).rejects.toThrow(
      /not found/,
    );
  });

  it("lists, globs and greps the workspace", async () => {
    await run("write_file", { path: "src/a.ts", content: "const alpha = 1;\n" });
    await run("write_file", { path: "src/b.ts", content: "const beta = 2;\n" });
    await run("write_file", { path: "docs/readme.md", content: "alpha docs\n" });
    await mkdir(join(workspace, "node_modules"), { recursive: true });

    const listed = await run("list_dir", {});
    expect(listed.content).toContain("dir  src/");
    expect(listed.content).toContain("dir  docs/");

    const globbed = await run("glob", { pattern: "**/*.ts" });
    expect(globbed.content.split("\n")).toEqual(["src/a.ts", "src/b.ts"]);

    const grepped = await run("grep", { pattern: "alpha" });
    expect(grepped.content).toContain("src/a.ts:1");
    expect(grepped.content).toContain("docs/readme.md:1");
  });

  it("keeps relative paths inside the workspace", async () => {
    await expect(run("read_file", { path: "../outside.txt" })).rejects.toThrow(/escapes the workspace/);
    await expect(run("write_file", { path: "../outside.txt", content: "x" })).rejects.toThrow(/escapes the workspace/);

    const absoluteInside = join(workspace, "inside.txt");
    await run("write_file", { path: absoluteInside, content: "ok" });
    expect(await readFile(absoluteInside, "utf8")).toBe("ok");
  });

  it("runs a shell command with the workspace as cwd", async () => {
    await run("write_file", { path: "marker.txt", content: "here" });
    const command = process.platform === "win32" ? "dir /b" : "ls";
    const result = await run("shell", { command });
    expect(result.content).toContain("exit_code: 0");
    expect(result.content).toContain("marker.txt");
  });

  it("tracks todos and terminates on finish", async () => {
    const listed = await run("todo_write", {
      todos: [
        { content: "inspect", status: "completed" },
        { content: "patch", status: "in_progress" },
      ],
    });
    expect(listed.content).toContain("[x] inspect");
    expect(listed.content).toContain("[~] patch");

    const finished = await run("finish", { summary: "done" });
    expect(finished.terminate).toBe(true);
    expect(finished.content).toBe("done");
  });
});

describe("htmlToText", () => {
  it("drops scripts and styles while keeping readable content", () => {
    const text = htmlToText(
      "<html><head><title>Doc</title><style>x{}</style></head><body><script>bad()</script><p>Hello &amp; welcome</p></body></html>",
    );
    expect(text).toContain("# Doc");
    expect(text).toContain("Hello & welcome");
    expect(text).not.toContain("bad()");
    expect(text).not.toContain("x{}");
  });
});
