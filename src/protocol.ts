/** 8-byte Postgres SSLRequest: length=8, code=80877103. */
export function sslRequest(): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeInt32BE(8, 0);
  buf.writeInt32BE(80877103, 4);
  return buf;
}

export function isSslRequest(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  return buf.readInt32BE(0) === 8 && buf.readInt32BE(4) === 80877103;
}

export type StartupFields = {
  user?: string;
  database?: string;
  [key: string]: string | undefined;
};

/** Decode a StartupMessage. Returns null until the full frame has arrived. */
export function tryReadStartup(buf: Buffer): StartupFields | null {
  if (buf.length < 8) return null;
  const length = buf.readInt32BE(0);
  if (length < 8 || buf.length < length) return null;
  const protocol = buf.readInt32BE(4);
  // 3.0 or CancelRequest (which we don't treat as startup)
  if (protocol !== 196608) return null;
  const fields: StartupFields = {};
  let offset = 8;
  while (offset < length) {
    if (buf[offset] === 0) break;
    const keyEnd = buf.indexOf(0, offset);
    if (keyEnd < 0 || keyEnd >= length) return null;
    const valueEnd = buf.indexOf(0, keyEnd + 1);
    if (valueEnd < 0 || valueEnd >= length) return null;
    const key = buf.toString("utf8", offset, keyEnd);
    const value = buf.toString("utf8", keyEnd + 1, valueEnd);
    fields[key] = value;
    offset = valueEnd + 1;
  }
  return fields;
}

export type PgError = {
  severity: string;
  code: string;
  message: string;
};

/** Pull the first ErrorResponse out of a buffer. Returns null if it isn't one. */
export function tryReadError(buf: Buffer): PgError | null {
  if (buf.length < 6 || buf[0] !== 0x45) return null;
  const length = buf.readInt32BE(1);
  if (buf.length < 1 + length) return null;
  const fields: Record<string, string> = {};
  let offset = 5;
  const end = 1 + length;
  while (offset < end) {
    const code = buf[offset];
    if (code === 0) break;
    const valueEnd = buf.indexOf(0, offset + 1);
    if (valueEnd < 0 || valueEnd >= end) break;
    fields[String.fromCharCode(code)] = buf.toString("utf8", offset + 1, valueEnd);
    offset = valueEnd + 1;
  }
  return {
    severity: fields.S ?? fields.V ?? "",
    code: fields.C ?? "",
    message: fields.M ?? "",
  };
}

export function errorResponse(code: string, message: string, severity = "FATAL"): Buffer {
  const body = Buffer.concat([
    cstring("S", severity),
    cstring("V", severity),
    cstring("C", code),
    cstring("M", message),
    Buffer.from([0]),
  ]);
  const header = Buffer.alloc(5);
  header[0] = 0x45;
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

function cstring(tag: string, value: string): Buffer {
  return Buffer.concat([Buffer.from(tag), Buffer.from(value), Buffer.from([0])]);
}
