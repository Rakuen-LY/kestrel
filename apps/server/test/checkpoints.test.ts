import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silencedLogger } from "@kestrel/kernel";
import { CheckpointError, CheckpointService } from "../src/checkpoints.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

let root: string;
let workspace: string;
let service: CheckpointService;

async function setup(options: { enabled?: boolean | "auto"; maxFiles?: number; exclude?: string[] } = {}) {
  root = await mkdtemp(join(tmpdir(), "kestrel-checkpoints-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  service = new CheckpointService({
    directory: join(root, "data"),
    logger: silencedLogger(),
    config: { enabled: options.enabled ?? true, maxFiles: options.maxFiles, exclude: options.exclude },
    timeoutMs: 20_000,
  });
}

beforeEach(async () => {
  await setup();
});

describe("CheckpointService", () => {
  it("restores modified, created and deleted files", async () => {
    await writeFile(join(workspace, "keep.txt"), "original");
    await writeFile(join(workspace, "delete-me.txt"), "gone soon");
    const checkpoint = await service.snapshot(workspace, { sessionId: "s1", label: "before" });

    await writeFile(join(workspace, "keep.txt"), "changed");
    await writeFile(join(workspace, "new.txt"), "created by the agent");
    await rm(join(workspace, "delete-me.txt"));

    const { restored, safety } = await service.restore(workspace, checkpoint.id);
    expect(restored.id).toBe(checkpoint.id);
    expect(await readFile(join(workspace, "keep.txt"), "utf8")).toBe("original");
    expect(await readFile(join(workspace, "delete-me.txt"), "utf8")).toBe("gone soon");
    await expect(readFile(join(workspace, "new.txt"), "utf8")).rejects.toThrow();

    // The state before the restore is itself recoverable.
    const records = await service.list(workspace);
    expect(records.map((record) => record.id)).toContain(safety.id);
  });

  it("tracks file counts and per-checkpoint changes", async () => {
    await writeFile(join(workspace, "a.txt"), "a");
    const first = await service.snapshot(workspace, { label: "first" });
    expect(first.files).toBe(1);
    expect(first.changes).toEqual({ added: 1, modified: 0, deleted: 0 });

    await writeFile(join(workspace, "a.txt"), "a2");
    await writeFile(join(workspace, "b.txt"), "b");
    await rm(join(workspace, "wrong.txt")).catch(() => undefined);
    const second = await service.snapshot(workspace, { label: "second" });
    expect(second.files).toBe(2);
    expect(second.changes).toEqual({ added: 1, modified: 1, deleted: 0 });

    const list = await service.list(workspace);
    expect(list.map((record) => record.label)).toEqual(["first", "second"]);
    expect(list.every((record) => record.sha.length >= 40)).toBe(true);
  });

  it("leaves ignored files alone", async () => {
    await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(workspace, "node_modules", "pkg", "index.js"), "module");
    await writeFile(join(workspace, "tracked.txt"), "one");
    const checkpoint = await service.snapshot(workspace);

    await writeFile(join(workspace, "node_modules", "pkg", "index.js"), "updated dependency");
    await writeFile(join(workspace, "tracked.txt"), "two");
    await service.restore(workspace, checkpoint.id);

    expect(await readFile(join(workspace, "node_modules", "pkg", "index.js"), "utf8")).toBe("updated dependency");
    expect(await readFile(join(workspace, "tracked.txt"), "utf8")).toBe("one");
  });

  it("honours the workspace .gitignore", async () => {
    await writeFile(join(workspace, ".gitignore"), "generated/\n");
    await mkdir(join(workspace, "generated"), { recursive: true });
    await writeFile(join(workspace, "generated", "out.txt"), "build output");
    await writeFile(join(workspace, "src.txt"), "source");
    const checkpoint = await service.snapshot(workspace);
    expect(checkpoint.files).toBe(2); // .gitignore and src.txt

    await writeFile(join(workspace, "generated", "out.txt"), "rebuilt");
    await service.restore(workspace, checkpoint.id);
    expect(await readFile(join(workspace, "generated", "out.txt"), "utf8")).toBe("rebuilt");
  });

  it("serializes concurrent snapshots", async () => {
    await writeFile(join(workspace, "file.txt"), "content");
    const results = await Promise.all([
      service.snapshot(workspace, { label: "one" }),
      service.snapshot(workspace, { label: "two" }),
      service.snapshot(workspace, { label: "three" }),
    ]);
    const records = await service.list(workspace);
    expect(records).toHaveLength(3);
    expect(new Set(results.map((record) => record.sha)).size).toBe(3);
  });

  it("reports unknown checkpoints", async () => {
    await writeFile(join(workspace, "file.txt"), "content");
    await service.snapshot(workspace);
    await expect(service.restore(workspace, "cp_missing")).rejects.toMatchObject({
      code: "checkpoint_not_found",
      status: 404,
    });
  });

  it("refuses workspaces above the file limit", async () => {
    await setup({ maxFiles: 1 });
    await writeFile(join(workspace, "a.txt"), "a");
    await writeFile(join(workspace, "b.txt"), "b");
    await expect(service.snapshot(workspace)).rejects.toBeInstanceOf(CheckpointError);
    await expect(service.snapshot(workspace)).rejects.toMatchObject({ code: "checkpoint_too_large" });
  });

  it("can be disabled", async () => {
    await setup({ enabled: false });
    const status = await service.status();
    expect(status.enabled).toBe(false);
    expect(status.reason).toContain("disabled");
    await expect(service.snapshot(workspace)).rejects.toMatchObject({ code: "checkpoints_disabled" });
    expect(await service.list(workspace)).toEqual([]);
  });

  it("adds configured exclude patterns", async () => {
    await setup({ exclude: ["*.tmp"] });
    await writeFile(join(workspace, "keep.txt"), "keep");
    await writeFile(join(workspace, "scratch.tmp"), "temporary");
    const checkpoint = await service.snapshot(workspace);
    expect(checkpoint.files).toBe(1);
  });
});
