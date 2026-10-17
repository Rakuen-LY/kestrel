import { describe, expect, it, vi } from "vitest";
import { ContextDisposedError, KestrelError, ServiceError, createContext, silencedLogger } from "../src/index.js";

const logger = silencedLogger();

describe("Context services", () => {
  it("resolves services through the parent chain", () => {
    const root = createContext({ logger });
    const child = root.extend("child");
    root.provide("alpha", 1);
    root.provide("beta", 2, { replace: true });
    child.provide("beta", 3, { replace: true });

    expect(child.get<number>("alpha")).toBe(1);
    expect(child.get<number>("beta")).toBe(3);
    expect(root.get<number>("beta")).toBe(2);
    expect(child.has("missing")).toBe(false);
    expect(child.serviceKeys()).toEqual(["alpha", "beta", "log"]);
  });

  it("rejects duplicate providers unless replacement is explicit", () => {
    const root = createContext({ logger });
    root.provide("alpha", 1);
    expect(() => root.provide("alpha", 2)).toThrow(ServiceError);
    expect(() => root.extend("child").provide("alpha", 2)).toThrow(ServiceError);
    expect(() => root.provide("alpha", 2, { replace: true })).not.toThrow();
  });

  it("removes services when their disposer runs", () => {
    const root = createContext({ logger });
    const dispose = root.provide("alpha", 1);
    expect(root.has("alpha")).toBe(true);
    dispose();
    expect(root.has("alpha")).toBe(false);
  });

  it("surfaces a helpful error for missing services", () => {
    const root = createContext({ logger });
    expect(() => root.get("nope")).toThrowError(/Service "nope" is not available/);
  });
});

describe("Context injection", () => {
  it("waits for dependencies regardless of registration order", () => {
    const root = createContext({ logger });
    const calls: string[] = [];
    root.inject(["late"], () => {
      calls.push("applied");
      return () => calls.push("disposed");
    });
    expect(calls).toEqual([]);
    root.provide("late", 1);
    expect(calls).toEqual(["applied"]);
    root.provide("late", 2, { replace: true });
    // Replacement keeps the injector satisfied; it is not torn down.
    expect(calls).toEqual(["applied"]);
  });

  it("tears down when a dependency disappears", async () => {
    const root = createContext({ logger });
    const calls: string[] = [];
    const dispose = root.provide("dep", 1);
    root.inject(["dep"], () => {
      calls.push("applied");
      return () => calls.push("disposed");
    });
    expect(calls).toEqual(["applied"]);
    dispose();
    await Promise.resolve();
    expect(calls).toEqual(["applied", "disposed"]);
  });
});

describe("Context events", () => {
  it("delivers events to the emitting context and ancestors", () => {
    const root = createContext({ logger });
    const child = root.extend("child");
    const seen: string[] = [];
    root.on("context/disposed", () => seen.push("root"));
    child.on("context/disposed", () => seen.push("child"));
    child.emit("context/disposed");
    expect(seen).toEqual(["child", "root"]);
  });

  it("supports once listeners and manual disposal", () => {
    const root = createContext({ logger });
    let count = 0;
    root.on("service/provided", () => {
      count += 1;
    }, { once: true });
    root.provide("a", 1);
    root.provide("b", 2);
    expect(count).toBe(1);

    const listener = vi.fn();
    const off = root.on("service/removed", listener);
    off();
    root.provide("c", 3)();
    expect(listener).not.toHaveBeenCalled();
  });

  it("isolates listener failures", () => {
    const root = createContext({ logger });
    root.on("service/provided", () => {
      throw new Error("boom");
    });
    expect(() => root.provide("a", 1)).not.toThrow();
    expect(root.has("a")).toBe(true);
  });
});

describe("Context lifecycle", () => {
  it("runs disposers in reverse order", async () => {
    const root = createContext({ logger });
    const order: string[] = [];
    root.scope.add(() => {
      order.push("first");
    });
    root.scope.add(() => {
      order.push("second");
    });
    await root.dispose();
    expect(order).toEqual(["second", "first"]);
  });

  it("records effects and unwinds them on dispose", async () => {
    const root = createContext({ logger });
    const disposed = vi.fn();
    root.effect(() => disposed);
    await root.dispose();
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("disposes child contexts with their parent", async () => {
    const root = createContext({ logger });
    const child = root.extend("child");
    const disposed = vi.fn();
    child.effect(() => disposed);
    await root.dispose();
    expect(child.scope.disposed).toBe(true);
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("refuses registration after disposal", async () => {
    const root = createContext({ logger });
    await root.dispose();
    expect(() => root.provide("x", 1)).toThrow(ContextDisposedError);
    expect(() => root.on("context/disposed", () => undefined)).toThrow(KestrelError);
  });
});

describe("Plugin registration", () => {
  it("activates plugins with dependencies and exposes snapshots", async () => {
    const root = createContext({ logger });
    const states: string[] = [];
    root.on("plugin/active", (snapshot) => states.push(`active:${snapshot.name}`));
    root.on("plugin/disposed", (snapshot) => states.push(`disposed:${snapshot.name}`));
    root.provide("dep", 42);

    const applied = vi.fn();
    root.plugin({
      name: "demo",
      version: "1.0.0",
      inject: ["dep"],
      apply(context) {
        applied(context.get<number>("dep"));
      },
    });

    const handle = root.plugin({ name: "demo", apply: () => undefined });
    await handle.ready();
    expect(applied).toHaveBeenCalledWith(42);
    expect(handle.snapshot().state).toBe("active");
    await handle.dispose();
    expect(states).toEqual(["active:demo", "disposed:demo"]);
  });

  it("marks failing plugins as errored", async () => {
    const root = createContext({ logger });
    const handle = root.plugin({
      name: "broken",
      apply() {
        throw new Error("nope");
      },
    });
    await expect(handle.ready()).rejects.toThrow();
    expect(handle.snapshot().state).toBe("error");
    expect(handle.snapshot().error).toContain("nope");
  });

  it("publishes plugin services application-wide and unwinds them on dispose", async () => {
    const root = createContext({ logger });
    const handle = root.plugin({
      name: "provided",
      apply(context) {
        context.provide("owned", true);
      },
    });
    await handle.ready();
    expect(root.has("owned")).toBe(true);
    expect(root.get("owned")).toBe(true);
    await handle.dispose();
    expect(root.has("owned")).toBe(false);
  });
});
