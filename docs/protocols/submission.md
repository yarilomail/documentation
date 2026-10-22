# Submission configuration

Yarilo runs two submission listeners. MX inbound (port 25) is handled by an external MTA (Postfix, Exim, etc.) which delivers to yarilo via LMTP (port 24).

| Service key | Port | Role |
|:---|:---|:---|
| `submission` | `587` | Outbound submission — AUTH required, STARTTLS. |
| `submissions` | `465` | Outbound submission — AUTH required, implicit TLS. |

See [Services configuration](/architecture/services) for listener-level settings (`port`, `ssl_mode`, `haproxy_protocol`, `auth_allow_cleartext`).

---

## `protocol.submission`

Protocol-level behaviour shared across both submission listeners.

| Key | Default | Description |
|:---|:---|:---|
| `hostname` | the top-level `hostname` | EHLO/HELO banner and `Message-ID` domain **for submission only**. Unset means the installation's name; see [General](/installation/general). Setting it here does not rename the LMTP banner, the `Received:` header or a delivered message's `Message-ID`. |
| `submission_max_mail_size` | `40M` | Maximum accepted message size. Takes a size with a unit (`40M`) or bytes. Also accepted as `max_message_size`. |
| `max_line_length` | `4096` | Maximum SMTP command or DATA line length in bytes. |
| `submission_max_recipients` | `0` | Maximum recipients per message. `0` = unlimited. Also accepted as `max_recipients`. |
| `recipient_delimiter` | `+` | Subaddress separator: `user+tag@domain` → `user@domain`. Empty = disabled. |
| `submission_client_workarounds` | — | Compatibility shims for non-conformant clients: `whitespace-before-path`, `mailbox-for-path` (see [LMTP](/protocols/lmtp#lmtp-client-workarounds) for what each does). Also accepted as `client_workarounds`. |
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

Accepts mail from MUAs. AUTH is required. `yarilo-submission-login` offers `PLAIN` and `LOGIN`, plus whatever `yarilo-auth` runs: the SCRAM mechanisms its passdbs can verify (`-PLUS` only over TLS 1.3) and, with OAuth2 configured, `OAUTHBEARER` and `XOAUTH2` (see [OAuth 2.0](/auth/oauth2)). A refused login answers `535`; a mechanism not offered answers `504`. After successful authentication and DATA, the message is forwarded to the configured upstream MTA via `protocol.submission.relay`. If `submission_relay_host` is empty, submission returns `451`.

`auth_allow_cleartext: false` in the service config blocks AUTH on unencrypted connections; pair it with `ssl_mode: starttls` (port 587) or `ssl_mode: ssl` (port 465).

### A proxy in front

A proxy or relay that passes the client's address with XCLIENT needs `xclient_protocol: true` on the listener and its own network in `general.xclient.trusted_nets`, which is empty by default. Only a peer in that list sees `250-XCLIENT` in the EHLO reply and has its forwarded address applied; any other client is not told about XCLIENT. See [General settings](/installation/general#general-xclient).

---

## Relay (`protocol.submission.relay`)

Configures the upstream MTA for submission. One TCP connection per message; any transport error returns `451 4.4.0` to the MUA.

| Key | Default | Description |
|:---|:---|:---|
| `submission_relay_host` | — | Upstream MTA hostname or IP. Empty = relay disabled, submission returns 451. |
| `submission_relay_port` | `25` | Upstream MTA port. |
| `submission_relay_user` | — | SASL PLAIN username sent to upstream; `%u` (or `%{user}`) is the session's user. Empty and no master = no AUTH. |
| `submission_relay_master_user` | — | Log in as this master acting for `submission_relay_user` (the SASL authzid), or for the session's user when that is empty. |
| `submission_relay_password` | — | SASL PLAIN password, the master's when one is set. Supports `${ENV_VAR}`. |
| `submission_relay_ssl` | `no` | Transport security to upstream: `no` \| `starttls` \| `smtps`. |
| `submission_relay_ssl_verify` | `true` | Verify upstream TLS certificate. |
| `submission_relay_ssl_ca` | — | PEM file the upstream certificate is verified against. Empty = the system roots. |
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

### Telling the relay who sends

A relay that authenticates through yarilo, such as Postfix with `smtpd_sasl_type = dovecot` pointed at `yarilo-sasl-login`, can check the sender against the login (`reject_authenticated_sender_login_mismatch`). For that it must see the user, not a service account. Log in as a master acting for each user:

```yaml
protocol:
  submission:
    relay:
      submission_relay_host: relay.example.internal
      submission_relay_port: 587
      submission_relay_ssl: starttls
      submission_relay_user: "%u"
      submission_relay_master_user: relay-master
      submission_relay_password: "${YARILO_SUBMISSION_RELAY_PASSWORD}"
```

- `relay-master` must be a master user in yarilo-auth (see [Master users](/auth/master_users)).
- The session's user is the one it logged in as, by every mechanism: PLAIN, LOGIN, SCRAM, OAUTHBEARER and XOAUTH2.
- When the relay needs a user (`%u`, or a master with no relay user) and the session has none, the message is refused before the relay is dialled.

A relay login that fails, or cannot be made for want of a user, answers the client `451 4.7.0 Temporary authentication failure, try again later`. The reason is logged with the session id.

In the Helm chart, `relay.password_secret_ref` (`name`, `key`) gives the password from a Secret to every container that relays, as `YARILO_SUBMISSION_RELAY_PASSWORD`.

### JMAP

JMAP `EmailSubmission` sends through this same relay, with the same login as the user and the same limits; see [JMAP](/protocols/jmap#sending-mail).

### Verifying the relay

A relay inside the cluster usually holds a certificate from an internal CA. To verify it against that CA, set `submission_relay_ssl_ca` to the CA's PEM and keep `submission_relay_ssl_verify: true`. With `internal_tls` on, the chart already mounts the internal CA at `/etc/yarilo/internal-tls/ca.crt`.

::: warning
2.4.3 and earlier delivered a reply a step behind after AUTH through the login, so a client could not send through Submission ([yarilo#2271](https://github.com/yarilomail/yarilo/issues/2271)).
:::

The pre-beta short names — `host`, `port`, `user`, `password`, `ssl`, `ssl_verify`, `trusted`, `connect_timeout`, `command_timeout` — are still accepted.
