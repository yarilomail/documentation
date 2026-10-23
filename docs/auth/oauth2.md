# OAuth 2.0 / OAUTHBEARER + XOAUTH2 Integration

`yarilo-auth` validates OAuth 2.0 bearer tokens for the SASL
**OAUTHBEARER** (RFC 7628) and **XOAUTH2** (Google/Microsoft legacy
extension) mechanisms and exposes them as a passdb so OAuth logins
flow through the same chain machinery as SQL logins (cache, penalty,
policy, audit log — all work unchanged).

Both mechanisms share the same token validator. The only difference
is the wire format of the client's initial response.

## When to enable

A token-based login is useful when:

- the deployment integrates with Google Workspace, Microsoft 365,
  Keycloak, Authelia or any OIDC-compliant IdP
- mailbox passwords should live entirely outside the mail server
  (no SQL passdb at all, or SQL-only as fallback)
- per-mailbox app passwords are replaced by IdP-issued tokens

Skip when the threat model is satisfied by a simple SQL passdb and
the operator has no OIDC infrastructure.

## Configuration

`auth.oauth2` in `yarilo.yaml` is a list (the Helm names are
[below](#helm)). Each entry becomes one passdb in the
auth chain, placed **ahead of SQL** so an OAUTHBEARER login
resolves through the validator before SQL ever sees the bearer
token as a plaintext password.

Four validation modes:

| Mode | Required fields | Notes |
|:---|:---|:---|
| `local` | `oauth2_jwks_url` and/or `oauth2_local_keys` | JWT signature verify against operator-provided keys and/or a cached JWKS. No HTTP call per login. RECOMMENDED when the IdP issues signed JWTs (Google, Microsoft, most OIDC providers). |
| `introspection` | `oauth2_introspection_url`, usually `oauth2_client_id` + `oauth2_client_secret` | RFC 7662 introspection. Supports opaque (non-JWT) tokens. Slower (one HTTP call per login). |
| `tokeninfo` | `oauth2_tokeninfo_url` | Google-style endpoint (`?access_token=…`). Pre-OIDC providers. |
| `discovery` | `oauth2_issuer_url` | Auto-resolves `jwks_uri` + `introspection_endpoint` from `<issuer>/.well-known/openid-configuration`. PREFERRED for new deployments — least operator config. |

### Common fields (apply across modes)

<!-- @settings auth.oauth2[].oauth2_issuers auth.oauth2[].oauth2_audience auth.oauth2[].oauth2_scope auth.oauth2[].oauth2_username_attribute auth.oauth2[].oauth2_username_validation_format auth.oauth2[].oauth2_active_attribute auth.oauth2[].oauth2_active_value auth.oauth2[].oauth2_fields auth.oauth2[].oauth2_token_expire_grace_seconds auth.oauth2[].oauth2_http_timeout_ms auth.oauth2[].oauth2_prefer_introspection auth.oauth2[].oauth2_jwks_unknown_kid_interval_seconds auth.oauth2[].oauth2_tls_ca auth.oauth2[].oauth2_grant_url auth.oauth2[].oauth2_force_introspection -->

`oauth2_local_keys` (`local` mode only) lists keys the operator provides; see [local keys](#local-keys).

### Password grant

With `oauth2_grant_url` set, a **plaintext** login (PLAIN, LOGIN) that
reaches the entry has its username and password exchanged at the token
endpoint (`grant_type=password`, plus `client_id`, `client_secret` and
`scope` when set). A token from OAUTHBEARER or XOAUTH2 is never sent there.

- The token endpoint's reply stands when it already carries
  `oauth2_username_attribute` (and `oauth2_active_attribute`, when set);
  otherwise the access token it returned is validated by the entry's mode,
  exactly like a presented token.
- `invalid_grant` is a wrong password: the chain goes on to the next passdb.
  Any other failure (endpoint down, `invalid_client`, a reply without
  `access_token`) is a temporary failure.
- The URL must be `https` — the request carries the user's password — and
  `oauth2_client_id` is required.

### Local keys

In `local` mode, `oauth2_local_keys` lists verification keys the operator
provides, so the IdP's keys can be pinned or a JWKS endpoint is not needed
at all. Each key is picked by the token's `azp` claim, its `alg` header and
its `kid` header; a token without `azp` or `kid` matches the key whose
`oauth2_local_key_azp` / `oauth2_local_key_kid` is empty (or `default`).

<!-- @settings auth.oauth2[].oauth2_local_keys[] -->

- `HS*` means a **shared secret**: whoever holds the file can mint tokens.
  An HS token is checked only against these files, never against the JWKS.
- A token the local keys do not name falls back to `oauth2_jwks_url`, when
  one is configured.
- A key file that does not parse, or a key that cannot sign its `alg`
  (an ES384 entry holding a P-256 key), stops `yarilo-auth` at startup.

### Forced introspection

`oauth2_force_introspection: true` sends a token to
`oauth2_introspection_url` even when the tokeninfo reply or the password
grant reply already names the user. It has no effect on a token validated
locally, so the config is refused where nothing would reach it: in
`tokeninfo` mode without `oauth2_introspection_url`, and in other modes
without `oauth2_grant_url`.

In `tokeninfo` mode, `oauth2_introspection_url` also decides any token whose
tokeninfo reply does not name the user.

### Introspection sub-modes

When `oauth2_mode: introspection` (or `discovery` with introspection
selected), `oauth2_introspection_mode` picks the transport:

| Value | Transport |
|:---|:---|
| `post` (default) | RFC 7662: POST `application/x-www-form-urlencoded` with `token=<token>` in the body |
| `auth` | GET with `Authorization: Bearer <token>` header; the token is not in the URL. 2.4.3-dev.20 and earlier sent a POST with an empty body |
| `get` | GET `<url>?token=<token>` |

### Helm

The chart builds `auth.oauth2` from `components.auth.oauth2`, where every
key is the `auth.oauth2` name without the `oauth2_` prefix — with two more
changes: `oauth2_scope` is `scopes` and `oauth2_fields` is `extra_fields`.
A `local_keys` entry takes `alg`, `azp`, `kid` and either `file` (a path in
the pod) or `secret_ref` (`name`, `key`): the chart mounts that Secret key
into `yarilo-auth` and renders its path.

```yaml
components:
  auth:
    oauth2:
      - mode: discovery
        issuer_url: https://accounts.google.com
        audience: "1234567890-abcdef.apps.googleusercontent.com"
        scopes: [openid, email]
        username_validation_format: "%Lu"
        extra_fields: [sub, hd]
```

From 2.4.2 a key under its `oauth2_` name fails the render and names the
chart's; in 2.4.1 it is dropped without a warning.

To keep the introspection client secret out of the config ConfigMap, name a
Secret in `client_secret_ref` instead of setting `client_secret`:

```yaml
components:
  auth:
    oauth2:
      - mode: introspection
        introspection_url: https://keycloak.example/realms/yarilo/protocol/openid-connect/token/introspect
        client_id: yarilo-auth
        client_secret_ref:
          name: yarilo-oauth2
          key: client_secret   # the default
```

The chart then renders `oauth2_client_secret: "${YARILO_OAUTH2_<n>_CLIENT_SECRET}"`,
where `<n>` is the entry's index in the list, and sets that variable in the
`yarilo-auth` pod from the Secret. Setting both `client_secret` and
`client_secret_ref` fails the render.

## Wire shapes

### OAUTHBEARER (RFC 7628, recommended)

Client sends a GS2-wrapped bearer token in the initial response:

```
n,a=alice@example.com,\x01host=mail.example.com\x01port=993\x01auth=Bearer <token>\x01\x01
```

Fields are separated by `\x01` (ASCII SOH). The `host=` and
`port=` fields are optional; field order is flexible.

The `a=` authzid is optional too (RFC 7628 §3.1): `n,,\x01auth=Bearer <token>\x01\x01`
logs in as the user the token names. When `a=` is sent it must match the
token's user after `oauth2_username_validation_format`.

### XOAUTH2 (Google/Microsoft legacy)

Client sends a simpler format — no GS2 header, no host/port:

```
user=alice@example.com\x01auth=Bearer <token>\x01\x01
```

Fields are `\x01`-separated. The `Bearer ` prefix on `auth=` is
case-insensitive. XOAUTH2 does not support channel binding.

**When to use XOAUTH2:** Legacy Outlook configurations, older
Android mail apps, and some older Thunderbird OAuth setups that
advertise XOAUTH2 instead of OAUTHBEARER. New clients should
prefer OAUTHBEARER. Both mechanisms hit the same token validator
— there is no difference in security posture once a TLS session
is established.

Both mechanisms validate the token per the configured provider and
either succeed or return a JSON failure descriptor
(`{"status":"invalid_token","schemes":"bearer"}`).

### Mechanism advertisement

`yarilo-auth` runs both mechanisms and announces them in its handshake only
when an OAuth provider is configured (`auth.oauth2` non-empty), since that is
what puts a token validator in the chain. The login proxies offer exactly what
the service announced:

- **IMAP** — `AUTH=OAUTHBEARER` and `AUTH=XOAUTH2` in `CAPABILITY`
- **POP3** — `CAPA` lists them on the `SASL` line
- **Submission (SMTP)** — the EHLO `AUTH` line lists them
- **ManageSieve** — the `SASL` capability lists them; `AUTHENTICATE "OAUTHBEARER" "<base64>"`, challenges as quoted base64. 2.4.3-dev.21 and earlier offered only `PLAIN LOGIN` here
- **JMAP** — a `401` lists `Bearer realm="jmap"` next to `Basic`; a request's
  `Authorization: Bearer <token>` is run in `yarilo-auth` as OAUTHBEARER for the
  `jmap` service, with no authzid, so the token names the user

A bearer token is a password to whoever reads it, so with
`auth_allow_cleartext: false` both are held back with `PLAIN` and `LOGIN` on a
connection that is not TLS, not proxied and not local, and refused there. JMAP
applies the same rule to `Bearer` as to `Basic`: refused over plain HTTP.

### Failure

A refused login follows RFC 7628 §3.2.2: the server answers with a challenge
carrying a JSON status, the client acknowledges it with a single `0x01` byte,
and only then is the login refused (`NO`, `-ERR`, `535`).

JMAP answers a refused token with `401` and
`WWW-Authenticate: Bearer realm="jmap", error="invalid_token"` (RFC 6750 §3),
the same for every refusal (a bad or expired token, `nologin`, the policy
server), so the answer never tells a valid token apart. While `yarilo-auth`
cannot answer, the request gets `503` instead, for Basic as well: the client
retries rather than asks for new credentials.

| Mechanism | JSON |
|:---|:---|
| `OAUTHBEARER` | `{"status":"invalid_token","scope":"…","openid-configuration":"…"}` — `invalid_token` for a token that did not validate, `invalid_request` for a malformed message |
| `XOAUTH2` | `{"status":"401","schemes":"bearer","scope":"…","openid-configuration":"…"}` — `401` for a bad token, `400` for a malformed message |

`scope` is the configured `oauth2_scope` list, or `mail` when none is set;
`openid-configuration` is `<oauth2_issuer_url>/.well-known/openid-configuration`
and appears only with an issuer configured.

## Worked examples

### Google Workspace (discovery mode)

```yaml
auth:
  oauth2:
    - oauth2_mode: discovery
      oauth2_issuer_url: https://accounts.google.com
      oauth2_audience: "1234567890-abcdef.apps.googleusercontent.com"
      oauth2_scope: [openid, email]
      oauth2_username_attribute: email
      oauth2_username_validation_format: "%Lu"
      oauth2_fields: [sub, hd]
```

- `oauth2_issuers` auto-resolved from the discovery document.
- `oauth2_audience` is the OAuth client ID from Google Cloud Console.
- `oauth2_username_validation_format: %Lu` accepts a mixed-case SASL
  authzid against a lowercased `email` claim.
- `oauth2_fields: [hd]` projects the Google "hosted domain" claim
  as `userdb_hd` so downstream rules (ACL, quota presets) can
  branch on it.

### Microsoft 365 (local JWT mode)

```yaml
auth:
  oauth2:
    - oauth2_mode: local
      oauth2_jwks_url: https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys
      oauth2_issuers:
        - https://login.microsoftonline.com/<tenant>/v2.0
      oauth2_audience: "<azure-app-id>"
      oauth2_scope: [openid, email, profile]
      oauth2_username_attribute: preferred_username
      oauth2_fields: [oid, tid, roles]
```

- `oauth2_username_attribute: preferred_username` — Microsoft's email is
  in this claim, not `email`.
- `oauth2_fields: [roles]` projects Azure AD app roles for
  downstream policy.

### Keycloak / Authelia (introspection mode)

```yaml
auth:
  oauth2:
    - oauth2_mode: introspection
      oauth2_introspection_url: https://keycloak.example/realms/yarilo/protocol/openid-connect/token/introspect
      oauth2_introspection_mode: post
      oauth2_client_id: yarilo-auth
      oauth2_client_secret: "${KEYCLOAK_CLIENT_SECRET}"
      oauth2_issuers: [https://keycloak.example/realms/yarilo]
      oauth2_audience: yarilo-auth
      oauth2_username_attribute: email
      oauth2_active_attribute: active
      oauth2_active_value: "true"
      oauth2_fields: [sub, realm_access]
```

- Keycloak's introspection endpoint requires client credentials
  HTTP Basic auth.
- `oauth2_client_secret` expands `${ENV}`, like a passdb `dsn`, so it can
  come from a Secret (through the chart: [`client_secret_ref`](#helm)).
  2.4.1 and earlier take it literally.
- `oauth2_active_attribute: active` + `oauth2_active_value: "true"` enforces the
  RFC 7662 `active` field explicitly even when client + server
  versions disagree on the default.

### Chained provider order

The OAuth chain runs **before** SQL. The order within
`auth.oauth2` is honoured — list the strictest / cheapest provider
first:

```yaml
auth:
  oauth2:
    - oauth2_mode: local        # try cached JWKS first
      oauth2_jwks_url: https://idp.example/jwks.json
    - oauth2_mode: introspection  # fall through to introspection for opaque tokens
      oauth2_introspection_url: https://idp.example/introspect
      oauth2_client_id: yarilo
      oauth2_client_secret: …
  passdb:
    - driver: sqlite     # SQL fallback for app passwords
      dsn: /var/lib/yarilo/users.db
```

A login that supplies an opaque token falls through `local` (no
matching signature → `ResultNext`) and lands in `introspection`. A token
from OAUTHBEARER or XOAUTH2 only ever meets the OAuth entries: when none
accepts it, the login is refused, and SQL never sees it as a password.
A login with a username + plaintext password is tried as a token by both
OAuth entries, fails, and reaches SQL. With `oauth2_grant_url` on an entry,
that password is first exchanged at the IdP; `invalid_grant` passes it on to
SQL, while an unreachable IdP stops the chain with a temporary failure.

## Error mapping

Validator-level errors translate to chain results:

| Validator error | Chain result | Effect |
|:---|:---|:---|
| `ErrUpstream` (network / 5xx, grant failure other than `invalid_grant`) | `ResultTempFail` | Caller maps to `temp_fail`; the internal failure delay applies, the penalty counter is not raised |
| `ErrTokenExpired` / `ErrTokenInvalid` / `ErrTokenInactive` / grant `invalid_grant` | `ResultNext` | The next OAuth entry tries; a PLAIN/LOGIN password goes on to SQL |
| `ErrUsernameMismatch` / `ErrIssuerMismatch` / `ErrAudienceMismatch` / `ErrScopeMissing` / `ErrInactiveAccount` | `ResultNext` | Same |

A deployment that mixes OAuth and SQL accounts handles both with one
chain: tokens are decided by the OAuth entries, passwords by SQL (after an
OAuth entry has tried them as a token, or through its password grant). 2.4.3-dev.21
and earlier handed a refused bearer token on to SQL as a password.

A temporary failure reaches the client as one: IMAP `NO [UNAVAILABLE]`,
POP3 `-ERR [SYS/TEMP]`, submission `454 4.7.0`, ManageSieve `NO (TRYLATER)`;
a refused token or password is `[AUTHENTICATIONFAILED]`, `[AUTH]`, `535`,
`(AUTHENTICATIONFAILED)`. 2.4.3-dev.21 and earlier answered both the same way.

## Privacy notes

- `local` mode never sends the bearer token to a third party.
  Only the IdP's public JWKS is fetched (no token leaves the auth
  pod).
- `introspection` / `tokeninfo` / `discovery` send the token to
  the configured endpoint. Use HTTPS endpoints exclusively.
- The auth cache (`auth.cache.auth_cache_size` set) caches validated
  tokens as HMAC, not plaintext. Set
  `auth.cache.auth_cache_ttl` shorter than the token's typical `exp`
  so revocation propagates within one cache window.

## Tuning notes

- For `local` mode, the JWKS auto-refreshes every hour and on an unknown
  `kid`, at most once per `oauth2_jwks_unknown_kid_interval_seconds`. A
  token whose `iss` is not in `oauth2_issuers` is refused before the JWKS is
  asked, so it cannot use that refresh up and delay a key rotation; set
  `oauth2_issuers` for that protection.
- For `introspection` / `tokeninfo` / `discovery`, pair with
  `auth.cache` to avoid one HTTP call per IMAP IDLE reconnect.
- `oauth2_token_expire_grace_seconds: 60` covers normal clock skew. Set
  higher (300+) when the IdP and the auth pod are in different
  data centres with poor NTP discipline.

## Client smoke-test recipes

Acquire a bearer token from the IdP (Google: `oauth2l fetch`;
Azure: `az account get-access-token`; Keycloak: `kcadm.sh` or
direct token endpoint POST). Then:

### `swaks` (Submission)

```sh
TOKEN="$(oauth2l fetch --scope='https://mail.google.com/' …)"
swaks --server mail.yarilo.example:587 \
      --tls --tls-verify \
      --auth OAUTHBEARER --auth-user alice@example.com \
      --auth-password "$TOKEN" \
      --from alice@example.com --to bob@example.com
```

### `openssl s_client` + raw SASL (IMAP / POP3)

```sh
TOKEN="…"
PAYLOAD=$(printf 'n,a=alice@example.com,\1auth=Bearer %s\1\1' "$TOKEN" | base64 -w0)

# IMAP
openssl s_client -quiet -connect mail.yarilo.example:993 <<EOF
a1 AUTHENTICATE OAUTHBEARER $PAYLOAD
a2 SELECT INBOX
a3 LOGOUT
EOF

# POP3
openssl s_client -quiet -connect mail.yarilo.example:995 <<EOF
AUTH OAUTHBEARER $PAYLOAD
STAT
QUIT
EOF
```

### Thunderbird

Settings → Account → Authentication method → **OAuth2**. On the
first connection Thunderbird opens the IdP's consent page;
subsequent reconnects refresh the access token automatically.
