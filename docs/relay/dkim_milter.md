---
description: "dkim-milter signs outgoing mail with the DKIM key of each From domain: keys per domain in a database table, private keys encrypted with Vault Transit, a bounded key cache, and who may have mail signed."
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

- Canonicalization is `relaxed/simple`; the algorithm is RSA or Ed25519, by the key.
- `From` is signed twice, so a `From` added later breaks the signature.
- The other signed fields: `Reply-To`, `Subject`, `Date`, `To`, `Cc`,
  `Message-ID`, `In-Reply-To`, `References`, `MIME-Version`, `Content-Type`,
  `Content-Transfer-Encoding`, `List-Id`, `List-Unsubscribe`,
  `List-Unsubscribe-Post`.
- The `DKIM-Signature` field goes at the top of the header.

The body is streamed into the signature and never held, so memory does not
grow with the message size. A message it cannot sign (no `From` domain, no
key, a signing error) is accepted unsigned with one log line; the milter
never refuses mail.

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
has succeeded and the token may decrypt with the Transit key. A wrong query,
a missing table or column, or a policy without decrypt keep the pod not
ready, with the reason logged.

## Environment

| Variable | Default |
|:---|:---|
| `LISTEN_ADDR` | `0.0.0.0:8891` |
| `METRICS_ADDR` | `0.0.0.0:8081` |
| `DB_DRIVER` | `postgres` (or `mysql`) |
| `DB_DSN` | none |
| `DB_MAX_OPEN_CONNS` | `10` |
| `DKIM_SQL_QUERY` | the newest row of one domain |
| `SIGN_AUTH` | `aligned` |
| `SIGN_DOMAIN` | none |
| `SIGN_HOPS_BEFORE` | `0` |
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

The Helm chart in the repository sets each of these from its values; the
repository's README lists them.

## Logs and metrics

Logs are JSON on stdout, one line per message: `dkim: signed` with domain,
selector and queue id, or the reason it was not signed.

| Metric | Meaning |
|:---|:---|
| `dkim_messages_total{result}` | `signed`, `no_key`, `no_from`, `unauthorized`, `tempfail`, `error` |
| `dkim_keys_loaded` | domains with a key in the cache |
| `dkim_key_cache_lookups_total{result}` | `hit`, `negative_hit`, `stale`, `miss` |
| `dkim_key_fetch_errors_total{stage}` | `db`, `vault`, `parse` |
