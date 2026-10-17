/**
 * Shared vocabulary for the plugin kernel.
 *
 * `ServiceMap` and `EventMap` are intentionally empty and merge-extensible:
 * every package augments them with its own service keys and events. This keeps
 * the kernel free of domain knowledge while preserving end-to-end type safety.
 */

export type MaybePromise<T> = T | Promise<T>;

/** A function that unwinds a registration made on a scope. */
export type Disposer = () => MaybePromise<void>;

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "silent";

export interface Logger {
  readonly level: LogLevel;
  child(bindings?: Record<string, unknown>): Logger;
  trace(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Services available from every Context. Augmented by feature packages. */
export interface ServiceMap {
  log: Logger;
}

/** Typed event catalogue. Augmented by feature packages. */
export interface EventMap {
  "plugin/loading": (plugin: PluginSnapshot) => void;
  "plugin/active": (plugin: PluginSnapshot) => void;
  "plugin/error": (plugin: PluginSnapshot, error: unknown) => void;
  "plugin/disposed": (plugin: PluginSnapshot) => void;
  "service/provided": (key: string, value: unknown) => void;
  "service/removed": (key: string) => void;
  "context/disposed": () => void;
}

export type PluginState = "waiting" | "loading" | "active" | "error" | "disposed";

export interface PluginSnapshot {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly state: PluginState;
  readonly dependencies: readonly string[];
  readonly error?: string;
}

/** A plugin is an object with a name and an apply function. */
export interface PluginDefinition<Config = unknown> {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  /**
   * Service keys that must exist before `apply` runs. Load order is expressed
   * through dependencies rather than manual boot sequencing.
   */
  readonly inject?: readonly string[];
  apply(context: ContextLike, config: Config): MaybePromise<void>;
}

/**
 * The public surface plugins program against. Kept as an interface so a plugin
 * package never has to import the concrete Context class.
 */
export interface ContextLike {
  readonly name: string;
  get<K extends keyof ServiceMap>(key: K): ServiceMap[K];
  get<T = unknown>(key: string): T;
  has(key: string): boolean;
  provide<K extends keyof ServiceMap>(key: K, value: ServiceMap[K], options?: { replace?: boolean }): Disposer;
  provide<T>(key: string, value: T, options?: { replace?: boolean }): Disposer;
  effect(setup: () => Disposer | void): Disposer;
  inject(dependencies: readonly string[], callback: (context: ContextLike) => MaybePromise<Disposer | void>): Disposer;
  on<K extends keyof EventMap>(
    event: K,
    listener: EventMap[K],
    options?: { prepend?: boolean; once?: boolean },
  ): Disposer;
  emit<K extends keyof EventMap>(event: K, ...args: Parameters<EventMap[K]>): void;
}
