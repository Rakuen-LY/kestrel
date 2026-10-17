import { ContextDisposedError, PluginError, ServiceError } from "./errors.js";
import { createLogger } from "./logger.js";
import { Scope } from "./scope.js";
import type {
  ContextLike,
  Disposer,
  EventMap,
  Logger,
  MaybePromise,
  PluginDefinition,
  PluginSnapshot,
  PluginState,
  ServiceMap,
} from "./types.js";

interface ServiceEntry {
  readonly value: unknown;
  readonly owner: Context;
}

interface Injector {
  readonly dependencies: readonly string[];
  readonly callback: (context: Context) => MaybePromise<Disposer | void>;
  active?: Disposer;
  running: boolean;
  disposed: boolean;
}

export interface PluginHandle {
  readonly id: string;
  readonly context: Context;
  snapshot(): PluginSnapshot;
  /** Resolves once `apply` has completed; rejects if it throws. */
  ready(): Promise<void>;
  dispose(): Promise<void>;
}

export interface CreateContextOptions {
  name?: string;
  logger?: Logger;
  /** Values installed before any plugin runs. */
  services?: Record<string, unknown>;
}

/**
 * The unit of composition. Every plugin receives its own child context, so
 * services, listeners and effects can be traced back to the plugin that
 * registered them and unwound together.
 */
export class Context implements ContextLike {
  readonly name: string;
  readonly scope: Scope;
  readonly root: Context;
  readonly parent?: Context;
  readonly logger: Logger;

  /**
   * Service registry. Plugin contexts point at the root registry so their
   * contributions are visible to every plugin, while their disposers stay on
   * the plugin scope.
   */
  private readonly services: Map<string, ServiceEntry>;
  private readonly ownsRegistry: boolean;
  private readonly listeners = new Map<string, Set<(...args: never[]) => void>>();
  private readonly injectors = new Set<Injector>();
  private readonly pluginHandles = new Map<string, PluginHandle>();
  private disposed = false;

  constructor(
    name: string,
    options: {
      parent?: Context;
      logger?: Logger;
      scope?: Scope;
      serviceRegistry?: Map<string, ServiceEntry>;
    } = {},
  ) {
    this.name = name;
    this.parent = options.parent;
    this.root = options.parent?.root ?? this;
    this.logger = options.logger ?? this.parent?.logger ?? createLogger();
    this.scope = options.scope ?? new Scope(name, options.parent?.scope);
    this.services = options.serviceRegistry ?? new Map<string, ServiceEntry>();
    this.ownsRegistry = options.serviceRegistry === undefined;
  }

  get<K extends keyof ServiceMap>(key: K): ServiceMap[K];
  get<T = unknown>(key: string): T;
  get<T = unknown>(key: string): T {
    const entry = this.lookup(key);
    if (!entry) {
      throw new ServiceError(`Service "${key}" is not available in context "${this.name}".`, {
        details: { service: key, context: this.name, available: this.serviceKeys() },
      });
    }
    return entry.value as T;
  }

  has(key: string): boolean {
    return this.lookup(key) !== undefined;
  }

  /** All service keys visible from this context, nearest registration wins. */
  serviceKeys(): string[] {
    const keys = new Set<string>(this.services.keys());
    let current = this.parent;
    while (current) {
      for (const key of current.services.keys()) keys.add(key);
      current = current.parent;
    }
    return [...keys].sort();
  }

  provide<K extends keyof ServiceMap>(key: K, value: ServiceMap[K], options?: { replace?: boolean }): Disposer;
  provide<T>(key: string, value: T, options?: { replace?: boolean }): Disposer;
  provide<T>(key: string, value: T, options: { replace?: boolean } = {}): Disposer {
    this.assertActive();
    const visible = this.lookup(key);
    if (visible && visible.owner !== this && !options.replace) {
      throw new ServiceError(`Service "${key}" is already provided by context "${visible.owner.name}".`, {
        details: { service: key, owner: visible.owner.name },
      });
    }
    const owned = this.services.get(key);
    if (owned && !options.replace && owned.value !== value) {
      throw new ServiceError(`Service "${key}" was already provided in this context; pass { replace: true } to override.`, {
        details: { service: key },
      });
    }
    const entry: ServiceEntry = { value, owner: this };
    this.services.set(key, entry);
    this.logger.debug("service provided", { service: key, context: this.name });
    this.broadcast("service/provided", key, value);
    this.scheduleInjectors();

    let removed = false;
    const dispose = () => {
      if (removed) return;
      removed = true;
      if (this.services.get(key) === entry) {
        this.services.delete(key);
        this.logger.debug("service removed", { service: key, context: this.name });
        this.broadcast("service/removed", key);
        this.scheduleInjectors();
      }
    };
    this.scope.add(dispose);
    return dispose;
  }

