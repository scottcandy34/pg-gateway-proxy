import { access, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { looksLikeAddress, parseAddress } from "./address.js";
import { parseDuration } from "./duration.js";
import { strategyOf } from "./router.js";
import type { BackendTls, Config, Route, ServerDef, TlsFile } from "./types.js";

const DEFAULT_NAME = "config.default.yml";

export function defaultConfigFile(): string {
  return fileURLToPath(new URL(`../${DEFAULT_NAME}`, import.meta.url));
}

export async function loadOrCreate(configPath: string): Promise<{ config: Config; created: boolean }> {
  try {
    await access(configPath);
  } catch {
    await mkdir(path.dirname(configPath), { recursive: true });
    await copyFile(defaultConfigFile(), configPath);
    return { config: await loadConfig(configPath), created: true };
  }
  return { config: await loadConfig(configPath), created: false };
}

export async function loadConfig(configPath: string): Promise<Config> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(configPath, "utf8");
  const raw = parseYaml(text);
  const config = parseConfig(raw, configPath);
  applyEnv(config);
  return config;
}

export function parseConfig(raw: unknown, configPath: string): Config {
  const doc = object(raw, "config");
  assertKeys(doc, [
    "bind",
    "log",
    "limits",
    "timeouts",
    "requireTls",
    "requireSni",
    "blockIpSni",
    "unmatched",
    "plaintext",
    "tls",
    "servers",
    "routes",
    "health",
  ], "config");

  const bind = parseAddress(typeof doc.bind === "string" ? doc.bind : "0.0.0.0:5432", "bind");
  const logDoc = object(doc.log ?? {}, "log");
  assertKeys(logDoc, ["level", "format", "exposeBackendErrors"], "log");
  const level = (logDoc.level as string | undefined) ?? "info";
  if (level !== "debug" && level !== "info" && level !== "warn" && level !== "error") {
    throw new Error(`log.level must be debug, info, warn, or error`);
  }
  const format = (logDoc.format as string | undefined) ?? "text";
  if (format !== "text" && format !== "json") throw new Error(`log.format must be text or json`);

  const limits = object(doc.limits ?? {}, "limits");
  assertKeys(limits, ["maxConnections"], "limits");
  const maxConnections = number(limits.maxConnections ?? 2000, "limits.maxConnections");
  if (maxConnections < 1) throw new Error("limits.maxConnections must be at least 1");

  const timeouts = object(doc.timeouts ?? {}, "timeouts");
  assertKeys(timeouts, ["connect", "idle", "handshake"], "timeouts");

  const requireTls = bool(doc.requireTls ?? true, "requireTls");
  const requireSni = bool(doc.requireSni ?? true, "requireSni");
  const blockIpSni = bool(doc.blockIpSni ?? true, "blockIpSni");
  const unmatched = parseUnmatched(doc.unmatched ?? "reject");

  const plaintextDoc = object(doc.plaintext ?? {}, "plaintext");
  assertKeys(plaintextDoc, ["enabled", "backend"], "plaintext");
  const plaintextEnabled = bool(plaintextDoc.enabled ?? false, "plaintext.enabled");
  const plaintextBackend = typeof plaintextDoc.backend === "string" ? plaintextDoc.backend : undefined;
  if (plaintextEnabled) {
    if (!plaintextBackend) throw new Error("plaintext.backend is required when plaintext.enabled is true");
    parseAddress(plaintextBackend, "plaintext.backend");
  }

  const servers = parseServers(doc.servers ?? {});
  const routes = parseRoutes(doc.routes ?? [], servers);

  if (!requireTls && !plaintextEnabled) {
    throw new Error("requireTls is false but plaintext.enabled is false, so nothing could connect. Set requireTls: true, or enable plaintext.");
  }

  return {
    configPath,
    bind,
    log: {
      level,
      format,
      exposeBackendErrors: bool(logDoc.exposeBackendErrors ?? true, "log.exposeBackendErrors"),
    },
    limits: { maxConnections },
    timeouts: {
      connectMs: parseDuration(timeouts.connect ?? "5s", "timeouts.connect"),
      idleMs: parseDuration(timeouts.idle ?? "0s", "timeouts.idle"),
      handshakeMs: parseDuration(timeouts.handshake ?? "10s", "timeouts.handshake"),
    },
    requireTls,
    requireSni,
    blockIpSni,
    unmatched,
    plaintext: { enabled: plaintextEnabled, backend: plaintextBackend },
    tls: parseTls(doc.tls ?? {}),
    servers,
    routes,
    health: parseHealth(doc.health ?? {}),
  };
}

