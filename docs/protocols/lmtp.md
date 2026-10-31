# LMTP configuration

LMTP (RFC 2033) is the Local Mail Transfer Protocol used for final delivery from an external MTA (Postfix, Exim, etc.) into the yarilo mailbox. It operates on port 24 and returns per-recipient status codes, making it a drop-in replacement for SMTP-based local delivery.

## Architecture

yarilo's LMTP stack is split into two components:

| Binary | Role |
|:---|:---|
| `yarilo-lmtp-login` | MTA-facing proxy. Accepts one LMTP session from the MTA, tracks each recipient in warden (`CONNECT`), issues a service-scoped SESSION token per recipient via yarilo-auth master protocol, then at DATA time fans out one preamble TCP connection to `yarilo-lmtp` per recipient. |
| `yarilo-lmtp` | Backend delivery. Accepts preamble connections (`YARILO\t...TOKEN=...\n`), verifies the token with yarilo-auth (`VERIFY`, `service=lmtp` enforced), and delivers to the mailbox. No XCLIENT, no HAProxy, no direct warden access. |

**Why fan-out?** Each recipient may hash to a different backend pod (in director mode). A single multi-recipient DATA payload is split per recipient so each backend receives exactly the messages it is responsible for. Per-recipient status codes are merged and returned to the MTA.

**Token scoping.** SESSION tokens are issued with `service=lmtp`. The `yarilo-lmtp` `PreambleListener` rejects tokens issued for any other service (imap, pop3, submission), preventing cross-service replay.

See [Services configuration](/architecture/services) for listener-level settings (`port`, `ssl_mode`).

---

## `protocol.lmtp`

<!-- @settings protocol.lmtp.login_greeting protocol.lmtp.lmtp_add_received_header protocol.lmtp.lmtp_save_to_detail_mailbox protocol.lmtp.lda_mailbox_autocreate protocol.lmtp.lda_mailbox_autosubscribe protocol.lmtp.lmtp_verbose_replies protocol.lmtp.lmtp_user_concurrency_limit protocol.lmtp.lmtp_max_recipients protocol.lmtp.read_timeout protocol.lmtp.write_timeout -->

The backend's listen address and port are listener settings (`services.lmtp`, see
[Services](/architecture/services)); the port the login service dials is
`lmtp_login_service.backend_port` below.

### A delivery to a folder that does not exist

A folder a delivery names (`user+folder@` with `lmtp_save_to_detail_mailbox`, or
a Sieve `fileinto`) may not exist yet:

