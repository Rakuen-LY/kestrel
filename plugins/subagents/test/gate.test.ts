import { describe, expect, it } from "vitest";
import { DelegationGate } from "../src/gate.js";

const signal = () => new AbortController().signal;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("DelegationGate", () => {
  it("lets up to the limit run at once", async () => {
    const gate = new DelegationGate(() => 2);

    const first = await gate.acquire("p", signal());
    const second = await gate.acquire("p", signal());
    expect(gate.activeCount("p")).toBe(2);

    let third = false;
    const pending = gate.acquire("p", signal()).then((release) => {
      third = true;
      return release;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    expect(gate.waitingCount("p")).toBe(1);

    first?.();
    const thirdRelease = await pending;
    expect(third).toBe(true);
    expect(gate.activeCount("p")).toBe(2);

    second?.();
    thirdRelease?.();
    expect(gate.activeCount("p")).toBe(0);
    expect(gate.waitingCount("p")).toBe(0);
  });

  it("grants queued slots in order", async () => {
    const gate = new DelegationGate(() => 1);
    const granted: string[] = [];

    const held = await gate.acquire("p", signal());
    const queued = ["b", "c", "d"].map((name) =>
      gate.acquire("p", signal()).then((release) => {
        granted.push(name);
        return release;
      }),
    );
    await Promise.resolve();

    held?.();
    await tick();
    expect(granted).toEqual(["b"]);
    (await queued[0])?.();
    await tick();
    expect(granted).toEqual(["b", "c"]);
    (await queued[1])?.();
    (await queued[2])?.();
    await tick();
    expect(granted).toEqual(["b", "c", "d"]);
  });

  it("drops a waiter when its run is aborted, without consuming a slot", async () => {
    const gate = new DelegationGate(() => 1);
    const held = await gate.acquire("p", signal());
    const controller = new AbortController();

    const queued = gate.acquire("p", controller.signal);
    await Promise.resolve();
    expect(gate.waitingCount("p")).toBe(1);

    controller.abort();
    expect(await queued).toBeUndefined();
    expect(gate.waitingCount("p")).toBe(0);
    expect(gate.activeCount("p")).toBe(1);

    held?.();
    expect(gate.activeCount("p")).toBe(0);
  });

  it("does not double-release", async () => {
    const gate = new DelegationGate(() => 1);
    const held = await gate.acquire("p", signal());

    held?.();
    held?.();
    expect(gate.activeCount("p")).toBe(0);

    // A second acquire must still succeed after the spurious release.
    const again = await gate.acquire("p", signal());
    expect(gate.activeCount("p")).toBe(1);
    again?.();
  });

  it("treats a non-positive limit as unbounded", async () => {
    const gate = new DelegationGate(() => 0);
    const held = await Promise.all(
      Array.from({ length: 5 }, () => gate.acquire("p", signal())),
    );
    expect(held.every(Boolean)).toBe(true);
    for (const release of held) release?.();
    expect(gate.activeCount("p")).toBe(0);
  });

  it("keeps budgets separate per parent session", async () => {
    const gate = new DelegationGate(() => 1);
    const first = await gate.acquire("parent-a", signal());
    const second = await gate.acquire("parent-b", signal());

    expect(second).toBeTypeOf("function");
    expect(gate.activeCount("parent-a")).toBe(1);
    expect(gate.activeCount("parent-b")).toBe(1);
    first?.();
    second?.();
  });
});
