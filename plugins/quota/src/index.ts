import type { SessionManager } from "@kestrel/agent";
import { SessionGuardError } from "@kestrel/agent/errors";
import type { Context } from "@kestrel/kernel";
import type { HttpRouteService, SessionEvent } from "@kestrel/protocol";

export interface QuotaLimits {
  /** Sessions a tenant may keep, including subagents. Omit for no limit. */
  maxSessions?: number;
  /** Runs a tenant may execute at the same time. Omit for no limit. */
  maxConcurrentRuns?: number;
  /** Lifetime tokens a tenant may consume, summed over its sessions. */
  maxTokens?: number;
}

export interface QuotaConfig {
  enabled?: boolean;
  /** Limits for tenants without an explicit entry. */
  default?: QuotaLimits;
  /** Per-tenant overrides; a tenant here does not inherit `default`. */
  tenants?: Record<string, QuotaLimits>;
}

export interface TenantUsage {
  tenantId: string;
  sessions: number;
  running: number;
  tokens: number;
  limits: QuotaLimits;
}

export interface QuotaService {
  limits(tenantId: string): QuotaLimits;
  usage(tenantId: string): { sessions: number; running: number; tokens: number };
  describe(): TenantUsage[];
}

const FIELDS = ["maxSessions", "maxConcurrentRuns", "maxTokens"] as const;

function validate(limits: QuotaLimits, where: string): QuotaLimits {
  for (const field of FIELDS) {
    const value = limits[field];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${where}.${field} must be a non-negative integer, received ${String(value)}.`);
    }
  }
  return limits;
}

/**
 * Enforces per-tenant limits through the runtime's session guard.
 *
 * The runtime knows nothing about quotas: it only knows that a guard may veto
 * a create or a run. That keeps policy in a plugin, where it can be swapped,
 * disabled or replaced by an entitlement service without touching the agent.
 *
 * Counts come from in-memory state, so this is per process. A deployment with
 * several replicas needs a shared counter before the limits mean anything
 * globally.
 */
export default {
  name: "@kestrel/plugin-quota",
  version: "0.1.0",
  description: "Per-tenant session, concurrency and token limits enforced through session guards.",
  inject: ["sessions", "http.routes"],
  apply(context: Context, config: QuotaConfig = {}) {
    if (config.enabled === false) return;
    const sessions: SessionManager = context.get("sessions");
    const routes: HttpRouteService = context.get("http.routes");
    const defaults = validate(config.default ?? {}, "quota.default");
    const overrides = new Map<string, QuotaLimits>();
    for (const [tenantId, limits] of Object.entries(config.tenants ?? {})) {
      overrides.set(tenantId, validate(limits, `quota.tenants.${tenantId}`));
    }
    // Keyed by run id so a duplicated terminal event cannot undercount.
    const activeRuns = new Map<string, string>();

    const tenantOf = (sessionId: string): string => {
      if (!sessions.has(sessionId)) return "default";
      return sessions.get(sessionId).tenantId ?? "default";
    };

    const service: QuotaService = {
      limits: (tenantId) => overrides.get(tenantId) ?? defaults,
      usage: (tenantId) => {
        const owned = sessions.list(tenantId);
        let running = 0;
        for (const owner of activeRuns.values()) if (owner === tenantId) running += 1;
        return {
          sessions: owned.length,
          running,
          tokens: owned.reduce((total, session) => total + (session.usage?.totalTokens ?? 0), 0),
        };
      },
      describe: () => {
        const ids = new Set<string>(["default", ...overrides.keys()]);
        for (const session of sessions.list()) ids.add(session.tenantId ?? "default");
        return [...ids]
          .sort()
          .map((tenantId) => ({ tenantId, ...service.usage(tenantId), limits: service.limits(tenantId) }));
      },
    };
    context.provide("quotas", service);

    context.effect(() => {
      const offGuard = sessions.addGuard((check) => {
        const limits = service.limits(check.tenantId);
        if (check.action === "create" && limits.maxSessions !== undefined) {
          const used = sessions.list(check.tenantId).length;
          if (used >= limits.maxSessions) {
            throw new SessionGuardError(
              "quota_exceeded",
              `Tenant "${check.tenantId}" has reached its limit of ${limits.maxSessions} session(s). ` +
                "Delete a session or raise the quota.",
            );
          }
        }
        if (check.action === "run") {
          let current = 0;
          for (const owner of activeRuns.values()) if (owner === check.tenantId) current += 1;
          if (limits.maxConcurrentRuns !== undefined && current >= limits.maxConcurrentRuns) {
            throw new SessionGuardError(
              "quota_exceeded",
              `Tenant "${check.tenantId}" is already running ${current} run(s); ` +
                `the limit is ${limits.maxConcurrentRuns}. Wait for a run to finish.`,
              { retryAfterSeconds: 5 },
            );
          }
          if (limits.maxTokens !== undefined) {
            const used = service.usage(check.tenantId).tokens;
            if (used >= limits.maxTokens) {
              throw new SessionGuardError(
                "quota_exceeded",
                `Tenant "${check.tenantId}" has consumed ${used} of its ${limits.maxTokens} token budget.`,
              );
            }
          }
        }
      });

      const offEvents = sessions.subscribe((event: SessionEvent) => {
        if (event.type === "run.started") {
          activeRuns.set(event.runId, tenantOf(event.sessionId));
          return;
        }
        if (event.type === "run.finished" || event.type === "run.failed") {
          activeRuns.delete(event.runId);
        }
      });

      const offRoute = routes.route({
        method: "GET",
        path: "/api/quotas",
        handler: (request) => {
          if (request.principal?.role !== "admin") {
            return { status: 403, body: { error: "Quotas are visible to administrators only." } };
          }
          return { status: 200, body: { tenants: service.describe() } };
        },
      });

      return () => {
        offGuard();
        offEvents();
        offRoute();
      };
    });
  },
};

declare module "@kestrel/kernel" {
  interface ServiceMap {
    quotas: QuotaService;
    "http.routes": HttpRouteService;
  }
}
