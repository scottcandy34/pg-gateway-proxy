import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { BackendError, type PostgresConnection, type TlsOptionsCallback } from "pg-gateway";
import { fromNodeSocket } from "pg-gateway/node";
import { formatAddress, parseAddress } from "./address.js";
import { BackendConnectError, connectBackend } from "./backend.js";
import { fingerprint, loadCertificates, selectCertificate } from "./cert.js";
import { createLogger, type Logger } from "./log.js";
import { isSslRequest, errorResponse, classifyInitial } from "./protocol.js";
import { Router, type Match, type Target } from "./router.js";
import type { Config } from "./types.js";

export type Running = {
  port: number;
  healthPort?: number;
  config: Config;
  close: () => Promise<void>;
};

export async function startProxy(config: Config, logger?: Logger): Promise<Running> {
  const log = logger ?? createLogger(config.log.level, config.log.format);
  installStabilityGuard(log);
  const certificates = await loadCertificates(config);
  const caPem = config.tls.clientCert.caPath ? await readFile(config.tls.clientCert.caPath, "utf8") : undefined;
  if (config.tls.clientCert.request && config.tls.clientCert.rejectUnauthorized && !caPem) {
    throw new Error("tls.requestCert with tls.rejectUnauthorized requires tls.ca");
  }

  const router = new Router(config);
  const sockets = new Set<Socket>();
  let connections = 0;
  let closing = false;

  const tls: TlsOptionsCallback = async (serverName) => {
    const material = selectCertificate(certificates, serverName);
    return { key: material.key, cert: material.cert, ca: material.ca, passphrase: material.passphrase };
  };

  async function acceptClient(socket: Socket): Promise<void> {
    let initial: Buffer;
    try {
      initial = await readInitial(socket);
    } catch {
      socket.destroy();
      return;
    }
    const kind = classifyInitial(initial);
    if (kind === "ssl" || kind === "startup") {
      socket.pause();
      socket.unshift(initial);
      await serveTls(socket);
      return;
    }
    if (kind === "cancel") {
      log.debug("ignored cancel request; it is not forwarded");
      socket.end();
      return;
    }
    const message = kind === "gss" ? "GSSAPI encryption is not supported" : "expected a PostgreSQL startup message";
    log.warn("rejected non-postgres client", { kind });
    if (socket.writable) socket.end(errorResponse("08P01", message));
    else socket.destroy();
  }

  async function serveTls(socket: Socket): Promise<void> {
    try {
      const connection = await fromNodeSocket(socket, {
        auth: config.tls.clientCert.request ? { method: "cert" } : { method: "trust" },
        tls,
        async onTlsUpgrade(state) {
          const serverName = state.tlsInfo?.serverName;
          try {
            const denied = sniDenial(config, router, serverName);
            if (denied) {
              await rejectClient(connection, denied.code, denied.message);
              return;
            }
            const certDenied = clientCertDenial(config, state.tlsInfo?.clientCertificate, caPem);
            if (certDenied) {
              await rejectClient(connection, certDenied.code, certDenied.message);
              return;
            }
            const match = router.match(serverName);
            if (!match || match.targets.length === 0) {
              const who = serverName ? `no PostgreSQL route for ${serverName}` : "no PostgreSQL route for this connection";
              await rejectClient(connection, "08001", who);
              return;
            }
            const backend = await dial(router, match, config, log);
            const client = nodeSide(await connection.detach());
            client.on("error", () => client.destroy());
            link(client, backend.socket, log);
            applyIdle(socket, config.timeouts.idleMs);
            applyIdle(backend.socket, config.timeouts.idleMs);
            router.acquire(backend.target);
            let released = false;
            const release = () => {
              if (released) return;
              released = true;
              router.release(backend.target);
            };
            client.once("close", release);
            backend.socket.once("close", release);
            log.info("proxied", {
              sni: serverName ?? "",
              route: match.route.name,
              backend: backend.target.key,
              pattern: match.reason,
            });
          } catch (error) {
            if (connection.detached) return;
            const message = error instanceof Error ? error.message : String(error);
            log.warn("proxy failed", { sni: serverName ?? "", error: message });
            await rejectClient(connection, "08001", config.log.exposeBackendErrors ? message : "backend connection failed");
          }
        },
      });
      void connection;
    } catch (error) {
      log.error("connection setup failed", { error: error instanceof Error ? error.message : String(error) });
      socket.destroy();
    }
  }

  async function servePlain(socket: Socket): Promise<void> {
    const backend = config.plaintext.backend;
    if (!backend) {
      socket.destroy();
      return;
    }
    try {
      const address = parseAddress(backend, "plaintext.backend");
      const remote = await connectBackend(address, { enabled: false, rejectUnauthorized: true }, config.timeouts.connectMs);
      socket.resume();
      link(socket, remote, log);
      applyIdle(socket, config.timeouts.idleMs);
      log.info("proxied plaintext", { backend: formatAddress(address) });
    } catch (error) {
      log.warn("plaintext proxy failed", { error: error instanceof Error ? error.message : String(error) });
      socket.destroy();
    }
  }

  const server = createServer((socket) => {
    if (closing || connections >= config.limits.maxConnections) {
      if (!closing) log.warn("rejecting connection, limit reached", { limit: config.limits.maxConnections });
      socket.destroy();
      return;
    }
    connections += 1;
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    socket.setTimeout(config.timeouts.handshakeMs);
    socket.on("timeout", () => socket.destroy());
    socket.on("error", (error) => log.debug("client socket error", { error: error.message }));
    socket.once("close", () => {
      connections -= 1;
      sockets.delete(socket);
    });

    if (!config.plaintext.enabled) {
      void acceptClient(socket);
      return;
    }
    peekFirstBytes(socket, (ssl) => {
      if (ssl) void serveTls(socket);
      else void servePlain(socket);
    });
  });

  await listen(server, config.bind.host, config.bind.port);
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("proxy failed to bind");

  let health: HttpServer | undefined;
  let healthPort: number | undefined;
  if (config.health.enabled) {
    health = createHttpServer((request, response) => {
      if (request.url !== "/health" && request.url !== "/") {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, connections, routes: config.routes.length, requireSni: config.requireSni }));
    });
    await listen(health, config.health.bind.host, config.health.bind.port);
    const healthBound = health.address();
    healthPort = healthBound && typeof healthBound !== "string" ? healthBound.port : undefined;
  }

  log.info("listening", {
    bind: `${config.bind.host}:${bound.port}`,
    routes: config.routes.length,
    requireSni: config.requireSni,
    blockIpSni: config.blockIpSni,
    cert: fingerprint(certificates.fallback.certPem),
    health: healthPort ? `${config.health.bind.host}:${healthPort}` : "off",
  });
  if (config.routes.length === 0 && config.unmatched === "reject") {
    log.warn("no routes configured; every hostname will be rejected until you edit the config");
  }
  for (const route of config.routes) {
    log.info("route", { name: route.name, host: route.hosts.join(","), backend: route.backends.join(",") });
  }

  return {
    port: bound.port,
    healthPort,
    config,
    close: async () => {
      closing = true;
      await Promise.all([closeServer(server), health ? closeServer(health) : Promise.resolve()]);
      for (const socket of sockets) socket.destroy();
    },
  };
}

