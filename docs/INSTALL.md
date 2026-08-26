# Installation Guide

Yarilo installs two ways. Pick the one that matches your target:

| Path | Best for | Topology |
|:---|:---|:---|
| [Docker Compose](#installing-with-docker-compose) | one host: local dev, evaluation, small self-hosted installs | standalone, all roles as containers, SQLite userdb |
| [Kubernetes](#installing-on-kubernetes) | production, HA, multi-node | director ring + co-located backends, MySQL or Postgres userdb |

Both run the same image, `ghcr.io/yarilomail/yarilo`. A container selects its
role via `YARILO_COMPONENT` (Compose) or the Helm chart (Kubernetes).

Clients always connect to login proxies. The proxies terminate TLS and forward
plaintext to the session backends; session processes have no TLS knowledge.

Examples use `mail.example.com` and namespace `yarilo-sb` — substitute your own
values throughout.

## Installing with Docker Compose

A single-host standalone deployment. The backends share a Maildir store and
coordinate through `yarilo-auth`, `yarilo-warden` and `yarilo-locks`
(Redis-backed). The userdb is SQLite — no external database required.

::: warning
Single-host, not highly available. For HA or multi-node, use
[Kubernetes](#installing-on-kubernetes).
:::

This section is the quickstart. MTA integration, operations and the full
service reference are in [Docker Compose](./DOCKER-COMPOSE); the deployment
files live in
[`deploy/compose/`](https://github.com/yarilomail/yarilo/tree/main/deploy/compose).

### Prerequisites

- Docker Engine 24+ with the Compose v2 plugin (`docker compose version`)
- Free host ports: 143/993, 110/995, 587/465, 4190, and — loopback-only by
  default — 24, 12325, 12340. Override in `.env`.
- ~512 MB RAM

### Quickstart

```sh
cd deploy/compose
cp .env.example .env
./gen-certs.sh mail.example.com
docker compose up -d
docker compose ps
```

This sequence:

- Copies the default environment; adjust the image tag or ports in `.env` if needed
- Generates a self-signed TLS certificate for local use
- Starts all containers; `docker compose ps` should report every one as `healthy`

`gen-certs.sh` writes `tls/cert.pem` and `tls/key.pem`. The key is
world-readable so the uid-1000 container can load it.

For a public deployment, drop a real certificate and key (e.g. Let's Encrypt
`fullchain.pem` / `privkey.pem`) into `deploy/compose/tls/` as `cert.pem` /
`key.pem` and restart the login proxies. The `tls/` directory is git-ignored.

### Creating the first user

The SQLite userdb lives in the `state` volume at `/var/lib/yarilo/users.db`.
`yarilo-auth` creates the `yarilo_users` table on first start.

Insert a user with a one-off sqlite container:

```sh
docker run --rm -v yarilo_state:/data nouchka/sqlite3 /data/users.db \
  "INSERT INTO yarilo_users (username,password,home,mail,enabled) VALUES \
   ('user@mail.example.com','{PLAIN}changeit', \
    '/var/mail/vhosts/mail.example.com/user@mail.example.com', \
    'maildir:/var/mail/vhosts/mail.example.com/user@mail.example.com',1);"
```

The `mail` column is the per-user mail location (`maildir:` / `sdbox:` /
`mdbox:`).

::: tip
`{PLAIN}` is fine for local testing only. Use a hashed scheme (`{BCRYPT}…`)
for anything real.
:::

### Sending and reading a test message

Deliver a message via LMTP on the loopback port, as your MTA would:

```sh
printf 'LHLO t\r\nMAIL FROM:<s@ext.test>\r\nRCPT TO:<user@mail.example.com>\r\nDATA\r\nSubject: hi\r\n\r\nhello\r\n.\r\nQUIT\r\n' \
  | nc 127.0.0.1 24
```

Read it back over IMAPS — with the self-signed certificate the verify warning
is expected:

```sh
printf 'a login user@mail.example.com changeit\r\nb select INBOX\r\nc logout\r\n' \
  | openssl s_client -quiet -connect 127.0.0.1:993
```

Or run the bundled smoke test. The entrypoint dispatches on
`YARILO_COMPONENT`, so invoke the binary directly:

```sh
docker compose exec yarilo-imap \
  yarilo-smoketest -host yarilo-imap-login -imap-port 10993 \
  -telemetry http://yarilo-imap-login:8080 -insecure=true
```

### Listening ports

| Service | Host port | Notes |
|:---|:---|:---|
| IMAP / IMAPS | 143 / 993 | login proxy, STARTTLS / implicit TLS |
| POP3 / POP3S | 110 / 995 | login proxy |
| Submission | 587 / 465 | login proxy |
| ManageSieve | 4190 | login proxy |
| LMTP | 24 (loopback) | unauthenticated — for your MTA only |
| SASL auth | 12325 (loopback) | fronting MTA: `smtpd_sasl_type = dovecot` |
| Quota policy | 12340 (loopback) | fronting MTA: `check_policy_service` |

Wiring a fronting Postfix — LMTP delivery, SASL auth, quota policy — is
covered in [Docker Compose](./DOCKER-COMPOSE).

### Operations

To follow logs of any service:

```sh
docker compose logs -f yarilo-imap
```

Set `LOG_LEVEL=debug` in `.env` for verbose output.

To upgrade, bump `YARILO_TAG` in `.env`, then:

```sh
docker compose pull && docker compose up -d
```

To back up, snapshot the `mail` (messages + indexes) and `state` (userdb)
volumes.

To uninstall:

```sh
docker compose down
```

Add `-v` to also delete the `mail`, `state` and `redis` volumes — this
destroys all data.

## Installing on Kubernetes

The production topology: a director ring (StatefulSet) routes each user to a
single co-located backend pod that carries every protocol, fronted by
per-protocol login proxies, with shared `yarilo-auth`, `yarilo-warden`,
`yarilo-locks` (Redis-backed) and `yarilo-quota-status`.

See [Deployment](./DEPLOYMENT) and the diagrams
[yarilo_director.svg](/yarilo_director.svg) /
[yarilo_backend.svg](/yarilo_backend.svg) for the full rationale.

This section uses the sandbox example (`helm_values/values-sandbox.yaml`, a
single-node microk8s namespace `yarilo-sb`). Production notes are called out
inline.

### What you'll end up with

| Component | Kind | Purpose |
|:---|:---|:---|
| `yarilo-director` | StatefulSet | LMTP proxy + consistent-hash ring, owns backend routing |
| `yarilo-backend` | StatefulSet | co-located pod: imap / pop3 / submission / lmtp / managesieve + fts + reg sidecar |
| `yarilo-*-login` | Deployments | TLS-terminating login proxies (imap / pop3 / submission / lmtp / managesieve / sasl) |
| `yarilo-auth` | Deployment | passdb + userdb against the SQL store |
| `yarilo-warden` | Deployment | connection accounting, auth-penalty, cross-node kick bus |
| `yarilo-locks` | Deployment | cross-process write coordination (mTLS `:9104`, Redis-backed) |
| `yarilo-quota-status` | Deployment | RCPT-time quota policy service for a fronting MTA |
| SQL StatefulSet | StatefulSet | passdb / userdb store (sandbox only — use managed SQL in production) |
| `yarilo-tls` Secret | Secret | TLS certificate provisioned by cert-manager |
| LoadBalancer Services | Service | public entry per login proxy (143/993, 110/995, 587/465, 4190, 24) |

### Prerequisites

#### DNS

An A (or AAAA) record for the public hostname pointing at the LoadBalancer IP
your cluster will assign:

```
mail.example.com  A  <LB-IP>
```

::: note
For real mail you also need MX, SPF/TXT, DKIM and PTR records, and the zone
should be served by more than one nameserver — see
[DNS for a mail domain](./DNS). For the sandbox an A record is enough — the
smoke test connects by hostname.
:::

#### cert-manager

```sh
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --version v1.16.x \
  --set installCRDs=true
kubectl -n cert-manager get pods
```

All cert-manager pods should report `Running` before you continue.

#### ClusterIssuer

The repo ships
[`deploy/clusterissuer.yaml`](https://github.com/yarilomail/yarilo/tree/main/deploy)
with two solvers: `http01` (nginx ingress) and `dns01` (Cloudflare, used for
mail since no port 80 is needed).

Edit it — replace `admin@example.com` / `example.com` — then apply:

```sh
kubectl -n cert-manager create secret generic cloudflare-api-token \
  --from-literal=api-token=<CLOUDFLARE-API-TOKEN>
kubectl apply -f deploy/clusterissuer.yaml
kubectl get clusterissuer letsencrypt-prod
```

The ClusterIssuer should report `STATUS: Ready`.

#### LoadBalancer support

The chart provisions `Service` objects of type `LoadBalancer`. Ensure a
controller can fulfil them:

- **microk8s** — `microk8s enable metallb` and assign an IP range
- **k3s** — bundled `klipper-lb` works out of the box
- **EKS / GKE / AKS** — the cloud LB controller handles it automatically

### Setting up the passdb / userdb store

`yarilo-auth` resolves logins from a SQL store. Two sandbox manifests ship:
MySQL is the default wired by `values-sandbox.yaml`; Postgres is an
alternative.

Both put login (passdb) and storage/quota/routing (userdb) in the same store.
The split into `passdb_sql_query` / `userdb_sql_query` / `userdb_sql_iterate_query` lives in
`values-sandbox.yaml`, so migrating to a production layout only changes the
queries.

::: tip Production
Swap the sandbox manifest for a managed SQL DSN: replace the `dsn` key in the
Secret and run the init SQL against the managed instance. The Secret
reference in `values-sandbox.yaml` stays the same.
:::

#### MySQL (default)

`helm_values/mysql-sandbox.yaml` creates namespace `db`, a `mysql` Secret
(DB `yarilo`, user `yarilo` / `sandbox-secret`), an init ConfigMap and a
MySQL 8.4 StatefulSet. The schema is the PostfixAdmin layout: `domain`,
`alias` and `mailbox` tables.

```sh
kubectl apply -f helm_values/mysql-sandbox.yaml
kubectl -n db get pods,svc,pvc
```

The `mailbox` table is what `values-sandbox.yaml` queries — columns are
matched by name, `password` is the only required one, `active` maps to
`enabled`. Its DSN reaches `yarilo-auth` through the `YARILO_DB_DSN` env var,
injected from the `mysql` Secret; `skip_schema: true` keeps `yarilo-auth`
from creating its own table.

Seed a user — `domain` + `mailbox` + `alias` rows:

```sh
kubectl -n db exec -i mysql-0 -- mysql -uyarilo -psandbox-secret yarilo <<'SQL'
INSERT IGNORE INTO domain (domain, transport, customer_id, active)
VALUES ('mail.example.com', 'virtual', 'cust-0001', 1);

INSERT IGNORE INTO mailbox
  (username, password, mbtype, home, mpath, maildir, local_part, domain, active)
VALUES
  ('alice@mail.example.com', '{BCRYPT}REPLACE_WITH_HASH', 'mdbox',
   '/var/mail/vhosts/', 'mail.example.com/alice@mail.example.com', 'mdbox',
   'alice', 'mail.example.com', 1);

INSERT IGNORE INTO alias (address, goto, domain, active)
VALUES ('alice@mail.example.com', 'alice@mail.example.com', 'mail.example.com', 1);
SQL
```

Generate the hash with `htpasswd -nbB alice '<password>' | cut -d: -f2` and
prefix it with `{BCRYPT}`.

#### Postgres (alternative)

`helm_values/postgres-sandbox.yaml` creates a `yarilo-postgres` StatefulSet
(PG 16, user `yarilo` / `sandbox-secret`) with a single `users` table covering
passdb (`username` / `password` / `active`) and userdb (`home` / `mail_path` /
quota / `allow_nets` / `director_tag`).

```sh
kubectl apply -f helm_values/postgres-sandbox.yaml
kubectl -n yarilo-sb get pods,svc,pvc
```

To use Postgres instead of MySQL, point `yarilo-auth` at this store and
switch the passdb block in `values-sandbox.yaml` to `driver: postgres` with
the `users`-table queries. The `postgres-sandbox.yaml` header documents the
columns and the expected `passdb_sql_query` / `userdb_sql_query` / `userdb_sql_iterate_query`.

Seed a user:

```sh
kubectl -n yarilo-sb exec -i yarilo-postgres-0 -- \
  psql -U yarilo -d yarilo -c \
  "INSERT INTO users (username, password, active, display_name)
   VALUES (LOWER('alice@mail.example.com'), '{BCRYPT}REPLACE_WITH_HASH', TRUE, 'Alice');"
```

With `home` / `mail_path` left blank, yarilo derives the path from
`storage.mailHomeTemplate` (`%d/%n` → `<maildirRoot>/<domain>/<local-part>`).
Set `home` to an absolute path to override per user.

### Deploying yarilo

```sh
helm upgrade --install yarilo ./helm \
  -f helm_values/values-sandbox.yaml \
  -n yarilo-sb
```

Listeners brought up, via the login-proxy LoadBalancer Services:

| Listener | Port | TLS mode |
|:---|:---|:---|
| IMAPS / IMAP | 993 / 143 | implicit TLS / STARTTLS |
| Submissions / Submission | 465 / 587 | implicit TLS / STARTTLS |
| POP3S / POP3 | 995 / 110 | implicit TLS / STARTTLS |
| LMTP | 24 | plain (internal — front it with an MTA) |
| Telemetry | 8080 | ClusterIP only — `/healthz`, `/readyz`, `/metrics` |

### Waiting for the certificate

cert-manager creates a `Certificate`, runs the DNS01 challenge, and writes
the result into the `yarilo-tls` Secret mounted by the login proxies. No
restart is needed once it is populated.

```sh
kubectl -n yarilo-sb get certificate yarilo-tls -w
```

Wait for `READY=True`; first issuance typically takes 1–3 minutes. If it
hangs:

```sh
kubectl -n yarilo-sb describe certificate yarilo-tls
```

### Getting the LoadBalancer IP

Each login proxy has its own LoadBalancer Service; the IMAP one is the usual
public entry.

```sh
kubectl -n yarilo-sb get svc yarilo-imap-login -w
dig +short mail.example.com
```

Wait for `EXTERNAL-IP`, then confirm DNS resolves to it.

### Running the smoke test

`app/smoketest-e2e` drives the full flow: Submission AUTH, LMTP delivery,
IMAPS LOGIN + SASL, POP3S. From the repo, against the public host:

```sh
go run ./app/smoketest-e2e/ \
  -host mail.example.com \
  -user alice@mail.example.com \
  -pass '<password>' \
  -submission-port 587 -lmtp-port 24 -imaps-port 993 -pop3s-port 995
```

For an in-cluster protocol/sieve check, the `yarilo-smoketest` binary runs as
a Job against the login-proxy Services — see
[`hack/smoketest/job.yaml`](https://github.com/yarilomail/yarilo/tree/main/hack/smoketest).

### Troubleshooting

| Symptom | Likely cause | Fix |
|:---|:---|:---|
| `Certificate` stuck `Issuing` | Cloudflare API token missing/expired | `kubectl -n cert-manager describe order …`; recreate `cloudflare-api-token` |
| login pod CrashLoopBackOff at startup | `YARILO_DB_DSN` resolves empty | check the SQL Secret's `dsn` key is populated and base64-encoded |
| LoadBalancer stuck `<pending>` | no LB controller / metallb not enabled | enable metallb or set `service.type=NodePort` for the sandbox |
| Smoke test `tls: handshake failure` | DNS not yet at the LB, or cert still issuing | `dig` the host, `kubectl get certificate`, wait |
| AUTH fails for the seeded user | wrong table/column or missing `{SCHEME}` prefix | MySQL: `mailbox` row has `active=1`; Postgres: `users` row has `active=TRUE`; verify the `{BCRYPT}` prefix |

There is no single `yarilo` Deployment — read logs per component:

```sh
kubectl -n yarilo-sb logs deploy/yarilo-imap-login --tail=200 -f
kubectl -n yarilo-sb logs deploy/yarilo-auth --tail=200 -f
```

`LOG_LEVEL=debug` is on by default in `values-sandbox.yaml`.

### Uninstalling

```sh
helm uninstall yarilo -n yarilo-sb
kubectl delete -f helm_values/mysql-sandbox.yaml
```

Use `postgres-sandbox.yaml` in the second command if you deployed Postgres.

::: warning
PVCs (backend maildir, SQL data) are deleted with their namespaces. To keep
mail data, take a `kubectl cp` snapshot first.
:::

## Storage layout

Yarilo storage follows the `mail_storage` pattern: `MailboxBackend` and
`IndexBackend` are per-process factories; `UserMailbox` / `UserIndex` are
per-session handles created once after authentication and closed when the
session ends. All per-user state — filesystem root, quota, uid/gid — is
captured in `mailbox.UserInfo` at login time.

The global home layout is controlled by two config keys:

```yaml
storage:
  maildirRoot: /var/mail/vhosts      # prepended to template-derived paths
  mailHomeTemplate: "%d/%n"          # %d=domain, %n=local-part, %u=full email
```

The default `%d/%n` gives `/var/mail/vhosts/example.com/alice`. Use `%u` for
a flat layout, or `%n` for single-domain setups. Per-user relocation is a
DB-only change — populate `home` — with no code or config change.

See [Mailbox Storage](./STORAGE) for backends (maildir, dbox, mdbox),
self-healing and rotation tuning, and [Quota](./QUOTA) for enforcement.
