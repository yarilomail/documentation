---
description: "One-host YariloMail install: login proxies on the mail ports, a session backend per protocol on loopback, auth, warden, locks and dict over Unix sockets, users and metadata in SQLite, MySQL or PostgreSQL, each process as its own account."
---

# One host

Every process on the host reads the same file. The login proxies take the mail
ports and terminate TLS, and a session backend per protocol serves the mail
behind them on loopback. `yarilo-auth`, `yarilo-warden`, `yarilo-locks` and
`yarilo-dict` are reached over Unix sockets.

Each process runs as an account that holds only what it needs. The units,
users and directories for systemd are in the repository's
[`deploy/systemd`](https://github.com/yarilomail/yarilo/tree/main/deploy/systemd);
FreeBSD runs the same set from a port, see
[Running on FreeBSD](#running-on-freebsd).

::: warning
Single-host, not highly available. For HA or multi-node, use
[Kubernetes](/installation/#installing-on-kubernetes).
:::

## Processes

| Process | Account | Listens on |
|:---|:---|:---|
| `yarilo-locks` | `yarilo` | `/run/yarilo/locks/locks.sock` |
| `yarilo-auth` | `yarilo-auth` | `/run/yarilo/auth/auth-client.sock`, `/run/yarilo/auth/auth-master.sock` |
| `yarilo-warden` | `yarilo-auth` | `/run/yarilo/auth/warden.sock` |
| `yarilo-dict` | `yarilo` | `/run/yarilo/dict/dict.sock` |
| `yarilo-imap`, `-pop3`, `-submission`, `-lmtp`, `-managesieve` | `yarilo` | `127.0.0.1:10143`, `10110`, `10587`, `10024`, `14190` |
| `yarilo-imap-login` | `yarilo-login` | `993`, `143` |
| `yarilo-pop3-login` | `yarilo-login` | `995`, `110` |
| `yarilo-submission-login` | `yarilo-login` | `465`, `587` |
| `yarilo-managesieve-login` | `yarilo-login` | `4190` |
| `yarilo-lmtp-login` | `yarilo-delivery` | `127.0.0.1:24`, for the local MTA |

Start `yarilo-locks` first, then `yarilo-auth`, `yarilo-warden` and
`yarilo-dict`, then the backends, then the login proxies. Every process reads the file named by
`CONFIG`, `/etc/yarilo/yarilo.yaml` when it is unset.

Each process also serves health and metrics on `telemetry.listen`, `:8080` by
default, so on one host every process gets its own port from
`TELEMETRY_LISTEN`. The units give `yarilo-locks` `127.0.0.1:18080`,
`yarilo-auth` `127.0.0.1:18081`, and so on. The service manager sets it per
process; it is not a key in the file.

## Accounts

| Account | Groups | Holds |
|:---|:---|:---|
| `yarilo` | `yarilo-auth`, `yarilo-master` | the mail in `/var/mail/vhosts`, the state in `/var/lib/yarilo/state`, the lock and dict sockets |
| `yarilo-auth` | `yarilo-master` | the user database in `/var/lib/yarilo/auth`; owns the auth and warden sockets |
| `yarilo-login` | `yarilo-auth` | the TLS key; reaches the auth client and warden sockets only |
| `yarilo-delivery` | `yarilo-auth`, `yarilo-master` | nothing on disk; reaches the master socket to deliver |

The auth master socket answers user lookups and issues sessions without a
password, which is how `yarilo-lmtp-login` delivers. It belongs to the
`yarilo-master` group, which the client login proxies are not in. On a socket,
`yarilo-auth` also checks the peer's uid and issues a session only to the
users in
[`auth_service.master_session_users`](/architecture/services#auth_service.master_session_users).
A compromised login proxy reaches neither the mail nor a session for another
user.

The login proxies bind ports below 1024 without root: the systemd units give
them `CAP_NET_BIND_SERVICE` and nothing else, and every other unit has no
capabilities at all.

## Databases

Two databases sit behind the mail, each opened by one process:

| Database | Opened by | Default | Keys |
|:---|:---|:---|:---|
| Users and passwords | `yarilo-auth` | SQLite, `/var/lib/yarilo/auth/users.db` | [`auth.passdb`](/auth/) |
| IMAP METADATA and the Sieve metadata extensions | `yarilo-dict` | SQLite, `/var/lib/yarilo/state/metadata.db` | [`dicts.metadata`](/storage/dict), driver `sql` |

Either can be MySQL or PostgreSQL instead, on this host or another; the
drivers are built in, so this is a change to the file only. The sessions
never open the metadata database: they reach `yarilo-dict` on its socket and
name the dict.

The file is readable by every yarilo process, so a database password does not
go in it. The DSN names a variable, and the service manager sets it for that
one process from a file only root reads:

```yaml
auth:
  passdb:
    - driver: postgres
      dsn: "postgres://yarilo:${YARILO_AUTH_DB_PASSWORD}@127.0.0.1:5432/yarilo?sslmode=disable"
dicts:
  metadata:
    driver: sql
    settings:
      driver: mysql
      dsn: "yarilo:${YARILO_DICT_DB_PASSWORD}@tcp(127.0.0.1:3306)/yarilo"
      namespace: metadata
```

| Password | File | Seen by |
|:---|:---|:---|
| `YARILO_AUTH_DB_PASSWORD` | `/etc/yarilo/auth.env` | `yarilo-auth` |
| `YARILO_DICT_DB_PASSWORD` | `/etc/yarilo/dict.env` | `yarilo-dict` |

Each file holds `NAME=value` lines, owned by root with mode `0600`:

```sh
install -o root -m 0600 /dev/null /etc/yarilo/auth.env
echo 'YARILO_AUTH_DB_PASSWORD=...' >> /etc/yarilo/auth.env
```

systemd loads it with `EnvironmentFile` in that unit alone. On FreeBSD rc.d
reads `/usr/local/etc/yarilo/auth.env` and `dict.env` as root for that
component alone, and a file not owned by root with mode `0600` stops that
component's start. With SQLite there is no password and no file.

For the SQLite user database, see
[Creating the first user](/installation/docker_compose#creating-the-first-user)
for the table, and keep the file `0600` and owned by `yarilo-auth`.

## Running with systemd

`deploy/systemd` holds:

- one unit per component and `yarilo.target`, which wants the processes above;
- `sysusers.d/yarilo.conf`, the four accounts and their groups;
- `tmpfiles.d/yarilo.conf`, the socket, state and mail directories with their
  owners;
- `yarilo.yaml`, the configuration on this page.

Build a `.deb` from a checkout:

```sh
./hack/package/deb.sh
```

This builds the binaries into `dist/bin` and writes
`dist/yarilo_<version>_amd64.deb`, which installs the binaries in
`/usr/libexec/yarilo`, the units and the sample configuration. Installing it
creates the accounts and directories and starts nothing.

Install the package, put the certificate and key in `/etc/yarilo/tls`, and
start the target:

```sh
apt install ./dist/yarilo_*_amd64.deb
install -o root -g yarilo-login -m 0640 key.pem /etc/yarilo/tls/key.pem
install -o root -g root -m 0644 cert.pem /etc/yarilo/tls/cert.pem
systemctl enable --now yarilo.target
```

This starts the processes in order: each of `yarilo-locks`, `yarilo-auth`,
`yarilo-warden` and `yarilo-dict` counts as started once its socket exists, so
the units after it do not race it.

- `systemctl restart yarilo-imap` restarts one component.
- `systemctl stop yarilo.target` stops them in reverse order.
- `yarilo-jmap`, `yarilo-jmap-login`, `yarilo-quota-status`,
  `yarilo-sasl-login` and `yarilo-backend-api` join the target with
  `systemctl enable`.
- Logs go to the journal: `journalctl -u 'yarilo-*'`.

Removing the package stops and disables the units and keeps the configuration,
the data and the accounts. Purging it removes the configuration and the state
in `/var/lib/yarilo`, but never the mail or the certificates: while
`/var/mail/vhosts` or `/etc/yarilo/tls` holds anything, it stays, and so do the
accounts that own it.

## Running on FreeBSD

The FreeBSD port `mail/yarilo` runs the same processes under the same accounts,
started by an rc.d script instead of units.

### Platforms

FreeBSD is fully supported. `yarilo-auth` reads the peer's uid on the master
socket, so the check against `auth_service.master_session_users` holds as it
does on Linux.

NetBSD and OpenBSD build, and the gate runs `go vet` for both, but the
service has not been run end to end on either. Neither gives the peer's
credentials on a Unix socket, so there the master socket rests on its group
alone.

### Installing from the port

The port is developed in
[yarilomail/freebsd-ports](https://github.com/yarilomail/freebsd-ports)
before it goes into the ports tree. It builds the 2.4.6 release, the first
that runs on FreeBSD with these accounts and the peer check. Once the port is
accepted into the tree, this step becomes `pkg install yarilo`.

The port builds with Go 1.27.3 or newer, the version `go.mod` names. The ports
tree's `lang/go127` is 1.27.3; a `go127` package from the quarterly branch may
still be 1.27.2, and the build then stops on the `go.mod` version. Check it
first, and build `lang/go127` from the tree when it is older:

```sh
pkg info go127                                  # 1.27.3 or newer is enough
cd /usr/ports/lang/go127 && make install clean  # only when it is older
```

Add the port's accounts to the ports tree, copy the port in and build it:

```sh
git clone https://github.com/yarilomail/freebsd-ports.git
cat freebsd-ports/UIDs.add >> /usr/ports/UIDs
cat freebsd-ports/GIDs.add >> /usr/ports/GIDs
cp -R freebsd-ports/mail/yarilo /usr/ports/mail/
cd /usr/ports/mail/yarilo && make install clean
```

- `FTS`, on by default, builds `yarilo-fts` on Xapian.
- `REDIS` pulls in Redis for state shared across hosts.
- `make config` changes either before the build.

Installing creates the accounts and the directories, and starts nothing.

### Starting and stopping

Start from the sample configuration, put the certificate and key in place and
enable the service:

```sh
cp /usr/local/etc/yarilo/yarilo.yaml.sample /usr/local/etc/yarilo/yarilo.yaml
install -o root -g yarilo-login -m 0640 key.pem /usr/local/etc/yarilo/tls/key.pem
install -o root -g wheel -m 0644 cert.pem /usr/local/etc/yarilo/tls/cert.pem
sysrc yarilo_enable=YES
service yarilo start
```

The script starts the processes in the order of `yarilo_components` and stops
them in reverse. It waits for the lock, auth, warden and dict sockets before
it starts what follows them.

| rc.conf variable | Default |
|:---|:---|
| `yarilo_enable` | `NO` |
| `yarilo_config` | `/usr/local/etc/yarilo/yarilo.yaml` |
| `yarilo_components` | `locks auth warden dict imap pop3 lmtp submission managesieve imap-login pop3-login lmtp-login submission-login managesieve-login` |
| `yarilo_log_level` | `info` |
| `yarilo_stop_timeout` | `60` seconds |

- `service yarilo restart imap` restarts one component, and `service yarilo
  status` lists each.
- `fts`, `jmap`, `jmap-login`, `quota-status`, `sasl-login` and
  `backend-api` join the set when added to `yarilo_components`.
- Each component gets a fixed telemetry port on loopback, from
  `127.0.0.1:18080` for `locks` to `18099` for `backend-api`, whatever the
  list holds.

### Accounts on FreeBSD

The accounts are the ones in [Accounts](#accounts), with fixed ids from the
port:

| Account | UID | GID |
|:---|:---|:---|
| `yarilo` | 803 | 803 |
| `yarilo-auth` | 804 | 804 |
| `yarilo-login` | 805 | 805 |
| `yarilo-delivery` | 809 | 809 |

`yarilo-master` is a group alone, GID 810, with `yarilo`, `yarilo-delivery`
and `yarilo-auth` as members. `yarilo`, `yarilo-login` and `yarilo-delivery`
are members of the `yarilo-auth` group.

### Paths

| | Linux | FreeBSD |
|:---|:---|:---|
| Binaries | `/usr/libexec/yarilo` | `/usr/local/libexec/yarilo` |
| Configuration | `/etc/yarilo/yarilo.yaml` | `/usr/local/etc/yarilo/yarilo.yaml` |
| Certificate and key | `/etc/yarilo/tls` | `/usr/local/etc/yarilo/tls` |
| Sockets | `/run/yarilo` | `/var/run/yarilo` |
| User database | `/var/lib/yarilo/auth` | `/var/db/yarilo/auth` |
| State, metadata database | `/var/lib/yarilo/state` | `/var/db/yarilo/state` |
| Database passwords | `/etc/yarilo/auth.env`, `dict.env` | `/usr/local/etc/yarilo/auth.env`, `dict.env` |
| Mail | `/var/mail/vhosts` | `/var/mail/vhosts` |
| Logs | the journal | `/var/log/yarilo` |

### Ports below 1024

FreeBSD has no per-process capability for low ports. The login proxies bind
them as `yarilo-login` and `yarilo-delivery` through mac_portacl(4), and
nothing runs as root.

Load the module and grant each account its ports:

```sh
sysrc -f /boot/loader.conf mac_portacl_load=YES
kldload mac_portacl
cat >> /etc/sysctl.conf <<'CONF'
net.inet.ip.portrange.reservedhigh=0
security.mac.portacl.suser_exempt=1
security.mac.portacl.rules=uid:809:tcp:24,uid:805:tcp:110,uid:805:tcp:143,uid:805:tcp:465,uid:805:tcp:587,uid:805:tcp:993,uid:805:tcp:995
CONF
service sysctl restart
```

This sequence:

- hands the decision on ports below 1024 to mac_portacl, with root still
  allowed every port;
- lets `yarilo-delivery` (809) bind 24, and `yarilo-login` (805) bind 110,
  143, 465, 587, 993 and 995.

Without the rules, `service yarilo start` names the missing piece and does not
start the login proxy.

### Logs

Each process writes `/var/log/yarilo/<component>.log`. newsyslog rotates them
daily and keeps seven, from `/usr/local/etc/newsyslog.conf.d/yarilo.conf`, and
`service yarilo reopen` makes the processes write to the new files.

### Delivery from Postfix

`yarilo-lmtp-login` takes local delivery on `127.0.0.1:24`. Point Postfix at
it:

```sh
postconf -e virtual_transport=lmtp:inet:127.0.0.1:24
```

## The file

The configuration the package installs as `/etc/yarilo/yarilo.yaml`, without
its Sieve extension list:

```yaml
## /etc/yarilo/yarilo.yaml for one host; every process reads this file.
general:
  ssl:
    ssl_server_cert_file: /etc/yarilo/tls/cert.pem
    ssl_server_key_file: /etc/yarilo/tls/key.pem
    ssl_min_protocol: TLS1.2
  xclient:
    trusted_nets: ["127.0.0.1/32"]

## The sockets carry no TLS: their permissions and the peer check are the boundary.
internal_tls:
  enabled: false

services:
  ## The login proxies, on the mail ports.
  imap_login:
    enabled: true
    port: 143
    ssl_mode: starttls
  imaps_login:
    enabled: true
    port: 993
    ssl_mode: ssl
  pop3_login:
    enabled: true
    port: 110
    ssl_mode: starttls
  pop3s_login:
    enabled: true
    port: 995
    ssl_mode: ssl
  submission_login:
    enabled: true
    port: 587
    ssl_mode: starttls
    auth_allow_cleartext: false
  submissions_login:
    enabled: true
    port: 465
    ssl_mode: ssl
    auth_allow_cleartext: false
  ## yarilo-lmtp-login takes mail from the local MTA without a login.
  lmtp_login:
    enabled: true
    port: 24
    address: 127.0.0.1
    ssl_mode: "no"
  managesieve_login:
    enabled: true
    port: 4190
    ssl_mode: starttls
  jmap_login:
    enabled: true
    port: 8443
    ssl_mode: ssl
    auth_allow_cleartext: false

  ## The session backends, behind the proxies; an empty address is 127.0.0.1.
  imap:
    enabled: true
    port: 10143
    ssl_mode: "no"
    xclient_protocol: true
  pop3:
    enabled: true
    port: 10110
    ssl_mode: "no"
    xclient_protocol: true
  submission:
    enabled: true
    port: 10587
    ssl_mode: "no"
    xclient_protocol: true
  lmtp:
    enabled: true
    port: 10024
    ssl_mode: "no"
    xclient_protocol: true
  managesieve:
    enabled: true
    port: 14190
    ssl_mode: "no"
    xclient_protocol: true
  jmap:
    enabled: true
    port: 10443
    ssl_mode: "no"
    xclient_protocol: true

imap_login_service:
  backend_addr: 127.0.0.1:10143
pop3_login_service:
  backend_addr: 127.0.0.1:10110
submission_login_service:
  backend_addr: 127.0.0.1:10587
lmtp_login_service:
  backend_addr: 127.0.0.1:10024
managesieve_login_service:
  backend_addr: 127.0.0.1:14190
## WebSocket push needs websocket_ticket_key, a secret of your own.
jmap_login_service:
  backend_addr: 127.0.0.1:10443
jmap_service:
  auth_master_addr: unix:/run/yarilo/auth/auth-master.sock

auth_service:
  listen: unix:/run/yarilo/auth/auth-client.sock
  addr: unix:/run/yarilo/auth/auth-client.sock
  master_listen: unix:/run/yarilo/auth/auth-master.sock
  master_addr: unix:/run/yarilo/auth/auth-master.sock
  socket_group: yarilo-auth
  ## The backends and yarilo-delivery reach it; only yarilo-delivery issues sessions.
  master_socket_group: yarilo-master
  master_session_users: [yarilo-delivery]

warden_service:
  listen: unix:/run/yarilo/auth/warden.sock
  addr: unix:/run/yarilo/auth/warden.sock
  socket_group: yarilo-auth

## One host: lock state in memory, on a socket only yarilo reaches.
locks_service:
  mode: embedded
  socket: /run/yarilo/locks/locks.sock
  socket_group: yarilo
locks_client:
  mode: embedded
  socket: /run/yarilo/locks/locks.sock

## yarilo-dict opens the dict databases; the sessions reach it over this socket.
dict_service:
  dict_listen: unix:/run/yarilo/dict/dict.sock
  dict_addr: unix:/run/yarilo/dict/dict.sock
  socket_group: yarilo

## SQLite, or MySQL or PostgreSQL with the password in /etc/yarilo/auth.env.
auth:
  passdb:
    - driver: sqlite
      dsn: /var/lib/yarilo/auth/users.db
    # - driver: mysql
    #   dsn: "yarilo:${YARILO_AUTH_DB_PASSWORD}@tcp(127.0.0.1:3306)/yarilo"
    # - driver: postgres
    #   dsn: "postgres://yarilo:${YARILO_AUTH_DB_PASSWORD}@127.0.0.1:5432/yarilo?sslmode=disable"

storage:
  mail_driver: maildir
  maildir_root: /var/mail/vhosts
  mail_home: "%d/%u"
  index: fileindex

## Submission and Sieve send through the local MTA.
protocol:
  jmap:
    jmap_base_url: "https://mail.example.org:8443"
  submission:
    relay:
      submission_relay_host: 127.0.0.1
      submission_relay_port: 25
sieve:
  sieve_enabled: true
  sieve_scripts_driver: fs
  sieve_submission_host: 127.0.0.1:25

## SQLite, or MySQL or PostgreSQL with the password in /etc/yarilo/dict.env.
dicts:
  metadata:
    driver: sql
    settings:
      driver: sqlite
      dsn: /var/lib/yarilo/state/metadata.db
      namespace: metadata
```

The shipped file lists every Sieve extension except `vnd.yarilo.execute`,
`vnd.yarilo.pipe` and `vnd.yarilo.filter`, which run programs as the `yarilo`
account; add them only with program directories you trust.

The MTA delivers to `127.0.0.1:24` (`lmtp_login`). For Postfix:

```sh
postconf -e virtual_transport=lmtp:inet:127.0.0.1:24
```

It authenticates its users, if it does, through `yarilo-sasl-login`; see
[Docker Compose](/installation/docker_compose) for the MTA side.

See [Services](/architecture/services) for the listener keys and the Unix
socket rules.
