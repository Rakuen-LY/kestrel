import type { Disposer } from "./types.js";

let scopeCounter = 0;

/**
 * A scope owns a stack of disposers. Disposal runs in reverse registration
 * order and cascades to child scopes, which is what makes plugin unload safe:
 * every registration a plugin made unwinds with it.
 */
export class Scope {
  readonly id: string;
  readonly parent?: Scope;
  readonly children = new Set<Scope>();
  private readonly disposers: Disposer[] = [];
  private disposing?: Promise<void>;
  disposed = false;

  constructor(name: string, parent?: Scope) {
    scopeCounter += 1;
    this.id = `${name}:${scopeCounter}`;
    this.parent = parent;
    parent?.children.add(this);
  }

  add(disposer: Disposer): void {
    if (this.disposed) {
      void Promise.resolve()
        .then(disposer)
        .catch(() => undefined);
      return;
    }
    this.disposers.push(disposer);
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposing = this.runDisposal();
    return this.disposing;
  }

  private async runDisposal(): Promise<void> {
    this.disposed = true;
    for (const child of [...this.children].reverse()) {
      await child.dispose();
    }
    for (const dispose of [...this.disposers].reverse()) {
      try {
        await dispose();
      } catch {
        // Disposal is best-effort: one broken teardown must not strand the rest.
      }
    }
    this.disposers.length = 0;
    this.parent?.children.delete(this);
  }
}