  /** Runs `setup` immediately and registers its disposer on this context. */
  effect(setup: () => Disposer | void): Disposer {
    this.assertActive();
    const dispose = setup();
    if (!dispose) return () => undefined;
    const wrapped = async () => {
      await dispose();
    };
    this.scope.add(wrapped);
    return wrapped;
  }

  /**
   * Invokes `callback` whenever every dependency is available and disposes its
   * result if a dependency disappears. This is the mechanism behind lazy,
   * order-independent plugins.
   */
  inject(dependencies: readonly string[], callback: (context: Context) => MaybePromise<Disposer | void>): Disposer {
    this.assertActive();
    const injector: Injector = { dependencies: [...dependencies], callback, disposed: false, running: false };
    this.injectors.add(injector);
    this.scheduleInjector(injector);

    const dispose = () => {
      if (injector.disposed) return;
      injector.disposed = true;
      this.injectors.delete(injector);
      const active = injector.active;
      injector.active = undefined;
      if (active) void Promise.resolve(active()).catch(() => undefined);
    };
    this.scope.add(dispose);
    return dispose;
  }

  on<K extends keyof EventMap>(
    event: K,
    listener: EventMap[K],
    options: { prepend?: boolean; once?: boolean } = {},
  ): Disposer {
    this.assertActive();
    const registry = this.listeners.get(event as string) ?? new Set();
    this.listeners.set(event as string, registry);
    let wrapped: (...args: never[]) => void;
    if (options.once) {
      wrapped = ((...args: never[]) => {
        this.off(event as string, wrapped);
        (listener as (...values: never[]) => void)(...args);
      }) as (...args: never[]) => void;
    } else {
      wrapped = listener as (...args: never[]) => void;
    }
    if (options.prepend) {
      const existing = [...registry];
      registry.clear();
      registry.add(wrapped);
      for (const item of existing) registry.add(item);
    } else {
      registry.add(wrapped);
    }
    let removed = false;
    const dispose = () => {
      if (removed) return;
      removed = true;
      this.off(event as string, wrapped);
    };
    this.scope.add(dispose);
    return dispose;
  }

  emit<K extends keyof EventMap>(event: K, ...args: Parameters<EventMap[K]>): void {
    this.broadcast(event as string, ...args);
  }

  /**
   * Registers a plugin on this context. The plugin gets a dedicated child
   * context whose lifetime ends when the handle is disposed.
   */
  plugin<Config>(definition: PluginDefinition<Config>, config?: Config): PluginHandle {
    this.assertActive();
    const existing = this.pluginHandles.get(definition.name);
    if (existing) return existing;

    const child = new Context(`plugin:${definition.name}`, {
      parent: this,
      logger: this.logger.child({ context: `plugin:${definition.name}` }),
      serviceRegistry: this.root.services,
    });
    this.scope.add(() => child.dispose());
    let state: PluginState = "waiting";
    let error: string | undefined;
    const dependencies = [...(definition.inject ?? [])];

    const snapshot = (): PluginSnapshot => ({
      id: `plugin:${definition.name}`,
      name: definition.name,
      version: definition.version,
      description: definition.description,
      state,
      dependencies,
      error,
    });

    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => undefined);

    const handle: PluginHandle = {
      id: `plugin:${definition.name}`,
      context: child,
      snapshot,
      ready: () => ready,
      dispose: async () => {
        if (state === "disposed") return;
        state = "disposed";
        this.pluginHandles.delete(definition.name);
        rejectReady(new PluginError(`Plugin "${definition.name}" was disposed before it became active.`));
        await child.dispose();
        this.broadcast("plugin/disposed", snapshot());
      },
    };
    this.pluginHandles.set(definition.name, handle);

