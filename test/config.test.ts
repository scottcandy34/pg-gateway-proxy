import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
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
});
