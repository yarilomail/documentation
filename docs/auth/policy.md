# Auth Policy Server Integration

`yarilo-auth` can POST every login attempt to an external HTTP policy
service that decides whether to allow, reject, or tarpit the request.
The wire shape follows the **wforce** ([weakforced](https://github.com/PowerDNS/weakforced))
HTTP API so any policy server speaking that dialect plugs in
without a custom adapter.

## When to enable

A policy server is useful when:

- credential-stuffing detection needs cross-IP pattern analysis (one
  IP brute-forcing 1000 distinct users — invisible to per-IP penalty)
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

Templates take these variables; `%%` is a literal `%`:

| Variable | Value |
|:---|:---|
| `%{requested_username}`, `%{user}` | the login name |
| `%{username}`, `%{domain}` | its local part and domain |
| `%{hashed_password}` | the `pwhash` below |
| `%{protocol}`, `%{service}` | `imap`, `pop3`, `submission`, `sieve`, `lmtp`, `jmap` |
| `%{remote_ip}`, `%{rip}` | the client's address |
| `%{local_ip}`, `%{lip}` | the address the client connected to |
| `%{session}` | the login's session ID |
| `%{client_id}` | the client's IMAP `ID`, see [Client fields](#client-fields) |
| `%{fail_type}` | why a login failed, see below |

Any other variable, and filters such as `%{user | lower}`, stop `yarilo-auth`
at start with the key and the reason, rather than sending an empty value.

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
  password, changes on password change — rate-limiters can count
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

## wforce example

Count different failed passwords per IP and per IP and login over an hour,
tarpit a login after 3 and refuse an IP after 50:

```lua
addListener("0.0.0.0:8084", false, "", "", {})
setWebserverPassword(os.getenv("WFORCE_HTTP_PASSWORD"))

local field_map = {}
field_map["diffFailedPasswords"] = "hll"
newStringStatsDB("OneHourDB", 600, 6, field_map)

function report(lt)
   if not lt.success and not lt.policy_reject then
      local sdb = getStringStatsDB("OneHourDB")
      sdb:twAdd(lt.remote, "diffFailedPasswords", lt.pwhash)
      sdb:twAdd(lt.remote:tostring() .. ":" .. lt.login, "diffFailedPasswords", lt.pwhash)
   end
end

function allow(lt)
   local sdb = getStringStatsDB("OneHourDB")
   if sdb:twGet(lt.remote, "diffFailedPasswords") > 50 then
      return -1, "Too many failed logins, try again later", "per-IP limit", {}
   end
   if sdb:twGet(lt.remote:tostring() .. ":" .. lt.login, "diffFailedPasswords") > 3 then
      return 3, "", "per-login limit", {}
   end
   return 0, "", "", {}
end

setReport(report)
setAllow(allow)
```

`yarilo-auth` sends the password as `Authorization: Basic` in
`auth_policy_server_api_header`, base64 of `wforce:<password>`.

## Rollout strategy

1. **Shadow mode** (week 1) — set `auth_policy_log_only: true`, watch the logs
   for would-have-rejected events. Tune policy server thresholds
   until false-positive rate is acceptable.
2. **Soft enforce** (week 2) — flip `auth_policy_log_only: false`, keep
   `auth_policy_reject_on_fail: false` (fail-open). A policy server outage
   does not affect logins.
3. **Hard enforce** (week 3+) — flip `auth_policy_reject_on_fail: true` once
   the policy server has proven HA. A policy server outage now
   blocks logins; pair this with a monitored healthcheck.

## Tuning notes

- `auth_policy_check_before_auth` + `auth_policy_check_after_auth` doubles the per-attempt latency.
  Most operators disable `auth_policy_check_after_auth` once `auth_policy_check_before_auth` is
  trusted; `auth_policy_report_after_auth` is fire-and-forget so it doesn't add
  perceived latency.
- The HTTP client uses keep-alive — a single yarilo-auth pod
  reuses connections to the policy server across thousands of
  requests.
- Set `timeout_ms` shorter than `auth.auth_failure_delay` so a slow
  policy server doesn't push the entire wire response past the
  client timeout.