function applyEnv(config: Config): void {
  const level = process.env.LOG_LEVEL;
  if (level === "debug" || level === "info" || level === "warn" || level === "error") {
    config.log.level = level;
  } else if (level) {
    throw new Error(`LOG_LEVEL must be debug, info, warn, or error (got ${JSON.stringify(level)})`);
  }
  if (process.env.BIND) config.bind = parseAddress(process.env.BIND, "BIND");
}

function parseUnmatched(value: unknown): "reject" | string {
  if (value === "reject" || value === false || value === null || value === undefined) return "reject";
  if (typeof value !== "string" || !value.trim()) throw new Error(`unmatched must be "reject", a server name, or host:port`);
  return value.trim();
}

function parseServers(raw: unknown): ServerDef[] {
  const doc = object(raw, "servers");
  return Object.entries(doc).map(([name, value]) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new Error(`servers.${name} is not a valid name (letters, numbers, '.', '_', '-')`);
    }
    if (typeof value === "string") {
      return {
        name,
        addresses: [parseAddress(value, `servers.${name}`)],
        strategy: "first" as const,
        tls: disabledTls(),
      };
    }
    const body = object(value, `servers.${name}`);
    assertKeys(body, ["addresses", "address", "strategy", "tls"], `servers.${name}`);
    const list = body.addresses ?? body.address;
    const addresses = (Array.isArray(list) ? list : [list]).map((entry, index) => {
      if (typeof entry !== "string") throw new Error(`servers.${name}.addresses[${index}] must be host:port`);
      return parseAddress(entry, `servers.${name}.addresses[${index}]`);
    });
    if (addresses.length === 0 || addresses.some((address) => !address)) {
      throw new Error(`servers.${name} needs at least one address`);
    }
    return {
      name,
      addresses,
      strategy: typeof body.strategy === "string" ? strategyOf(body.strategy, `servers.${name}`) : "first",
      tls: parseBackendTls(body.tls ?? false, `servers.${name}.tls`),
    };
  });
}

function parseRoutes(raw: unknown, servers: ServerDef[]): Route[] {
  if (!Array.isArray(raw)) throw new Error("routes must be a list");
  const serverNames = new Set(servers.map((server) => server.name));
  return raw.map((entry, index) => {
    const path = `routes[${index}]`;
    const doc = object(entry, path);
    assertKeys(doc, ["name", "host", "backend", "strategy", "tls", "backendTls", "connectTimeout"], path);
    const hosts = asList(doc.host, `${path}.host`);
    if (hosts.length === 0) throw new Error(`${path}.host is required`);
    const backends = asList(doc.backend, `${path}.backend`);
    if (backends.length === 0) throw new Error(`${path}.backend is required`);
    const named = backends.every((backend) => !looksLikeAddress(backend));
    const addressed = backends.every((backend) => looksLikeAddress(backend));
    if (!named && !addressed) {
      throw new Error(`${path}.backend cannot mix server names and addresses`);
    }
    if (named) {
      for (const backend of backends) {
        if (!serverNames.has(backend)) throw new Error(`${path}.backend names unknown server ${JSON.stringify(backend)}`);
      }
    }
    const name = typeof doc.name === "string" && doc.name.trim() ? doc.name.trim() : `route-${index + 1}`;
    let strategy = typeof doc.strategy === "string" ? strategyOf(doc.strategy, path) : undefined;
    if (!strategy && named && backends.length === 1) {
      strategy = servers.find((server) => server.name === backends[0])?.strategy;
    }
    const certificate = parseRouteCertificate(doc.tls, `${path}.tls`);
    const backendTls: Route["backendTls"] = doc.backendTls === undefined ? "inherit" : parseBackendTls(doc.backendTls, `${path}.backendTls`);
    return {
      name,
      hosts,
      backends,
      serverNames: named ? backends : [],
      strategy: strategy ?? "first",
      backendTls,
      connectTimeoutMs: doc.connectTimeout === undefined ? undefined : parseDuration(doc.connectTimeout, `${path}.connectTimeout`),
      cert: certificate.cert,
      key: certificate.key,
    };
  });
}

