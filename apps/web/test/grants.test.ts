import { describe, expect, it } from "vitest";
import { apiAllowed, normalizeApiPath } from "../src/grants";

describe("plugin API grants", () => {
  it("defaults to read-only access", () => {
    expect(apiAllowed(undefined, "GET", "/api/sessions")).toBe(true);
    expect(apiAllowed(undefined, "GET", "/api/sessions/abc/messages?limit=10")).toBe(true);
    expect(apiAllowed(undefined, "POST", "/api/sessions")).toBe(false);
    expect(apiAllowed(undefined, "GET", "/api/plugins")).toBe(true);
  });

  it("denies everything for an explicit empty list", () => {
    expect(apiAllowed([], "GET", "/api/sessions")).toBe(false);
  });

  it("matches exactly without wildcards", () => {
    const grants = ["GET /api/sessions"];
    expect(apiAllowed(grants, "GET", "/api/sessions")).toBe(true);
    expect(apiAllowed(grants, "GET", "/api/sessions/abc")).toBe(false);
    expect(apiAllowed(grants, "POST", "/api/sessions")).toBe(false);
  });

  it("supports one-segment and recursive wildcards", () => {
    expect(apiAllowed(["GET /api/sessions/*"], "GET", "/api/sessions/abc")).toBe(true);
    expect(apiAllowed(["GET /api/sessions/*"], "GET", "/api/sessions/abc/messages")).toBe(false);
    expect(apiAllowed(["GET /api/sessions/**"], "GET", "/api/sessions")).toBe(true);
    expect(apiAllowed(["GET /api/sessions/**"], "GET", "/api/sessions/abc/messages")).toBe(true);
    expect(apiAllowed(["* /api/plugins/**"], "POST", "/api/plugins/reload")).toBe(true);
  });

  it("rejects traversal instead of letting a wildcard cover it", () => {
    expect(apiAllowed(["GET /api/sessions/**"], "GET", "/api/sessions/../tenants")).toBe(false);
    expect(apiAllowed(["GET /api/sessions/**"], "GET", "/api/sessions/%2e%2e/tenants")).toBe(false);
    expect(apiAllowed(["GET /api/**"], "GET", "//evil.example/api")).toBe(false);
    expect(apiAllowed(["GET /api/**"], "GET", "https://evil.example/api")).toBe(false);
  });

  it("normalises paths before matching", () => {
    expect(normalizeApiPath("/api/sessions/abc?x=1#top")).toBe("/api/sessions/abc");
    expect(apiAllowed(["GET /api/sessions"], "GET", "/api/sessions/?x=1")).toBe(true);
  });
});
