# Services configuration

The `services` section controls which listeners are started and how each one behaves at the network level. Each entry is named after the process that reads it: the `*_login` entries are the login proxies', which alone terminate client TLS, and the bare names are the session backends', one plain listener each. A process reads its own entries only: one it needs that is missing stops its start, naming the key. `enabled: false` leaves the listener off.

---

## Common fields

All services share the following fields:

<!-- @settings services.* -->

A service may also carry `ssl`, a per-service SSL override with the same fields as `general.ssl`; it overrides only the fields it sets.

::: warning Renamed with an inverted sense
`auth_allow_cleartext` replaces the pre-beta `disable_plaintext_auth`, and the meaning is flipped: `auth_allow_cleartext: false` is what `disable_plaintext_auth: true` used to say. The old key is still accepted on its own. Setting **both** keys on one listener refuses startup - even when their values agree - because a config carrying both is one edit away from meaning the opposite of what it says.
:::

---

## Listeners

### Login proxies

The ports are the conventional ones; the Helm chart puts the login pods on the
`10xxx` container ports behind their Services.

| Key | Port | ssl_mode | Read by | Protocol doc |
|:---|:---|:---|:---|:---|
| `imaps_login` | `993` | `ssl` | `yarilo-imap-login` | [IMAP configuration](/protocols/imap) |
| `imap_login` | `143` | `starttls` | `yarilo-imap-login` | [IMAP configuration](/protocols/imap) |
| `submissions_login` | `465` | `ssl` | `yarilo-submission-login` | [Submission configuration](/protocols/submission) |
| `submission_login` | `587` | `starttls` | `yarilo-submission-login` | [Submission configuration](/protocols/submission) |
| `pop3s_login` | `995` | `ssl` | `yarilo-pop3-login` | [POP3 configuration](/protocols/pop3) |
| `pop3_login` | `110` | `starttls` | `yarilo-pop3-login` | [POP3 configuration](/protocols/pop3) |
| `lmtp_login` | `24` | `no` | `yarilo-lmtp-login` | [LMTP configuration](/protocols/lmtp) |
| `managesieve_login` | `4190` | `starttls` | `yarilo-managesieve-login` | [SIEVE](/features/sieve) |
| `jmap_login` | `8443` | `ssl` | `yarilo-jmap-login` | [JMAP](/protocols/jmap) |

### Session backends

One plain listener per backend, which its login proxy dials; the single
`yarilo` binary reads these entries and none of the `*_login` ones.

| Key | Port (chart) | Read by |
|:---|:---|:---|
| `imap` | `10143` | `yarilo-imap` |
| `pop3` | `10110` | `yarilo-pop3` |
| `submission` | `10587` | `yarilo-submission` |
| `lmtp` | `10024` | `yarilo-lmtp` |
| `managesieve` | `14190` | `yarilo-managesieve` |
| `jmap` | `10443` | `yarilo-jmap` |

### Removed in 2.4.6

These keys stop the start, and the message names the key that replaced them:

| Removed | Use |
|:---|:---|
| `imaps`, `pop3s`, `submissions` | `imaps_login`, `pop3s_login`, `submissions_login`; a backend has no implicit-TLS listener |
| `managesieve_be` | `managesieve` |
| `jmap_be` | `jmap` |

Before 2.4.6, `imap`, `pop3`, `submission`, `lmtp`, `managesieve` and `jmap`
were the login proxies' entries; they are the backends' now.

---

## Internal services

Outside k8s, the internal services listen on `127.0.0.1` unless the config
names an address, and so does a session backend whose `address` is empty.
A host install that reaches any of them from another host sets the address
explicitly. The Helm chart sets every one of them, so a release listens as
before. The director's ring and API
([`director_service.listen`](/architecture/director#director_service.listen)) and
the quota policy service
([`quota_status.listen`](/storage/quota#quota_status.listen)) follow the same
rule.

<!-- @settings auth_service.listen warden_service.listen backend_api.listen fts.fts_listen sasl_login.listen -->

### Unix sockets

On one host, `yarilo-auth`, `yarilo-warden` and `yarilo-dict` can listen on
Unix sockets instead: a listen or dial address written `unix:/path` is a socket, and
`yarilo-locks` in embedded mode uses one already.

- The socket gets its mode and group after the bind, so the umask does not
  decide them. A group that does not exist, or that the process may not give
  the socket, stops the start.
- A socket file left by a process that is gone is replaced. One a running
  process answers on is left to it and the start fails, so a second instance
  cannot take it; a path that is not a socket is never removed.
- `internal_tls` does not apply to a socket, on either side: its permissions
  are the boundary. With `internal_tls` on, the process logs that once per
  address.
- The master listener issues sessions without a password. On a socket,
  `yarilo-auth` reads the peer's uid from the kernel and issues one only to
  the users in `auth_service.master_session_users`, so a login proxy that
  can reach the socket still cannot issue itself a session.

<!-- @settings auth_service.addr auth_service.master_listen auth_service.master_addr auth_service.socket_mode auth_service.socket_group auth_service.master_socket_mode auth_service.master_socket_group auth_service.master_session_users warden_service.addr warden_service.socket_mode warden_service.socket_group -->

---

## Examples

A whole host, with every process reading one file, is in
[One host](/installation/single_host).

### IMAP login proxy behind HAProxy

```yaml
services:
  imaps_login:
    enabled: true
    port: 993
    ssl_mode: ssl
    haproxy_protocol: true
  imap_login:
    enabled: true
    port: 143
    ssl_mode: starttls
    haproxy_protocol: true
    auth_allow_cleartext: false
```

### Submission login proxy

```yaml
services:
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
```

### LMTP backend (yarilo-lmtp)

```yaml
services:
  lmtp:
    enabled: true
    port: 10024
    ssl_mode: "no"
```

Accepts preamble connections from `yarilo-lmtp-login` only. See [LMTP configuration](/protocols/lmtp) for architecture and `lmtp_login_service` config.

---

### Per-service TLS certificate override

```yaml
services:
  imaps_login:
    enabled: true
    port: 993
    ssl_mode: ssl
    ssl:
      ssl_server_cert_file: /etc/ssl/mail.example.com/cert.pem
      ssl_server_key_file:  /etc/ssl/mail.example.com/key.pem
```
