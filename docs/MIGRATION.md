# Migration and backfill

`yarilo-migrate` is the operator tool for bringing an existing mail store under
yarilo, and for filling in per-message state that newer features need. It has
three modes, and they answer three different questions.

| Mode | Question it answers |
|:---|:---|
| conversion (default) | my mail is in one format and I want another |
| `--guid-backfill` | my messages have no stable identifiers yet |
| `--thread-backfill` | my existing accounts have no conversations yet |

Every mode accepts **`--dry-run`**, which prints what would happen and writes
nothing. Run it first, every time — the tool works on live mail.

## Conversion

```sh
yarilo-migrate --src maildir|dbox-v1|mdbox-v1 --dst sdbox|mdbox \
               --from <source-root> --to <destination-root> [--dry-run]
```

Reads the source tree and writes a new store in the destination format. The
source is left alone.

**Effect:** writes the destination tree; reads the source.

### What carries over, and what does not

| | after conversion |
|:---|:---|
| message GUIDs | **preserved** — the source id is written into the destination, and only a message that had none gets a fresh one. `EMAILID` and JMAP ids survive, so `--guid-backfill` is not needed afterwards |
| UIDs | **reallocated** in the destination. Clients resync; this is a new store, not a renamed one |
| flags, internal dates, folder structure | carried |
| threading sidecar | **not carried.** Conversion writes messages, not conversations — run `--thread-backfill` afterwards, or the account has no conversations until it is |
| index | rebuilt from what is written, not copied |

The GUID line is the one that matters for a client: a message keeps its identity
across the conversion even though its UID changes, which is what lets a JMAP
client recognise mail it already knows.

## `--guid-backfill` — stable message identifiers

```sh
yarilo-migrate --guid-backfill --config /etc/yarilo/yarilo.yaml \
               [--user alice@example.com] [--dry-run]
```

Stamps a per-message GUID across an existing store, in place. A GUID is what
survives a message being moved between folders, expunged and redelivered, or
carried through a migration — so it is what `EMAILID` reports, what JMAP uses
as a message id, and what threading keys on.

Without `--config`, both `--driver` and `--root` are required; with it, layout,
driver and the `yarilo-locks` client all come from the service configuration,
so the tool addresses exactly the store the services do.

| Flag | Meaning |
|:---|:---|
| `--config PATH` | service configuration: layout, driver, locks client |
| `--driver maildir\|sdbox\|mdbox` | override `storage.mailbox` |
| `--root PATH` | override `storage.maildir_root` |
| `--home-template T` | override `storage.mail_home_template`, e.g. `%d/%u` |
| `--user u@d` | one account; default is every account under the root |
| `--offline` | resolve paths from flags instead of userdb — for a **stopped** store |
| `--index-template`, `--mail-template` | offline stand-ins for the userdb overrides |

**What happens if you do not run it:** messages without a GUID have no stable
id. `EMAILID` cannot be answered for them, JMAP cannot name them, and
`--thread-backfill` skips them — threading keys on the GUID, so a message
without one cannot be placed in a conversation.

**Effect:** writes message metadata in place. Reads the mail.

## `--thread-backfill` — conversations for existing accounts

```sh
yarilo-migrate --thread-backfill --config /etc/yarilo/yarilo.yaml \
               [--user alice@example.com] [--force] [--dry-run]
```

Builds the threading sidecar for accounts that already have mail. Threading is
recorded **at delivery time**, so messages that arrived before the feature was
enabled are in no conversation until this runs.

There is deliberately **no lazy path**: an account is migrated by a command an
operator runs, not on first read. A lazy rebuild would spread an
account-sized fold across arbitrary requests and make "is this account
migrated" unanswerable.

`--force` rebuilds a sidecar that already exists. Without it, an account that
has one is skipped, so a rerun over a live deployment does not rewrite state
the deliveries have been extending.

**Locking:** the rebuild holds the account's threading lock for its whole
duration, the same lock a delivery takes, so it is safe to run against a live
store — deliveries to that account wait rather than interleave.

**What happens if you do not run it:** the account behaves exactly as it did
before threading existed. Every message is its own conversation: `THREAD`
returns one message per thread, `FETCH THREADID` answers `NIL`, and JMAP's
`Thread/get` reports single-message threads. New mail delivered from now on
*is* threaded, so an unmigrated account looks like one where only recent
messages have conversations — which is the shape to expect, not a defect.

**Effect:** writes `yarilo.threads` in the account's mail root. Reads message
headers only.

## Two whole stories

### Upgrading a deployment that predates threading

Threading is on by default since **2.3.246**. New mail threads immediately;
existing mail does not, until you say so.

```sh
# 1. See what it would do, for one account first.
yarilo-migrate --thread-backfill --config /etc/yarilo/yarilo.yaml \
               --user alice@example.com --dry-run

# 2. Do it for that account, and check the result in a client.
yarilo-migrate --thread-backfill --config /etc/yarilo/yarilo.yaml \
               --user alice@example.com

# 3. Then the rest, account by account or in one pass.
yarilo-migrate --thread-backfill --config /etc/yarilo/yarilo.yaml
```

The rebuild is deterministic: the same mail produces the same sidecar, byte for
byte, so re-running it is safe and a second pass over an unchanged account
changes nothing.

### Converting a store to another format