- if a namespace configures it with `auto` (see
  [Namespaces](/storage/namespace#configured-mailboxes-mailboxes)), the delivery
  makes it like any other open, subscribed when `auto: subscribe`. The two
  knobs below play no part in that;
- otherwise, with `lda_mailbox_autocreate: true`, the delivery makes it, and
  subscribes it with `lda_mailbox_autosubscribe: true`;
- otherwise the message goes to the detail mailbox when that is another folder
  and exists, then to `INBOX`. The delivery is not refused.

`fileinto :create` makes the folder regardless of these settings.

### Synthesised Message-ID

<!-- @settings protocol.lmtp.lmtp_add_message_id -->

A message stored without a `Message-ID` cannot be replied to and cannot be
threaded, and that is permanent: the header is part of the stored bytes, so
nothing can add it afterwards without rewriting mail. Such a message is its own
root in every conversation, no later reply can name it in `In-Reply-To` or
`References`, and JMAP reports its `messageId` as `null`.

Behind an MTA the header is already present and this key changes nothing. Fed
LMTP directly - a script, or a deployment with no MTA in front - delivery is the
last place the identity can still be given, which is why the default is `true`.
Set it to `false` if the stored bytes must be exactly what arrived.

The identifier is 128 bits of randomness at the server's hostname:

```
Message-ID: <9f0c6a1d4b2e8735c1a0d6f4e2b98357@mx.example.com>
```

Unique among all messages, as RFC 5322 §3.6.4 requires, rather than unique
within one host or one run.

**An existing `Message-ID` is never rewritten**, not even a malformed one:
whatever a sender wrote is what a reply quotes back in `References`, so
replacing it would break the conversation the message already belongs to. Only a
message whose header section has no `Message-ID` field at all is given one - a
header inside a forwarded or quoted message is body, and does not count.

The header is added before Sieve runs, before the message is stored and before
the conversation is recorded, so a script, the stored bytes and the thread all
see the same identity.

```yaml
protocol:
  lmtp:
    login_greeting: "Yarilo ready."
    lmtp_add_received_header: true
    lmtp_add_message_id: true
    lmtp_save_to_detail_mailbox: false
    lmtp_hdr_delivery_address: final
    lmtp_verbose_replies: false
    lmtp_user_concurrency_limit: 5
    read_timeout: 300
    write_timeout: 300
```

---

## Message size and a full mailbox

**Size.** When `quota.quota_mail_size` is set, both `yarilo-lmtp-login` and the
backend LMTP service offer it in the `LHLO` reply as `SIZE <bytes>`:

- `MAIL FROM:<...> SIZE=<n>` above the limit is refused at once with `552`.
- A body that grows past the limit is refused with `552 5.3.4 Maximum message
  size exceeded` while it is being read. The rest is read and discarded rather
  than held in memory, and the connection stays open for the next transaction.

Leave `quota_mail_size` empty or `0` for no limit; then `LHLO` offers a bare
`SIZE` with no number, which RFC 1870 reads as "supported, no fixed limit".

**Full mailbox.** A recipient over quota is answered after `DATA`, with the text
of `quota.quota_exceeded_message`:

| `quota_full_tempfail` | Reply | What the MTA does |
|:---|:---|:---|
| `false` (default) | `552 5.2.2` | Bounces the message to the sender at once. |
| `true` | `452 4.2.2` | Keeps the message queued and retries until the mailbox has room or the queue lifetime runs out. |

Turn it on only when a full mailbox is expected to be emptied soon and a
delayed message is better than a bounce. Otherwise the sender learns of the
failure only when the MTA gives up, often days later.

<!-- @settings protocol.lmtp.quota_full_tempfail -->

---

## Recipient rate limiting

Caps how many messages one sender may deliver to one recipient inside a moving
window. Beyond the cap that recipient is refused with `451 4.7.0 Rate limit
exceeded for recipient`, and the sender retries later. Nothing is lost and
nothing is bounced. The connection stays open, and the other recipients of the
same transaction are answered as usual.

Counters live in `yarilo-locks`, so the limit is **cluster-wide** - a sender
does not get a fresh allowance by reaching a different backend pod. The key is
the pair (sender IP, recipient mailbox), so one noisy sender cannot exhaust
another's allowance, and one busy mailbox does not throttle its neighbours.

<!-- @settings protocol.lmtp.rate_limit -->

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
delivery into a single account - a migration, a load test, a mailing-list
expansion landing in one mailbox. Those are what the burst and the window are
for. Turning the check off entirely leaves nothing between a misbehaving sender
and a mailbox.

If a lock-service call fails, the delivery is **accepted**: the availability of
the rate limiter is never allowed to block legitimate mail.

---

## Original recipient (ORCPT)

A relay may name a recipient's original address with the `ORCPT` parameter of `RCPT TO` (RFC 3461). yarilo-lmtp-login takes it and passes it on to the backend, which takes it too, without either of them offering DSN. Sieve's vacation uses it as one of the user's addresses when `sieve_vacation_use_original_recipient` is on; see [Sieve](/features/sieve#vacation-replies).

::: warning Postfix sends no ORCPT here
Postfix adds `ORCPT` only for a server that announces DSN, and yarilo does not announce DSN: that would make it responsible for delivery notifications (RFC 3461), which it does not send. So with Postfix in front, no ORCPT arrives and `sieve_vacation_use_original_recipient` has no effect. It takes effect with a relay that sends ORCPT without DSN, such as another IMAP server's LMTP proxy placed in front of yarilo during a migration.
:::

## Delivered-To header

<!-- @settings protocol.lmtp.lmtp_hdr_delivery_address -->

The values:

| Value | Behaviour |
|:---|:---|
| `none` | No `Delivered-To:` header is added. |
| `final` | `Delivered-To:` shows the address after subaddress stripping (`alice@example.com`). Default. |
| `original` | `Delivered-To:` shows the RCPT TO address as received (`alice+tag@example.com`). |

---

## Client workarounds

<!-- @settings protocol.lmtp.lmtp_client_workarounds -->

The names:

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

`yarilo-lmtp-login` reads this section. For each recipient it opens one connection to the backend that the director's LOOKUP names (or to `backend_addr` in standalone mode). Deliveries to different backends run in parallel, and the per-recipient status codes are merged before the reply to the MTA. The backend, `yarilo-lmtp`, ignores the section.

<!-- @settings protocol.lmtp.proxy -->

```yaml
protocol:
  lmtp:
    proxy:
      lmtp_proxy_timeout: 60
```

A recipient's userdb field `proxy_timeout` replaces it for that recipient; see [AUTH](/auth/) for the format. When that lookup fails the recipient gets `451 4.3.0 Temporary user lookup failure`; when the value cannot be read, `550 5.3.5 Internal user lookup failure`. A user the userdb does not know is refused at `RCPT` with `550 5.1.1 No such user here`, before the director is asked. With `auth_master_addr` empty no lookup is made, and every recipient goes on to the backend, which refuses an unknown one the same way.

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

Configuration for `yarilo-lmtp-login`. Set either `backend_addr` (standalone) or `director_addr` (director mode). When both are set, `backend_addr` wins and the service logs a warning at start.

<!-- @settings lmtp_login_service -->

**Standalone mode:**

```yaml
lmtp_login_service:
  backend_addr: "yarilo-lmtp.yarilo.svc.cluster.local:24"
```

```yaml
components:
  lmtpLogin:
    enabled: true
    backend_addr: "yarilo-lmtp.yarilo.svc.cluster.local:24"
```

**Director mode:**

```yaml
lmtp_login_service:
  director_addr: "yarilo-director.yarilo.svc.cluster.local:9102"
  director_tag: "prod"
  backend_port: 10024
```

```yaml
components:
  lmtpLogin:
    enabled: true
    director_addr: "yarilo-director.yarilo.svc.cluster.local:9102"
    director_tag: "prod"
    backend_port: 10024
```

Postfix `main.cf`:

```
mailbox_transport = lmtp:inet:[yarilo-lmtp-login.yarilo.svc.cluster.local]:24
```

