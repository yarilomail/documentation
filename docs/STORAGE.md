# Storage — self-healing, rebuild & mdbox tuning

Mailbox backends (Maildir, sdbox, mdbox) and the FileIndex (binary mail-index v7.3 wire
format: `.index` / `.index.log` / `.index.names`). All index mutations go through the
cross-process mailbox lock (`yarilo-locks`); sessions sharing a pod serialise on an
in-process `sync.RWMutex` — the Redis lock is only ever contested across pods, not within
a single pod. See also [MDBOX_ALT.md](MDBOX_ALT.md).

## Path templates

Every path setting that can differ per user — `mail_home_template`, `mail_path`,
`mail_inbox_path`, `index_dir`, `control_dir`, `volatile_dir`, `alt_dir`,
`mdbox_alt_storage_path` — is a template expanded against the user. Two spellings are
accepted, and nothing else is.

| short form | expression form | expands to |
|:---|:---|:---|
| `%u` | `%{user}` | the full username, `alice@example.com` |
| `%n` | `%{user \| username}` | the local part, `alice` |
| `%d` | `%{user \| domain}` | the domain, `example.com` |
| `%h`, or a leading `~/` | `%{home}` | the user's home directory |
| `%2.256Nu` | `%{user \| sha1 % 256 \| hex(2)}` | a hash bucket, `d5` |
| `%%` | — | a literal `%` |

The expression form is a variable followed by filters: `username`, `domain`, `lower`,
`upper`, `md5`, `sha1`, and `hex(n)`. A hash becomes a number through a modulo
(`sha1 % 256`) and a number becomes text through `hex(n)`, which zero-pads to `n` digits
and keeps the low ones; a negative width pads on the right and keeps the high ones.

**The two forms do not hash the same way, deliberately.** An expression names its
algorithm, so `%{user | sha1 % 256}` is SHA-1 while the older `%2.256Nu` stays MD5. Each
does what it says, and neither changes where an existing deployment's users already live.
The expression form matches the reference implementation byte for byte, including reading
the digest as a big-endian integer from its **last** eight bytes — so a config migrated
from it keeps every user in the bucket they already had.

**A template that cannot be expanded stops startup**, naming the key and the sequence that
was not understood. There is no pass-through: a template copied from a newer reference
config used to produce a directory literally named `%{user | sha1 % 256 | hex(2)}` —
created, written to, and never mentioned.

The same templates are accepted in the matching userdb fields, and expanded the same way
on every path — a delivery and an interactive session resolve one user to one set of
directories. (Before 2.3.133 the delivery path resolved `~/` in `mail_path` /
`mail_inbox_path` but left `%u` alone, so the two could disagree.)

Hash buckets matter once a directory holds one entry per user. The shipped
`volatile_dir` uses one:

```yaml
storage:
  volatile_dir: "/tmp/yarilo-volatile/%{user | sha1 % 256 | hex(2)}/%{user}"
```

## Maildir sync-on-open

**Maildir sync-on-open** (`storage.maildir_sync_on_select`, default `true`): on
SELECT/EXAMINE, STATUS and IDLE the Maildir index is reconciled against `cur/` and `new/`,
so a message delivered by an external MDA or moved/renamed by a second MUA appears without
an operator rebuild — files in `new/` are migrated to `cur/`, new files gain a UID,
vanished files are expunged, and out-of-band flag renames keep their UID. It is gated on a
cheap `cur/`+`new/` mtime token, so a quiescent folder costs a single `stat`. Only Maildir
honours it; dbox stays index-authoritative.

## dbox reactive rebuild

**dbox reactive rebuild** (`storage.dbox_reactive_rebuild`, default `true`): dbox is
index-authoritative and does not scan storage on every access, but it self-heals
reactively. When an **sdbox** read hits a missing or corrupt message file the folder is
flagged (a persisted FSCKD marker in the index header); the next SELECT, STATUS or IDLE
poll then heals the index under the mailbox lock — every record whose file has vanished is
expunged (with a QRESYNC tombstone), surviving messages keep their UID. Transient I/O
errors (EIO, timeouts) do not trigger a heal.

