# Submission configuration

Yarilo runs two submission listeners. MX inbound (port 25) is handled by an external MTA (Postfix, Exim, etc.) which delivers to yarilo via LMTP (port 24).

| Service key | Port | Role |
|:---|:---|:---|
| `submission` | `587` | Outbound submission — AUTH required, STARTTLS. |
| `submissions` | `465` | Outbound submission — AUTH required, implicit TLS. |

See [SERVICES.md](SERVICES.md) for listener-level settings (`port`, `ssl_mode`, `haproxy_protocol`, `auth_allow_cleartext`).

---

## `protocol.submission`

Protocol-level behaviour shared across both submission listeners.

| Key | Default | Description |
|:---|:---|:---|
| `hostname` | the top-level `hostname` | EHLO/HELO banner and `Message-ID` domain **for submission only**. Unset means the installation's name; see [General](GENERAL). Setting it here does not rename the LMTP banner, the `Received:` header or a delivered message's `Message-ID`. |
| `submission_max_mail_size` | `40M` | Maximum accepted message size. Takes a size with a unit (`40M`) or bytes. Also accepted as `max_message_size`. |
| `max_line_length` | `4096` | Maximum SMTP command or DATA line length in bytes. |
| `submission_max_recipients` | `0` | Maximum recipients per message. `0` = unlimited. Also accepted as `max_recipients`. |
| `recipient_delimiter` | `+` | Subaddress separator: `user+tag@domain` → `user@domain`. Empty = disabled. |
| `submission_client_workarounds` | — | Compatibility shims for non-conformant clients: `whitespace-before-path`, `mailbox-for-path` (see [LMTP](./LMTP#lmtp-client-workarounds) for what each does). Also accepted as `client_workarounds`. |
| `submission_add_received_header` | `true` | Prepend a `Received:` trace header to messages before forwarding. Set to `false` to suppress (the reference parity — protects sender identity). |

```yaml
protocol:
  submission:
    hostname: mail.example.com
    submission_max_mail_size: 40M
    max_line_length: 4096
    submission_max_recipients: 100
    recipient_delimiter: "+"
    submission_add_received_header: true
```

---

## Submission (port 587 / 465)

Accepts mail from MUAs. AUTH is required. `yarilo-submission-login` advertises `AUTH PLAIN LOGIN`, and with OAuth2 configured also `OAUTHBEARER XOAUTH2`, but only `PLAIN` and `LOGIN` are accepted; any other mechanism answers `504` ([yarilo#2121](https://github.com/yarilomail/yarilo/issues/2121)). After successful authentication and DATA, the message is forwarded to the configured upstream MTA via `protocol.submission.relay`. If `submission_relay_host` is empty, submission returns `451`.

`auth_allow_cleartext: false` in the service config blocks AUTH on unencrypted connections; pair it with `ssl_mode: starttls` (port 587) or `ssl_mode: ssl` (port 465).

---

## Relay (`protocol.submission.relay`)

Configures the upstream MTA for submission. One TCP connection per message; any transport error returns `451 4.4.0` to the MUA.

| Key | Default | Description |
|:---|:---|:---|
| `submission_relay_host` | — | Upstream MTA hostname or IP. Empty = relay disabled, submission returns 451. |
| `submission_relay_port` | `25` | Upstream MTA port. |
| `submission_relay_user` | — | SASL PLAIN username sent to upstream. Empty = no AUTH. |
| `submission_relay_password` | — | SASL PLAIN password. Supports `${ENV_VAR}`. |
| `submission_relay_ssl` | `no` | Transport security to upstream: `no` \| `starttls` \| `smtps`. |
| `submission_relay_ssl_verify` | `true` | Verify upstream TLS certificate. |
| `submission_relay_trusted` | `false` | Send XCLIENT to upstream with the MUA's real IP (requires upstream to advertise XCLIENT). |
| `submission_relay_connect_timeout` | `30` | TCP connect timeout in seconds. |
| `submission_relay_command_timeout` | `300` | Per-command timeout in seconds. |

```yaml
protocol:
  submission:
    relay:
      submission_relay_host: smtp.example.com
      submission_relay_port: 587
      submission_relay_user: relay-user
      submission_relay_password: "${RELAY_PASSWORD}"
      submission_relay_ssl: starttls
      submission_relay_ssl_verify: true
      submission_relay_trusted: false
      submission_relay_connect_timeout: 30
      submission_relay_command_timeout: 300
```

The pre-beta short names — `host`, `port`, `user`, `password`, `ssl`, `ssl_verify`, `trusted`, `connect_timeout`, `command_timeout` — are still accepted.
