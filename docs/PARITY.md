# Dovecot parity matrix

What yarilo covers of Dovecot's feature surface, feature by feature, so that
"drop-in replacement" is something you can check rather than something you have
to take on faith.

Three values are used, and **no** is as legitimate an answer as **yes**:

| | meaning |
|:---|:---|
| **yes** | implemented and exercised by tests; a Dovecot configuration using it has an equivalent here |
| **partial** | usable, with a stated limit — read the note before relying on it |
| **no** | not implemented. Where an issue exists it is linked, and that issue is where the plan lives |

This page is maintained in the same change that alters coverage: a row is
updated by the PR that moves it, not by a later sweep. A matrix that lags is
worse than none, because every row here is a promise somebody may migrate on.

The IMAP extension table below is **exhaustive for what is advertised**: every
capability in the server's `CAPABILITY` reply has a row here, and the rows
marked `no` name the notable extensions that are not advertised. Where this
page and a protocol page disagree, this one is the one kept current — the
disagreement is a bug in the other, and both are fixed together.

Version: **2.3.x line** (beta). Last reviewed 2026-08-25.

## Protocols

| Feature | yarilo | Notes |
|:---|:---|:---|
| IMAP4rev1 / IMAP4rev2 | yes | RFC 3501 / RFC 9051 |
| POP3 | yes | including `TOP`, `UIDL` |
| LMTP | yes | delivery, proxying to backends |
| Submission (MSA) | yes | separate service, relay to an external MTA |
| ManageSieve | yes | RFC 5804 |
| JMAP | partial | **reads and synchronises; does not write.** `Email/get`, `Mailbox/get`, `Thread/get`, `*/changes` with real state strings. `Email/set`, `Mailbox/set` and blob upload are not implemented ([#712](https://github.com/yarilomail/yarilo/issues/712)); push is not ([#714](https://github.com/yarilomail/yarilo/issues/714)) |

## IMAP extensions

| Extension | yarilo | Notes |
|:---|:---|:---|
| IDLE, UNSELECT, LITERAL+, ENABLE, SASL-IR | yes | |
| UIDPLUS, MOVE, NAMESPACE | yes | |
| CONDSTORE / QRESYNC | yes | RFC 7162 |
| ESEARCH, SEARCHRES | yes | RFC 4731 |
| LIST-EXTENDED, LIST-STATUS, STATUS=SIZE | yes | |
| SPECIAL-USE, CREATE-SPECIAL-USE | yes | RFC 6154 |
| SORT | yes | RFC 5256, all keys; `SORT=DISPLAY` (RFC 5957) is not implemented |
| THREAD | yes | RFC 5256, `REFERENCES` and `ORDEREDSUBJECT` |
| OBJECTID | yes | RFC 8474 — `MAILBOXID`, `EMAILID`, `THREADID` |
| BINARY | yes | RFC 3516 |
| NOTIFY | partial | RFC 5465; annotation/metadata events are not reported |
| METADATA | yes | RFC 5464, when a metadata dict is configured |
| ACL | yes | RFC 4314 |
| QUOTA | yes | RFC 9208 |
| ID | yes | RFC 2971 |
| COMPRESS | no | |
| URLAUTH, CATENATE, BURL | no | RFC 4467 / RFC 4469 / RFC 4468. Until 2026-08-25 the IMAP page listed URLAUTH as supported; it never was, and the claim is removed rather than kept |
| SEARCH=FUZZY, CONTEXT=SEARCH, CONTEXT=SORT, ESORT | no | |
| REPLACE, SAVEDATE, PREVIEW | no | |
| I18NLEVEL | no | collation follows `i;unicode-casemap` in SORT/THREAD, but the extension is not advertised |

## Storage

| Format | yarilo | Notes |
|:---|:---|:---|
| Maildir | yes | Maildir++, filename and flag conventions match |
| sdbox | yes | |
| mdbox | yes | including the map, alt storage, and `purge` |
| mbox | no | no plan; the format is legacy in Dovecot too |
| obox / object storage | no | [#247](https://github.com/yarilomail/yarilo/issues/247) |
| Index format | yes | Dovecot's on-disk index layout, byte-compatible where documented |

## Authentication

| Feature | yarilo | Notes |
|:---|:---|:---|
| SASL PLAIN / LOGIN | yes | |
| SASL SCRAM-SHA-1 / SHA-256 / SHA-256-PLUS | yes | channel binding included |
| SASL XOAUTH2 / OAUTHBEARER | yes | with token introspection |
| SASL CRAM-MD5, DIGEST-MD5 | no | [#245](https://github.com/yarilomail/yarilo/issues/245) |
| SASL EXTERNAL (client certificates) | no | [#615](https://github.com/yarilomail/yarilo/issues/615) |
| SASL GSSAPI / Kerberos | no | [#245](https://github.com/yarilomail/yarilo/issues/245) |
| passdb/userdb: SQL (MySQL, PostgreSQL, SQLite) | yes | |
| passdb/userdb: passwd-file, static | yes | |
| passdb/userdb: LDAP, PAM, Lua, IMAP | no | [#558](https://github.com/yarilomail/yarilo/issues/558) |
| Password schemes | partial | `PLAIN`, `CLEARTEXT`, `CRYPT`, `BCRYPT`/`BLF-CRYPT`, `SHA512-CRYPT`, `SCRAM-SHA-1`, `SCRAM-SHA-256`. Dovecot's older MD5 and SHA1 families are not implemented |
| Master users | yes | |
| Auth policy / penalty (weakforced-style) | yes | |

## Filtering and delivery

| Feature | yarilo | Notes |
|:---|:---|:---|
| Sieve (RFC 5228) | yes | |
| Sieve extensions | yes | 43 extensions, including `imap4flags`, `editheader`, `enotify`, `imapsieve`, `mailboxid`, `spamtest`/`virustest` and the RFC 5703 MIME set. The full list is on the [Sieve page](/SIEVE) rather than repeated here — one list cannot disagree with itself |
| Sieve `pipe` / external programs | yes | with a configured binary directory |
| LDA (`dovecot-lda` equivalent) | partial | delivery is via LMTP; there is no standalone local-delivery binary |
| Recipient rate limiting | yes | cluster-wide, per (sender IP, recipient) |

## Search

| Feature | yarilo | Notes |
|:---|:---|:---|
| FTS with Xapian (flatcurve) | yes | separate `yarilo-fts` service |
| FTS: Solr, Elasticsearch | no | the engine is pluggable, no other engine is implemented |
| Language handling, stemming | yes | per-language filters, tokeniser knobs |

## Quota

| Feature | yarilo | Notes |
|:---|:---|:---|
| Storage and message-count quotas | yes | counted from the index, no dict drift |
| `quota_rule` / per-user overrides | yes | |
| Quota warnings | yes | |
| `quota-status` policy service for MTAs | yes | separate service |

## Clustering and operations

| Feature | yarilo | Notes |
|:---|:---|:---|
| Director (per-user backend affinity) | yes | own ring and peer sync, plus a `flush_socket` hook |
| Replication (dsync) | no | [#249](https://github.com/yarilomail/yarilo/issues/249) |
| Shared and public namespaces | partial | namespaces and ACLs work; cross-user delivery and some enforcement gaps remain ([#544](https://github.com/yarilomail/yarilo/issues/544)) |
| imap-hibernate | no | idle IMAP sessions are not parked into a separate process; each holds its own. No issue open yet — this row is the record |
| Prometheus metrics, health endpoints | yes | beyond Dovecot's own stats surface |
| `doveadm`-equivalent administration | partial | `yarilo-admin` and `yarctl` cover the operations the services expose; the command set is not a one-to-one map of `doveadm` |

## What "drop-in" means here

Configuration keys keep Dovecot's names where the setting means the same thing,
so `dovecot.conf` → `yarilo.yaml` is mechanical for the covered surface. The
on-disk formats — Maildir, dbox, the index — are the same layouts, which is
what makes a migration a matter of pointing yarilo at existing mail rather than
converting it.

Where a row above says **no**, a Dovecot configuration using that feature has no
equivalent yet, and the linked issue is the honest state of the plan.
