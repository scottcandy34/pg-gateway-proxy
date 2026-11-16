import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { hostMatches } from "./router.js";
import type { Config, LoadedMaterial, TlsFile } from "./types.js";

const execFileAsync = promisify(execFile);

export type CertificateSet = {
  fallback: LoadedMaterial;
  named: Array<{ serverName: string; material: LoadedMaterial }>;
};

export async function loadCertificates(config: Config): Promise<CertificateSet> {
  const dir = path.join(path.dirname(config.configPath), "certs");
  let files = config.tls.files;
  const routeFiles = config.routes.filter((route) => route.cert && route.key);
  if (files.length === 0) {
    if (config.tls.mode === "auto") {
      const keyPath = path.join(dir, "server-key.pem");
      const certPath = path.join(dir, "server-cert.pem");
      await ensureAutoCert(keyPath, certPath, sanList(config));
      files = [{ keyPath, certPath }];
    } else if (routeFiles.length === 0) {
      throw new Error("tls.mode files requires tls.key and tls.cert, or cert and key on each route");
    }
  } else if (config.tls.mode === "auto") {
    const fallback = files.find((file) => !file.serverName);
    if (fallback) await ensureAutoCert(fallback.keyPath, fallback.certPath, sanList(config));
  }

  const named: CertificateSet["named"] = [];
  let fallback: LoadedMaterial | undefined;
  for (const file of files) {
    const material = await readMaterial(file);
    if (file.serverName) named.push({ serverName: file.serverName, material });
    else fallback ??= material;
  }
  const routeNamed: CertificateSet["named"] = [];
  for (const route of routeFiles) {
    const material = await readMaterial({ keyPath: route.key!, certPath: route.cert! });
    for (const host of route.hosts) routeNamed.push({ serverName: host, material });
    fallback ??= material;
  }
  if (!fallback) fallback = named[0]?.material;
  if (!fallback) throw new Error("no TLS certificate is configured");
  return { fallback, named: [...routeNamed, ...named] };
}

export function selectCertificate(set: CertificateSet, serverName: string | undefined): LoadedMaterial {
  if (serverName) {
    const hit = set.named.find((entry) => hostMatches(entry.serverName, serverName));
    if (hit) return hit.material;
  }
  return set.fallback;
}

export function fingerprint(pem: string): string {
  return new X509Certificate(pem).fingerprint256;
}

async function readMaterial(file: TlsFile): Promise<LoadedMaterial> {
  const key = await readFile(file.keyPath);
  const cert = await readFile(file.certPath);
  const ca = file.caPath ? await readFile(file.caPath) : undefined;
  return {
    key: toArrayBuffer(key),
    cert: toArrayBuffer(cert),
    ca: ca ? toArrayBuffer(ca) : undefined,
    passphrase: file.passphrase,
    certPem: cert.toString("utf8"),
  };
}

async function ensureAutoCert(keyPath: string, certPath: string, sans: string[]): Promise<void> {
  try {
    await access(keyPath);
    await access(certPath);
    return;
  } catch {
    // generate below
  }
  await mkdir(path.dirname(keyPath), { recursive: true });
  await mkdir(path.dirname(certPath), { recursive: true });
  const san = sans.map((name) => (name.startsWith("IP:") || name.startsWith("DNS:") ? name : `DNS:${name}`)).join(",");
  try {
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "825",
      "-nodes",
      "-subj",
      "/CN=pg-gateway-proxy",
      "-addext",
      `subjectAltName=${san}`,
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `could not write a TLS certificate (${message}). Install openssl, or set tls.mode: files and provide tls.key and tls.cert.`,
    );
  }
}

function sanList(config: Config): string[] {
  const names = new Set<string>(["localhost", "*.localhost", "IP:127.0.0.1"]);
  for (const route of config.routes) {
    for (const host of route.hosts) {
      const normalized = host.trim().toLowerCase().replace(/\.$/, "");
      if (normalized === "*" || normalized.includes("**")) continue;
      names.add(normalized);
    }
  }
  return [...names];
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
