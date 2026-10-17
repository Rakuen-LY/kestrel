import { inspect } from "node:util";
import type { LogLevel, Logger } from "./types.js";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: 100,
};

const LEVEL_COLOR: Record<string, string> = {
  trace: "\x1b[90m",
  debug: "\x1b[36m",
  info: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

const RESET = "\x1b[0m";
const DIM = "\x1b[90m";

export interface LoggerOptions {
  level?: LogLevel;
  /** `json` emits one JSON object per line; `pretty` is human oriented. */
  format?: "pretty" | "json";
  bindings?: Record<string, unknown>;
  /** Destination, defaults to stdout for normal levels and stderr for errors. */
  sink?: (line: string, level: LogLevel) => void;
}

function parseLevel(value: string | undefined): LogLevel {
  if (!value) return "info";
  return value in LEVEL_WEIGHT ? (value as LogLevel) : "info";
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = parseLevel(options.level ?? process.env.KESTREL_LOG_LEVEL);
  const format = options.format ?? (process.env.KESTREL_LOG_FORMAT === "json" ? "json" : "pretty");
  const bindings = options.bindings ?? {};
  const useColor =
    format === "pretty" &&
    !process.env.NO_COLOR &&
    (options.sink ? false : Boolean(process.stderr.isTTY));

  const sink =
    options.sink ??
    ((line: string, logLevel: LogLevel) => {
      if (logLevel === "error" || logLevel === "warn") process.stderr.write(`${line}\n`);
      else process.stdout.write(`${line}\n`);
    });

  const write = (logLevel: Exclude<LogLevel, "silent">, message: string, meta?: Record<string, unknown>) => {
    if (LEVEL_WEIGHT[logLevel] < LEVEL_WEIGHT[level]) return;
    const merged = { ...bindings, ...meta };
    if (format === "json") {
      const record: Record<string, unknown> = {
        time: new Date().toISOString(),
        level: logLevel,
        msg: message,
      };
      for (const [key, value] of Object.entries(merged)) {
        if (value !== undefined) record[key] = value;
      }
      sink(JSON.stringify(record), logLevel);
      return;
    }
    const timestamp = new Date().toISOString().slice(11, 23);
    const name = typeof merged.name === "string" ? ` ${DIM}[${merged.name}]${RESET}` : "";
    const color = useColor ? LEVEL_COLOR[logLevel] : "";
    const reset = useColor ? RESET : "";
    const dim = useColor ? DIM : "";
    const rest: Record<string, unknown> = { ...merged };
    delete rest.name;
    const metaText = Object.keys(rest).length > 0 ? ` ${dim}${inspect(rest, { breakLength: 120, colors: useColor })}${reset}` : "";
    const levelText = logLevel.toUpperCase().padEnd(5);
    sink(`${dim}${timestamp}${reset} ${color}${levelText}${reset}${name} ${message}${metaText}`, logLevel);
  };

  const logger: Logger = {
    level,
    child(extra) {
      return createLogger({ level, format, bindings: { ...bindings, ...extra }, sink });
    },
    trace: (message, meta) => write("trace", message, meta),
    debug: (message, meta) => write("debug", message, meta),
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
  };

  return logger;
}

export function silencedLogger(): Logger {
  return createLogger({ level: "silent", sink: () => {} });
}
