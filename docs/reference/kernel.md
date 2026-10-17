# Kernel reference

Package: `@kestrel/kernel` · no runtime dependencies · Node 22+.

The kernel provides contexts, services, events, scopes and plugin handles. Everything else in
Kestrel is built on these five concepts.

## `createContext`

```ts
function createContext(options?: CreateContextOptions): Context;
```

```ts
interface CreateContextOptions {
  name?: string;             // default "root"
  logger?: Logger;           // default createLogger()
  services?: Record<string, unknown>; // installed before any plugin runs
}
```

The root context owns the service registry. `createContext` installs the logger as `log` and then
every entry in `services`.

## `Context`

```ts
class Context implements ContextLike {
  readonly name: string;
  readonly root: Context;
  readonly parent?: Context;
  readonly logger: Logger;
  readonly scope: Scope;

  get<T>(key: string): T;
  has(key: string): boolean;
  provide<T>(key: string, value: T, options?: { replace?: boolean }): Disposer;
  effect(setup: () => Disposer | void): Disposer;
  inject(keys: readonly string[], callback: (context: Context) => MaybePromise<Disposer | void>): Disposer;
  on(event, listener, options?: { prepend?: boolean; once?: boolean }): Disposer;
  emit(event, ...args): void;
  plugin<T>(definition: PluginDefinition<T>, config?: T): PluginHandle;
  dispose(): Promise<void>;
}
```

### `get` / `has`

`get` searches the current context, then its ancestors. A missing key throws
`ServiceError` with the key and the context name. `has` performs the same walk without throwing.

```ts
const tools = context.get<ToolRegistry>("tools");
if (context.has("memory")) { /* optional capability */ }
```

### `provide`

Installs a value in the **root registry** and returns a disposer that removes it when this context
still owns it.

- Throws `ServiceError` if the key exists and was provided by a different context, unless
  `{ replace: true }`.
- Re-providing from the same context replaces the value and returns a disposer for the new value.
- Removing a service emits `service/removed`, which deactivates injectors that depend on it.

### `effect`

Runs `setup` immediately and registers the returned disposer on this context's scope.

```ts
context.effect(() => {
  const timer = setInterval(poll, 5_000);
  return () => clearInterval(timer);
});
```

If `setup` throws, the error propagates to the caller. Effects run in registration order and unwind
in reverse order.

### `inject`

Registers a callback that runs whenever **all** listed service keys exist. The callback may return a
disposer, which runs if any dependency disappears or the context is disposed.

```ts
context.inject(["models", "tools"], (ctx) => {
  ctx.get<ToolRegistry>("tools").register(tool);
});
```

- The callback is not run synchronously if dependencies are missing.
- It is re-run if dependencies are removed and later provided again.
- Concurrent scheduling is guarded: a callback is not entered twice.
- Errors in the callback are logged and do not crash the process.

### `on` / `emit`

Events bubble from the context up through its ancestors. Listeners on a parent observe events
emitted by children. `once` removes the listener after the first call; `prepend` puts it at the
front of the listener list. A throwing listener is logged and skipped.

### `plugin`

```ts
const handle = context.plugin(definition, config);
await handle.ready();      // resolves after apply
await handle.dispose();    // unwinds the plugin scope
handle.snapshot();         // { id, name, version, state, dependencies, error? }
```

The child context is named after the definition. The handle is registered with the parent, so
disposing the parent disposes the child. Calling `plugin` with a name that already exists under the
same parent returns the existing handle.

### `dispose`

Disposes child plugins (in reverse creation order), injectors, listeners, effects and services. The
returned promise resolves after all disposers have run. Errors are logged, not thrown. Disposing
twice is a no-op.

## `Scope`

```ts
class Scope {
  constructor(name: string, parent?: Scope);
  add(disposer: Disposer): void;
  dispose(): Promise<void>;
  disposed: boolean;
}
```

A scope is an ordered disposer bag. Child scopes must be disposed before the parent; the kernel
handles this ordering internally. Disposers are invoked sequentially in reverse registration order,
and a failing disposer does not prevent the rest from running.

## Events

| Event | Arguments | When |
| --- | --- | --- |
| `plugin/loading` | `snapshot` | `apply` is about to run. |
| `plugin/active` | `snapshot` | `apply` resolved. |
| `plugin/error` | `snapshot, error` | `apply` threw or timed out. |
| `plugin/disposed` | `snapshot` | All plugin disposers finished. |
| `service/provided` | `key, value` | A service became available. |
| `service/removed` | `key` | A service was removed. |
| `context/disposed` | — | The context finished disposing. |

Feature packages augment `EventMap` and `ServiceMap` through declaration merging.

## Logger

```ts
interface LoggerOptions {
  level?: LogLevel;                 // trace | debug | info | warn | error | silent
  format?: "pretty" | "json";
  bindings?: Record<string, unknown>;
  sink?: (line: string, level: LogLevel) => void;
}

function createLogger(options?: LoggerOptions): Logger;
function silencedLogger(): Logger;
```

`createLogger` reads `KESTREL_LOG_LEVEL` and `KESTREL_LOG_FORMAT` when options are omitted. `child()`
merges bindings; the console uses `logger.child({ component: "sessions" })` to tag records.

## Errors

| Class | Fields | Raised when |
| --- | --- | --- |
| `KestrelError` | `code` | Base class for platform errors. |
| `ServiceError` | `service`, `context` | A service is missing or already owned. |
| `PluginError` | `plugin` | A plugin cannot be loaded or applied. |
| `ContextDisposedError` | — | An operation touches a disposed context. |

## Purity

The kernel imports only `node:util` (for logging) and no network or filesystem APIs. It can run in a
worker, a test, or an embedded runtime without side effects.
