import { timingSafeEqual } from "node:crypto";
import type { SessionManager } from "@kestrel/agent";
import type { Context } from "@kestrel/kernel";
import type {
  HttpRouteService,
  PluginHttpHandler,
  PluginHttpRequest,
} from "@kestrel/protocol";

export interface WebhookTrigger {
  prompt: string;
  title?: string;
  model?: string;
  workspace?: string;
  /** Required for `public` hooks and checked against `x-kestrel-hook-secret`. */
  secret?: string;
  /** Skip server authentication. Only allowed together with `secret`. */
  public?: boolean;
}

export interface ScheduleTrigger {
  id: string;
  /** Five-field cron in UTC: minute hour day-of-month month day-of-week. */
  cron: string;
  prompt: string;
  title?: string;
  model?: string;
  workspace?: string;
  enabled?: boolean;
}

export interface TriggersConfig {
  webhooks?: Record<string, WebhookTrigger>;
  schedules?: ScheduleTrigger[];
  /** How often schedules are evaluated. Minimum 1000 ms. */
  tickMs?: number;
}

export interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

const LIMITS: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

/**
 * Parses the common five-field cron dialect: `*`, lists, ranges, steps and a
 * numeric day-of-week with 0 and 7 both meaning Sunday. All times are UTC.
 */
export function parseCron(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => !field)) {
    throw new Error(`Cron expression "${expression}" must have five fields.`);
  }
  const sets = fields.map((field, index) => {
    const [min, max] = LIMITS[index];
    return parseField(field, min, max, index === 4);
  });
  return {
    minutes: sets[0],
    hours: sets[1],
    daysOfMonth: sets[2],
    months: sets[3],
    daysOfWeek: sets[4],
    dayOfMonthRestricted: fields[2] !== "*",
    dayOfWeekRestricted: fields[4] !== "*",
  };
}

export function cronMatches(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.minutes.has(date.getUTCMinutes())) return false;
  if (!schedule.hours.has(date.getUTCHours())) return false;
  if (!schedule.months.has(date.getUTCMonth() + 1)) return false;
  const dayOfMonth = schedule.daysOfMonth.has(date.getUTCDate());
  const dayOfWeek = schedule.daysOfWeek.has(date.getUTCDay());
  if (schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted) return dayOfMonth || dayOfWeek;
  return dayOfMonth && dayOfWeek;
}