**mdbox** now self-heals reactively too, the same way as sdbox: a read that trips over a
missing/corrupt message flags the folder FSCKD, and the next SELECT/STATUS/IDLE poll (or
POP3 login) runs a targeted per-folder heal under the mailbox lock — every index record
whose message is no longer present in storage is expunged (QRESYNC tombstone), the rest
keep their UID. This is per-folder and does *not* touch the shared map's refcounts, so it
needs none of the quiescence the storage-wide rebuild does. Because it goes through the
shared `box.Scan`, a **concurrent `purge`/`altmove`** (both write the new `m.<N>` before
unlinking the old) makes the scan incomplete and the heal **abort-and-retry** rather than
mistake a just-compacted message for a vanished one — so if a folder stays FSCKD, check
whether a purge is running. A structurally corrupt `m.<N>` record also aborts the heal
until an operator moves the bad file aside, and the vanished message's map refcount is not
decremented by the heal (a leak the next operator rebuild + purge reclaims).

## mdbox operator rebuild

For the **operator** side, because mdbox messages are shared across folders through the
map, a per-folder rebuild would import unrelated messages — so the per-folder endpoint
(`/api/backend/index/rebuild`) returns `501` for mdbox and there is a dedicated
**storage-wide rebuild**: `POST /api/backend/index/rebuild-storage {user}` (or
`yarctl backend index rebuild-storage <user>`). It reconciles the shared map against the
physical `m.<N>` files under the storage lock, resets every folder index to the messages
that still exist, **recomputes each map record's refcount from the actual folder
references** (the reference `rebuild_apply_map` parity), drops map records whose message
vanished, and bumps a persisted `rebuild_count` generation counter in the map header. It
**refuses** to run when the scan is incomplete (a half-corrupt `m.<N>` or transient I/O —
move/repair the named file and re-run) or when a configured alt tier is unmounted (would
mass-expunge alt-resident mail). It is an operator repair tool (the reference `force-resync`
parity) and should run with the user's mailboxes **quiesced** — no concurrent delivery
*and* no concurrent folder operations (CREATE/DELETE/RENAME); neither the delivery
folder-append nor the restore is serialised on the storage lock, so a concurrent message
or folder change can race the rebuild.

A message present on disk but referenced by no folder becomes **zero-ref** (reported as
`unreferenced_zeroref` and logged) so the next purge reclaims it — by default it is **not**
re-filed into a mailbox.

Each mdbox message records the mailbox it was saved into (an `ORIG_MAILBOX` key in the dbox
trailer, appended after the GUID/size fields — an older reader ignores the unknown key).
With **`restore_orphans=true`** (`--restore-orphans` on the CLI) the rebuild re-files an
unreferenced message that carries this tag back into its home folder (created if missing),
via the normal append path so vsize/modseq/quota stay correct; untagged records are still
left zero-ref. A restored orphan comes back with **default flags** (unseen, no keywords) —
flags live in the fileindex and an orphan has no index record to recover them from (an
accepted gap, like the VANISHED-tombstone gap of the reset path). Restore is off by default
and per-request, because the tag proves only *"was once in this folder"*, not *"is lost"* —
a delete-with-refcount-leak carries the same tag, so the resurrection decision stays the
operator's. A default run (`restore_orphans=false`) writes and reads the tag but takes no
action, so its numbers are identical to a rebuild without the feature.

The rebuild **preserves each surviving record's own modseq** across the reset (no QRESYNC
modseq storm on an operator rebuild); `highest_modseq` advances to the greatest value
carried in, and only a record with no modseq (a freshly assigned UID) is stamped fresh. It
also **notifies FTS to expunge** every UID it drops, per folder — the storage-wide rebuild,
the per-folder rebuild, and the reactive heal all return the dropped UIDs so their FTS
documents are invalidated immediately instead of lingering as ghost entries until the next
`fts rescan` (the POP3-only reactive heal has no FTS client wired in, so those still rely on
the next rescan). One accepted gap remains: the reset still loses per-UID VANISHED tombstone
fidelity for dropped records, since it rewrites the whole set.

