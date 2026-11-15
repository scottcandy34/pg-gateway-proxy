const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/** Parse `500ms`, `5s`, `1m`, `1h`, or a bare millisecond number. `0` disables. */
export function parseDuration(value: unknown, path: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${path} must be a non-negative duration, got ${value}`);
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new Error(`${path} must be a duration string like "5s" or a number of milliseconds`);
  }
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(trimmed);
  if (!match) {
    throw new Error(`${path} must look like "500ms", "5s", "1m", or "1h" (got ${JSON.stringify(value)})`);
  }
  return Number(match[1]) * UNITS[match[2]];
}