function parseRouteCertificate(raw: unknown, path: string): { cert?: string; key?: string } {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${path} is the certificate clients see, same as ldap-gateway-proxy. Set cert and key. Use backendTls for the hop to Postgres`);
  }
  const doc = raw as Record<string, unknown>;
  assertKeys(doc, ["cert", "key"], path);
  const cert = optionalString(doc.cert, `${path}.cert`);
  const key = optionalString(doc.key, `${path}.key`);
  if ((cert && !key) || (!cert && key)) throw new Error(`${path} cert and key must be set together`);
  return { cert, key };
}

function parseBackendTls(raw: unknown, path: string): BackendTls {
  if (raw === true) return { ...disabledTls(), enabled: true };
  if (raw === false || raw === undefined || raw === null) return disabledTls();
  const doc = object(raw, path);
  assertKeys(doc, ["enabled", "rejectUnauthorized", "servername", "ca", "cert", "key"], path);
  const enabled = bool(doc.enabled ?? true, `${path}.enabled`);
  if ((doc.cert && !doc.key) || (!doc.cert && doc.key)) {
    throw new Error(`${path} cert and key must be set together`);
  }
  return {
    enabled,
    rejectUnauthorized: bool(doc.rejectUnauthorized ?? true, `${path}.rejectUnauthorized`),
    servername: optionalString(doc.servername, `${path}.servername`),
    ca: optionalString(doc.ca, `${path}.ca`),
    cert: optionalString(doc.cert, `${path}.cert`),
    key: optionalString(doc.key, `${path}.key`),
  };
}

function parseTls(raw: unknown): Config["tls"] {
  const doc = object(raw, "tls");
  assertKeys(doc, ["mode", "key", "cert", "ca", "passphrase", "requestCert", "rejectUnauthorized", "allowedCns", "certificates"], "tls");
  const mode = (doc.mode as string | undefined) ?? "auto";
  if (mode !== "auto" && mode !== "files") throw new Error(`tls.mode must be auto or files`);
  const files: TlsFile[] = [];
  if (typeof doc.key === "string" || typeof doc.cert === "string" || mode === "files") {
    if (mode === "files" && (typeof doc.key !== "string" || typeof doc.cert !== "string")) {
      throw new Error("tls.mode files requires tls.key and tls.cert");
    }
    if (typeof doc.key === "string" || typeof doc.cert === "string") {
      if (typeof doc.key !== "string" || typeof doc.cert !== "string") {
        throw new Error("tls.key and tls.cert must be set together");
      }
      files.push({
        keyPath: doc.key,
        certPath: doc.cert,
        caPath: optionalString(doc.ca, "tls.ca"),
        passphrase: optionalString(doc.passphrase, "tls.passphrase"),
      });
    }
  }
  const extra = doc.certificates ?? [];
  if (!Array.isArray(extra)) throw new Error("tls.certificates must be a list");
  extra.forEach((entry, index) => {
    const path = `tls.certificates[${index}]`;
    const body = object(entry, path);
    assertKeys(body, ["serverName", "key", "cert", "ca", "passphrase"], path);
    if (typeof body.serverName !== "string" || typeof body.key !== "string" || typeof body.cert !== "string") {
      throw new Error(`${path} needs serverName, key, and cert`);
    }
    files.push({
      serverName: body.serverName,
      keyPath: body.key,
      certPath: body.cert,
      caPath: optionalString(body.ca, `${path}.ca`),
      passphrase: optionalString(body.passphrase, `${path}.passphrase`),
    });
  });
  const allowed = doc.allowedCns === undefined ? [] : asList(doc.allowedCns, "tls.allowedCns");
  return {
    mode,
    files,
    clientCert: {
      request: bool(doc.requestCert ?? false, "tls.requestCert"),
      rejectUnauthorized: bool(doc.rejectUnauthorized ?? true, "tls.rejectUnauthorized"),
      allowedCns: allowed,
      caPath: optionalString(doc.ca, "tls.ca"),
    },
  };
}

function parseHealth(raw: unknown): Config["health"] {
  const doc = object(raw, "health");
  assertKeys(doc, ["enabled", "bind"], "health");
  return {
    enabled: bool(doc.enabled ?? true, "health.enabled"),
    bind: parseAddress(typeof doc.bind === "string" ? doc.bind : "127.0.0.1:8081", "health.bind"),
  };
}

function disabledTls(): BackendTls {
  return { enabled: false, rejectUnauthorized: true };
}

function asList(value: unknown, path: string): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (typeof entry !== "string" || !entry.trim()) throw new Error(`${path}[${index}] must be a string`);
      return entry.trim();
    });
  }
  throw new Error(`${path} must be a string or a list of strings`);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(doc: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(doc)) {
    if (!allowed.includes(key)) throw new Error(`${path}.${key} is not a known setting`);
  }
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be true or false`);
  return value;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a number`);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a string`);
  return value;
}
