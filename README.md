# pg-gateway-proxy

One PostgreSQL port, many hostnames. Clients connect to `db1.example.com:5432` or `db2.example.com:5432`. The proxy looks at the TLS server name and forwards the session to the Postgres you configured for that name.

It is the Postgres version of [Gate Lite](https://gate.minekube.com/guide/lite): a thin route table, first match wins, wildcards, and a single listen address. Direct IP connections are refused unless you turn that off.

A generic SNI proxy (sniproxy, HAProxy `ssl_preread`, nginx stream) is not enough. Postgres sends an `SSLRequest` packet before the TLS ClientHello, so those proxies never see the hostname. This image uses [pg-gateway](https://github.com/supabase-community/pg-gateway) to speak that handshake, then pipes the rest of the session through.

The proxy terminates TLS from the client. It does not check the password. The backend does.

You run the image GitHub Actions publishes to GHCR. You do not need the source on the machine that runs the proxy.

## The GitHub image

[`.github/workflows/docker.yml`](.github/workflows/docker.yml) builds and pushes on every push to `main`, on `v*` tags, and when you run the workflow by hand.

| | |
|---|---|
| Registry | `ghcr.io` |
| Image | `ghcr.io/scottcandy34/pg-gateway-proxy` |
| Platforms | `linux/amd64`, `linux/arm64` |
| Tags | `v0.1.1` (this release), `0.1.1`, the `v0.1` line, and `latest` |

That name comes from the GitHub repo [scottcandy34/pg-gateway-proxy](https://github.com/scottcandy34/pg-gateway-proxy). GHCR wants the owner and repo in lowercase. The workflow lowercases them for you.

The first push creates the package. Two settings have to be true or the build cannot push, and other machines cannot pull:

1. Repo **Settings → Actions → General → Workflow permissions**: read and write. The workflow already asks for `packages: write`.
2. The package page → **Package settings → Change visibility**. Set it to public if you want `docker pull` to work without a token. A private package needs a PAT with `read:packages`:

```bash
docker login ghcr.io -u scottcandy34
```

After that:

```bash
docker pull ghcr.io/scottcandy34/pg-gateway-proxy:v0.1.1
```

`latest` moves when a newer version is published. `v0.1.1` does not. Pin the version.

## Versions

The image version is the `version` in [package.json](package.json). This release is **v0.1.1**. Major stays `0` until a breaking change.

A push to `main` publishes `v<version>` only when that version has not already been published from another commit. The next change has to bump it first, or the Docker build stops:

```bash
npm version patch    # v0.1.0 -> v0.1.1
# or
npm version minor    # v0.1.0 -> v0.2.0
```

Commit the version bump and push `main`. The workflow builds `v0.1.1` (and moves `latest` and `v0.1`). It does not overwrite `v0.1.0`.

When [pg-gateway](https://github.com/supabase-community/pg-gateway) publishes a new npm release, [`.github/workflows/upstream.yml`](.github/workflows/upstream.yml) bumps this project's patch version and publishes that new image the same way.

## Container configuration

The image is `node:22-alpine` plus `tini` and `openssl`. It runs as root so the first start can write the seed config into a mounted volume. `tini` is the entrypoint and forwards stop signals.

| | |
|---|---|
| Listen | `5432/tcp`, mapped to the host. Inside the container the process must bind `0.0.0.0`, not `127.0.0.1`, or the published port never connects. |
| Volume | `/config` (required, writable) |
| Config file | `/config/config.yml` |
| Certs, when `tls.mode` is `auto` | `/config/certs/server-key.pem`, `/config/certs/server-cert.pem` |
| Seed baked into the image | `/app/config.default.yml` |
| Health, inside the container only | `http://127.0.0.1:8081/health` |
| Stop | `SIGTERM`. Open connections are dropped. |
| Restart | `unless-stopped` in the compose file |

Do not publish `8081`. The health check runs inside the container. The image `HEALTHCHECK` calls that URL every 30 seconds.

Environment variables. The file is still the config. These only override it:

| Variable | Default in the image | Effect |
|---|---|---|
| `CONFIG_PATH` | `/config/config.yml` | YAML file to load. The entrypoint creates it from the seed if it is missing. |
| `LOG_LEVEL` | unset (file wins, file default `info`) | `debug`, `info`, `warn`, or `error`. |
| `BIND` | unset (file wins, file default `0.0.0.0:5432`) | `host:port` the process listens on **inside** the container. |
| `HEALTHCHECK_URL` | `http://127.0.0.1:8081/health` | Only the Docker health check. Change it if `health.bind` in the YAML is not `127.0.0.1:8081`. |
| `NODE_ENV` | `production` | Set by the image. Leave it. |

On every start the entrypoint does this:

1. `mkdir` the directory of `CONFIG_PATH`.
2. If that file is not there, copy `/app/config.default.yml` onto it.
3. Exec `node /app/dist/index.js`.

An empty `./config` mount is enough. The container writes `config.yml` and, because the seed uses `tls.mode: auto`, a self-signed cert under `config/certs/`. Those files stay on the volume across restarts and image upgrades. Pulling a new image does not rotate the cert and does not overwrite a config you have edited.

`routes: []` in the seed means the process starts and then rejects every hostname until you edit the file and restart.

## Run the published image

[`docker-compose.yml`](docker-compose.yml) already points at `ghcr.io/scottcandy34/pg-gateway-proxy:v0.1.1`. Then:

```bash
docker compose up -d
```

Compose will pull from GHCR. It does not build. Edit `./config/config.yml` (created on first start) and restart:

```bash
docker compose restart
```

The same thing without compose, using a bind mount so the config is a normal file:

```bash
mkdir -p config
docker run -d \
  --name pg-gateway-proxy \
  --restart unless-stopped \
  -p 5432:5432 \
  -e CONFIG_PATH=/config/config.yml \
  -e LOG_LEVEL=info \
  -v "$PWD/config:/config" \
  ghcr.io/scottcandy34/pg-gateway-proxy:v0.1.1
```

Watch the first start:

```bash
docker logs -f pg-gateway-proxy
```

You want a `listening` line and, until routes exist, a warning that every hostname will be rejected. `docker inspect --format '{{.State.Health.Status}}' pg-gateway-proxy` should become `healthy` once `/health` answers.

A named volume works too if you do not want the file on the host. You then copy the config out, edit it, and copy it back:

```bash
docker volume create pg-gateway-config
docker run -d --name pg-gateway-proxy --restart unless-stopped \
  -p 5432:5432 -v pg-gateway-config:/config \
  ghcr.io/scottcandy34/pg-gateway-proxy:v0.1.1
docker cp pg-gateway-proxy:/config/config.yml ./config.yml
# edit config.yml
docker cp ./config.yml pg-gateway-proxy:/config/config.yml
docker restart pg-gateway-proxy
```

Upgrading is a pull and a recreate. The volume keeps the config and certs:

```bash
docker compose pull
docker compose up -d
```

## Point a client at it

DNS for each name must land on this proxy. Then:

```bash
psql "host=db1.example.com port=5432 user=postgres dbname=app sslmode=require"
```

`sslmode=require` encrypts but does not verify the proxy certificate. The default certificate is self-signed, generated on first start at `config/certs/server-cert.pem`. Use `sslmode=verify-full` only after clients trust that cert (or a real one you configured).

Connecting to the raw IP, or with a driver that omits SNI, is rejected:

```text
server name indication (SNI) is required; connect with a hostname, not a raw IP
```

If the driver can split them, dial the IP and still send the name:

```text
host=db1.example.com hostaddr=<proxy ip> port=5432 sslmode=require
```

## A working route table

```yaml
bind: 0.0.0.0:5432
requireTls: true
requireSni: true
blockIpSni: true
unmatched: reject

servers:
  app: 10.0.1.10:5432
  analytics:
    addresses:
      - 10.0.2.10:5432
      - 10.0.2.11:5432
    strategy: least-connections

routes:
  - host: app.example.com
    backend: app

  - host: "*.db.example.com"          # tenant.db.example.com -> tenant.postgres.internal
    backend: "$1.postgres.internal:5432"

  - host:
      - analytics.example.com
      - reports.example.com
    backend: analytics
    strategy: least-connections

tls:
  mode: auto
```

`bind` stays `0.0.0.0:5432` in a container. Every other key is documented in [docs/config.md](docs/config.md). The seed copied into `/config` on first start is [config.default.yml](config.default.yml).

## Backend Postgres

The backend sees the proxy, not the original client address.

- Route `tls: false` (the default): the hop after the proxy is plaintext. `pg_hba.conf` needs a `host` line for the proxy's network, not only `hostssl`.
- Route `tls: true`: the proxy does a real Postgres SSL handshake to the backend. Use `hostssl`, and give the proxy the backend CA if you want the certificate checked.

```text
host    all all 172.16.0.0/12 scram-sha-256
hostssl all all 172.16.0.0/12 scram-sha-256
```

User and password in the client are the backend's user and password. From another container on the same Docker network, use the backend's compose service name as the host (`postgres:5432`), not `127.0.0.1`. `127.0.0.1` inside this container is the proxy itself.

## When GitHub rebuilds the image

[`.github/workflows/test.yml`](.github/workflows/test.yml) runs the tests and the typecheck on every push and pull request. It does not push an image.

[`.github/workflows/docker.yml`](.github/workflows/docker.yml) publishes `v<package.json version>` on every push to `main`. It refuses the push when that version tag already belongs to another commit.

[`.github/workflows/upstream.yml`](.github/workflows/upstream.yml) runs every six hours and on demand. It compares the pinned `pg-gateway` version and git commit with what npm currently publishes. If either changed it:

1. installs that version,
2. bumps this project's patch version (`v0.1.0` becomes `v0.1.1`),
3. runs the tests,
4. commits the bump and tags it,
5. builds and pushes that new image version in the same job.

The image build is in this workflow on purpose. A commit made with the default `GITHUB_TOKEN` does not start the other Docker workflow.

Run it by hand from the Actions tab (`Upstream pg-gateway`) after Actions is enabled. This tracks the published npm package. Unpublished commits on [supabase-community/pg-gateway](https://github.com/supabase-community/pg-gateway) are ignored until they ship to npm.

## Build the image yourself

Only if you are not using GHCR. From a checkout:

```bash
docker build -t pg-gateway-proxy .
docker run -d --name pg-gateway-proxy --restart unless-stopped \
  -p 5432:5432 -v "$PWD/config:/config" pg-gateway-proxy
```

The container configuration above is the same. The image name is the only thing that changes.

## Develop

Node 22.

```bash
npm ci
npm test
npm run typecheck
npm run dev          # reads ./config.yml, creating it if needed
```

`npm run build` writes `dist/`. The image runs `node dist/index.js`.

## Layout

| Path | Role |
|---|---|
| `Dockerfile` | Image that GitHub Actions publishes. |
| `entrypoint.sh` | Seeds `/config/config.yml`, then starts the proxy. |
| `docker-compose.yml` | Run config for the GHCR image. |
| `.github/workflows/docker.yml` | Build and push `linux/amd64` and `linux/arm64`. |
| `.github/workflows/upstream.yml` | Rebuild when pg-gateway is published. |
| `src/index.ts` | Process entry. Loads config, starts the listener, handles SIGTERM. |
| `src/config.ts` | YAML loader and checks. |
| `src/server.ts` | Postgres listener, SNI rules, pipe to the backend. |
| `src/router.ts` | Host patterns, `$1` substitution, backend order. |
| `src/backend.ts` | TCP connect and optional Postgres SSL to the backend. |
| `src/cert.ts` | Load or generate the certificate clients see. |
| `config.default.yml` | Seed config, commented with the usual routes. |
| `docs/config.md` | Full reference. |

## License

MIT, for this proxy. pg-gateway is MIT, copyright Supabase.
