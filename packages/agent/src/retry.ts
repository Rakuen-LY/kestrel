/**
 * Model calls fail transiently: a provider sheds load with 429, a gateway
 * answers 502, a socket resets. Retrying those is the runtime's job, not each
 * provider's, so every adapter only has to classify its failures.
 */
export interface RetryOptions {
  /** Total attempts, including the first one. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export const DEFAULT_RETRY: Required<RetryOptions> = {
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

export interface ModelRequestErrorOptions {
  status?: number;
  retryable?: boolean;
  retryAfterMs?: number;
  cause?: unknown;
}

/**
 * A failed model request. `retryable` is the adapter's judgement; the runtime
 * only reads it. Detection is structural so a provider bundled against its own
 * copy of @kestrel/agent still classifies correctly.
 */
export class ModelRequestError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(message: string, options: ModelRequestErrorOptions = {}) {
    super(message);
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
    this.name = "ModelRequestError";
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isModelRequestError(error: unknown): error is ModelRequestError {
  if (error instanceof ModelRequestError) return true;
  return (
    error instanceof Error &&
    error.name === "ModelRequestError" &&
    typeof (error as { retryable?: unknown }).retryable === "boolean"
  );
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429]);

/** Builds the error for a non-2xx response, honouring `Retry-After`. */
export function modelHttpError(
  status: number,
  statusText: string,
  body: string,
  retryAfter?: string | null,
): ModelRequestError {
  const detail = body.slice(0, 2_000) || "(empty body)";
  return new ModelRequestError(`Model endpoint returned ${status} ${statusText}: ${detail}`, {
    status,
    retryable: RETRYABLE_STATUS.has(status) || status >= 500,
    retryAfterMs: parseRetryAfter(retryAfter),
  });
}

/** Wraps an unexpected fetch failure; the caller decides when it is not retryable. */
export function modelNetworkError(error: unknown, message: string): ModelRequestError {
  const reason = error instanceof Error ? error.message : String(error);
  return new ModelRequestError(`${message}: ${reason}`, { retryable: true, cause: error });
}

/** `Retry-After` is either delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1_000));
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

/**
 * Equal-jitter exponential backoff: half the window is fixed so retries do not
 * stampede, half is random so replicas spread out. A server-provided
 * `Retry-After` wins over the computed delay, capped by `maxDelayMs`.
 */
export function retryDelay(
  error: unknown,
  attempt: number,
  options: RetryOptions = {},
  random: () => number = Math.random,
): number {
  const base = options.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs;
  const cap = options.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs;
  const exponential = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(exponential * (0.5 + random() * 0.5));
  const hinted = isModelRequestError(error) ? error.retryAfterMs : undefined;
  return Math.min(cap, Math.max(jittered, hinted ?? 0));
}

/** Sleeps, rejecting as soon as the run is cancelled. */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw new Error("aborted");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
