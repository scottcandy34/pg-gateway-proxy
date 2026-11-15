import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseConfig } from "../src/config.js";
import { Router, substitute } from "../src/router.js";

function routerFor(yaml: Record<string, unknown>): Router {
  return new Router(parseConfig({ bind: "127.0.0.1:0", health: { enabled: false }, ...yaml }, "/tmp/pg-gateway-proxy.yml"));
}

describe("host routing", () => {
  const router = routerFor({
    servers: {
      primary: "10.0.0.1:5432",
      pool: { addresses: ["10.0.0.2:5432", "10.0.0.3:5432"], strategy: "round-robin" },
    },
    routes: [
      { name: "exact", host: "db1.example.com", backend: "primary" },
      { name: "wild", host: "*.db.example.com", backend: "$1.postgres.internal:5432" },
      { name: "deep", host: "**.apps.example.com", backend: "${sni}:5432" },
      { name: "many", host: ["a.example.com", "b.example.com"], backend: ["10.1.0.1:5432", "10.1.0.2:5432"], strategy: "round-robin" },
    ],
  });

  it("matches exact names case-insensitively and strips a trailing dot", () => {
    const match = router.match("DB1.Example.com.");
    assert.equal(match?.route.name, "exact");
    assert.equal(match?.targets[0].key, "10.0.0.1:5432");
    assert.equal(match?.tls.enabled, false);
  });

  it("captures a single label and substitutes it into the backend", () => {
    const match = router.match("tenant-a.db.example.com");
    assert.equal(match?.route.name, "wild");
    assert.equal(match?.targets[0].key, "tenant-a.postgres.internal:5432");
    assert.equal(router.match("a.b.db.example.com"), null);
  });

  it("lets ** swallow leftover labels", () => {
    const match = router.match("a.b.apps.example.com");
    assert.equal(match?.route.name, "deep");
    assert.equal(match?.targets[0].host, "a.b.apps.example.com");
  });

  it("round-robins a host with several backends", () => {
    const first = router.match("a.example.com");
    const second = router.match("a.example.com");
    assert.ok(first && second);
    assert.deepEqual(router.order(first).map((target) => target.key), ["10.1.0.1:5432", "10.1.0.2:5432"]);
    assert.deepEqual(router.order(second).map((target) => target.key), ["10.1.0.2:5432", "10.1.0.1:5432"]);
  });

  it("treats an IP server name as an IP", () => {
    assert.equal(router.isIp("10.1.1.1"), true);
    assert.equal(router.isIp("[::1]"), true);
    assert.equal(router.isIp("db.example.com"), false);
  });

  it("rejects unknown substitution indexes", () => {
    assert.throws(() => substitute("$2.internal:5432", { sni: "a.example.com", groups: ["a"] }), /\$2/);
  });
});