```sh
yarilo-migrate --src maildir --dst mdbox --from /old/mail --to /new/mail --dry-run
yarilo-migrate --src maildir --dst mdbox --from /old/mail --to /new/mail
yarilo-migrate --thread-backfill --config /etc/yarilo/yarilo.yaml
```

No `--guid-backfill` in that sequence: conversion carries the identifiers it
finds and mints the rest. The thread backfill **is** needed, because the
sidecar is not part of what conversion writes.

### Moving an existing store from another server

**Pointing yarilo at the tree: Maildir only.** A Maildir mailbox *is* its
files — the message is the file, and the directory is the index. A dbox tree —
mdbox `m.<N>` or sdbox `u.<UID>` — is a different case: the records parse, but
the index saying which message sits at which offset is not read, so a mailbox
pointed at directly comes up **empty**. See
[Storage](STORAGE#record-header-size) for what does and does not interoperate.

A dbox store is therefore **converted rather than adopted**, and that is what
`--src dbox-ref` below does: it reads the other server's index as well as its
records, and writes a store of ours.

Moving a dbox store from another server therefore means moving the mail rather
than adopting the tree. There are two ways, and they differ in what survives.

#### `--src dbox-ref` — read the other server's store, write ours

```sh
yarilo-migrate --src dbox-ref --dst mdbox \
  --from /var/mail/olduser --to /var/mail/newuser --dry-run
```

Reads the store where it is and writes a fresh one. **The source is never
written to**, so it can be run against a copy, and `--dry-run` prints what it
would do without writing at all.

**What comes across**

| | |
|:---|:---|
| messages, in their folders | yes, including nested folders and non-ASCII names |
| flags — `\Seen` `\Answered` `\Flagged` `\Deleted` `\Draft` | yes |
| keywords | yes |
| per-message identifiers (GUID) | yes |
| received date | yes |
| **UIDs and UIDVALIDITY** | **no — reallocated** |
| flags and keywords, for a folder whose index is missing | no — see below |
| subscriptions, ACLs, quota state | no |

The flags and the keywords are the reason this exists: a dbox record carries
neither, so anything that read only the stored files would hand over a mailbox
in which nothing has been read and nothing is marked.

UIDs are reallocated because the messages are written through the destination's
own save path, as in every other conversion here. Clients resynchronise the
account once afterwards.

**What it requires**

The store must be the reference's default dbox layout — a folder is a directory
under `mailboxes/` with its messages in a `dbox-Mails` beneath it. Anything
else is not read, and is not half-read either: nothing outside that shape looks
like a folder.

**A folder with no index is recovered from the store instead**, and what it
costs is stated below. A folder whose index is there but unreadable — a
permission problem, a truncated file — stops the import instead, naming it: a
folder imported as empty would lose its mail with nothing in the output saying
so.

**The map is required.** Everything the importer knows about where a message's
bytes are comes from it, so a store without a readable
`storage/dovecot.map.index.log` cannot be imported at all.

##### When a folder has no index

Its messages are found by walking the store's records, which describe
themselves. That recovers the message and loses the rest:

| | |
|:---|:---|
| body, GUID, received date | yes |
| **flags and keywords** | **no — a dbox record carries none** |
| folder | the one the record names, which is where the message was **first saved** |

The last row is the one to read twice. Nothing rewrites that name when a
message is moved, so a mailbox somebody has been filing for years comes back
sorted by where each message originally landed.

This is **mdbox only**. Only mdbox writes the folder name into the record;
sdbox does not, because a single-message file already sits in its folder's
directory — so an sdbox folder without an index is found by its path, not by
this.

##### The run says which messages came which way

```
migration complete migrated=1204 from_index=1198 from_store_scan=6
                   folders_with_index=14 folders_scanned=1
```

and a run that used the scan at all warns. Check those numbers before telling
anyone the migration is done: `from_store_scan` is mail that arrived with no
flags and no keywords, and a large number there means the folder indexes were
not copied with the store.

**The source server must be stopped.** This reads files that a running server
is still writing.

#### Delivery or upload

Deliver the mail over LMTP, or upload it over IMAP, into a store yarilo has
written itself. Slower, and it carries no flags or keywords either — but it
needs no access to the old server's files and no downtime on it.

For a Maildir tree, point yarilo at the store, then fill in what it does not
carry — **in this order**, because the second depends on the first:

```sh
# 1. Stable identifiers. Threading keys on these.
yarilo-migrate --guid-backfill --config /etc/yarilo/yarilo.yaml --dry-run
yarilo-migrate --guid-backfill --config /etc/yarilo/yarilo.yaml

# 2. Conversations, now that every message can be named.
yarilo-migrate --thread-backfill --config /etc/yarilo/yarilo.yaml --dry-run
yarilo-migrate --thread-backfill --config /etc/yarilo/yarilo.yaml
```

Running them the other way round is not an error and not a disaster — it is
quietly incomplete. Threading skips every message that has no GUID yet, so the
sidecar comes out missing exactly the messages the first step had not reached,
and it takes a `--force` rebuild afterwards to fix.

## Where the output goes

Both backfills log JSON to stdout with a per-account summary — accounts,
skipped, folders, messages, threads, unreadable. Read the summary rather than
the exit status: an account skipped because it already had a sidecar and an
account with no mail both exit zero.
