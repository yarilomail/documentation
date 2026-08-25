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

Point yarilo at the store, then fill in what it does not carry — **in this
order**, because the second depends on the first:

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