function parseField(field: string, min: number, max: number, dayOfWeek: boolean): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!range || !Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid cron field "${field}".`);
    }
    let start: number;
    let end: number;
    if (range === "*") {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const [startText, endText] = range.split("-");
      start = Number(startText);
      end = Number(endText);
    } else {
      start = Number(range);
      end = stepText === undefined ? start : max;
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < min ||
      end > max ||
      start > end
    ) {
      throw new Error(`Invalid cron field "${field}".`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(dayOfWeek && value === 7 ? 0 : value);
    }
  }
  return values;
}

export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
}

interface TriggerSpec {
  title?: string;
  model?: string;
  workspace?: string;
}

interface ScheduleState {
  spec: ScheduleTrigger;
  cron: CronSchedule;
  minute: number;
  running: boolean;
}

export default {
  name: "@kestrel/plugin-triggers",
  version: "0.1.0",
  description: "Start runs from HTTP webhooks and UTC cron schedules.",
  inject: ["sessions", "http.routes"],
  apply(context: Context, config: TriggersConfig = {}) {
    const sessions: SessionManager = context.get("sessions");
    const routes = context.get("http.routes");

    const start = (spec: TriggerSpec, prompt: string): { sessionId: string; runId: string } => {
      const session = sessions.create({ title: spec.title, model: spec.model, workspace: spec.workspace });
      const run = session.start(prompt);
      void run.done.catch((error: unknown) => {
        context.logger.error("trigger run failed", {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return { sessionId: session.id, runId: run.runId };
    };

    for (const [id, hook] of Object.entries(config.webhooks ?? {})) {
      if (!hook.prompt) {
        context.logger.error("webhook has no prompt", { hook: id });
        continue;
      }
      const secret = hook.secret ? expandEnv(hook.secret) : undefined;
      if (hook.public && !secret) {
        context.logger.error("public webhook requires a secret", { hook: id });
        continue;
      }
      const handler = webhookHandler(id, { ...hook, secret }, start, context);
      context.effect(() =>
        routes.route({
          method: "POST",
          path: `/api/hooks/${encodeURIComponent(id)}`,
          public: hook.public === true,
          handler,
        }),
      );
      context.logger.info("webhook registered", { hook: id, public: hook.public === true });
    }

    const schedules = buildSchedules(config.schedules ?? [], context);
    if (schedules.length > 0) {
      const tickMs = Math.max(1_000, config.tickMs ?? 30_000);
      const startedMinute = Math.floor(Date.now() / 60_000);
      for (const state of schedules) state.minute = startedMinute;

      const tick = (): void => {
        const now = new Date();
        const minute = Math.floor(now.getTime() / 60_000);
        for (const state of schedules) {
          if (state.minute === minute) continue;
          state.minute = minute;
          if (!cronMatches(state.cron, now)) continue;
          if (state.running) {
            context.logger.warn("scheduled run still active, skipping", { schedule: state.spec.id });
            continue;
          }
          state.running = true;
          try {
            const prompt = renderTemplate(state.spec.prompt, {
              id: state.spec.id,
              date: now.toISOString(),
              payload: "{}",
            });
            const { sessionId } = start(
              {
                title: state.spec.title ?? `Schedule: ${state.spec.id}`,
                model: state.spec.model,
                workspace: state.spec.workspace,
              },
              prompt,
            );
            context.logger.info("schedule fired", {
              schedule: state.spec.id,
              sessionId,
              cron: state.spec.cron,
            });
          } catch (error) {
            context.logger.error("schedule failed to start", {
              schedule: state.spec.id,
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            state.running = false;
          }
        }
      };

      const timer = setInterval(tick, tickMs);
      timer.unref?.();
      context.effect(() => () => clearInterval(timer));
    }

    context.logger.info("triggers ready", {
      webhooks: Object.keys(config.webhooks ?? {}).length,
      schedules: schedules.length,
    });
  },
};

function buildSchedules(configs: ScheduleTrigger[], context: Context): ScheduleState[] {
  const states: ScheduleState[] = [];
  for (const spec of configs) {
    if (!spec.id || !spec.prompt) {
      context.logger.error("schedule needs an id and a prompt", { schedule: spec.id ?? "(missing)" });
      continue;
    }
    if (spec.enabled === false) continue;
    try {
      states.push({ spec, cron: parseCron(spec.cron), minute: -1, running: false });
    } catch (error) {
      context.logger.error("invalid cron expression", {
        schedule: spec.id,
        cron: spec.cron,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return states;
}

function webhookHandler(
  id: string,
  hook: WebhookTrigger,
  start: (spec: TriggerSpec, prompt: string) => { sessionId: string; runId: string },
  context: Context,
): PluginHttpHandler {
  return (request: PluginHttpRequest) => {
    if (hook.secret && !secretMatches(headerValue(request.headers, "x-kestrel-hook-secret"), hook.secret)) {
      return { status: 401, body: { error: { code: "invalid_hook_secret", message: "Hook secret is missing or wrong." } } };
    }
    const prompt = renderTemplate(hook.prompt, {
      id,
      date: new Date().toISOString(),
      payload: JSON.stringify(request.body ?? {}),
    });
    try {
      const { sessionId, runId } = start(
        { title: hook.title ?? `Hook: ${id}`, model: hook.model, workspace: hook.workspace },
        prompt,
      );
      context.logger.info("webhook started a run", { hook: id, sessionId });
      return { status: 202, body: { hook: id, sessionId, runId } };
    } catch (error) {
      return {
        status: 500,
        body: {
          error: { code: "trigger_failed", message: error instanceof Error ? error.message : String(error) },
        },
      };
    }
  };
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "");
}

function secretMatches(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

declare module "@kestrel/kernel" {
  interface ServiceMap {
    "http.routes": HttpRouteService;
  }
}