## mdbox on-disk layout & rotation

On-disk `m.<N>` files follow the **dbox v2 layout**: the ASCII file-header line
(`version M<hdr-size> C<create-stamp>`) is written **once per physical file**, before its
first message, then each message is `[32-byte header][body][trailer]`. The reader is
self-describing — at each record it tells a file-header line (starts with the ASCII version
digit) apart from a raw message header (starts with the `\x01\x02` magic) by the first
byte, so a reference-format store parses past the first message in a multi-message file, and
legacy yarilo stores that stamped the header before every record still read back unchanged
(no migration).

Three parity knobs tune when a new `m.<N>` is rolled and how it is allocated (all
under `storage:`, mdbox only):

| Key | Default | Effect |
|:---|:---|:---|
| `mdbox_rotate_size` | `10485760` (10 MiB) | Max bytes per `m.<N>` before the next save rolls to a fresh file. `0` selects the 10 MiB default. |
| `mdbox_rotate_interval` | `0` (disabled) | Seconds; roll the append file once it is older than this, regardless of size. |
| `mdbox_preallocate_space` | `false` | `fallocate()` the new file to `mdbox_rotate_size` up front (Linux only; a no-op elsewhere). |
| `mdbox_map_format` | `v2` | On-disk format of the per-user map index; see [mdbox map index format](#mdbox-map-index-format). |

The age check reads a **persisted per-file create-time** stored in the map header (not a
filesystem `btime`, which is unreliable over NFS), so it survives restarts. Unlike the reference
it uses a **rolling window** (`now − createTime > interval`) rather than a clock-boundary
snap, so "rotate every interval" means the file actually lived at least that long.
Preallocation uses `FALLOC_FL_KEEP_SIZE` so the file's logical size still grows from zero
as records are appended — reserving blocks without breaking the offset model — and any
failure is a non-fatal hint.

The **reactive heal** is retry-bounded per folder per session on the IMAP path: a
near-continuous purge/altmove keeps every scan incomplete (the heal aborts rather than
mistake a compacted message for a vanished one), so after a few consecutive aborts the
session stops auto-retrying that folder — each attempt costs a full storage scan — and logs
once, pointing the operator at a rebuild. The counter resets on a successful heal or when
another session clears the marker. The **POP3** path carries no such bound: a POP3 session
heals at most once, at login, not in a command loop, so it cannot spin; a rapidly
reconnecting client during a purge could still reproduce the storm across logins, but POP3
sessions are short and a cross-login bound would need persistent state — an accepted gap.

## mdbox map index format

The per-user map index (`yarilo.map.index`) is what makes an mdbox COPY O(1): every folder
record points at a `map_uid`, and the map resolves that to `(file_id, offset, size)` plus a
reference count. Two on-disk formats exist, selected by `storage.mdbox_map_format`:

| Value | Layout |
|:---|:---|
| `v2` (default) | A fixed 80-byte header and 36-byte records sorted by `map_uid`. A record is addressed by offset arithmetic and found by binary search over the file bytes, so opening the map parses nothing and builds no lookup table. The header also records which append log the base already folded in, and how far. |
| `v1` | The older mail-index-backed format: a record stream with per-record extensions that has to be parsed into objects before anything can be looked up. |

**Changing the value converts the map on the next open, in either direction**, preserving
every `map_uid`. Both writers are atomic (temp file + rename), so an interrupted conversion
leaves the previous format readable and the next open converts again. A base carrying a
version this binary does not know is refused rather than guessed at — the map decides which
bytes belong to which message and which file a purge may unlink.

Choose `v1` only to keep the map readable by an older yarilo image; it is the reason the
setting exists. It gives up what its header cannot hold: with no log lineage and no record
digest, a v1 map re-reads its base whenever the file moves and replays its log from the
start, and the window between writing the base and dropping the log is unprotected, so a
reference-count delta in it can be applied twice.

## Durability: what a save promises

An mdbox save appends the message to `m.<N>` and records it in the map. Neither
write is followed by an `fsync`: durability is delegated to the filesystem and
its mount options, as it is in the reference implementation. A message
acknowledged to the client is therefore in the page cache and on its way to
disk, not proven to be on it.

That is the trade every dbox-family store makes, and it is stated here because
it is the kind of property an operator discovers at the worst possible moment
otherwise. A deployment that needs the stronger guarantee gets it from the
mount (`sync`, or a filesystem whose journal covers data), not from a setting
here.

Index writes are a separate matter: the base is replaced atomically (temp file
+ rename) and the log is append-only, so a crash costs the tail of the log
rather than the folder. The `volatile_dir` setting moves the index's temporary
file — and its fsync — off the mail volume, which is why it is worth setting on
NFS deployments (see [Path templates](#path-templates)).

## Folding indexes before a measurement

`yarctl backend index optimize <user> --all` folds every folder index of the
account **and**, for mdbox, the per-user map. Both are structures a session
replays when it opens; folding them is what makes an open cost what it will
cost in steady state.

This matters for benchmarking specifically, and the reason is worth stating
because it is not obvious: **a read-only workload never folds anything.** The
map log is folded by writes, and a FETCH-only profile performs none — so a
freshly seeded account replays the entire seed on every session open, in every
window, and discarding the first run does not help because the state is not
warming up, it is stationary. One measured account showed 36.8 ms per map open
against 0.23 ms after a fold.

So the sequence for any comparative run is:

```sh
# seed the account, then
yarctl backend index optimize <user> --all
# and only then start the measurement window
```

Do not use `rebuild` for this. A rebuild scans storage and reconciles state; a
fold writes the base and drops the log. They are different operations, and the
expensive one standing in for the cheap one is how a seeding script ends up
doing eleven full storage scans to get the effect of eleven folds.

## Moving a user between mailbox formats

One folder name is legal under one format and not under another: **`dbox-Mails`**.
Maildir++ gives every folder a leading `.`, so `.dbox-Mails` collides with
nothing; the dbox layouts store a folder as `mailboxes/<name>/dbox-Mails`, where
that name is their own marker, and a folder called `dbox-Mails` would produce
`mailboxes/dbox-Mails/dbox-Mails` — an outer directory that is a folder and an
inner one that is a marker, indistinguishable to a tree walk. So it is refused
on mdbox and sdbox and accepted on maildir:

| name | mdbox | maildir | sdbox |
|:--|:--|:--|:--|
| `New`, `cur`, `new`, `tmp` | OK | OK | OK |
| `dbox-Mails` | `NO [CANNOT]` | **OK** | `NO [CANNOT]` |

The first row is the reserved-segment rule working as intended: only the names
the layout in use actually owns are enforced, and no layout owns those.

**It is a precondition, not a wall.** Set `mailbox_list_storage_escape_char` on
the target and the name is stored escaped, out from under the marker:

```
esc=""   ValidateName("dbox-Mails") = refused
         path = mailboxes/dbox-Mails/dbox-Mails        <- the collision

esc="^"  ValidateName("dbox-Mails") = accepted
         path = mailboxes/^64box-Mails/dbox-Mails      <- stored literally
```

Escaping supersedes the refusals that exist because a name could not be
*represented*, which is what this one is. So the rule for a format migration is:

- **without an escape character on the target** — such a folder cannot be
  migrated;
- **with one configured** — it migrates and is stored escaped.

And it inherits that key's retroactivity: enabling it is **not** retroactive, so
it has to be set on the target **before** the mail arrives, not after.

This is the only name that exists under one driver and cannot exist under
another, which is why it is stated here rather than left to be discovered.
