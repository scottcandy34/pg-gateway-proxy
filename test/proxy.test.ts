import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect as tlsConnect, createSecureContext, TLSSocket } from "node:tls";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { parseConfig } from "../src/config.js";
import { errorResponse, isSslRequest, sslRequest, tryReadError, tryReadStartup, type PgError } from "../src/protocol.js";
import { startProxy, type Running } from "../src/server.js";

const execFileAsync = promisify(execFile);

describe("proxy", () => {
  it("routes hostnames and refuses IP, missing SNI, plaintext, and unknown hosts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pg-proxy-"));
    const one = await mockBackend();
    const two = await mockBackend();
    const proxy = await boot(dir, {
      routes: [
        { name: "one", host: "one.test", backend: `127.0.0.1:${one.port}` },
        { name: "two", host: "two.test", backend: `127.0.0.1:${two.port}` },
      ],
    });

    try {
      assert.equal((await pgClient(proxy.port, "one.test")).message, `reached:${one.port}`);
      assert.equal((await pgClient(proxy.port, "two.test")).message, `reached:${two.port}`);
      assert.deepEqual(one.users, ["postgres"]);
      assert.deepEqual(two.databases, ["app"]);
      // Node will not put an IP in the SNI extension (RFC 6066), so this is
      // rejected either as an IP name or as a missing server name.
      assert.match((await pgClient(proxy.port, "127.0.0.1")).message, /IP address|SNI is required/);
      assert.match((await pgClient(proxy.port)).message, /SNI/);
      assert.match((await pgClient(proxy.port, "nope.test")).message, /no PostgreSQL route/);
      assert.match((await plaintext(proxy.port)).message, /SSL connection is required/);

      const health = await fetch(`http://127.0.0.1:${proxy.healthPort}/health`);
      assert.equal(health.status, 200);
      const body = (await health.json()) as { ok: boolean; routes: number };
      assert.equal(body.ok, true);
      assert.equal(body.routes, 2);
    } finally {
      await proxy.close();
      await one.close();
      await two.close();
    }
  });

  it("round-robins one hostname across backends", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pg-proxy-"));
    const backends = [await mockBackend(), await mockBackend()];
    const proxy = await boot(dir, {
      routes: [
        {
          host: "pool.test",
          backend: backends.map((backend) => `127.0.0.1:${backend.port}`),
          strategy: "round-robin",
        },
      ],
    });
    try {
      const seen = [];
      for (let n = 0; n < backends.length; n++) seen.push((await pgClient(proxy.port, "pool.test")).message);
      assert.deepEqual(seen.sort(), backends.map((backend) => `reached:${backend.port}`).sort());
    } finally {
      await proxy.close();
      await Promise.all(backends.map((backend) => backend.close()));
    }
  });

  it("sends a Postgres SSLRequest when the route enables backend TLS", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pg-proxy-"));
    const material = await selfSigned(dir);
    const backend = await mockBackend(material);
    const proxy = await boot(dir, {
      routes: [
        {
          host: "secure.test",
          backend: `127.0.0.1:${backend.port}`,
          tls: { enabled: true, rejectUnauthorized: false },
        },
      ],
    });
    try {
      assert.equal((await pgClient(proxy.port, "secure.test")).message, `reached:${backend.port}`);
      assert.equal(backend.sslRequests, 1);
    } finally {
      await proxy.close();
      await backend.close();
    }
  });

  it("drops junk and cancel requests without exiting", async () => {
    const crashes: string[] = [];
    const onCrash = (error: Error) => crashes.push(error.message);
    process.on("uncaughtException", onCrash);
    const dir = await mkdtemp(path.join(tmpdir(), "pg-proxy-"));
    const proxy = await boot(dir, {
      routes: [{ host: "db.test", backend: "127.0.0.1:1" }],
    });
    try {
      await raw(proxy.port, Buffer.from("GET / HTTP/1.0\r\n\r\n"));
      const cancel = Buffer.alloc(16);
      cancel.writeInt32BE(16, 0);
      cancel.writeInt32BE(80877102, 4);
      await raw(proxy.port, cancel);
      await tlsJunk(proxy.port);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const health = await fetch(`http://127.0.0.1:${proxy.healthPort}/health`);
      assert.equal(health.status, 200);
      for (const message of crashes) assert.match(message, /reading 'error'/);
    } finally {
      process.off("uncaughtException", onCrash);
      await proxy.close();
    }
  });
});

async function boot(dir: string, body: Record<string, unknown>): Promise<Running> {
  const config = parseConfig(
    {
      bind: "127.0.0.1:0",
      requireSni: true,
      blockIpSni: true,
      health: { enabled: true, bind: "127.0.0.1:0" },
      tls: { mode: "auto" },
      timeouts: { connect: "2s", handshake: "2s", idle: "0s" },
      ...body,
    },
    path.join(dir, "config.yml"),
  );
  return startProxy(config);
}

