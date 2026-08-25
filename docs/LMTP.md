# LMTP configuration

LMTP (RFC 2033) is the Local Mail Transfer Protocol used for final delivery from an external MTA (Postfix, Exim, etc.) into the yarilo mailbox. It operates on port 24 and returns per-recipient status codes, making it a drop-in replacement for SMTP-based local delivery.

## Architecture

yarilo's LMTP stack is split into two components:

| Binary | Role |
|:---|:---|
| `yarilo-lmtp-login` | MTA-facing proxy. Accepts one LMTP session from the MTA, tracks each recipient in warden (`CONNECT`), issues a service-scoped SESSION token per recipient via yarilo-auth master protocol, then at DATA time fans out one preamble TCP connection to `yarilo-lmtp` per recipient. |
| `yarilo-lmtp` | Backend delivery. Accepts preamble connections (`YARILO\t...TOKEN=...\n`), verifies the token with yarilo-auth (`VERIFY`, `service=lmtp` enforced), and delivers to the mailbox. No XCLIENT, no HAProxy, no direct warden access. |

**Why fan-out?** Each recipient may hash to a different backend pod (in director mode). A single multi-recipient DATA payload is split per recipient so each backend receives exactly the messages it is responsible for. Per-recipient status codes are merged and returned to the MTA.

**Token scoping.** SESSION tokens are issued with `service=lmtp`. The `yarilo-lmtp` `PreambleListener` rejects tokens issued for any other service (imap, pop3, smtp), preventing cross-service replay.

See [SERVICES.md](SERVICES.md) for listener-level settings (`port`, `ssl_mode`).

---

## `protocol.lmtp`

| Key | Default | Description |
|:---|:---|:---|
| `login_greeting` | `Yarilo ready.` | Text appended to the `220` banner. |
| `lmtp_add_received_header` | `true` | Prepend a `Received:` header to every delivered message. |
| `lmtp_save_to_detail_mailbox` | `false` | When `true`, `user+folder@domain` delivers to the `folder` mailbox instead of `INBOX`. |
| `lmtp_hdr_delivery_address` | `final` | Controls the `Delivered-To:` header: `none` — omit; `final` — address after detail stripping; `original` — RCPT TO address as received. |
| `lmtp_verbose_replies` | `false` | Include diagnostic details in 4xx/5xx error responses (useful for debugging; disable in production). |
| `lmtp_user_concurrency_limit` | `0` | Maximum concurrent deliveries per user. `0` = unlimited. |
| `read_timeout` | `300` | Per-command read timeout in seconds. |
| `write_timeout` | `300` | Per-command write timeout in seconds. |
| `lmtp_client_workarounds` | — | List of client compatibility workarounds (see below). |
| `lmtp_listen` | — | Listen address of the backend LMTP service. |
| `lmtp_backend_port` | — | Port the login service proxies to on the backend. |

```yaml
protocol:
  lmtp:
    login_greeting: "Yarilo ready."
    lmtp_add_received_header: true
    lmtp_save_to_detail_mailbox: false
    lmtp_hdr_delivery_address: final
    lmtp_verbose_replies: false
    lmtp_user_concurrency_limit: 5
    read_timeout: 300
    write_timeout: 300
```

---

## Recipient rate limiting

Caps how many messages one sender may deliver to one recipient inside a moving
window. Beyond the cap the sender is told `421 4.7.0 Rate limit exceeded for
recipient` and retries later; nothing is lost, and nothing is bounced.

Counters live in `yarilo-locks`, so the limit is **cluster-wide** — a sender
does not get a fresh allowance by reaching a different backend pod. The key is
the pair (sender IP, recipient mailbox), so one noisy sender cannot exhaust
another's allowance, and one busy mailbox does not throttle its neighbours.

| Key | Default | Description |
|:---|:---|:---|
| `rate_limit_enabled` | `true` | Gates the whole check. |
| `rate_limit_per_recipient_burst` | `100` | Messages allowed per (sender IP, recipient) inside one window. |
| `rate_limit_per_recipient_window_seconds` | `60` | Width of the window, in seconds. |

```yaml
protocol:
  lmtp:
    rate_limit:
      rate_limit_enabled: true
      rate_limit_per_recipient_burst: 100
      rate_limit_per_recipient_window_seconds: 60
```

In the Helm chart the same settings live under `protocol.lmtp.rate_limit`
without the prefix (`enabled`, `per_recipient_burst`,
`per_recipient_window_seconds`).

