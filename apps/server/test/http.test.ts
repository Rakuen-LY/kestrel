import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Tool } from "@kestrel/agent";
import { ScriptedModel, type ScriptedTurn } from "@kestrel/testkit";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { createHttpServer } from "../src/http.js";

interface Harness {
  base: string;
  runtime: Runtime;
  token: string;
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
const clients = new Set<SseClient>();
const TOKEN = "test-token";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+4wAAAABJRU5ErkJggg==";

beforeAll(() => {
  process.env.KESTREL_LOG_LEVEL ??= "silent";
});

afterEach(async () => {
  for (const client of clients) client.close();
  clients.clear();
  while (cleanups.length) await cleanups.pop()?.();
});

async function boot(
  options: {
    turns?: ScriptedTurn[];
    tools?: Tool[];
    token?: string;
    pluginSource?: string;
    pluginInject?: string[];
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-http-"));
  const workspace = join(root, "workspace");
  const plugins = join(root, "plugins");
  const data = join(root, "data");
  await mkdir(workspace, { recursive: true });
  await mkdir(plugins, { recursive: true });
  if (options.pluginSource) {
    const directory = join(plugins, "test-layer");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "kestrel.plugin.json"),
      JSON.stringify({
        name: "@test/plugin-layer",
        version: "0.0.0",
        entry: "index.js",
        inject: options.pluginInject ?? ["prompts"],
      }),
    );
    await writeFile(join(directory, "index.js"), options.pluginSource);
  }

  const token = options.token === undefined ? TOKEN : options.token;
  const configPath = join(root, "kestrel.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      server: { host: "127.0.0.1", port: 0, token },
      model: { default: "scripted", maxSteps: 6 },
      agent: { workspace },
      plugins: { directories: [plugins] },
      storage: { directory: data },
      approvals: { timeoutMs: 5_000 },
    }),
  );

  const runtime = await createRuntime({ configPath });
  runtime.models.register(new ScriptedModel(options.turns ?? [{ content: "hello" }]), { setDefault: true });
  for (const tool of options.tools ?? []) runtime.tools.register(tool);

  const server: Server = createHttpServer(runtime);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  cleanups.push(close);
  return { base, runtime, token, close };
}

function headers(token = TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function createSession(harness: Harness, body: Record<string, unknown> = {}): Promise<string> {
  const response = await fetch(`${harness.base}/api/sessions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  const payload = (await response.json()) as { session: { id: string } };
  return payload.session.id;
}

async function waitForIdle(harness: Harness, id: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${harness.base}/api/sessions/${id}`, { headers: headers() });
    const payload = (await response.json()) as { session: Record<string, unknown> };
    if (payload.session.status !== "running") return payload.session;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("session did not become idle");
}

interface Envelope<T = Record<string, unknown>> {
  seq: number;
  at: string;
  event: T;
}

class SseClient {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  readonly events: Array<Envelope> = [];
  private closed = false;

  constructor(
    private readonly iterator: AsyncIterator<Buffer>,
    private readonly destroy: () => void,
  ) {}

  async next(predicate: (event: Envelope) => boolean = () => true, timeoutMs = 5_000): Promise<Envelope> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frame = this.takeFrame();
      if (frame) {
        const envelope = parseFrame(frame);
        if (envelope) {
          this.events.push(envelope);
          if (predicate(envelope)) return envelope;
        }
        continue;
      }
      const remaining = deadline - Date.now();
      const chunk = await Promise.race([
        this.iterator.next(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`SSE read timed out; seen: ${this.events.map((e) => e.event.type).join(", ")}`)),
            remaining,
          ),
        ),
      ]);
      if (chunk.done) throw new Error("SSE stream closed");
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
    throw new Error("SSE event not observed in time");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.destroy();
    clients.delete(this);
  }

  private takeFrame(): string | undefined {
    const index = this.buffer.indexOf("\n\n");
    if (index === -1) return undefined;
    const frame = this.buffer.slice(0, index);
    this.buffer = this.buffer.slice(index + 2);
    return frame;
  }
}

function parseFrame(frame: string): Envelope | undefined {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  if (!data) return undefined;
  return JSON.parse(data) as Envelope;
}

