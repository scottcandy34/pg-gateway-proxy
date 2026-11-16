import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadCertificates, selectCertificate } from "../src/cert.js";
import { loadOrCreate, parseConfig } from "../src/config.js";

describe("config", () => {
  it("parses the shipped default", async () => {
    const text = await readFile(new URL("../config.default.yml", import.meta.url), "utf8");
    const { parse } = await import("yaml");
    const config = parseConfig(parse(text), "/config/config.yml");
    assert.equal(config.bind.port, 5432);
    assert.equal(config.requireSni, true);
    assert.equal(config.blockIpSni, true);
    assert.equal(config.routes.length, 0);
    assert.equal(config.tls.mode, "auto");
    assert.equal(config.health.bind.port, 8081);
  });

  it("writes a default file when the path is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pg-proxy-"));
    const file = path.join(dir, "nested", "config.yml");
    const { created, config } = await loadOrCreate(file);
    assert.equal(created, true);
    assert.equal(config.requireSni, true);
    const again = await loadOrCreate(file);
    assert.equal(again.created, false);
  });

  it("rejects unknown keys and mixed backends", () => {
    assert.throws(() => parseConfig({ bind: "0.0.0.0:5432", nope: true }, "c.yml"), /nope/);
    assert.throws(
      () =>
        parseConfig(
          {
            servers: { db1: "10.0.0.1:5432" },
            routes: [{ host: "db.example.com", backend: ["db1", "10.0.0.2:5432"] }],
          },
          "c.yml",
        ),
      /mix/,
    );
  });

  it("gives each route its own certificate", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pg-proxy-certs-"));
    await writeFile(path.join(dir, "db.pem"), "DB");
    await writeFile(path.join(dir, "db.key"), "DBKEY");
    await writeFile(path.join(dir, "auth.pem"), "AUTH");
    await writeFile(path.join(dir, "auth.key"), "AUTHKEY");
    await writeFile(path.join(dir, "fallback.pem"), "FALLBACK");
    await writeFile(path.join(dir, "fallback.key"), "FALLBACKKEY");
    const config = parseConfig(
      {
        tls: { mode: "files", cert: path.join(dir, "fallback.pem"), key: path.join(dir, "fallback.key") },
        routes: [
          { host: "db.example.com", backend: "10.0.0.1:5432", tls: { cert: path.join(dir, "db.pem"), key: path.join(dir, "db.key") } },
          { host: "*.auth.example.com", backend: "10.0.0.2:5432", tls: { cert: path.join(dir, "auth.pem"), key: path.join(dir, "auth.key") } },
          { host: "plain.example.com", backend: "10.0.0.3:5432" },
        ],
      },
      path.join(dir, "config.yml"),
    );
    const certificates = await loadCertificates(config);
    assert.equal(selectCertificate(certificates, "db.example.com").certPem, "DB");
    assert.equal(selectCertificate(certificates, "one.auth.example.com").certPem, "AUTH");
    assert.equal(selectCertificate(certificates, "plain.example.com").certPem, "FALLBACK");
    assert.throws(
      () => parseConfig({ routes: [{ host: "db.example.com", backend: "10.0.0.1:5432", tls: { cert: "only.pem" } }] }, "c.yml"),
      /cert and key/,
    );
  });
});
