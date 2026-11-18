---
title: "ARC sealing for forwarded mail (arc-milter)"
description: "arc-milter adds an ARC set (RFC 8617) to mail a forwarding relay passes to other domains: it checks the incoming chain and seals with the forwarder's key."
---

# ARC sealing with arc-milter

[arc-milter](https://github.com/yarilomail/arc-milter) is a Postfix milter
that adds an ARC set ([RFC 8617](https://www.rfc-editor.org/rfc/rfc8617)) to
each message the forwarding relay passes on. A Sieve `redirect` breaks SPF,
and often the author's DKIM signature, for the receiver of the forwarded
copy. The ARC set tells that receiver what the forwarder saw when the message
first arrived, signed with the forwarder's key, so a receiver that trusts the
forwarder can still deliver mail from a domain with a strict DMARC policy.

## Where it runs

arc-milter runs on relay-fwd-out of
[yarilo-postfix](https://github.com/yarilomail/yarilo-postfix), after
dkim-milter-fwd, so its signature covers the forwarder's `DKIM-Signature`.
relay-fwd-out carries the mail yarilo sends to other domains, so ARC applies
to a redirect to another domain only. A redirect to a mailbox of a local
domain goes from relay-fwd straight to delivery and is not sealed: it never
leaves the installation.

The MX does not seal. It stamps inbound mail with an `Authentication-Results`
in its own name (the authserv-id, its `myhostname`), and arc-milter copies
that header. Nothing else may claim that name:

- rspamd on relay-mx removes an `Authentication-Results` with that authserv-id
  that arrived from outside;
- relay-mta, where every message comes from a login, drops one with a
  `header_checks` rule, so a user cannot write results in the MX's name into
  a message a redirect then seals. A message attached inside keeps its
  header.

## Sealing a message

At the end of the headers:

1. arc-milter collects the ARC sets the message came with. If the newest
   `ARC-Seal` says `cv=fail`, the chain ended at that hop and nothing is
   added. The new instance is one above the highest `i=` any ARC field names,
   a broken one included, so a number is never used twice; a chain already at
   instance 50 gets nothing.
2. It reads the key (see below). A message that will not be sealed is
   accepted here, and Postfix sends the milter no body for it.

At the end of the message:

3. It validates the chain: sets 1 to n, each with exactly one of the three
   fields; the newest `ARC-Message-Signature` against the body and fields;
   every `ARC-Seal` from n down to 1, `cv=none` on the first and `cv=pass` on
   the others. A key under 1024 bits fails its signature. The result is this
   hop's `cv`: `none` without a chain, `pass` or `fail`.
4. It adds instance n+1 at the top of the header:
   - `ARC-Authentication-Results`: `i=`, then the first
     `Authentication-Results` with the MX's authserv-id, as it stands; without
     one, `<authserv-id>; none`.
   - `ARC-Message-Signature`: `rsa-sha256`, `relaxed/relaxed`, over `From`
     (once more than it appears, so a `From` added later breaks it),
     `Reply-To`, `Subject`, `Date`, `To`, `Cc`, `Message-ID`, `In-Reply-To`,
     `References`, `MIME-Version`, `Content-Type`,
     `Content-Transfer-Encoding`, the `List-*` fields and `DKIM-Signature`.
   - `ARC-Seal`: `rsa-sha256` with this hop's `cv`. A chain this hop found
     broken is sealed `cv=fail`, and that seal signs only its own set.

The body is streamed through the hashes and never held.

## When it cannot seal

| Case | What happens |
|:---|:---|
| The key was read before; the database or Vault is down now | sealed with the cached key |
| The key was never read; the database or Vault is down | temporary failure: Postfix keeps the message and retries |
| No row for the seal domain with the ARC selector | passed on unsealed, counted as `no_key`: a configuration gap, not an outage |
| A key lookup in DNS fails for any reason but a name that does not exist | temporary failure at the end of the message, never a `cv=fail` seal |
| The same key name has kept failing so for `DNS_TEMPFAIL_GRACE_SECONDS` (4 hours) | that signature counts as failed and the message is sealed `cv=fail`, instead of waiting in the queue to the end of its life |
| The newest `ARC-Message-Signature` uses `simple` header canonicalization and does not check | passed on unsealed, counted as `simple_unverifiable` |

All the key lookups of one message share one deadline,
`DNS_TIMEOUT_SECONDS`. Any answer from DNS clears a name's count of
failures. `DNS_FAILURE_STORE` says where the first failure of each name is
kept: `memory` (the default) in the process, so a restart or another replica
starts the count again; `redis`, shared by the replicas and kept over
restarts, under `REDIS_KEY_PREFIX` with a TTL of the grace plus a day. While
Redis does not answer, the count goes on in the process.

::: warning
The last row exists because the milter protocol makes Postfix drop the space
after a field's colon. arc-milter puts the usual single space back; an
earlier hop that signed `simple` header bytes with no space or two cannot be
checked here, and a `cv=fail` on a sound chain could not be undone by anyone
after.
:::

## Keys

ARC defines `rsa-sha256` only, so the key is RSA. It is a row in the same
`dkim` table as dkim-milter's keys:

- `domain` is the forwarder's domain, the one dkim-milter-fwd signs with and
  postsrsd rewrites to;
- `selector` is `arc`, or after a rotation `arc-<label>` (`arc-2027`).
  dkim-milter never signs with these selectors, however new, so a DKIM
  selector may not be named so, and arc-milter refuses any other
  `ARC_SELECTOR` at start;
- `private_key_enc` is the PEM key encrypted with the Vault Transit key
  `arc`, never with dkim-milter's `dkim`.

The key loads on the first message into the same kind of cache as
dkim-milter's, and keeps sealing past its TTL while the row is read again.

### Adding the key

```sh
umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out arc.key
openssl pkey -in arc.key -pubout -outform DER | base64 | tr -d '\n' > arc.pub
{ printf '{"plaintext":"'; base64 < arc.key | tr -d '\n'; printf '"}'; } | \
  curl -s --cacert "$VAULT_CACERT" -H "X-Vault-Token: $VAULT_TOKEN" -d @- \
  "$VAULT_ADDR/v1/transit/encrypt/arc" | jq -r '.data.ciphertext' > arc.enc
shred -u arc.key
```

The private key goes to `curl` on its standard input, never as an argument,
and is overwritten and deleted once encrypted. On macOS, where there is no
`shred`, the last line is `rm -P arc.key`. Then insert the row and publish the public
key:

```sql
INSERT INTO dkim (domain, selector, public_key, private_key_enc)
VALUES ('fwd.example.org', 'arc', '<arc.pub>', '<arc.enc>');
```

```
arc._domainkey.fwd.example.org.  3600  IN  TXT  "v=DKIM1; k=rsa; p=<arc.pub>"
```

To rotate, publish the new selector's TXT record, insert a row with
`arc-<label>`, set `ARC_SELECTOR` to it, and remove the old row and record
once the old seals are older than the record's TTL.

## Vault Transit

arc-milter has a Transit key, a decrypt-only policy and a Kubernetes role of
its own: key `arc`, policy `arc-milter-decrypt`, role `arc-milter` for the
ServiceAccount `arc-milter`.

::: warning
Never give arc-milter dkim-milter's role or the key `dkim`. That key decrypts
every client domain's DKIM key, and arc-milter parses the most hostile input
there is: other servers' headers and DNS answers from the domains they name.
A flaw in it must reach the ARC key alone.
:::

```sh
vault write -f transit/keys/arc
vault policy write arc-milter-decrypt - <<'EOF'
path "transit/decrypt/arc" { capabilities = ["update"] }
EOF
vault write auth/kubernetes/role/arc-milter \
  bound_service_account_names=arc-milter \
  bound_service_account_namespaces=<namespace> \
  policies=arc-milter-decrypt ttl=10m
```

Check both ways that the arc-milter role cannot decrypt with `dkim`, and
dkim-milter's role cannot decrypt with `arc`.

## Postfix configuration

On relay-fwd-out, after the DKIM signer:

```
smtpd_milters = { inet:dkim-milter-fwd:8891, default_action=tempfail },
                { inet:arc-milter:8893, default_action=tempfail }
```

`tempfail` keeps a forward queued while the sealer is down. yarilo-postfix
sets this through `fwdOut.arcMilter.addr`. Enable it only once an arc-milter
pod is ready: with no ready pod behind the address, every forward waits.

## Readiness

`/readyz` answers 200 once the key query has run and, with Vault, a login as
the role has succeeded and the token may decrypt with the Transit key. A
missing role, a wrong query or a policy without decrypt keep the pod not
ready, with the reason logged.

## Environment

| Variable | Default |
|:---|:---|
| `SEAL_DOMAIN` | none, required: `d=` of every seal and the key row's domain |
| `ARC_SELECTOR` | `arc` (or `arc-<label>`) |
| `AUTHSERV_ID` | none, required: the MX's authserv-id |
| `DNS_TIMEOUT_SECONDS` | `10` |
| `DNS_TEMPFAIL_GRACE_SECONDS` | `14400` |
| `DNS_FAILURE_STORE` | `memory` (or `redis`) |
| `REDIS_ADDR`, or `REDIS_SENTINEL_ADDRS` with `REDIS_SENTINEL_MASTER` | none, one required with `redis` |
| `REDIS_USERNAME`, `REDIS_PASSWORD`, `REDIS_DB` | none, none, `0` |
| `REDIS_SENTINEL_USERNAME`, `REDIS_SENTINEL_PASSWORD` | none |
| `REDIS_KEY_PREFIX` | none, required with `redis` |
| `LISTEN_ADDR` | `0.0.0.0:8893` |
| `METRICS_ADDR` | `0.0.0.0:8081` |
| `DB_DRIVER` | `postgres` (or `mysql`) |
| `DB_DSN` | none |
| `DB_MAX_OPEN_CONNS` | `4` |
| `ARC_SQL_QUERY` | the seal domain's newest row with the ARC selector; two placeholders, the domain and the selector |
| `KEY_DECRYPT` | `vault` (or `none` for PEM in the column) |
| `KEY_CACHE_SIZE`, `KEY_CACHE_TTL_SECONDS`, `KEY_CACHE_MISS_TTL_SECONDS` | `100`, `600`, `60` |
| `VAULT_ADDR`, `VAULT_ROLE` | none, required with `vault` |
| `VAULT_AUTH_PATH`, `VAULT_TRANSIT_PATH`, `VAULT_TRANSIT_KEY` | `kubernetes`, `transit`, `arc` |
| `VAULT_CACERT` | none |
| `MILTER_READ_TIMEOUT_SECONDS`, `MILTER_WRITE_TIMEOUT_SECONDS` | `3600`, `60` |
| `LOG_LEVEL` | none (`debug` for more) |

## Helm chart

The chart in the repository's `helm/` sets every variable above from its
values; the chart's defaults are the code's. `sealDomain` and `authservId`
are required; `selector`, `dnsTimeoutSeconds`, `dnsTempfailGraceSeconds`,
`dnsFailureStore` and `redis.*` set the rest of the sealing, and `db.*`,
`keyDecrypt`, `keyCache.*` and `vault.*` (`vault.transitKey` defaults to
`arc`) the key, as in [dkim-milter's chart](/relay/dkim_milter#helm-chart).
`networkPolicy.postfix` opens the milter port to the Postfix pods named
there; on yarilo-postfix that is relay-fwd-out alone.

::: warning
A NetworkPolicy is enforced only by a CNI that implements it, such as Calico,
Cilium, or the kube-router built into k3s. With flannel alone it is accepted
and silently ignored.
:::

## Logs and metrics

Logs are JSON on stdout, one line per message: `arc: sealed` with the
instance, the `cv` it found and the selector, or the reason it was not.

| Metric | Meaning |
|:---|:---|
| `arc_messages_total{result}` | `sealed`, `chain_failed`, `instance_limit`, `simple_unverifiable`, `no_key`, `tempfail_key`, `tempfail_dns`, `error` |
| `arc_chain_total{cv}` | sealed messages by the `cv` found: `none`, `pass`, `fail` |
| `arc_dns_temporary_errors_total` | key lookups that failed for a reason other than a missing name |
| `arc_dns_given_up_total` | of those, the ones taken as failed past the grace |
| `arc_redis_errors_total` | Redis calls that failed; the count went on in the process |
| `arc_keys_loaded`, `arc_key_cache_lookups_total{result}`, `arc_key_fetch_errors_total{stage}` | the key cache |
