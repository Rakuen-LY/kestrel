import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { boot, createSession, headers, TOKEN, type BootOptions, type Harness } from "./support/server.js";

/**
 * Every error the HTTP layer can produce, asserted against the wire shape
 * clients depend on: a JSON body with a single `error` object, `code` for
 * programmatic branching, `message` for humans, and no caching.
 */

const cleanups: Array<() => Promise<void>> = [];

beforeAll(() => {
  process.env.KESTREL_LOG_LEVEL ??= "silent";
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function bootHarness(options: BootOptions = {}): Promise<Harness> {
  const harness = await boot(options);
  cleanups.push(harness.close);
  return harness;
}

async function expectError(
  response: Response,
  status: number,
  code: string,
): Promise<{ code: string; message: string; details?: unknown }> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = (await response.json()) as { error: { code: string; message: string; details?: unknown } };
  expect(Object.keys(body)).toEqual(["error"]);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
  expect(body.error.message.length).toBeGreaterThan(0);
  return body.error;
}

describe("HTTP error paths", () => {
  it("answers unknown API routes with a not_found envelope", async () => {
    const harness = await bootHarness();
    const response = await fetch(`${harness.base}/api/nope`, { headers: headers(harness.token) });
    const error = await expectError(response, 404, "not_found");
    expect(error.message).toContain("/api/nope");
    expect(error.details).toBeUndefined();
  });

  it("rejects unsupported methods on collection routes", async () => {
    const harness = await bootHarness();
    const response = await fetch(`${harness.base}/api/sessions`, {
      method: "PUT",
      headers: headers(harness.token),
      body: "{}",
    });
    await expectError(response, 405, "method_not_allowed");
  });

  it("rejects writes to read-only workspace file routes", async () => {
    const harness = await bootHarness();
    const id = await createSession(harness);
    const response = await fetch(`${harness.base}/api/sessions/${id}/files`, {
      method: "POST",
      headers: headers(harness.token),
      body: "{}",
    });
    await expectError(response, 405, "method_not_allowed");
  });

  it("reports unknown sessions instead of leaking existence", async () => {
    const harness = await bootHarness();
    const read = await fetch(`${harness.base}/api/sessions/missing`, { headers: headers(harness.token) });
    await expectError(read, 404, "session_not_found");

    const remove = await fetch(`${harness.base}/api/sessions/missing`, {
      method: "DELETE",
      headers: headers(harness.token),
    });
    await expectError(remove, 404, "session_not_found");
  });

  it("rejects malformed JSON bodies", async () => {
    const harness = await bootHarness();
    const response = await fetch(`${harness.base}/api/sessions`, {
      method: "POST",
      headers: headers(harness.token),
      body: "{\"title\":",
    });
    await expectError(response, 400, "invalid_json");
  });

  it("rejects bodies that violate the request schema", async () => {
    const harness = await bootHarness();
    const response = await fetch(`${harness.base}/api/sessions`, {
      method: "POST",
      headers: headers(harness.token),
      body: JSON.stringify({ title: 42 }),
    });
    const error = await expectError(response, 400, "invalid_body");
    expect(error.message).toContain("title");
  });

  it("refuses bodies above the configured limit", async () => {
    const harness = await bootHarness({ config: { server: { bodyLimitBytes: 256 } } });
    const response = await fetch(`${harness.base}/api/sessions`, {
      method: "POST",
      headers: headers(harness.token),
      body: JSON.stringify({ title: "x".repeat(2_048) }),
    });
    await expectError(response, 413, "payload_too_large");
  });

  it("requires a token for SSE streams", async () => {
    const harness = await bootHarness();
    const events = await fetch(`${harness.base}/api/events`);
    await expectError(events, 401, "unauthorized");

    const id = await createSession(harness);
    const sessionEvents = await fetch(`${harness.base}/api/sessions/${id}/events`);
    await expectError(sessionEvents, 401, "unauthorized");
  });

  it("rejects a wrong token", async () => {
    const harness = await bootHarness();
    const response = await fetch(`${harness.base}/api/bootstrap`, { headers: headers("wrong-token") });
    await expectError(response, 401, "unauthorized");
  });

  it("rejects reads outside the workspace", async () => {
    const harness = await bootHarness();
    const id = await createSession(harness);
    const response = await fetch(
      `${harness.base}/api/sessions/${id}/file?path=${encodeURIComponent("../../etc/passwd")}`,
      { headers: headers(harness.token) },
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code.length).toBeGreaterThan(0);
  });

  it("treats static content as read-only", async () => {
    const harness = await bootHarness();
    const response = await fetch(`${harness.base}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await expectError(response, 405, "method_not_allowed");
  });

  it("blocks encoded path traversal into the console root", async () => {
    const harness = await bootHarness();
    const response = await fetch(`${harness.base}/..%2F..%2Fetc%2Fpasswd`);
    await expectError(response, 403, "forbidden");
  });

  it("returns not_found for missing static assets", async () => {
    const harness = await bootHarness();
    const response = await fetch(`${harness.base}/assets/missing.js`);
    await expectError(response, 404, "not_found");
  });

  it("returns not_found for assets of unknown plugins", async () => {
    const harness = await bootHarness();
    const response = await fetch(`${harness.base}/plugins/unknown/panel.js`);
    await expectError(response, 404, "not_found");
  });

  it("returns not_found for incomplete plugin asset paths", async () => {
    const harness = await bootHarness();
    const response = await fetch(`${harness.base}/plugins/only-an-id`);
    await expectError(response, 404, "not_found");
  });

  it("explains that account routes are disabled in single-user mode", async () => {
    const harness = await bootHarness();
    const response = await fetch(`${harness.base}/api/users`, { headers: headers(harness.token) });
    await expectError(response, 409, "accounts_disabled");
  });

  it("serves health without a token", async () => {
    const harness = await bootHarness({ token: TOKEN });
    const response = await fetch(`${harness.base}/api/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; protocol: string };
    expect(body.status).toBe("ok");
    expect(body.protocol).toBe("1.0");
  });
});