function readInitial(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const fail = () => {
      cleanup();
      reject(new Error("client closed before a startup message"));
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (classifyInitial(buf) === "short") return;
      cleanup();
      resolve(buf);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", fail);
      socket.off("close", fail);
    };
    socket.on("data", onData);
    socket.once("error", fail);
    socket.once("close", fail);
  });
}

function peekFirstBytes(socket: Socket, done: (ssl: boolean) => void): void {
  const chunks: Buffer[] = [];
  const onData = (chunk: Buffer) => {
    chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    if (buf.length < 8) return;
    socket.off("data", onData);
    socket.pause();
    socket.unshift(buf);
    done(isSslRequest(buf));
  };
  socket.on("data", onData);
}

async function dial(router: Router, match: Match, config: Config, log: Logger): Promise<{ socket: Socket; target: Target }> {
  const timeout = match.route.connectTimeoutMs ?? config.timeouts.connectMs;
  let last: Error | undefined;
  for (const target of router.order(match)) {
    try {
      const socket = await connectBackend(target, match.tls, timeout);
      return { socket, target };
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error));
      log.warn("backend attempt failed", { backend: target.key, error: last.message });
    }
  }
  throw last ?? new BackendConnectError("no backends configured");
}

function link(client: Duplex, backend: Duplex, log: Logger): void {
  const fail = (error?: Error) => {
    if (error) log.debug("pipe closed", { error: error.message });
    client.destroy();
    backend.destroy();
  };
  client.pipe(backend);
  backend.pipe(client);
  client.on("error", fail);
  backend.on("error", fail);
  client.on("close", () => backend.destroy());
  backend.on("close", () => client.destroy());
}

