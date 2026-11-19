---
title: "Encrypting mail at rest on an IMAP server"
description: "Mail encryption at rest in yarilo: what is encrypted, age keys, turning it on, key rotation, re-encrypting stored mail and back, metrics, limits and cost."
---

# Mail encryption at rest

yarilo can store message bodies encrypted on disk with [age](https://age-encryption.org)
keys, for maildir, sdbox and mdbox stores, and re-encrypt mail that is already
stored: to a new key, or back to plaintext.

## What is encrypted, what is not

| Encrypted | Stays in clear |
|:---|:---|
| message bodies in maildir, sdbox and mdbox files | mail indexes (flags, UIDs, sizes, cached headers and envelopes) |
| JMAP uploads while they wait to be used | the full-text search index |
| | folder names, the uid list, the mdbox map |

Indexes and search stay in clear, so FETCH of headers, SEARCH and SORT cost what
they cost without encryption. A body is decrypted when a client reads it, and
only the 64 KiB chunks a partial FETCH touches are decrypted.

Sizes do not change for a client: RFC822.SIZE, quota and the sizes in maildir
names (`S=`, `W=`) and dbox metadata count the plaintext.

A store taken over from another IMAP server that wrote the common elliptic-curve
encrypted stream (P-256 keys in PEM, AES-256-GCM) is read as it is: list its keys
in `reference_keys`. New mail is always written in age.

## Keys

- **Public key** (`public_key`): the age recipients new mail is encrypted to.
  X25519 (`age1...`) or hybrid post-quantum (`age1pq1...`); one type per file.
- **Private keys** (`private_keys`): the age identities that open mail, one per
  line. During a rotation the file holds the old key and the new one.
- **Reference keys** (`reference_keys`): PEM private keys of a store taken over
  from another server.

To generate a pair, run yarctl with the key type; the private key goes only
into the file, created with mode 0600, and the public key is printed:

```sh
yarctl backend crypt keygen --type x25519 --out mail-crypt.key
yarctl backend crypt keygen --type hybrid --out mail-crypt.key
```

`yarctl backend crypt keys` shows the keys a running backend loaded, by their
public halves only: which one new mail is sealed to, a public key no private key
opens, and fingerprints of the reference keys.

## Turning it on

The keys live in a Kubernetes Secret mounted read-only at `/etc/yarilo/mail-crypt`
in every container that opens mail. To create it from Vault with the External
Secrets Operator, apply:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: yarilo-mail-crypt
spec:
  secretStoreRef: { kind: ClusterSecretStore, name: vault }
  target: { name: yarilo-mail-crypt }
  data:
    - secretKey: public
      remoteRef: { key: mail/yarilo/mail-crypt, property: public }
    - secretKey: private
      remoteRef: { key: mail/yarilo/mail-crypt, property: private }
```

To turn it on, name the Secret and set the write mode in the Helm values:

```yaml
mailCrypt:
  secretName: yarilo-mail-crypt
storage:
  mail_crypt:
    write: age
```

`yarctl config check` reports an unreadable key before a rollout.

<!-- @settings mailCrypt.secretName storage.mail_crypt storage.mail_temp_dir -->

From the rollout on, new mail is encrypted. Mail already on disk stays as it was
until it is re-encrypted.

## Re-encrypting stored mail

To see where a user's mail stands, preview a run, run it, and then do the same
for every user:

```sh
yarctl backend crypt status    alice@example.com
yarctl backend crypt reencrypt alice@example.com --dry-run
yarctl backend crypt reencrypt alice@example.com
yarctl backend crypt reencrypt --all --jobs 2 --rate 100
yarctl backend crypt status --all
```

`status` counts each folder's messages by state:

| State | Meaning |
|:---|:---|
| `plain` | stored in clear |
| `current` | age, sealed to exactly the keys of `public_key` |
| `other_key` | age that another configured key opens, alone or beside the current one |
| `reference` | the other server's format, opened by `reference_keys` |
| `no_key` | encrypted, and no configured key opens it |

`reencrypt` rewrites every message that is not `current` (or, with
`--to plain`, every encrypted one) and leaves `no_key` messages untouched. Each
message is written to a temporary file, read back and compared with the old
plaintext by SHA-256, and only then put in place; a message that fails any step
stays as it was and is counted. Name, flags, UID, date, GUID and sizes do not
change, and the search index is not rebuilt.

- `--rate N` bounds the messages rewritten a second, shared by the jobs running
  at once (default 100); 0 is no bound.
- `--all` takes every user from the user database, `--jobs` at a time, each on
  the backend that keeps the user, then the public namespace once
  (`--public NAME`, default `public`). The summary sums every state over all of
  them and exits non-zero when anything failed.
- An mdbox store is rewritten whole, one storage file at a time, so a run on it
  names no folders.
- A job runs in yarilo-backend-api, one per user at a time. A restart of that
  pod loses the job; run the command again, and it continues where the mail
  shows it was: every message is classified anew.
- Run right after such a restart, the command waits up to 80 s for the lost
  job's hold to lapse, then starts. While a job for the same user still runs on
  another backend, it is refused: `a crypt job for <user> is already running on
  another backend`.
- Ctrl-C cancels the running jobs; a second Ctrl-C leaves at once.

`reencrypt` needs the lock service (`yarilo-locks`): without it the command is
refused at once. On maildir it also needs `flock` on the mail volume: without
it the job stops at its first message with the reason `nolock` and writes
nothing. `status` and `--dry-run` need neither.

### Back to plaintext

To store mail in clear again, decrypt it first:

```sh
yarctl backend crypt reencrypt --all --to plain
```

then set `write: off` and roll out. Keep the private keys until `status --all`
shows no encrypted message.

## Key rotation

1. Add the new private key to the `private` key of the Secret, beside the old one.
2. Switch `public` to the new recipient; roll out.
3. `yarctl backend crypt reencrypt --all`.
4. `yarctl backend crypt status --all` shows 0 `other_key` and 0 `reference`
   for every user and the public namespace. Wait `jmap_upload_ttl` after step 2,
   so that JMAP uploads sealed to the old key have expired.
5. Remove the old private key; roll out. Everything reads.

Moving from X25519 to a hybrid key, or back, is the same procedure.

## Mount requirements

maildir re-encryption locks each folder with `flock` (`storage_lock_method: flock`,
the default) shared by the sessions and exclusive by the swap. On NFS the lock
must be taken on the server: a mount with `local_lock=flock`, `local_lock=all` or
`nolock` gives a `flock` that other hosts do not see. Do not run maildir
re-encryption on such a mount. The uid list of maildir has relied on the same
lock all along.

A volume out of space or inodes still lets mail be removed and flags change; a
re-encryption there does not run.

## Metrics

| Metric | Labels | Meaning |
|:---|:---|:---|
| `mailbox_crypt_sealed_total` | driver | bodies encrypted on save |
| `mailbox_crypt_opened_total` | driver, format | bodies opened: plain, age, reference |
| `mailbox_crypt_failed_total` | driver, op, reason | bodies refused: no-key, integrity, truncated, unsupported, planted |
| `mailbox_crypt_seconds` | op, format | time to seal, or to open up to the first byte |
| `mailbox_crypt_key_cache_total` | result | file keys found in the key cache (hit) or unwrapped (miss) |
| `mailbox_crypt_cache_bytes` | | decrypted reference bodies held in `mail_temp_dir` |
| `mailbox_crypt_cache_bypass_total` | | reference bodies read as a stream because the cache was full |
| `mailbox_crypt_reencrypted_total` | driver, from | messages rewritten, by the state they were in |
| `mailbox_crypt_reencrypt_failed_total` | driver, reason | messages left as they were |
| `mailbox_crypt_reencrypt_nokey_total` | driver | messages no configured key opens |
| `maildir_crypt_lock_total` | mode, waited | holds of the maildir folder lock; `waited="no-room"` is a rename that went unheld on a full volume |

Reasons a re-encryption leaves a message: `verify` (the new body did not read
back the same), `read`, `write`, `nospace` (the run stops), `vanished` (expunged
meanwhile), `changed` (renamed or moved meanwhile; a rerun takes it), `busy`
(the folder stayed busy for 2 s; a rerun takes it) and `nolock` (no `flock` on
the volume; the run stops).

## Cost

Measured on a test cluster with imaptest, the same load with encryption off and
on, X25519 and hybrid keys: logins per run fell by 16 to 21 % with encryption
on (mdbox 21 %, maildir 16 %, sdbox 20 %). Read this as an upper bound: the test
machine's CPU has no SHA extensions and ran at 91 to 95 % in every run, where a
percent of CPU costs more than a percent of throughput. Delivery over LMTP did
not slow down measurably.

On disk, an age message in mdbox takes about 1.7 KB more; in maildir and sdbox
the growth hides in the filesystem's block rounding.

## Limits

- There are no folder or user keys: every user's mail is sealed to the same
  global keys.
- Encryption covers maildir, sdbox and mdbox; other storage formats store
  plaintext.
