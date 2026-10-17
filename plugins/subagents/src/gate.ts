/**
 * A FIFO semaphore that bounds how many subagents one parent session may have
 * in flight. Both delegation tools acquire from the same gate, so a single
 * `delegate` call and a `delegate_many` batch cannot jointly exceed the limit.
 *
 * Queue waiters are abort-aware: cancelling the parent run drops queued tasks
 * instead of starting them after the fact.
 */
export class DelegationGate {
  private readonly active = new Map<string, number>();
  private readonly queues = new Map<string, Waiter[]>();

  constructor(private readonly limit: () => number) {}

  /** Resolves with a release function, or `undefined` if aborted while queued. */
  async acquire(key: string, signal: AbortSignal): Promise<(() => void) | undefined> {
    const limit = this.limit();
    const running = this.active.get(key) ?? 0;
    if (limit <= 0 || running < limit) {
      this.active.set(key, running + 1);
      return this.releaser(key);
    }
    if (signal.aborted) return undefined;

    return new Promise<(() => void) | undefined>((resolve) => {
      let settled = false;
      const waiter: Waiter = {
        grant: () => settle(this.releaser(key)),
      };
      const settle = (value: (() => void) | undefined) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => {
        const queue = this.queues.get(key);
        const index = queue?.indexOf(waiter) ?? -1;
        if (index >= 0) queue?.splice(index, 1);
        settle(undefined);
      };

      this.queueFor(key).push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Slots currently held for `key`. Exposed for observability and tests. */
  activeCount(key: string): number {
    return this.active.get(key) ?? 0;
  }

  /** Tasks waiting for a slot. */
  waitingCount(key: string): number {
    return this.queues.get(key)?.length ?? 0;
  }

  private queueFor(key: string): Waiter[] {
    const existing = this.queues.get(key);
    if (existing) return existing;
    const created: Waiter[] = [];
    this.queues.set(key, created);
    return created;
  }

  private releaser(key: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      const queue = this.queues.get(key);
      const next = queue?.shift();
      if (next) {
        // Hand the slot over directly so a concurrent acquire cannot jump the queue.
        next.grant();
        return;
      }
      if (queue) this.queues.delete(key);

      const running = (this.active.get(key) ?? 1) - 1;
      if (running <= 0) this.active.delete(key);
      else this.active.set(key, running);
    };
  }
}

interface Waiter {
  grant: () => void;
}