function applyIdle(socket: { setTimeout(ms: number): void }, idleMs: number): void {
  socket.setTimeout(idleMs);
}

function nodeSide(stream: Awaited<ReturnType<PostgresConnection["detach"]>>): Duplex {
  return Duplex.fromWeb(stream as unknown as Parameters<typeof Duplex.fromWeb>[0]);
}

function sniDenial(config: Config, router: Router, serverName: string | undefined): { code: string; message: string } | undefined {
  const host = router.normalize(serverName);
  if (!host) {
    if (config.requireSni) {
      return { code: "08000", message: "server name indication (SNI) is required; connect with a hostname, not a raw IP" };
    }
    return;
  }
  if (config.blockIpSni && router.isIp(host)) {
    return { code: "08000", message: "connections by IP address are not accepted" };
  }
  return;
}

function clientCertDenial(
  config: Config,
  raw: Uint8Array | undefined,
  caPem: string | undefined,
): { code: string; message: string } | undefined {
  const rule = config.tls.clientCert;
  if (!rule.request) return;
  if (!raw || raw.byteLength === 0) return { code: "28000", message: "client certificate required" };
  const cert = new X509Certificate(Buffer.from(raw));
  if (rule.rejectUnauthorized) {
    if (!caPem) return { code: "28000", message: "client certificate cannot be verified" };
    const ca = new X509Certificate(caPem);
    if (!cert.checkIssued(ca) || !cert.verify(ca.publicKey)) {
      return { code: "28000", message: "client certificate is not trusted" };
    }
  }
  if (rule.allowedCns.length > 0 && !rule.allowedCns.includes(subjectCn(cert.subject))) {
    return { code: "28000", message: "client certificate is not allowed" };
  }
  return;
}

async function rejectClient(connection: PostgresConnection, code: string, message: string): Promise<void> {
  if (connection.detached) return;
  const node = nodeSide(await connection.detach());
  node.on("error", () => node.destroy());
  node.end(Buffer.from(new BackendError({ severity: "FATAL", code, message }).flush()));
}

function subjectCn(subject: string): string {
  const match = /(?:^|[\n,])\s*CN=([^,\n]+)/.exec(subject);
  return match?.[1]?.trim() ?? "";
}

function installStabilityGuard(log: Logger): void {
  const marker = Symbol.for("pg-gateway-proxy.stability-guard");
  const proc = process as NodeJS.Process & { [key: symbol]: boolean };
  if (proc[marker]) return;
  proc[marker] = true;
  process.on("uncaughtException", (error) => {
    if (isStreamCloseBug(error)) {
      log.debug("ignored a Node stream close error after a client disconnected", { error: error.message });
      return;
    }
    log.error("fatal", { error: error.stack ?? error.message });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    if (isStreamCloseBug(error) || error.message === "Unexpected initial message") {
      log.warn("client connection failed", { error: error.message });
      return;
    }
    log.error("unhandled rejection", { error: error.stack ?? error.message });
  });
}

function isStreamCloseBug(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  if (!error.message.includes("reading 'error'")) return false;
  const stack = error.stack ?? "";
  return stack.includes("webstreams/adapters") || stack.includes("AbortError");
}

function listen(server: Server | HttpServer, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server | HttpServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
