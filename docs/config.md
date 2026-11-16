# Configuration reference

The proxy reads one YAML file. Docker uses `/config/config.yml`. A missing file is created from [config.default.yml](../config.default.yml) on startup, in the directory you mounted.

Environment overrides, applied after the file:

| Variable | Effect |
|---|---|
| `CONFIG_PATH` | Path to the YAML file. Default `config.yml` in the working directory, `/config/config.yml` in the image. |
| `LOG_LEVEL` | `debug`, `info`, `warn`, or `error`. Overrides `log.level`. |
| `BIND` | `host:port`. Overrides `bind`. |

Unknown keys are an error. The process exits instead of starting with a typo.

## What a connection looks like

1. The client sends a Postgres `SSLRequest` (8 bytes). This is not a TLS ClientHello, which is why a plain SNI proxy drops it.
2. The proxy answers `S` and finishes a TLS handshake. The hostname is the SNI value from that handshake.
3. The proxy picks a route, opens the backend, then gets out of the way. User, database, and password travel through untouched. The backend authenticates the client.

Routing is by hostname only. Two databases on the same Postgres still share a route. Put them on different hostnames if they live on different servers.

## `bind`

Address the proxy listens on. Default `0.0.0.0:5432`.

```yaml
bind: 0.0.0.0:5432
```

IPv6 is `[::]:5432`.

## `log`

```yaml
log:
  level: info          # debug | info | warn | error
  format: text         # text | json
  exposeBackendErrors: true
```

`exposeBackendErrors: false` still logs the real failure, but the client only sees `backend connection failed`.

## `limits`

```yaml
limits:
  maxConnections: 2000
```

Past the cap the proxy drops the TCP connection. It does not send a Postgres error, because the client may still be on the SSLRequest step.

## `timeouts`

Durations are `500ms`, `5s`, `1m`, `1h`, or a bare number of milliseconds. `0` / `0s` disables.

```yaml
timeouts:
  connect: 5s       # one backend attempt
  idle: 0s          # silence on an established proxy session
  handshake: 10s    # client SSLRequest + TLS
```

A route can override `connect` with `connectTimeout`.

## `requireTls`

Default `true`. Clients that send a startup message without SSL get `08P01` / `SSL connection is required`.

Set `false` only together with `plaintext.enabled`. Without TLS there is no SNI, so hostname routing is impossible.

## `requireSni`

Default `true`. A TLS client that does not send a server name gets:

`08000` / `server name indication (SNI) is required; connect with a hostname, not a raw IP`

`psql` sends SNI when `host` is a name. `hostaddr` may be an IP; `host` must still be the name:

```text
psql "host=db1.example.com hostaddr=203.0.113.10 port=5432 user=postgres dbname=app sslmode=require"
```

## `blockIpSni`

Default `true`. Some drivers put the IP in the SNI field. Those connections are rejected with `connections by IP address are not accepted`, even if a route's host is that IP.

Set `false` only if you intentionally route on an IP literal.

## `unmatched`

What to do when no route matches.

| Value | Behavior |
|---|---|
| `reject` | Default. Client gets `no PostgreSQL route for <host>`. |
| a server name | Forward to that entry under `servers`. |
| `host:port` | Forward to that address. `$1` / `${sni}` work; the capture is the whole hostname. |

An inline `unmatched` address is plaintext to the backend. Use a named server when that hop must be TLS.

## `plaintext`

```yaml
plaintext:
  enabled: false
  backend: 127.0.0.1:5432
```

When `enabled` is true and `requireTls` is false, a client that never sends `SSLRequest` is piped to this single backend. TLS clients still use the routes. Leave it off unless you have a client that cannot do SSL.

## `tls`

The certificate clients see. The proxy terminates TLS. It is not a passthrough of the backend certificate.

```yaml
tls:
  mode: auto                 # auto | files
  key: /config/certs/server-key.pem
  cert: /config/certs/server-cert.pem
  ca: /config/certs/ca.pem
  passphrase: ""
  requestCert: false
  rejectUnauthorized: true
  allowedCns: []
  certificates:
    - serverName: "*.db.example.com"
      key: /config/certs/wildcard.key
      cert: /config/certs/wildcard.crt
```

`mode: auto` (the default) writes a self-signed certificate the first time the key and cert files are missing. Files already there are kept, so restarts do not rotate the cert. SANs include `localhost`, `*.localhost`, and every exact or single-wildcard route host. That certificate is the fallback for a route that does not set its own.

`mode: files` uses `key` and `cert` when they are set. It does not generate anything. If they are omitted, every route you want to serve needs its own `cert` and `key`.

Put the certificate clients see on the route. A name is matched against the route's `host` patterns, and that route's files are presented. Route files win over this global block.

```yaml
routes:
  - host: db.example.com
    backend: "10.0.0.10:5432"
    tls:
      cert: /certs/db.example.com/fullchain.pem
      key: /certs/db.example.com/privkey.pem
```