**When to raise it.** The defaults suit ordinary mail and do not suit bulk
delivery into a single account — a migration, a load test, a mailing-list
expansion landing in one mailbox. Those are what the burst and the window are
for. Turning the check off entirely leaves nothing between a misbehaving sender
and a mailbox.

If a lock-service call fails, the delivery is **accepted**: the availability of
the rate limiter is never allowed to block legitimate mail.

---

## `lmtp_hdr_delivery_address`

Controls the `Delivered-To:` header prepended before storing the message.

| Value | Behaviour |
|:---|:---|
| `none` | No `Delivered-To:` header is added. |
| `final` | `Delivered-To:` shows the address after subaddress stripping (`alice@example.com`). Default. |
| `original` | `Delivered-To:` shows the RCPT TO address as received (`alice+tag@example.com`). |

---

## `lmtp_client_workarounds`

A list of compatibility shims for non-conformant MTA clients. Unknown entries are silently ignored (the reference behaviour).

| Name | Effect |
|:---|:---|
| `whitespace-before-path` | Allows whitespace between the command verb and `<path>`: `MAIL FROM: <user@example.com>`. |
| `mailbox-for-path` | Allows a bare mailbox name without a domain in RCPT TO: `RCPT TO:<alice>`. |

```yaml
protocol:
  lmtp:
    lmtp_client_workarounds:
      - whitespace-before-path
      - mailbox-for-path
```

---

## `protocol.lmtp.proxy`

Proxy mode is active only on **director** nodes. The director's consistent-hashing ring (built from `general` backend settings) routes each recipient to the correct backend. Backend nodes always deliver locally — `protocol.lmtp.proxy` has no effect on them.

When multiple recipients hash to different backends, deliveries run in parallel and per-recipient status codes are merged before replying to the MTA.

| Key | Default | Description |
|:---|:---|:---|
| `proxy.timeout` | `125` | Per-backend connect + transaction timeout in seconds. |

```yaml
protocol:
  lmtp:
    proxy:
      timeout: 60
```

---

## Listener (service-level settings)

```yaml
services:
  lmtp:
    enabled: true
    port: 24
    ssl_mode: no    # no | starttls | ssl
```

The real client IP and recipient identity are carried in the YARILO preamble from `yarilo-lmtp-login`; no HAProxy or XCLIENT handling on the backend.

---

## Example: backend node (yarilo-lmtp)

```yaml
services:
  lmtp:
    enabled: true
    port: 24
    ssl_mode: no

protocol:
  lmtp:
    lmtp_add_received_header: true
    lmtp_hdr_delivery_address: final
    lmtp_user_concurrency_limit: 5
    read_timeout: 300
    write_timeout: 300
```

The backend listens only for preamble connections from `yarilo-lmtp-login`. MTAs connect to `yarilo-lmtp-login`, not directly to this port.

## `lmtp_login_service`

Configuration for `yarilo-lmtp-login`. Set either `backend_addr` (standalone) or `director_addr` (director mode).

| Key | Default | Description |
|:---|:---|:---|
| `backend_addr` | — | Fixed address of `yarilo-lmtp` backend. Used in standalone mode. |
| `director_addr` | — | Address of `yarilo-director` for per-recipient LOOKUP. Takes priority over `backend_addr`. |
| `director_tag` | `""` | Restrict LOOKUP to backends with this tag. Empty = full ring. |
| `backend_port` | `0` | Override the port in the LOOKUP result. `0` = use the result address as-is. |

**Standalone mode:**

```yaml
lmtp_login_service:
  backend_addr: "yarilo-lmtp.yarilo.svc.cluster.local:24"
```

```yaml
components:
  lmtpLogin:
    enabled: true
    backendAddr: "yarilo-lmtp.yarilo.svc.cluster.local:24"
```

**Director mode:**

```yaml
lmtp_login_service:
  director_addr: "yarilo-director.yarilo.svc.cluster.local:9101"
  director_tag: "prod"
  backend_port: 10024
```

```yaml
components:
  lmtpLogin:
    enabled: true
    directorAddr: "yarilo-director.yarilo.svc.cluster.local:9101"
    directorTag: "prod"
    backendPort: 10024
```

Postfix `main.cf`:

```
mailbox_transport = lmtp:inet:[yarilo-lmtp-login.yarilo.svc.cluster.local]:24
```

