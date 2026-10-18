import { describe, expect, it } from "vitest";
import { silencedLogger } from "@kestrel/kernel";
import {
  ModelRegistry,
  SessionGuardError,
  SessionManager,
  ToolRegistry,
  isSessionGuardError,
  type SessionGuardContext,
} from "../src/index.js";
import { ScriptedModel } from "../../testkit/src/index.js";

function manager() {
  const models = new ModelRegistry();
  models.register(new ScriptedModel([{ content: "ok" }, { content: "ok" }]), { setDefault: true });
  const instance = new SessionManager({
    models,
    tools: new ToolRegistry(),
    logger: silencedLogger(),
    defaultWorkspace: process.cwd(),
    systemPrompt: () => "test prompt",
  });
  return instance;
}

describe("session guards", () => {
  it("runs before a session is created, with the tenant and request", () => {
    const sessions = manager();
    const seen: SessionGuardContext[] = [];
    sessions.addGuard((context) => {
      seen.push(context);
      throw new SessionGuardError("locked", "Tenant is locked.");
    });

    expect(() => sessions.create({ title: "denied" }, "acme")).toThrow(SessionGuardError);
    expect(seen).toEqual([
      { action: "create", tenantId: "acme", request: { title: "denied", model: undefined, workspace: undefined } },
    ]);
    expect(sessions.list()).toHaveLength(0);
  });

  it("defaults the tenant to `default` and removes the guard on dispose", () => {
    const sessions = manager();
    const seen: string[] = [];
    const off = sessions.addGuard((context) => {
      seen.push(context.tenantId);
    });
    sessions.create({});
    off();
    sessions.create({});
    expect(seen).toEqual(["default"]);
  });

  it("vetoes run launches for the owning tenant", async () => {
    const sessions = manager();
    const session = sessions.create({}, "acme");
    let allowed = false;
    const seen: SessionGuardContext[] = [];
    sessions.addGuard((context) => {
      seen.push(context);
      if (!allowed) throw new SessionGuardError("quota_exceeded", "No runs right now.");
    });

    expect(() => session.start("first")).toThrow(/No runs right now/);
    expect(session.messages).toHaveLength(0);
    expect(session.status).toBe("idle");

    allowed = true;
    await session.start("second").done;
    expect(seen.map((context) => context.action)).toEqual(["run", "run"]);
    expect(seen[1].sessionId).toBe(session.id);
  });

  it("lets the first guard win and is recognised structurally across bundles", () => {
    const sessions = manager();
    sessions.addGuard(() => {
      throw new SessionGuardError("first", "First guard.");
    });
    sessions.addGuard(() => {
      throw new SessionGuardError("second", "Second guard.");
    });
    expect(() => sessions.create({})).toThrow("First guard.");

    const foreign = Object.assign(new Error("Foreign bundle."), {
      name: "SessionGuardError",
      code: "quota_exceeded",
    });
    expect(isSessionGuardError(foreign)).toBe(true);
    expect(isSessionGuardError(new Error("plain"))).toBe(false);
  });
});
