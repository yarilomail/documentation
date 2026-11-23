---
title: "DKIM signing per domain with dkim-milter"
description: "dkim-milter signs outgoing mail with the DKIM key of each From domain: keys in a database table, private keys encrypted with Vault Transit, a key cache."
---

# DKIM signing with dkim-milter

[dkim-milter](https://github.com/yarilomail/dkim-milter) is a Postfix milter
that DKIM-signs each message with the key of its `From:` domain. Keys live
per domain in a database table, private keys are encrypted with Vault
Transit, and signing happens in memory.

It runs beside the Postfix relays of
[yarilo-postfix](https://github.com/yarilomail/yarilo-postfix), after
mailfrom-milter, which refuses a message whose `From:` does not match its
envelope sender.

## Signing a message

The signing domain is the domain of the first address in `From:`.

- The algorithm is RSA or Ed25519, by the key.
- A field is signed only when the message has it: once per time it is there.
  A field the message does not have stays out of the signature, so a mailing
  list that adds `List-Id` later leaves the signature valid.
- `From` is always signed and guarded: it is listed in the signature once more
  than the message has it, so a `From` added later breaks the signature.
- Which fields are signed, never signed and guarded, and the canonicalization,
  are [settings](#signed-header-fields).
- The `DKIM-Signature` field goes at the top of the header.

The body is streamed into the signature and never held, so memory does not
grow with the message size. A message it cannot sign (no `From` domain, no
key, a signing error) is accepted unsigned with one log line; the milter
never refuses mail.

### Signed header fields

| Value | Variable | Default | What |
|:---|:---|:---|:---|
| `signHeaders` | `SIGN_HEADERS` | `*,+Message-ID,+MIME-Version,+Content-Type,+Content-Transfer-Encoding` | fields signed when the message has them |
| `omitHeaders` | `OMIT_HEADERS` | `*` | fields never signed; wins over `signHeaders` |
| `oversignHeaders` | `OVERSIGN_HEADERS` | `From` | fields listed once more than the message has them, once when it has none, so one added later breaks the signature |
| `canonicalization` | `CANONICALIZATION` | `relaxed/simple` | header/body, each `relaxed` or `simple` |

`*` stands for a standard list:

- in `signHeaders`: `From`, `Reply-To`, `Subject`, `Date`, `To`, `Cc`,
  `Resent-Date`, `Resent-From`, `Resent-Sender`, `Resent-To`, `Resent-Cc`,
  `In-Reply-To`, `References`, `List-Id`, `List-Help`, `List-Unsubscribe`,
  `List-Subscribe`, `List-Post`, `List-Owner`, `List-Archive` (the fields
  RFC 6376 section 5.4 says should be signed);
- in `omitHeaders`: `Return-Path`, `Received`, `Comments`, `Keywords`, `Bcc`,
  `Resent-Bcc`, `DKIM-Signature`.

The lists are comma-separated names, compared without case. A list with `*`
is a change to the standard list: `+Name` adds a field, `-Name` removes one,
so `*,-Cc` is the standard list without `Cc`. A list without `*` replaces the
standard list entirely.

`From` is always signed and guarded: `-From` in `signHeaders` and `From` in
`omitHeaders` are ignored, and an empty `oversignHeaders` means `From` only.

The milter does not start, and names the setting and its value, when
`signHeaders` is empty, when a field in `oversignHeaders` is not signed or is
in `omitHeaders`, when an entry of any of the three lists is not a header
field name (it has a space or a colon), and when `canonicalization` is empty
or has a word other than `relaxed` and `simple`. A lone word sets the header canonicalization; the
body is then `simple`.

`relaxed` for the body forgives changed whitespace at the ends of lines on
the way, but not a change to the content.

## Who may have mail signed

Only a client that logged in with SASL has mail signed; Postfix's
`{auth_authen}` macro names the login. `SIGN_AUTH` chooses which logins:

| Value | Signed when |
|:---|:---|
| `aligned` (default) | the login's domain is the `From:` domain |
| `any` | any login; for a listener where only trusted accounts can log in |

Under `aligned`, `bob@example.org` may send `From: alice@example.org`; a
subdomain is another domain. Mail without a login is never signed, and no
setting changes that: a signer that signs whatever reaches it would sign for
anyone who reaches Postfix.

yarilo-postfix runs two releases:

- `dkim-milter`, `aligned`, for relay-mta, where yarilo's Submission and JMAP
  sending log in as the sending user.
- `dkim-milter-fwd`, `any` with `SIGN_DOMAIN`, for relay-fwd-out, where only
  relay-fwd logs in.

## Forwarded mail

relay-fwd carries mail yarilo makes (vacation replies, notifications) and
mail it passes on (a Sieve `redirect`). A redirected copy did not come from
its author's domain, so that domain's key must not sign it.

With `SIGN_DOMAIN` set, the milter tells the two apart by the `Received`
fields Postfix passes it:

- `SIGN_HOPS_BEFORE` is the number of Postfix hops between yarilo and this
  signer. A message with no more `Received` fields than that was made by
  yarilo and is signed with its `From` domain's key.
- A message with more was forwarded. It is signed with the key of
  `SIGN_DOMAIN`, `d=` that domain. The author's own signature stays as it was.

With relay-fwd passing mail to relay-fwd-out, which signs, the number is 1.
Every hop added between yarilo and the signer raises it by one.

`SIGN_DOMAIN` is also the SRS domain of postsrsd, so a forwarded message
carries one domain in its envelope and its signature. That domain needs its
own row in the key table and its own DNS records; see
[DNS for a mail domain](/installation/dns).

::: warning
Set `SIGN_DOMAIN` only on the listener where yarilo's Sieve sender logs in.
On a listener for mail clients, a client's own MTA adds a `Received`, and the
user's mail would be signed with the forwarder's key.
:::

## Keys

Keys are rows in the table `dkim`: `domain`, `selector`, `public_key`,
`private_key_enc`, `created_at`. The repository ships the schema for
PostgreSQL and MySQL.

- A domain may have one row per selector; its newest row signs.
- The selectors `arc` and `arc-*` (`arc-2027` after a rotation) belong to
  [arc-milter](/relay/arc_milter), whose ARC keys sit
  in the same table on the forwarder's domain. They never sign DKIM, however
  new, so a DKIM selector may not be named so.
- The domain is compared without case and surrounding spaces.
- With `KEY_DECRYPT=vault`, `private_key_enc` is the PEM private key
  encrypted with the Vault Transit key `dkim`. The database, its dumps and
  its backups hold ciphertext only.

### Key cache

Keys load on demand. The first message of a domain reads its row, decrypts
that one key and keeps it in an LRU cache of `KEY_CACHE_SIZE` entries.

- After `KEY_CACHE_TTL_SECONDS` the cached key keeps signing while one
  background read takes the row again, so a new selector shows within that
  time.
- A domain with no usable row is remembered as keyless for
  `KEY_CACHE_MISS_TTL_SECONDS`; its mail goes unsigned.
- A parsed RSA-2048 key takes about 5 KB, Ed25519 under 1 KB. The default of
  10 000 keys fits the chart's 128Mi memory limit.

When the database or Vault fails, the cache keeps answering from what it
has, past the TTLs. Only a domain the cache has never seen gets a temporary
failure, and Postfix keeps the message and retries.

### Adding a domain

Generate the key pair and encrypt the private key with Vault Transit:

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out example.org.key
openssl pkey -in example.org.key -pubout -outform DER | base64 -w0 > example.org.pub
vault write -field=ciphertext transit/encrypt/dkim plaintext="$(base64 -w0 < example.org.key)" > example.org.enc
```

Insert the row:

```sql
INSERT INTO dkim (domain, selector, public_key, private_key_enc)
VALUES ('example.org', 's2026', '<example.org.pub>', '<example.org.enc>');
```

Publish the public key:

```
s2026._domainkey.example.org.  3600  IN  TXT  "v=DKIM1; k=rsa; p=<example.org.pub>"
```

This sequence:

- keeps the private key in plain text only on the machine that made it;
  delete `example.org.key` once the row is in;
- for Ed25519, use `openssl genpkey -algorithm ED25519` and publish
  `k=ed25519` with the raw 32-byte public key in `p=`.

### Rotating a selector

1. Publish the new selector's TXT record and wait until it resolves.
2. Insert the new row. Being the newest, it signs within `KEY_CACHE_TTL_SECONDS`.
3. Once the old selector's last signatures are older than the TXT record's
   TTL plus `KEY_CACHE_TTL_SECONDS`, delete the old row, then its TXT record.

In that order every signature a receiver sees has its key in DNS.

### Upgrading an older key table

The key query reads `created_at` and uses an index on `lower(trim(domain))`.
A table made before 0.1.0 lacks them. For MySQL:

```sql
ALTER TABLE dkim
  ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD KEY idx_domain_lookup ((lower(trim(domain))), created_at, id),
  DROP KEY idx_domain;
```

For PostgreSQL:

```sql
ALTER TABLE dkim ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS dkim_domain_lookup ON dkim (lower(trim(domain)), created_at DESC, id DESC);
DROP INDEX IF EXISTS dkim_domain;
UPDATE dkim SET domain = lower(trim(domain)) WHERE domain <> lower(trim(domain));
ALTER TABLE dkim ADD CONSTRAINT dkim_domain_normalized CHECK (domain = lower(trim(domain)));
```

::: warning
Run it before deploying the new image. Until then the new pod's key query
fails and it stays not ready, while the old pod keeps signing.
:::

## Vault Transit

Create the Transit key, a decrypt-only policy and the Kubernetes auth role:

```sh
vault secrets enable transit
vault write -f transit/keys/dkim
vault policy write dkim-milter - <<'EOF'
path "transit/decrypt/dkim" { capabilities = ["update"] }
EOF
vault write auth/kubernetes/role/dkim-milter \
  bound_service_account_names=dkim-milter,dkim-milter-fwd \
  bound_service_account_namespaces=<namespace> \
  policies=dkim-milter ttl=10m
```

The signer only decrypts; whoever adds keys needs `transit/encrypt/dkim`.

## Postfix configuration

Add the milter after mailfrom-milter:

```
smtpd_milters = inet:mailfrom-milter:10031, inet:dkim-milter:8891
non_smtpd_milters = inet:dkim-milter:8891
milter_default_action = tempfail
```

`tempfail` keeps mail queued while the signer is down instead of sending it
unsigned. yarilo-postfix sets this through `dkimMilter.addr`.

## Readiness

`/readyz` answers 200 once the key query has run and, with Vault, a login
has succeeded and the token may decrypt with the Transit key. The query runs
for the domain `readiness-probe.invalid`, which no row has. A wrong query, a
missing table or column, or a policy without decrypt keep the pod not ready,
with the reason logged. No key is loaded before the first message.

## Environment

| Variable | Default |
|:---|:---|
| `LISTEN_ADDR` | `0.0.0.0:8891` |
| `METRICS_ADDR` | `0.0.0.0:8081` |
| `DB_DRIVER` | `postgres` (or `mysql`) |
| `DB_DSN` | none |
| `DB_MAX_OPEN_CONNS` | `10` |
| `DKIM_SQL_QUERY` | the newest row of one domain, `arc` and `arc-*` left out; a query of your own must leave them out too |
| `SIGN_AUTH` | `aligned` |
| `SIGN_DOMAIN` | none |
| `SIGN_HOPS_BEFORE` | `0` |
| `SIGN_HEADERS`, `OMIT_HEADERS`, `OVERSIGN_HEADERS` | `*,+Message-ID,+MIME-Version,+Content-Type,+Content-Transfer-Encoding`, `*`, `From` ([signed header fields](#signed-header-fields)) |
| `CANONICALIZATION` | `relaxed/simple` |
| `KEY_DECRYPT` | `vault` (or `none` for PEM in the column) |
| `KEY_CACHE_SIZE` | `10000` |
| `KEY_CACHE_TTL_SECONDS` | `600` |
| `KEY_CACHE_MISS_TTL_SECONDS` | `60` |
| `VAULT_ADDR`, `VAULT_ROLE` | none, required with `vault` |
| `VAULT_AUTH_PATH` | `kubernetes` |
| `VAULT_TRANSIT_PATH`, `VAULT_TRANSIT_KEY` | `transit`, `dkim` |
| `VAULT_CACERT` | none |
| `MILTER_READ_TIMEOUT_SECONDS` | `3600` |
| `MILTER_WRITE_TIMEOUT_SECONDS` | `60` |
| `LOG_LEVEL` | none (`debug` for more) |

## Helm chart

The chart in the repository's `helm/` sets every variable above from its
values; the chart's defaults are the code's.

| Value | Default | Meaning |
|:---|:---|:---|
| `image.repository`, `.tag` | `docker.io/0kaba0/dkim-milter`, the chart's `appVersion` | the image |
| `replicaCount` | `1` | stateless, any number |
| `milterPort`, `metricsPort` | `8891`, `8081` | ports |
| `milterReadTimeoutSeconds`, `milterWriteTimeoutSeconds` | `3600`, `60` | `MILTER_READ_TIMEOUT_SECONDS`, `MILTER_WRITE_TIMEOUT_SECONDS` |
| `db.driver` | `postgres` | `postgres` or `mysql` |
| `db.dsnSecret.name`, `.key` | none, `DB_DSN` | the Secret with the DSN |
| `db.query` | the driver's default | `DKIM_SQL_QUERY` |
| `db.maxOpenConns` | `10` | `DB_MAX_OPEN_CONNS` |
| `signAuth`, `signDomain`, `signHopsBefore` | `aligned`, none, `0` | `SIGN_AUTH`, `SIGN_DOMAIN`, `SIGN_HOPS_BEFORE` |
| `signHeaders`, `omitHeaders`, `oversignHeaders`, `canonicalization` | see [signed header fields](#signed-header-fields) | `SIGN_HEADERS`, `OMIT_HEADERS`, `OVERSIGN_HEADERS`, `CANONICALIZATION` |
| `keyDecrypt` | `vault` | `KEY_DECRYPT` |
| `keyCache.size`, `.ttlSeconds`, `.missTtlSeconds` | `10000`, `600`, `60` | the key cache |
| `resources.limits.memory` | `128Mi` | room for `keyCache.size` keys |
| `vault.addr`, `vault.role` | none | required with `vault` |
| `vault.authPath`, `.transitPath`, `.transitKey` | `kubernetes`, `transit`, `dkim` | mounts and key |
| `vault.caCertSecret` | none | a Secret with `ca.crt` for Vault's certificate |
| `vault.caCertificate.issuerRef.name`, `.kind` | none, `Issuer` | with a name, a cert-manager Certificate writes `vault.caCertSecret` from that issuer's CA |
| `networkPolicy.enabled` | `false` | the milter port only from the Postfix pods; the metrics port from anywhere |
| `networkPolicy.postfix.podSelector`, `.namespaceSelector` | none, this namespace | the Postfix pods that run the milter |
| `logLevel` | none | `debug` |

Every resource is named after the release, so two releases (`dkim-milter`
and `dkim-milter-fwd`) share a namespace; the ServiceAccount is the release's
name, and the Vault role binds both. Its token is mounted only with
`keyDecrypt: vault`.

::: warning
A NetworkPolicy is enforced only by a CNI that implements it, such as Calico,
Cilium, or the kube-router built into k3s. With flannel alone it is accepted
and silently ignored.
:::

Images: Docker Hub (`0kaba0/dkim-milter`) keeps the releases and `latest`;
GHCR (`ghcr.io/yarilomail/dkim-milter`) also carries the `develop` builds.

## Logs and metrics

Logs are JSON on stdout, one line per message: `dkim: signed` with domain,
selector and queue id, or the reason it was not signed.

| Metric | Meaning |
|:---|:---|
| `dkim_messages_total{result}` | `signed`, `no_key`, `no_from`, `unauthorized`, `tempfail`, `error` |
| `dkim_keys_loaded` | domains with a key in the cache |
| `dkim_key_cache_lookups_total{result}` | `hit`, `negative_hit`, `stale`, `miss` |
| `dkim_key_fetch_errors_total{stage}` | `db`, `vault`, `parse` |
