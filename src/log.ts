export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "text" | "json";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Logger = {
  debug: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
};

export function createLogger(level: LogLevel, format: LogFormat): Logger {
  const write = (at: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (RANK[at] < RANK[level]) return;
    const time = new Date().toISOString();
    if (format === "json") {
      console.log(JSON.stringify({ time, level: at, message, ...fields }));
      return;
    }
    const extra = fields && Object.keys(fields).length > 0 ? ` ${formatFields(fields)}` : "";
    console.log(`${time} ${at.toUpperCase().padEnd(5)} ${message}${extra}`);
  };
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}

function formatFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return /\s/.test(value) ? JSON.stringify(value) : value;
  if (value instanceof Error) return value.message;
  return JSON.stringify(value);
}
