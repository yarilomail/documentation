# Running yarilo with Docker Compose

A single-host standalone deployment for local development, evaluation and
small self-hosted installs. It mirrors the standalone topology from the Helm
chart, on one host, with Docker Compose.

Clients connect to login proxies, which terminate TLS and forward to the
session backends. The backends share a Maildir store and coordinate through
`yarilo-auth`, `yarilo-warden` and `yarilo-locks` (Redis-backed). One image
serves every role — each container picks its component via `YARILO_COMPONENT`.

::: warning
Single-host, not highly available. For HA or multi-node, use the Helm chart —
see [Deployment](./DEPLOYMENT).
:::

Everything lives in
[`deploy/compose/`](https://github.com/yarilomail/yarilo/tree/main/deploy/compose).

## Services

| Group | Containers |
|:---|:---|
| Infra | `redis`, `yarilo-auth` (userdb), `yarilo-warden`, `yarilo-locks` |
| Session backends | `yarilo-imap`, `yarilo-pop3`, `yarilo-lmtp`, `yarilo-submission`, `yarilo-managesieve`, `yarilo-jmap` |
| Login proxies (TLS) | `yarilo-imap-login`, `yarilo-pop3-login`, `yarilo-submission-login`, `yarilo-lmtp-login`, `yarilo-managesieve-login`, `yarilo-jmap-login` |
| MTA integration | `yarilo-sasl-login` (SASL auth for Postfix), `yarilo-quota-status` (quota policy) |

The userdb is SQLite — `yarilo-auth` owns it in the `state` volume; mail lives
in the shared `mail` volume. No external database is required.

## Prerequisites

- Docker Engine 24+ with the Compose v2 plugin (`docker compose version`)
- Free host ports: 143/993, 110/995, 587/465, 4190, 8443, and — loopback-only
  by default — 24, 12325, 12340. Override in `.env`.
- ~512 MB RAM

## Quickstart

```sh
cd deploy/compose
cp .env.example .env
./gen-certs.sh mail.example.test
docker compose up -d
docker compose ps
```

This sequence:

- Copies the default environment; adjust the image tag or ports in `.env` if needed
- Generates a self-signed TLS certificate for local use
- Starts all containers; `docker compose ps` should report every one as `healthy`

### Creating the first user

The SQLite userdb lives in the `state` volume at `/var/lib/yarilo/users.db`.
`yarilo-auth` creates the `yarilo_users` table on first start.

Insert a user with a one-off sqlite container:

```sh
docker run --rm -v yarilo_state:/data nouchka/sqlite3 /data/users.db \
  "INSERT INTO yarilo_users (username,password,home,mail,enabled) VALUES \
   ('user@example.test','{PLAIN}changeit', \
    '/var/mail/vhosts/example.test/user@example.test', \
    'maildir:/var/mail/vhosts/example.test/user@example.test',1);"
```

The `mail` column is the per-user `mail_location` (`maildir:` / `sdbox:` /
`mdbox:`).

::: tip
`{PLAIN}` is fine for local testing only. Use a hashed scheme for real use.
:::

### Sending and reading a test message

Deliver a message via LMTP on the loopback port, as your MTA would:

```sh
printf 'LHLO t\r\nMAIL FROM:<s@ext.test>\r\nRCPT TO:<user@example.test>\r\nDATA\r\nSubject: hi\r\n\r\nhello\r\n.\r\nQUIT\r\n' \
  | nc 127.0.0.1 24
```

Read it back over IMAPS — with the self-signed certificate the verify warning
is expected:

```sh
printf 'a login user@example.test changeit\r\nb select INBOX\r\nc logout\r\n' \
  | openssl s_client -quiet -connect 127.0.0.1:993
```

## Listening ports

| Service | Host port | Notes |
|:---|:---|:---|
| IMAP / IMAPS | 143 / 993 | login proxy, STARTTLS / implicit TLS |
| POP3 / POP3S | 110 / 995 | login proxy |
| Submission | 587 / 465 | login proxy |
| ManageSieve | 4190 | login proxy |
| JMAP | 8443 | login proxy, HTTPS |
| LMTP | 24 (loopback) | unauthenticated — for your MTA only |
| SASL auth | 12325 (loopback) | Postfix `smtpd_sasl_type = dovecot` |
| Quota policy | 12340 (loopback) | Postfix `check_policy_service` |

## TLS

For local use, `./gen-certs.sh <hostname>` writes a self-signed `tls/cert.pem`
and `tls/key.pem`. The key is world-readable so the uid-1000 container can
load it.

For production, drop a real certificate and key (e.g. Let's Encrypt
`fullchain.pem` / `privkey.pem`) into `deploy/compose/tls/` as `cert.pem` /
`key.pem` and restart the login proxies. The `tls/` directory is git-ignored.

## Fronting MTA (Postfix)

Inbound mail reaches yarilo over LMTP (port 24); outbound is your MTA's job.

Wire Postfix to yarilo:

- Deliver local recipients: `mailbox_transport = lmtp:inet:127.0.0.1:24`
- SMTP AUTH against yarilo: `smtpd_sasl_type = dovecot`,
  `smtpd_sasl_path = inet:127.0.0.1:12325`
- Reject over-quota recipients: `check_policy_service inet:127.0.0.1:12340` in
  `smtpd_recipient_restrictions`

::: note
For a public deployment you also need MX, SPF, DKIM (signed at the MTA) and
PTR records.
:::

## Verifying

Check that every container reports `healthy`:

```sh
docker compose ps
```

Check the IMAP/POP3/Submission/ManageSieve greetings with `openssl s_client`
or `nc`, or run the smoke test. The entrypoint dispatches on
`YARILO_COMPONENT`, so invoke the binary directly:

```sh
docker compose exec yarilo-imap \
  yarilo-smoketest -host yarilo-imap-login -imap-port 10993 \
  -telemetry http://yarilo-imap-login:8080 -insecure=true
```

## Operations

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

For the admin CLI, run `yarctl` inside any session container:

```sh
docker compose exec yarilo-imap yarctl ...
```

Migrate mailbox formats with `yarilo-migrate`.

## Troubleshooting

| Symptom | Check |
|:---|:---|
| a container is unhealthy | `docker compose logs <svc>`; is `tls/cert.pem` present and readable? |
| client connects but gets no greeting | the matching login proxy AND its backend are up; both share the compose network |
| auth always fails | user row exists with `enabled=1`; password has a `{SCHEME}` prefix |
| 0 messages for a user | the `mail` column driver (maildir/sdbox/mdbox) matches how mail was delivered |
| DNS / `network is unreachable` between services | recreate cleanly: `docker compose down && docker compose up -d` (stale network) |
