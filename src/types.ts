import type { Address } from "./address.js";

export type Strategy = "first" | "round-robin" | "random" | "least-connections";

export type BackendTls = {
  enabled: boolean;
  rejectUnauthorized: boolean;
  /** Sent as the TLS server name. Defaults to the backend host. */
  servername?: string;
  ca?: string;
  cert?: string;
  key?: string;
};

export type ServerDef = {
  name: string;
  addresses: Address[];
  strategy: Strategy;
  tls: BackendTls;
};

export type RouteTls = BackendTls | "inherit";

export type Route = {
  /** Optional label used only in logs. */
  name: string;
  /** Host patterns. First route that matches wins. */
  hosts: string[];
  /**
   * Concrete addresses, or a single server name resolved later.
   * Strings may contain `$1`, `$2`, `${sni}`, `${host}`.
   */
  backends: string[];
  /** Set when every backend entry is a named server rather than an address. */
  serverNames: string[];
  strategy: Strategy;
  tls: RouteTls;
  connectTimeoutMs?: number;
};

export type ClientCert = {
  request: boolean;
  rejectUnauthorized: boolean;
  /** Empty means any client certificate that chains to `ca`. */
  allowedCns: string[];
  caPath?: string;
};

export type TlsFile = {
  serverName?: string;
  keyPath: string;
  certPath: string;
  caPath?: string;
  passphrase?: string;
};

export type Config = {
  configPath: string;
  bind: Address;
  log: {
    level: "debug" | "info" | "warn" | "error";
    format: "text" | "json";
    exposeBackendErrors: boolean;
  };
  limits: {
    maxConnections: number;
  };
  timeouts: {
    connectMs: number;
    idleMs: number;
    handshakeMs: number;
  };
  requireTls: boolean;
  requireSni: boolean;
  blockIpSni: boolean;
  /** `reject`, a server name, or `host:port` (substitution allowed). */
  unmatched: "reject" | string;
  plaintext: {
    enabled: boolean;
    backend?: string;
  };
  tls: {
    mode: "auto" | "files";
    files: TlsFile[];
    clientCert: ClientCert;
  };
  servers: ServerDef[];
  routes: Route[];
  health: {
    enabled: boolean;
    bind: Address;
  };
};

export type LoadedMaterial = {
  key: ArrayBuffer;
  cert: ArrayBuffer;
  ca?: ArrayBuffer;
  passphrase?: string;
  /** PEM of the default certificate, for the startup fingerprint log. */
  certPem: string;
};
