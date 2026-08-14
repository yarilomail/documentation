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

`auth.policy` in `yarilo.yaml` (or `components.auth.policy` in Helm
`values.yaml`):

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

| Setting | Default | Notes |
|---|---|---|
| `auth_policy_server_url` | `""` | `""` disables the hook. URL may end with `&` to extend an existing query string instead of starting a new one (e.g. `https://w/?tenant=42&`) |
| `auth_policy_server_api_header` | `""` | `"Key: value"` → custom header. `"value"` → `X-API-Key: value` |
| `auth_policy_hash_mech` | `sha256` | `sha256` or `sha512`. Must match the policy server's hash setting |
| `auth_policy_hash_nonce` | `""` | **Required when `auth_policy_server_url` is set.** Salt mixed into `pwhash`. Two deployments with different nonces have different hash spaces |
| `auth_policy_hash_truncate` | `12` | Top N bits of the digest kept. 12 → 4096 buckets — enough for rate-limit patterns, useless for password recovery. `0` disables truncation (sends the full digest) |
| `timeout_ms` | `5000` | HTTP round-trip cap |
| `auth_policy_reject_on_fail` | `false` | `true` → reject auth when policy server is unreachable / malformed. `false` (default) → continue without policy guidance |
| `auth_policy_log_only` | `false` | `true` → the client still POSTs and logs decisions, but the verdict is NOT enforced. Use this to roll out a new policy in shadow-mode before flipping `false` |
| `auth_policy_check_before_auth` | `true` | POST `?command=allow` BEFORE the chain runs. Reject blocks the passdb call entirely |
| `auth_policy_check_after_auth` | `true` | POST `?command=allow` AFTER the chain result is known. Reject downgrades a successful auth (account-takeover detection) |
| `auth_policy_report_after_auth` | `true` | POST `?command=report` fire-and-forget after every decision. Telemetry pipeline; never blocks the wire reply |

## Wire shape

Every request is `POST {url}?command={allow|report}` with header
`Content-Type: application/json` and JSON body:

```json
{
  "device_id": "<client_id>",
  "fail_type": "policy" | "internal" | "credentials" | "expired" | "disabled" | "account" | "",
  "login": "alice@example.com",
  "protocol": "imap",
  "pwhash": "ae",
  "remote": "203.0.113.42",
  "session_id": "<unique-per-attempt>",
  "tls": true,
  "success": true,
  "policy_reject": false
}
```

- `success` and `policy_reject` appear only in `auth_policy_check_after_auth` and
  `report` calls.
- Keys are alphabetic so the payload is byte-stable across
  releases — wforce Lua rules that hash the body for caching
  work without surprises.

### `pwhash`

```
digest = hash_mech(hash_nonce || requested_username || "\0" || password)
pwhash = hex(truncate_to_top_N_bits(digest))
```

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
  "msg": "optional human-readable reason"
}
```

- `status == 0` → allow / continue
- `status < 0` → reject (auth fails with opaque wire response; `msg`
  goes to server-side logs)
- `status > 0` → tarpit: yarilo-auth sleeps `status` seconds before
  proceeding

A 2xx HTTP status with malformed JSON or missing `status` field is
treated as a failover per `auth_policy_reject_on_fail`.

## Master-user exemption

Master-user impersonation (SASL PLAIN with non-empty `authzid`)
**bypasses the policy server entirely.** Admin sessions are not
subject to user-facing abuse policy. This matches the policy
exemption applied to the cross-pod penalty store.

## wforce example

Minimal `wforce.conf` that approves every attempt and counts
failures per IP:

```lua
setACL({"0.0.0.0/0"})
addListener("0.0.0.0:8084")

function allow(args)
    if args.attrs.protocol == "imap" then
        local key = args.attrs.remote
        local fails = newCA(key)
        if fails:get() > 50 then
            return -1, "too many failures", {}
        end
        if fails:get() > 10 then
            return 5, "slow down", {}
        end
    end
    return 0, "", {}
end

function report(args)
    if not args.success then
        local key = args.attrs.remote
        local fails = newCA(key)
        fails:add(1, 3600)  -- expire after 1h
    end
end

setAllow(allow)
setReport(report)
```

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