async function openEvents(harness: Harness, path: string, lastEventId?: number): Promise<SseClient> {
  const request = httpRequest(`${harness.base}${path}`, {
    headers: {
      authorization: `Bearer ${harness.token}`,
      accept: "text/event-stream",
      ...(lastEventId === undefined ? {} : { "last-event-id": String(lastEventId) }),
    },
  });
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    request.once("response", resolve);
    request.once("error", reject);
    request.end();
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toContain("text/event-stream");
  const client = new SseClient(response[Symbol.asyncIterator](), () => request.destroy());
  clients.add(client);
  return client;
}

describe("plugin HTTP routes", () => {
  const source = `
    export default {
      name: "@test/plugin-layer",
      version: "0.0.0",
      inject: ["http.routes"],
      apply(context) {
        const routes = context.get("http.routes");
        context.effect(() => routes.route({
          method: "POST",
          path: "/api/echo/:id",
          handler: (request) => ({
            status: 201,
            body: { id: request.params.id, body: request.body, user: request.principal?.id ?? null },
          }),
        }));
        context.effect(() => routes.route({
          method: "GET",
          path: "/api/public/ping",
          public: true,
          handler: () => ({ body: { pong: true } }),
        }));
        context.effect(() => routes.route({
          method: "GET",
          path: "/api/plain",
          handler: () => ({
            raw: "one\\ntwo\\n",
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
        }));
      },
    };
  `;

  it("authenticates private routes and dispatches public ones without a token", async () => {
    const harness = await boot({ pluginSource: source, pluginInject: ["http.routes"] });

    const denied = await fetch(`${harness.base}/api/echo/abc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(denied.status).toBe(401);

    const echo = await fetch(`${harness.base}/api/echo/abc`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ x: 1 }),
    });
    expect(echo.status).toBe(201);
    expect(await echo.json()).toMatchObject({ id: "abc", body: { x: 1 } });

    const publicRoute = await fetch(`${harness.base}/api/public/ping`);
    expect(publicRoute.status).toBe(200);
    expect(await publicRoute.json()).toEqual({ pong: true });

    const raw = await fetch(`${harness.base}/api/plain`, { headers: headers() });
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await raw.text()).toBe("one\ntwo\n");
  });
});

describe("HTTP API", () => {
  it("serves health without auth and protects everything else", async () => {
    const harness = await boot();
    const health = await fetch(`${harness.base}/api/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.protocol).toBe("1.0");

    const unauthorized = await fetch(`${harness.base}/api/bootstrap`);
    expect(unauthorized.status).toBe(401);
    const error = (await unauthorized.json()) as { error: { code: string } };
    expect(error.error.code).toBe("unauthorized");

    const bootstrap = await fetch(`${harness.base}/api/bootstrap`, { headers: headers() });
    expect(bootstrap.status).toBe(200);
    const payload = (await bootstrap.json()) as { models: Array<{ id: string }>; features: { streaming: boolean } };
    expect(payload.models.map((model) => model.id)).toContain("scripted");
    expect(payload.features.streaming).toBe(true);
  });

  it("creates, updates, runs and deletes a session", async () => {
    const harness = await boot({ turns: [{ content: "the answer is 42" }] });
    const id = await createSession(harness, { title: "First", systemPrompt: "Be brief." });

    const patch = await fetch(`${harness.base}/api/sessions/${id}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { session: { title: string } }).session.title).toBe("Renamed");

    const stream = await openEvents(harness, `/api/sessions/${id}/events`);
    const sent = await fetch(`${harness.base}/api/sessions/${id}/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ content: "What is the answer?" }),
    });
    expect(sent.status).toBe(202);
    const { runId } = (await sent.json()) as { runId: string };
    expect(runId).toBeTruthy();

    const finished = await stream.next((event) => event.event.type === "run.finished");
    expect((finished.event as { runId: string }).runId).toBe(runId);
    const updated = await stream.next((event) => event.event.type === "session.updated");
    expect((updated.event as { session: { messageCount: number } }).session.messageCount).toBe(2);
    stream.close();

    const detail = await waitForIdle(harness, id);
    const messages = detail.messages as Array<{ role: string; content: string }>;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1].content).toBe("the answer is 42");

    const removed = await fetch(`${harness.base}/api/sessions/${id}`, { method: "DELETE", headers: headers() });
    expect(removed.status).toBe(204);
    const missing = await fetch(`${harness.base}/api/sessions/${id}`, { headers: headers() });
    expect(missing.status).toBe(404);
  });

  it("replays buffered events for reconnects", async () => {
    const harness = await boot({ turns: [{ content: "replay me" }] });
    const id = await createSession(harness);
    await fetch(`${harness.base}/api/sessions/${id}/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ content: "hello" }),
    });
    await waitForIdle(harness, id);

    const replay = await openEvents(harness, `/api/sessions/${id}/events`, 0);
    const events: string[] = [];
    for (let index = 0; index < 50; index += 1) {
      const envelope = await replay.next();
      events.push(envelope.event.type as string);
      if (envelope.event.type === "run.finished") break;
    }
    replay.close();
    expect(events).toContain("run.started");
    expect(events).toContain("message.delta");
    expect(events).toContain("run.finished");
  });

  it("reports cumulative token usage", async () => {
    const harness = await boot({
      turns: [
        { content: "one", usage: { inputTokens: 100, outputTokens: 20 } },
        { content: "two", usage: { inputTokens: 50, outputTokens: 5 } },
      ],
    });
    const id = await createSession(harness);
    for (const content of ["first", "second"]) {
      const sent = await fetch(`${harness.base}/api/sessions/${id}/messages`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ content }),
      });
      expect(sent.status).toBe(202);
      await waitForIdle(harness, id);
    }
    const detail = await fetch(`${harness.base}/api/sessions/${id}`, { headers: headers() });
    const session = ((await detail.json()) as { session: { usage: { totalTokens: number } } }).session;
    expect(session.usage.totalTokens).toBe(175);
    const totals = await fetch(`${harness.base}/api/usage`, { headers: headers() });
    expect(totals.status).toBe(200);
    expect(await totals.json()).toMatchObject({
      sessions: 1,
      running: 0,
      usage: { inputTokens: 150, outputTokens: 25, totalTokens: 175 },
    });
  });
  it("pauses for approval and resumes the run", async () => {
    const approvalTool: Tool = {
      schema: {
        name: "danger",
        description: "A tool that needs approval.",
        permission: "ask",
        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      },
      execute: (args) => ({ content: `approved:${String(args.value)}` }),
    };
    const harness = await boot({
      tools: [approvalTool],
      turns: [
        { toolCalls: [{ name: "danger", arguments: { value: "x" } }] },
        { content: "finished after approval" },
      ],
    });
    const id = await createSession(harness);
    const stream = await openEvents(harness, `/api/sessions/${id}/events`);
    const sent = await fetch(`${harness.base}/api/sessions/${id}/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ content: "run the dangerous tool" }),
    });
    expect(sent.status).toBe(202);

    const requested = await stream.next((event) => event.event.type === "approval.requested", 8_000);
    const approval = (requested.event as { approval: { id: string; call: { name: string } } }).approval;
    expect(approval.call.name).toBe("danger");

    const decision = await fetch(
      `${harness.base}/api/sessions/${id}/approvals/${encodeURIComponent(approval.id)}`,
      { method: "POST", headers: headers(), body: JSON.stringify({ approved: true }) },
    );
    expect(decision.status).toBe(200);

    const finished = await stream.next((event) => event.event.type === "run.finished", 8_000);
    expect((finished.event as { status: string }).status).toBe("completed");
    stream.close();

    const detail = await waitForIdle(harness, id);
    const toolMessage = (detail.messages as Array<{ role: string; content: string }>).find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.content).toContain("approved:x");
  });

  it("rejects invalid input with protocol errors", async () => {
    const harness = await boot();
    const badTitle = await fetch(`${harness.base}/api/sessions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: 42 }),
    });
    expect(badTitle.status).toBe(400);
    expect(((await badTitle.json()) as { error: { code: string } }).error.code).toBe("invalid_body");

    const id = await createSession(harness);
    const empty = await fetch(`${harness.base}/api/sessions/${id}/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ content: "   " }),
    });
    expect(empty.status).toBe(400);

    const wrongMethod = await fetch(`${harness.base}/api/sessions/${id}/cancel`, {
      method: "GET",
      headers: headers(),
    });
    expect(wrongMethod.status).toBe(405);

    const unknownModel = await fetch(`${harness.base}/api/sessions/${id}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ model: "nope" }),
    });
    expect(unknownModel.status).toBe(400);
    expect(((await unknownModel.json()) as { error: { code: string } }).error.code).toBe("unknown_model");
  });

  it("applies plugin prompt layers when a session is created", async () => {
    const harness = await boot({
      pluginSource: `
        export default {
          name: "@test/plugin-layer",
          version: "0.0.0",
          inject: ["prompts"],
          apply(context) {
            context.effect(() =>
              context.get("prompts").add({
                name: "integration-layer",
                transform: (prompt) => prompt + String.fromCharCode(10) + "integration layer active",
              }),
            );
          },
        };
      `,
    });
    const id = await createSession(harness);
    const response = await fetch(`${harness.base}/api/sessions/${id}`, { headers: headers() });
    const payload = (await response.json()) as { session: { systemPrompt: string } };
    expect(payload.session.systemPrompt).toContain("integration layer active");
  });

  it("stores image attachments and strips the data URL prefix", async () => {
    const harness = await boot({ turns: [{ content: "a white pixel" }] });
    const id = await createSession(harness);
    const sent = await fetch(`${harness.base}/api/sessions/${id}/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        content: "what is this?",
        images: [{ mimeType: "image/png", data: `data:image/png;base64,${PNG}`, name: "dot.png" }],
      }),
    });
    expect(sent.status).toBe(202);
    const detail = await waitForIdle(harness, id);
    const messages = detail.messages as Array<{ role: string; images?: Array<Record<string, string>> }>;
    expect(messages[0].images).toEqual([{ mimeType: "image/png", data: PNG, name: "dot.png" }]);
    expect(messages[0].images?.[0].data).not.toContain("data:");
  });

  it("accepts a message made only of images", async () => {
    const harness = await boot({ turns: [{ content: "seen" }] });
    const id = await createSession(harness);
    const sent = await fetch(`${harness.base}/api/sessions/${id}/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ content: "", images: [{ mimeType: "image/png", data: PNG }] }),
    });
    expect(sent.status).toBe(202);
    const detail = await waitForIdle(harness, id);
    const messages = detail.messages as Array<{ role: string; content: string; images?: unknown[] }>;
    expect(messages[0].content).toBe("");
    expect(messages[0].images).toHaveLength(1);
  });

  it("rejects malformed attachments", async () => {
    const harness = await boot();
    const id = await createSession(harness);
    const post = (images: unknown[]) =>
      fetch(`${harness.base}/api/sessions/${id}/messages`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ content: "look", images }),
      });

    const badBase64 = await post([{ mimeType: "image/png", data: "not base64!" }]);
    expect(badBase64.status).toBe(400);
    expect(((await badBase64.json()) as { error: { code: string } }).error.code).toBe("invalid_images");

    const badMime = await post([{ mimeType: "image/svg+xml", data: PNG }]);
    expect(badMime.status).toBe(400);

    const tooMany = await post(Array.from({ length: 7 }, () => ({ mimeType: "image/png", data: PNG })));
    expect(tooMany.status).toBe(413);

    const empty = await fetch(`${harness.base}/api/sessions/${id}/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ content: "   " }),
    });
    expect(empty.status).toBe(400);
  });

  it("resumes an interrupted run over HTTP", async () => {
    const harness = await boot({ turns: [{ content: "first answer" }, { content: "after resume" }] });
    const id = await createSession(harness);
    const sent = await fetch(`${harness.base}/api/sessions/${id}/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ content: "start" }),
    });
    expect(sent.status).toBe(202);
    await waitForIdle(harness, id);

    const idleResume = await fetch(`${harness.base}/api/sessions/${id}/resume`, {
      method: "POST",
      headers: headers(),
    });
    expect(idleResume.status).toBe(409);
    expect(((await idleResume.json()) as { error: { code: string } }).error.code).toBe("not_resumable");

    harness.runtime.sessions.get(id).markInterrupted();
    const resumed = await fetch(`${harness.base}/api/sessions/${id}/resume`, {
      method: "POST",
      headers: headers(),
    });
    expect(resumed.status).toBe(202);
    expect(((await resumed.json()) as { runId: string }).runId).toBeTruthy();

    const detail = await waitForIdle(harness, id);
    const contents = (detail.messages as Array<{ content: string }>).map((message) => message.content);
    expect(contents).toEqual(["start", "first answer", "after resume"]);
  });

  it("requires a token for session-scoped streams", async () => {
    const harness = await boot();
    const id = await createSession(harness);
    const response = await fetch(`${harness.base}/api/sessions/${id}/events`);
    expect(response.status).toBe(401);
  });
});
