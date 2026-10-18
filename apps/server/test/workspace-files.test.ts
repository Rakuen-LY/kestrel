import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceFile, WorkspaceListing } from "@kestrel/protocol";
import { createHttpServer } from "../src/http.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { WorkspaceFiles, WorkspaceFilesError } from "../src/workspace-files.js";

beforeAll(() => {
  process.env.KESTREL_LOG_LEVEL ??= "silent";
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-files-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe("WorkspaceFiles", () => {
  it("lists directories with directories first and skips ignored names", async () => {
    const root = await workspace();
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "README.md"), "# hi");
    await writeFile(join(root, "src", "index.ts"), "export {};");

    const files = new WorkspaceFiles();
    const listing = await files.list(root);
    expect(listing.path).toBe(".");
    expect(listing.entries.map((entry) => entry.name)).toEqual(["src", "README.md"]);
    expect(listing.entries[0]).toMatchObject({ type: "directory", path: "src" });

    const nested = await files.list(root, "src");
    expect(nested.entries).toEqual([expect.objectContaining({ path: "src/index.ts", type: "file", size: 10 })]);
  });

  it("reads utf8 files with line counts and truncates large files", async () => {
    const root = await workspace();
    await writeFile(join(root, "notes.md"), "one\ntwo\nthree\n");

    const files = new WorkspaceFiles({ maxFileBytes: 8 });
    const text = await files.read(root, "notes.md");
    expect(text).toMatchObject({ encoding: "utf8", binary: false, truncated: true, lines: 2, mimeType: "text/markdown" });
    expect(text.content).toBe("one\ntwo\n");
  });

  it("returns base64 for images and flags binary files", async () => {
    const root = await workspace();
    await writeFile(join(root, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await writeFile(join(root, "blob.bin"), Buffer.from([0, 1, 2, 3]));

    const files = new WorkspaceFiles();
    const image = await files.read(root, "pixel.png");
    expect(image.encoding).toBe("base64");
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.content, "base64")).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const binary = await files.read(root, "blob.bin");
    expect(binary).toMatchObject({ encoding: "base64", binary: true });
    expect(binary.lines).toBeUndefined();
  });

  it("rejects absolute paths, traversal and escaping symlinks", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "kestrel-outside-"));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, "secret.txt"), "nope");
    await symlink(join(outside, "secret.txt"), join(root, "leak.txt"));

    const files = new WorkspaceFiles();
    await expect(files.read(root, "/etc/passwd")).rejects.toMatchObject({ code: "invalid_path", status: 400 });
    await expect(files.read(root, "../outside.txt")).rejects.toMatchObject({ code: "outside_workspace", status: 403 });
    await expect(files.read(root, "leak.txt")).rejects.toMatchObject({ code: "outside_workspace" });

    const listing = await files.list(root);
    expect(listing.entries.map((entry) => entry.name)).not.toContain("leak.txt");
  });

  it("reports missing paths and wrong node types", async () => {
    const root = await workspace();
    await writeFile(join(root, "file.txt"), "x");
    const files = new WorkspaceFiles();

    await expect(files.read(root, "missing.txt")).rejects.toBeInstanceOf(WorkspaceFilesError);
    await expect(files.list(root, "missing")).rejects.toMatchObject({ status: 404 });
    await expect(files.list(root, "file.txt")).rejects.toMatchObject({ code: "not_a_directory" });
    await expect(files.read(root, ".")).rejects.toMatchObject({ code: "not_a_file" });
  });
});

interface Harness {
  base: string;
  runtime: Runtime;
  workspace: string;
  close(): Promise<void>;
}

async function boot(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-files-http-"));
  const directory = join(root, "workspace");
  await mkdir(directory, { recursive: true });
  const configPath = join(root, "kestrel.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      server: { host: "127.0.0.1", port: 0 },
      model: { default: "scripted", maxSteps: 2 },
      agent: { workspace: directory },
      plugins: { directories: [join(root, "plugins")] },
      storage: { directory: join(root, "data") },
    }),
  );
  const runtime = await createRuntime({ configPath });
  const server: Server = createHttpServer(runtime);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    runtime,
    workspace: directory,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

describe("workspace file routes", () => {
  it("lists and reads files for a session", async () => {
    const harness = await boot();
    cleanups.push(harness.close);
    await writeFile(join(harness.workspace, "hello.txt"), "hello");

    const created = await fetch(`${harness.base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { session } = (await created.json()) as { session: { id: string } };

    const listing = await fetch(`${harness.base}/api/sessions/${session.id}/files`);
    expect(listing.status).toBe(200);
    const body = (await listing.json()) as WorkspaceListing;
    expect(body.entries.map((entry) => entry.name)).toEqual(["hello.txt"]);

    const read = await fetch(`${harness.base}/api/sessions/${session.id}/file?path=hello.txt`);
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    const file = (await read.json()) as WorkspaceFile;
    expect(file).toMatchObject({ path: "hello.txt", content: "hello", encoding: "utf8", truncated: false });
  });

  it("refuses traversal and non-GET methods", async () => {
    const harness = await boot();
    cleanups.push(harness.close);
    const created = await fetch(`${harness.base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { session } = (await created.json()) as { session: { id: string } };

    const traversal = await fetch(`${harness.base}/api/sessions/${session.id}/file?path=../../etc/passwd`);
    expect(traversal.status).toBe(403);
    expect(((await traversal.json()) as { error: { code: string } }).error.code).toBe("outside_workspace");

    const absolute = await fetch(`${harness.base}/api/sessions/${session.id}/file?path=${encodeURIComponent("/etc/passwd")}`);
    expect(absolute.status).toBe(400);

    const write = await fetch(`${harness.base}/api/sessions/${session.id}/files`, { method: "POST" });
    expect(write.status).toBe(405);
  });

  it("hides workspace files from other tenants' sessions", async () => {
    const harness = await boot();
    cleanups.push(harness.close);
    const created = await fetch(`${harness.base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { session } = (await created.json()) as { session: { id: string } };

    const missing = await fetch(`${harness.base}/api/sessions/${session.id}/file?path=nope.txt`);
    expect(missing.status).toBe(404);
  });
});