[npm-cert-share](https://github.com/scottcandy34/npm-cert-share) writes those files from Nginx Proxy Manager. Mount its output at `/certs`. A wildcard name is the folder `_.example.com`. The process reads the files at startup, so recreate the container after a renewal.

`certificates` is an older global SNI list. A route's `tls.cert` and `tls.key` are checked first. A name that matches neither falls back to the global `key` / `cert`. Patterns are the same as route hosts (`*`, `*.example.com`).

`cert` and `key` inside `backendTls` are not the certificate clients see. Those are an optional client certificate offered to Postgres.

Client certificates are optional and checked before the connection is handed to the backend:

- `requestCert: true` asks for a cert during the handshake. `tls.ca` is required when `rejectUnauthorized` is true.
- `rejectUnauthorized: true` requires the client cert to be signed by `ca`.
- `allowedCns` limits the certificate CN. Empty means any trusted cert.

This is not Postgres password auth. The backend still sees the client's user and password.

## `servers`

Named backends, so several hosts can share a pool.

```yaml
servers:
  db1: 10.0.1.10:5432
  analytics:
    addresses:
      - 10.0.2.10:5432
      - 10.0.2.11:5432
    strategy: round-robin
    tls: false
```

A string is shorthand for one plaintext address and strategy `first`.

`tls` on a server is the default `backendTls` for routes that point at it and do not set their own.

## `routes`

Matched from top to bottom. First hit wins.

```yaml
routes:
  - name: db1
    host: db1.example.com
    backend: db1

  - name: tenants
    host: "*.db.example.com"
    backend: "$1.postgres.internal:5432"
    strategy: first
    connectTimeout: 3s
    backendTls: false

  - name: reports
    host:
      - reports.example.com
      - analytics.example.com
    backend:
      - 10.0.2.10:5432
      - 10.0.2.11:5432
    strategy: least-connections
    backendTls:
      enabled: true
      rejectUnauthorized: true
      servername: analytics.internal
      ca: /config/certs/backend-ca.pem
      cert: /config/certs/client.crt
      key: /config/certs/client.key
```

### `host`

A string or a list.

| Pattern | Matches | Captures |
|---|---|---|
| `db1.example.com` | that name only | none |
| `*.db.example.com` | one label, then `.db.example.com` | `$1` is the label |
| `*.*.example.com` | two labels | `$1`, `$2` |
| `**.apps.example.com` | one or more labels | `$1` is the rest |
| `*` | anything that is not rejected as an IP | `$1` and `${sni}` are the full name |

Names are compared case-insensitively. A trailing dot is ignored.

`a.b.db.example.com` does **not** match `*.db.example.com`. Use `**.db.example.com` or `*.*.db.example.com` for that.

### `backend`

A string or a list. Each entry is either a server name or `host:port`.

Do not mix names and addresses in one list.

Substitution runs on addresses only:

| Token | Value |
|---|---|
| `$1`, `$2`, … | wildcard captures, left to right |
| `$0`, `${sni}`, `${host}` | the full hostname the client sent |

IPv6 addresses are `[::1]:5432`.

### `strategy`

Used when a route has more than one address. The proxy tries the next address if a connect fails.

| Strategy | Order |
|---|---|
| `first` | listed order (default) |
| `round-robin` | rotate the start each new connection, then fail over |
| `random` | shuffle, then fail over |
| `least-connections` | fewest open proxied connections, then fail over |

A route with one named server and no `strategy` of its own uses that server's strategy. Otherwise the default is `first`. Set `strategy` on the route to override it.

### `backendTls`

| Value | Meaning |
|---|---|
| omitted on a route that names one server | use that server's `tls` |
| `false` | plaintext after the proxy. The backend must allow `host` (not only `hostssl`) from the proxy's address |
| `true` | Postgres SSL: send `SSLRequest`, expect `S`, then TLS. Certificate is verified. Server name is the backend host |
| a mapping | same as `true`, with the fields below |

```yaml
backendTls:
  enabled: true
  rejectUnauthorized: true
  servername: db1.internal   # SNI toward the backend, if its cert name differs
  ca: /config/certs/backend-ca.pem
  cert: /config/certs/client.crt   # optional client cert for the backend
  key: /config/certs/client.key
```

`rejectUnauthorized: false` is for a backend with a private cert you have not given the proxy. Do not leave it off on a network you do not trust.

Backend TLS is the Postgres handshake, not a raw TLS ClientHello. Postgres 17 direct SSL (`sslnegotiation=direct`) is not used.

### `connectTimeout`

Per-route override of `timeouts.connect`.

### `name`

Optional. Shows up in logs. Default `route-1`, `route-2`, …

## `health`

```yaml
health:
  enabled: true
  bind: 127.0.0.1:8081
```

`GET /health` returns JSON: `ok`, `connections`, `routes`, `requireSni`.

The image `HEALTHCHECK` calls `http://127.0.0.1:8081/health`. If you move the health port, set `HEALTHCHECK_URL` or override the compose healthcheck. The health port is not published by the sample compose file; it is for the container itself.

## What this config does not do

pg-gateway can also terminate the session and answer queries itself (`onStartup`, `onQuery`, md5, scram, trust-as-the-server). This program does not. Those modes consume the startup message, and the backend would then see a half-finished handshake. Password checks stay on Postgres.

A transparent proxy also cannot rewrite the database name. Use a hostname per server.

## pg_hba on the backend

The backend sees the proxy's source address, not the original client, unless you terminate somewhere else.

Plaintext hop (`backendTls: false`):

```text
host all all 172.16.0.0/12 scram-sha-256
```

TLS hop (`backendTls: true` or a mapping):

```text
hostssl all all 172.16.0.0/12 scram-sha-256
```

The user and password in the client connection string are the backend's user and password.
