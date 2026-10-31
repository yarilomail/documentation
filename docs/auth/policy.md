# Auth Policy Server Integration

`yarilo-auth` can POST every login attempt to an external HTTP policy
service that decides whether to allow, reject, or tarpit the request.
The wire shape follows the **wforce** ([weakforced](https://github.com/PowerDNS/weakforced))
HTTP API so any policy server speaking that dialect plugs in
without a custom adapter.

## When to enable

A policy server is useful when:

- credential-stuffing detection needs cross-IP pattern analysis (one
  IP brute-forcing 1000 distinct users - invisible to per-IP penalty)
- access policies depend on signals that don't fit a SQL passdb:
  geolocation, time of day, fraud-score, SIEM integration
- multi-tenant deployments need per-tenant abuse policies
- compliance requires policy decisions in an audit pipeline

When the deployment is small and the threat model is satisfied by
in-process `auth_failure_delay` + `auth_penalty` + per-user@IP
connection limits, the policy hook is overkill.

## Configuration

`auth.policy` in `yarilo.yaml` (the Helm names are [below](#helm)):

```yaml
auth:
  policy:
    auth_policy_server_url: "https://wforce.internal:8084/?ctx=imap"
    auth_policy_server_api_header: "X-API-Key: change-me"
    auth_policy_hash_mech: sha256
    auth_policy_hash_nonce: "deployment-specific-salt-please-rotate"
    auth_policy_hash_truncate: 12
    timeout_ms: 5000
    auth_policy_reject_on_fail: false
    auth_policy_log_only: false
    auth_policy_check_before_auth: true
    auth_policy_check_after_auth: true
    auth_policy_report_after_auth: true
```

<!-- @settings auth.policy -->

### Helm

The chart builds `auth.policy` from `components.auth.policy`, with shorter
names; each card above names its chart value.

From 2.4.2 a key under its `auth.policy` name fails the render and names the
chart's, and `check_before`, `check_after` and `report_after` set to `false`
and `hash_truncate_bits: 0` reach the config. In 2.4.1 such a key is dropped,
the three switches cannot be turned off through the chart (a `false` is
rendered as `true`), and `hash_truncate_bits: 0` is rendered as `12`.

`auth_policy_server_api_header` and `auth_policy_hash_nonce` expand `${ENV}`,
so both can come from a Secret; 2.4.1 and earlier take them literally. Through the
chart, name the Secret in `*_secret_ref` to keep the value out of the config
ConfigMap:

```yaml
components:
  auth:
    policy:
      url: https://wforce.internal:8084/
      api_header_secret_ref:
        name: yarilo-policy
        key: api_header   # the default
      hash_nonce_secret_ref:
        name: yarilo-policy
        key: hash_nonce   # the default
```

The chart renders `"${YARILO_AUTH_POLICY_API_HEADER}"` and
`"${YARILO_AUTH_POLICY_HASH_NONCE}"` and sets both variables in the
`yarilo-auth` pod from the Secret. Setting a value and its `*_secret_ref`
together fails the render.

<!-- @settings components.auth.policy -->

## Wire shape

Every request is `POST {url}?command={allow|report}` with header
`Content-Type: application/json` and a JSON body. Every login is checked,
whatever the mechanism: PLAIN, LOGIN, SCRAM-SHA-1 and SCRAM-SHA-256 with or
without `-PLUS`, OAUTHBEARER and XOAUTH2.

The default body:

```json
{
  "device_id": "\"name\" \"Thunderbird\" \"version\" \"140.4.0\"",
  "fail_type": "credentials",
  "login": "alice@example.com",
  "protocol": "imap",
  "pwhash": "ae30",
  "remote": "203.0.113.42",
  "session_id": "dGVzdHNlc3Npb24",
  "tls": true,
  "success": false,
  "policy_reject": false
}
```

- `success` and `policy_reject` appear only in the check after the login and
  in `report` calls.
- Keys are in alphabetical order, so the payload is byte-stable across
  releases.

### Request body

`auth_policy_request_attributes` sets the body: each key is sent as a string
expanded from its template. A key `name/sub` puts `sub` inside the object
`name`. `tls`, and `success` and `policy_reject` where they apply, always
follow the attributes.

An entry adds a key or replaces one; a key of the defaults cannot be removed.

Add the client's local address to the defaults:

```yaml
auth:
  policy:
    auth_policy_request_attributes:
      attrs/local: "%{local_ip}"
```

A key `a/b/c` nests as deep as it names: `c` inside `b` inside `a`. A key
cannot be both a value and an object.

### Templates

A template is text with `%{...}` expressions. An expression names a variable,
then filters joined with `|`:

```yaml
auth:
  policy:
    auth_policy_request_attributes:
      attrs/domain: "%{user | domain}"
      attrs/client: "%{real_remote_ip}:%{real_remote_port}"
      attrs/tenant: "%{passdb:tenant | default('none')}"
```

- `%%{` is a literal `%{`. A `%` before anything else, `%%` included, is
  sent as it is.
- Filters take positional and named arguments, as in
  `%{user | substr(0, 4)}` and `%{user | hash('sha256', rounds=2)}`. An
  argument can name a variable.
- The language has arithmetic (`%{remote_port + 1}`), comparisons with `if`
  and `switch`, `regexp`, hashes, `base64` and `hex`, `encrypt` and `decrypt`,
  and dates. `default` gives a value when the expression before it has none
  or fails.
- `regexp` and the `~` comparison use RE2 syntax: no backreferences, no
  lookaround.
- `encrypt` and `decrypt` take AES-128, AES-192 or AES-256 in CBC or ECB mode.
- A value is JSON-escaped before it goes into the body. `safe` sends it
  unescaped, so a value marked `safe` must already be valid inside a JSON
  string.

A template naming an unknown variable or filter stops `yarilo-auth` at start
with the key and the reason, rather than sending an empty value.

### Variables

| Variable | Value |
|:---|:---|
| `%{requested_username}` | the login name as the client sent it |
| `%{user}`, `%{owner_user}` | the user; after the login, as the passdb resolved it |
| `%{original_user}`, `%{auth_user}` | the login name, as `requested_username` |
| `%{domain_first}`, `%{domain_last}` | the part after the first or the last `@` |
| `%{password}` | the password in plain text |
| `%{hashed_password}` | the `pwhash` below |
| `%{protocol}` | `imap`, `pop3`, `submission`, `sieve`, `lmtp`, `jmap` |
| `%{mechanism}` | the SASL mechanism, as `PLAIN` or `SCRAM-SHA-256` |
| `%{secured}` | `TLS` when the client's connection is TLS, else empty |
| `%{remote_ip}`, `%{remote_port}` | the client's address and port |
| `%{local_ip}`, `%{local_port}` | the address and port the client connected to |
| `%{real_remote_ip}`, `%{real_remote_port}` | the peer's own address and port |
| `%{real_local_ip}`, `%{real_local_port}` | the local end of that connection |
| `%{local_name}` | the TLS server name (SNI) the client asked for |
| `%{ssl_ja3_hash}` | the JA3 hash of the client's TLS hello |
| `%{client_id}` | the client's IMAP `ID`, see [Client fields](#client-fields) |
| `%{session}` | the login's session ID |
| `%{client_pid}` | the process ID of the login process |
| `%{id}` | after the login, the position of the passdb that answered, from 1 |
| `%{fail_type}` | why a login failed, see [below](#fail-type) |
| `%{cert}`, `%{ssl_client_cert_fp}`, `%{ssl_client_cert_pubkey_fp}` | always empty |
| `%{login_user}`, `%{master_user}`, `%{session_pid}`, `%{home}` | always empty |

- Behind a PROXY header or a trusted proxy (XCLIENT, or the IMAP `ID` of a
  login in `general.xclient.trusted_nets`), `remote_ip` is the client the
  proxy names and `real_remote_ip` is the proxy itself. Without one, the
  `real_` variables equal the plain ones.
- A port the login did not learn is `0`.
- `%{password}` sends the password itself to the policy server. Use
  `%{hashed_password}` unless the server must see the password.
- The login pods do not ask for a client certificate, so the certificate
  variables are empty.
- Master logins skip the policy server, and the check runs before any
  session exists, so the other four are empty.

### Providers

A variable `prefix:name` is read from a provider:

| Provider | Value |
|:---|:---|
| `%{passdb:name}` | a field the passdb returned, empty when it returned none |
| `%{userdb:name}` | a `userdb_` field the passdb returned, without the prefix |
| `%{date:name}` | the date: `year`, `month`, `day` |
| `%{time:name}` | the time: `hour`, `min`, `sec`, `us`, `unix` |
| `%{generate:name}` | a new `guid`, `guid128` or `uuid` |

The passdb fields exist only after the login; in the check before it they are
empty.

`env:`, `process:` and `system:` read `yarilo-auth`'s own environment and
host. They are refused in the request body: a template naming one stops
`yarilo-auth` at start, so a secret of its own never reaches the policy
server. `event:` is not available.

### Client fields

- `tls` is true when the client's connection is TLS, implicit or after
  STARTTLS. JMAP, served over HTTPS only, is always TLS.
- `session_id` is the session ID the login process gave the connection.
- `device_id` is the IMAP `ID` the client sent before login, kept only with
  `protocol.imap.imap_id_retain`. Each pair is quoted, as in
  `"name" "Thunderbird" "version" "140.4.0"`; the login's own `x-` keys are
  left out. Without the setting, and for other protocols, it is empty.

### `fail_type`

| Value | Meaning |
|:---|:---|
| empty | the login succeeded, or the call is the check before it |
| `credentials` | a passdb knew the user and refused the password |
| `account` | no passdb knew the user |
| `internal` | a passdb could not answer |
| `policy` | the policy server refused the login |

`expired` and `disabled` are valid values for a policy server but are not
sent: no passdb reports them.

### `pwhash`

```
digest = hash_mech(hash_nonce || requested_username || "\0" || password)
pwhash = hex(truncate_to_top_N_bits(digest))
```

A SCRAM login carries no password, so its `pwhash` is over the user alone.

With the default 12-bit truncation:

- `pwhash` is 4 hex chars (a leading byte + the top nibble of the
  second byte, masked off)
- 4096 possible distinct values for the entire user base
- a single user's `pwhash` is stable across attempts with the same
  password, changes on password change - rate-limiters can count
  reused-vs-novel passwords per IP without ever seeing plain text

If your policy server needs higher precision, set `auth_policy_hash_truncate`
to `24`, `48`, or `0` (full digest). Anything above ~32 bits starts
to leak which-user-has-which-password information; pick the smallest
value your detection logic tolerates.

### Response

```json
{
  "status": 0,
  "msg": "optional message for the client"
}
```

- `status == 0`: allow.
- `status < 0`: refuse. A `msg` is shown to the client: IMAP answers
  `NO [AUTHENTICATIONFAILED] <msg>`, POP3 `-ERR [AUTH] <msg>`, Submission
  `535 5.7.8 <msg>` and ManageSieve `NO (AUTHENTICATIONFAILED) "<msg>"`.
  Without one, the client gets the usual authentication failure.
- `status > 0`: tarpit, `yarilo-auth` waits `status` seconds before the
  login goes on.

A 2xx HTTP status with malformed JSON or missing `status` field is
treated as a failover per `auth_policy_reject_on_fail`.

### Tarpit

Only the check before the login tarpits. The check after a successful login
can refuse it but never delays it.

A login process whose peer is in `general.xclient.trusted_nets` is a proxy
in front of yarilo: its logins are not tarpitted and do not count towards the
auth penalty.

## Master-user exemption

Master-user impersonation (SASL PLAIN with non-empty `authzid`)
**bypasses the policy server entirely.** Admin sessions are not
subject to user-facing abuse policy. This matches the policy
exemption applied to the cross-pod penalty store.

## Observability

`yarilo-auth` exports:

| Metric | Labels |
|:---|:---|
| `yarilo_auth_policy_decisions_total` | `check` (`before`, `after`), `result` (`ok`, `delayed`, `refused`) |
| `yarilo_auth_policy_errors_total` | `check` |
| `yarilo_auth_policy_tarpit_seconds_total` | |

The `auth: ok` and `auth: fail` log lines carry `policy_result` and
`policy_penalty`, the tarpit seconds, when a check ran.

## wforce

[wforce Integration](/auth/wforce) deploys weakforced as the policy server,
with a policy against password guessing and the steps to turn it on.

## Rollout strategy

1. **Shadow mode** (week 1) - set `auth_policy_log_only: true`, watch the logs
   for would-have-rejected events. Logins are neither delayed nor refused.
   Tune policy server thresholds until false-positive rate is acceptable.
2. **Soft enforce** (week 2) - flip `auth_policy_log_only: false`, keep
   `auth_policy_reject_on_fail: false` (fail-open). A policy server outage
   does not affect logins.
3. **Hard enforce** (week 3+) - flip `auth_policy_reject_on_fail: true` once
   the policy server has proven HA. A policy server outage now
   blocks logins; pair this with a monitored healthcheck.

## Tuning notes

- `auth_policy_check_before_auth` + `auth_policy_check_after_auth` doubles the per-attempt latency.
  Most operators disable `auth_policy_check_after_auth` once `auth_policy_check_before_auth` is
  trusted; `auth_policy_report_after_auth` is fire-and-forget so it doesn't add
  perceived latency.
- The HTTP client uses keep-alive - a single yarilo-auth pod
  reuses connections to the policy server across thousands of
  requests.
- Set `timeout_ms` shorter than `auth.auth_failure_delay` so a slow
  policy server doesn't push the entire wire response past the
  client timeout.
