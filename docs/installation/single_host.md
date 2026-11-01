---
description: "One-host YariloMail install from a single yarilo.yaml: login proxies on the mail ports, the yarilo binary behind them, auth, warden and locks over Unix sockets."
---

# One host

Every process on the host reads the same file. The login proxies take the mail
ports and terminate TLS; the single `yarilo` binary serves the sessions behind
them on loopback; `yarilo-auth`, `yarilo-warden` and `yarilo-locks` are reached
over Unix sockets.

::: warning
Single-host, not highly available. For HA or multi-node, use
[Kubernetes](/installation/#installing-on-kubernetes).
:::

## Processes

| Process | Listens on |
|:---|:---|
| `yarilo-locks` | `/run/yarilo/locks.sock` |
| `yarilo-auth` | `/run/yarilo/auth.sock`, `/run/yarilo/auth-master.sock` |
| `yarilo-warden` | `/run/yarilo/warden.sock` |
| `yarilo` | `127.0.0.1:10143`, `127.0.0.1:10587`, `127.0.0.1:10024` |
| `yarilo-imap-login` | `993`, `143` |
| `yarilo-submission-login` | `465`, `587` |
| `yarilo-lmtp-login` | `127.0.0.1:24`, for the local MTA |

Start `yarilo-locks`, `yarilo-auth` and `yarilo-warden` first. Every process
reads the file named by `CONFIG`, `/etc/yarilo/yarilo.yaml` when it is unset.

Each process also serves health and metrics on `telemetry.listen`, `:8080` by
default, so on one host every process gets its own port from
`TELEMETRY_LISTEN`, for example `127.0.0.1:8081` for `yarilo-locks`,
`127.0.0.1:8082` for `yarilo-auth`, and so on. The service manager sets it per
process; it is not a key in the file.

`/run/yarilo` belongs to the service user, with the `yarilo` group that the
sockets are given; the service manager creates it before the first process
starts.

## The file

```yaml
## /etc/yarilo/yarilo.yaml for one host; every process reads this file.
hostname: mail.example.org

general:
  ssl:
    ssl_server_cert_file: /etc/yarilo/tls/cert.pem
    ssl_server_key_file: /etc/yarilo/tls/key.pem

services:
  ## yarilo-imap-login
  imaps_login:
    enabled: true
    port: 993
    ssl_mode: ssl
  imap_login:
    enabled: true
    port: 143
    ssl_mode: starttls
    auth_allow_cleartext: false
  ## yarilo-submission-login
  submissions_login:
    enabled: true
    port: 465
    ssl_mode: ssl
  submission_login:
    enabled: true
    port: 587
    ssl_mode: starttls
    auth_allow_cleartext: false
  ## yarilo-lmtp-login takes mail from the local MTA without a login.
  lmtp_login:
    enabled: true
    address: 127.0.0.1
    port: 24
    ssl_mode: "no"
  ## The yarilo binary, behind the proxies; an empty address is 127.0.0.1.
  imap:
    enabled: true
    port: 10143
    ssl_mode: "no"
  submission:
    enabled: true
    port: 10587
    ssl_mode: "no"
  lmtp:
    enabled: true
    port: 10024
    ssl_mode: "no"

imap_login_service:
  backend_addr: 127.0.0.1:10143
submission_login_service:
  backend_addr: 127.0.0.1:10587
lmtp_login_service:
  backend_addr: 127.0.0.1:10024

auth:
  passdb:
    - driver: sqlite
      dsn: /var/lib/yarilo/users.db
  penalty:
    enabled: true

storage:
  mail_driver: maildir
  maildir_root: /var/mail/vhosts
  mail_home: "%d/%u"

## The sockets carry no TLS: their permissions are the boundary.
internal_tls:
  enabled: false

auth_service:
  listen: unix:/run/yarilo/auth.sock
  socket_group: yarilo
  ## The master listener answers userdb lookups without a password.
  master_listen: unix:/run/yarilo/auth-master.sock
  master_addr: unix:/run/yarilo/auth-master.sock
  master_socket_mode: "0600"

warden_service:
  listen: unix:/run/yarilo/warden.sock
  socket_group: yarilo

locks_service:
  mode: embedded
  socket: /run/yarilo/locks.sock
  socket_group: yarilo

locks_client:
  mode: embedded
  socket: /run/yarilo/locks.sock
```

The MTA delivers to `127.0.0.1:24` (`lmtp_login`) and authenticates its users,
if it does, through `yarilo-sasl-login`, which is not in this file; see
[Docker Compose](/installation/docker_compose) for the MTA side.

See [Services](/architecture/services) for the listener keys and the Unix
socket rules.