async function pgClient(port: number, servername?: string): Promise<PgError> {
  const socket = netConnect({ host: "127.0.0.1", port });
  await once(socket, "connect");
  socket.write(sslRequest());
  const answer = await readFrame(socket);
  if (answer[0] !== 0x53) {
    socket.destroy();
    return mustError(answer);
  }
  const secure = tlsConnect({ socket, servername, rejectUnauthorized: false });
  await once(secure, "secureConnect");
  secure.write(startup({ user: "postgres", database: "app" }));
  const payload = await readFrame(secure);
  secure.destroy();
  return mustError(payload);
}

async function plaintext(port: number): Promise<PgError> {
  const socket = netConnect({ host: "127.0.0.1", port });
  await once(socket, "connect");
  socket.write(startup({ user: "postgres", database: "app" }));
  const payload = await readFrame(socket);
  socket.destroy();
  return mustError(payload);
}

function raw(port: number, payload: Buffer): Promise<void> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve();
    };
    socket.on("error", finish);
    socket.on("connect", () => {
      socket.write(payload);
      socket.once("data", finish);
      socket.once("close", finish);
      setTimeout(finish, 1000);
    });
  });
}

function tlsJunk(port: number): Promise<void> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve();
    };
    socket.on("error", finish);
    socket.on("connect", () => {
      socket.write(sslRequest());
      socket.once("data", () => {
        const secure = tlsConnect({ socket, servername: "db.test", rejectUnauthorized: false });
        secure.on("error", finish);
        secure.on("secureConnect", () => {
          secure.write(Buffer.from("not a postgres message"));
          setTimeout(finish, 200);
        });
      });
    });
  });
}

function mustError(buf: Buffer): PgError {
  const error = tryReadError(buf);
  if (!error) throw new Error(`expected an ErrorResponse, got ${buf.toString("hex")}`);
  return error;
}

function startup(params: Record<string, string>): Buffer {
  const chunks = [Buffer.from([0, 3, 0, 0])];
  for (const [key, value] of Object.entries(params)) chunks.push(Buffer.from(`${key}\0${value}\0`));
  chunks.push(Buffer.from([0]));
  const body = Buffer.concat(chunks);
  const frame = Buffer.alloc(4 + body.length);
  frame.writeInt32BE(frame.length, 0);
  body.copy(frame, 4);
  return frame;
}

function readFrame(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => reject(new Error("timed out waiting for postgres bytes")), 4000);
    const finish = (buf: Buffer) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      resolve(buf);
    };
    const onError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (buf[0] === 0x53 || buf[0] === 0x4e) return finish(buf.subarray(0, 1));
      if (buf[0] === 0x45 && buf.length >= 5) {
        const length = buf.readInt32BE(1);
        if (buf.length >= 1 + length) finish(buf.subarray(0, 1 + length));
      }
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

type Mock = {
  port: number;
  users: string[];
  databases: string[];
  sslRequests: number;
  close: () => Promise<void>;
};

function mockBackend(tls?: { cert: string; key: string }): Promise<Mock> {
  const users: string[] = [];
  const databases: string[] = [];
  const state = { sslRequests: 0 };
  const server = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    if (!tls) {
      consumeStartup(socket, server, users, databases);
      return;
    }
    socket.once("data", (chunk) => {
      if (!isSslRequest(chunk)) {
        socket.destroy();
        return;
      }
      state.sslRequests += 1;
      socket.write("S");
      const secure = new TLSSocket(socket, {
        isServer: true,
        secureContext: createSecureContext({ cert: tls.cert, key: tls.key }),
      });
      secure.on("error", () => secure.destroy());
      consumeStartup(secure, server, users, databases);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("mock failed to bind");
      resolve({
        port: address.port,
        users,
        databases,
        get sslRequests() {
          return state.sslRequests;
        },
        close: () => shut(server),
      });
    });
  });
}

function consumeStartup(stream: Socket, server: Server, users: string[], databases: string[]): void {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    const message = tryReadStartup(Buffer.concat(chunks));
    if (!message) return;
    users.push(message.user ?? "");
    databases.push(message.database ?? "");
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : 0;
    stream.write(errorResponse("28000", `reached:${port}`));
  });
}

async function selfSigned(dir: string): Promise<{ cert: string; key: string }> {
  const key = path.join(dir, "backend.key");
  const cert = path.join(dir, "backend.crt");
  await execFileAsync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "2", "-nodes", "-subj", "/CN=backend",
  ]);
  return { cert: await readFile(cert, "utf8"), key: await readFile(key, "utf8") };
}

function shut(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
