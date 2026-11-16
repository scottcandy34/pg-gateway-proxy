import { connect as netConnect, type Socket } from "node:net";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { connect as tlsConnect } from "node:tls";
import { formatAddress, type Address } from "./address.js";
import { sslRequest } from "./protocol.js";
import type { BackendTls } from "./types.js";

export class BackendConnectError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BackendConnectError";
  }
}

export async function connectBackend(address: Address, tls: BackendTls, timeoutMs: number): Promise<Socket> {
  const socket = await connectTcp(address, timeoutMs);
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30_000);
  if (!tls.enabled) return socket;
  try {
    return await upgradeBackendTls(socket, address, tls, timeoutMs);
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function connectTcp(address: Address, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: address.host, port: address.port });
    const fail = (error: Error) => {
      socket.destroy();
      reject(new BackendConnectError(`connect ${formatAddress(address)} failed: ${error.message}`, { cause: error }));
    };
    const timer = setTimeout(() => fail(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    socket.once("error", fail);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", fail);
      resolve(socket);
    });
  });
}

async function upgradeBackendTls(socket: Socket, address: Address, tls: BackendTls, timeoutMs: number): Promise<Socket> {
  socket.write(sslRequest());
  const answer = await readByte(socket, timeoutMs, address);
  if (answer === 0x4e) {
    throw new BackendConnectError(`${formatAddress(address)} refused SSL (answered N). Set this route's backendTls: false, or enable SSL on the backend.`);
  }
  if (answer !== 0x53) {
    throw new BackendConnectError(`${formatAddress(address)} sent ${answer} instead of accepting SSL`);
  }
  const [ca, cert, key] = await Promise.all([
    tls.ca ? readFile(tls.ca) : undefined,
    tls.cert ? readFile(tls.cert) : undefined,
    tls.key ? readFile(tls.key) : undefined,
  ]);
  const secure = tlsConnect({
    socket,
    servername: tls.servername ?? (isIp(address.host) ? undefined : address.host),
    rejectUnauthorized: tls.rejectUnauthorized,
    ca,
    cert,
    key,
  });
  try {
    await withTimeout(once(secure, "secureConnect"), timeoutMs, `TLS handshake to ${formatAddress(address)}`);
  } catch (error) {
    secure.destroy();
    throw error instanceof BackendConnectError
      ? error
      : new BackendConnectError(`TLS to ${formatAddress(address)} failed: ${error instanceof Error ? error.message : error}`, { cause: error });
  }
  return secure;
}

function readByte(socket: Socket, timeoutMs: number, address: Address): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new BackendConnectError(`${formatAddress(address)} did not answer SSLRequest within ${timeoutMs}ms`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      if (chunk.length === 0) return;
      cleanup();
      if (chunk.length > 1) socket.unshift(chunk.subarray(1));
      resolve(chunk[0]);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(new BackendConnectError(`${formatAddress(address)} failed during SSLRequest: ${error.message}`, { cause: error }));
    };
    const onClose = () => {
      cleanup();
      reject(new BackendConnectError(`${formatAddress(address)} closed during SSLRequest`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function withTimeout(promise: Promise<unknown>, timeoutMs: number, label: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new BackendConnectError(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isIp(host: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(":");
}

