export class KestrelError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: { code?: string; details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? "kestrel_error";
    this.details = options.details;
  }
}

export class PluginError extends KestrelError {
  constructor(message: string, options: { details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, { ...options, code: "plugin_error" });
  }
}

export class ServiceError extends KestrelError {
  constructor(message: string, options: { details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, { ...options, code: "service_error" });
  }
}

export class ContextDisposedError extends KestrelError {
  constructor() {
    super("The plugin context has been disposed.", { code: "context_disposed" });
  }
}