    state = "loading";
    this.broadcast("plugin/loading", snapshot());

    child.inject(dependencies, async () => {
      if (state === "disposed") return;
      state = "active";
      error = undefined;
      this.broadcast("plugin/active", snapshot());
      try {
        await definition.apply(child, config as Config);
        resolveReady();
      } catch (cause) {
        state = "error";
        error = cause instanceof Error ? cause.message : String(cause);
        this.logger.error("plugin failed", { plugin: definition.name, error: error });
        this.broadcast("plugin/error", snapshot(), cause);
        rejectReady(cause);
        throw new PluginError(`Plugin "${definition.name}" failed to apply: ${error}`, {
          details: { plugin: definition.name },
          cause,
        });
      }
    });

    return handle;
  }

  /** Creates a child context. Disposing the parent disposes every child. */
  extend(name: string): Context {
    this.assertActive();
    const child = new Context(name, { parent: this, logger: this.logger.child({ context: name }) });
    this.scope.add(() => child.dispose());
    return child;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const handle of this.pluginHandles.values()) await handle.dispose();
    for (const injector of this.injectors) {
      injector.disposed = true;
      if (injector.active) await injector.active();
      injector.active = undefined;
    }
    this.injectors.clear();
    await this.scope.dispose();
    if (this.ownsRegistry) this.services.clear();
    this.listeners.clear();
    this.broadcast("context/disposed");
  }

  private lookup(key: string): ServiceEntry | undefined {
    // eslint-disable-next-line typescript/no-this-alias -- walks the parent chain
    let current: Context | undefined = this;
    while (current) {
      const entry = current.services.get(key);
      if (entry) return entry;
      current = current.parent;
    }
    return undefined;
  }

  private missing(dependencies: readonly string[]): string[] {
    return dependencies.filter((key) => !this.has(key));
  }

  private scheduleInjectors(): void {
    for (const injector of this.injectors) this.scheduleInjector(injector);
  }

  private scheduleInjector(injector: Injector): void {
    if (injector.disposed) return;
    const missing = this.missing(injector.dependencies);
    if (missing.length === 0 && !injector.active && !injector.running) {
      // The flag is set before the callback runs: a callback that provides a
      // service re-enters this method synchronously.
      injector.running = true;
      void (async () => {
        try {
          const disposer = await injector.callback(this);
          if (injector.disposed || this.disposed) {
            if (disposer) await disposer();
          } else if (disposer) {
            injector.active = disposer;
          }
        } catch (cause) {
          this.logger.error("inject callback failed", {
            context: this.name,
            dependencies: injector.dependencies,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        } finally {
          injector.running = false;
          if (!injector.disposed && this.missing(injector.dependencies).length > 0 && injector.active) {
            const active = injector.active;
            injector.active = undefined;
            void Promise.resolve(active()).catch(() => undefined);
          }
        }
      })();
    } else if (missing.length > 0 && injector.active) {
      const active = injector.active;
      injector.active = undefined;
      void Promise.resolve(active()).catch(() => undefined);
    }
  }

  private off(event: string, listener: (...args: never[]) => void): void {
    const registry = this.listeners.get(event);
    if (!registry) return;
    registry.delete(listener);
    if (registry.size === 0) this.listeners.delete(event);
  }

  private broadcast(event: string, ...args: unknown[]): void {
    // eslint-disable-next-line typescript/no-this-alias -- walks the parent chain
    let current: Context | undefined = this;
    const seen = new Set<Context>();
    while (current) {
      if (!seen.has(current)) {
        seen.add(current);
        const registry = current.listeners.get(event);
        if (registry) {
          for (const listener of registry) {
            try {
              (listener as (...values: unknown[]) => void)(...args);
            } catch (cause) {
              this.logger.error("event listener failed", {
                event,
                context: current.name,
                error: cause instanceof Error ? cause.message : String(cause),
              });
            }
          }
        }
      }
      current = current.parent;
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new ContextDisposedError();
  }
}

export function createContext(options: CreateContextOptions = {}): Context {
  const context = new Context(options.name ?? "root", { logger: options.logger ?? createLogger() });
  context.provide("log", context.logger);
  for (const [key, value] of Object.entries(options.services ?? {})) {
    context.provide(key, value);
  }
  return context;
}
