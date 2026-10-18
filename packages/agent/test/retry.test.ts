import { describe, expect, it } from "vitest";
import { silencedLogger } from "@kestrel/kernel";
import type { SessionEvent } from "@kestrel/protocol";
import {
  ModelRegistry,
  ModelRequestError,
  SessionManager,
  ToolRegistry,
  isModelRequestError,
  modelHttpError,
  parseRetryAfter,
  retryDelay,
  type CompletionRequest,
  type CompletionResponse,
  type LanguageModel,
  type TokenDelta,
} from "../src/index.js";

class FlakyModel implements LanguageModel {
  readonly info = { id: "flaky", provider: "test", label: "Flaky", supportsTools: true };
  attempts = 0;

  constructor(
    private readonly outcomes: Array<"fail" | "fail-after-delta" | "ok">,
    private readonly error: () => Error = () => new ModelRequestError("boom", { status: 503, retryable: true }),
  ) {}

  async generate(request: CompletionRequest, onDelta?: (delta: TokenDelta) => void): Promise<CompletionResponse> {
    const outcome = this.outcomes[this.attempts] ?? "fail";
    this.attempts += 1;
    if (outcome === "fail") throw this.error();
    if (outcome === "fail-after-delta") {
      onDelta?.({ channel: "text", delta: "partial" });
      throw this.error();
    }
    onDelta?.({ channel: "text", delta: "done" });
    return {
      content: "done",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    };
  }
}

function session(model: LanguageModel, retry = { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 }) {
  const models = new ModelRegistry();
  models.register(model, { setDefault: true });
  const manager = new SessionManager({
    models,
    tools: new ToolRegistry(),
    logger: silencedLogger(),
    defaultWorkspace: process.cwd(),
    systemPrompt: () => "test prompt",
    retry,
  });
  const events: SessionEvent[] = [];
  manager.subscribe((event) => events.push(event));
  return { manager, session: manager.create({}), events };
}

async function settle(run: ReturnType<typeof session>["session"]): Promise<{ status: string; error?: string }> {
  try {
    const result = await run.start("go").done;
    return { status: result.status };
  } catch (error) {
    return { status: run.status, error: error instanceof Error ? error.message : String(error) };
  }
}

describe("model retries", () => {
  it("retries transient failures and reports the backoff", async () => {
    const model = new FlakyModel(["fail", "fail", "ok"]);
    const { session: run, events } = session(model);
    const result = await settle(run);

    expect(result.status).toBe("completed");
    expect(model.attempts).toBe(3);
    const notices = events.filter((event) => event.type === "notice");
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatchObject({ level: "warn" });
    expect((notices[0] as { message: string }).message).toMatch(/HTTP 503.*attempt 2\/3/);
    expect(run.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("does not retry a non-retryable error", async () => {
    const model = new FlakyModel([], () => new ModelRequestError("bad request", { status: 400 }));
    const { session: run } = session(model);
    const result = await settle(run);

    expect(result.status).toBe("error");
    expect(model.attempts).toBe(1);
  });

  it("does not retry after the stream produced output", async () => {
    const model = new FlakyModel(["fail-after-delta", "ok"]);
    const { session: run } = session(model);
    const result = await settle(run);

    expect(result.status).toBe("error");
    expect(model.attempts).toBe(1);
    expect(result.error).toMatch(/boom/);
  });

  it("gives up after the configured attempts", async () => {
    const model = new FlakyModel(["fail"]);
    const { session: run } = session(model, { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 });
    const result = await settle(run);
    expect(result.status).toBe("error");
    expect(model.attempts).toBe(2);
  });

  it("stops during backoff when the run is cancelled", async () => {
    const model = new FlakyModel([], () => new ModelRequestError("shed", { status: 429, retryable: true }));
    const { session: run } = session(model, { attempts: 5, baseDelayMs: 5_000, maxDelayMs: 5_000 });
    const pending = run.start("go").done;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run.cancel()).toBe(true);

    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(model.attempts).toBe(1);
    expect(run.messages.every((message) => message.role !== "assistant")).toBe(true);
  });

  it("classifies HTTP failures and parses Retry-After", () => {
    const rateLimited = modelHttpError(429, "Too Many Requests", "slow down", "3");
    expect(isModelRequestError(rateLimited)).toBe(true);
    expect(rateLimited.retryable).toBe(true);
    expect(rateLimited.retryAfterMs).toBe(3_000);
    expect(modelHttpError(400, "Bad Request", "nope", null).retryable).toBe(false);
    expect(modelHttpError(502, "Bad Gateway", "", null).retryable).toBe(true);
    expect(parseRetryAfter("not a date")).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });

  it("computes jittered exponential backoff and honours server hints", () => {
    const noJitter = () => 1;
    expect(retryDelay(undefined, 1, { baseDelayMs: 100, maxDelayMs: 10_000 }, noJitter)).toBe(100);
    expect(retryDelay(undefined, 2, { baseDelayMs: 100, maxDelayMs: 10_000 }, noJitter)).toBe(200);
    expect(retryDelay(undefined, 9, { baseDelayMs: 100, maxDelayMs: 500 }, noJitter)).toBe(500);

    const hinted = new ModelRequestError("shed", { retryable: true, retryAfterMs: 2_000 });
    expect(retryDelay(hinted, 1, { baseDelayMs: 10, maxDelayMs: 10_000 }, noJitter)).toBe(2_000);
    expect(retryDelay(hinted, 1, { baseDelayMs: 10, maxDelayMs: 1_000 }, noJitter)).toBe(1_000);
  });
});
