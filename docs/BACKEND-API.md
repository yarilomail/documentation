# yarilo-backend-api — backend-plane HTTP wire reference

`yarilo-backend-api` exposes the operator surface for per-account state over HTTP: dict, ACL, quota, folders, users, index, mdbox storage, messages, subscriptions, special-use, metadata, sessions and full-text search. One instance runs per backend pod in the co-located layout, or as its own Deployment otherwise.

The `yarctl` CLI is a thin HTTP client over this API: every endpoint below has a `yarctl backend <family> <command>` counterpart, named under each section. See [yarctl](./YARILO-ADMIN) for the CLI itself.

For the director's own admin endpoints (ring, backends, users) see [Director API](./DIRECTOR-API) — different binary, different port, different token.

## Transport

- **Protocol:** JSON over HTTP, or over HTTPS with mutual TLS when `internal_tls.enabled: true`. The director API, by contrast, is always plain HTTP.
- **Auth:** Bearer token in `Authorization: Bearer <token>`. The server reads it from the `BACKEND_API_TOKEN` env var, which the chart wires from a Secret. An empty token disables auth — local dev only.
- **IP allow-list:** when `backend_api.allowed_nets` is set, clients outside those CIDRs get `403 forbidden` before the bearer check.
- **Request bodies:** every `POST` endpoint takes a JSON body. `GET` endpoints take query parameters.

## Limits

| Setting | Value |
|:---|:---|
| Listen | `:9105` |
| Request body | 1 MiB |
| Read timeout | 60 s |
| Write timeout | 60 s — the effective cap on any single call, streaming included |
| Dict operation context | 30 s; 5 min for `iterate`, `expire-scan` and `commit-batch` |

A streamed `iterate` therefore ends at 60 s even though its context allows 5 minutes.

## Error format

Errors come back with the matching HTTP status and a JSON body:

```json
{ "error": "dict \"no-such\" not configured" }
```

| Status | Meaning |
|:---|:---|
| 400 | bad request body, malformed JSON, missing required field |
| 401 | missing or invalid bearer token |
| 403 | client IP not in `allowed_nets` |
| 404 | the named dict, folder, user or message does not exist |
| 409 | conflict: the folder already exists, or the change targets the owner's own rights |
| 500 | driver or I/O error |
| 501 | the operation is not available here: no FTS or warden configured, or not supported by the storage driver |
| 502 | an upstream service (auth, warden, FTS) failed |
| 503 | a required service is not configured, or the dict is closed |

## Health

### `GET /api/backend/health`

Liveness probe. Returns `200 {"status":"ok"}` whenever the process is up. It takes no token and ignores the allow-list, so Kubernetes probes can reach it.

## Dict endpoints

Direct access to the configured dicts. `NAME` in the path is a dict name such as `metadata` or `quota`.

CLI: `yarctl backend dict …`.

### `GET /api/backend/dict/drivers`

Lists every dict driver registered in this process.

```json
{ "drivers": ["fail", "file", "memory", "redis", "sql"] }
```

### `GET /api/backend/dict/{name}/exists`

Reports whether the named dict is configured on this backend-api.

```json
{ "name": "metadata", "exists": true }
```

### `POST /api/backend/dict/{name}/lookup`

```json
// request
{ "key": "priv/box/<guid>/comment", "op": { "username": "alice@x.com" } }

// response
{ "found": true, "values": ["<base64>"] }
```

`op` (per-call `pkg/dict.OpSettings`) is optional. Multi-value
drivers return the full list; single-value drivers return a
one-element array. `found: false` → `values` is omitted/empty.

### `POST /api/backend/dict/{name}/iterate`

Streaming endpoint. Response `Content-Type: application/x-ndjson` —
one JSON object per line. A `{"error": "..."}` line MAY appear
mid-stream when iteration fails after some rows have been emitted;
clients MUST check every line for the `error` key.

```json
// request
{
  "path": "priv/box/",
  "flags": 3,
  "op": { "username": "alice@x.com" }
}

// response (NDJSON, one row per line)
{"key":"priv/box/abc123/comment","values":["<base64>"]}
{"key":"priv/box/abc123/admin","values":["<base64>"]}
```

**Flags bitmask** (`pkg/dict.IterFlag`):

| Bit | Value | Meaning |
|:---|:---|:---|
| 0 | 1 | `Recurse` — descend into sub-hierarchies |
| 1 | 2 | `SortByKey` |
| 2 | 4 | `SortByValue` |
| 3 | 8 | `NoValue` — omit values from rows |
| 4 | 16 | `ExactKey` — return all values for one exact key (no recursion) |

### `POST /api/backend/dict/{name}/set`

```json
// request
{ "key": "priv/foo", "value": "<base64>", "op": {} }

// response
{ "result": 1, "status": "ok" }
```

`result` is the raw `pkg/dict.CommitResult` value (`1` = OK,
`0` = not-found, `-1` = failed, `-2` = write-uncertain). `status`
is the human-readable mirror used by the CLI.

### `POST /api/backend/dict/{name}/unset`

```json
// request
{ "key": "priv/foo", "op": {} }

// response
{ "result": 1, "status": "ok" }
```

Unsetting a missing key is not an error — `status: ok`.

### `POST /api/backend/dict/{name}/atomic-inc`

```json
// request
{ "key": "priv/quota/storage", "delta": 1024, "op": {} }

// response when key exists
{ "result": 1, "status": "ok" }

// response when key is missing
{ "result": 0, "status": "not-found" }
```

### `POST /api/backend/dict/{name}/expire-scan`

```json
// request
{}

// response
{ "status": "ok" }
```

Drivers without TTL support are a no-op (still 200).

### `POST /api/backend/dict/{name}/commit-batch`

Multi-op atomic transaction. Returns a single commit result; on
failure no individual op is applied.

```json
// request
{
  "op": { "username": "alice@x.com" },
  "ops": [
    { "kind": "set",        "key": "a", "value": "<base64>" },
    { "kind": "unset",      "key": "b" },
    { "kind": "atomic-inc", "key": "counter", "delta": 5 }
  ]
}

// response
{ "result": 1, "status": "ok" }
```

`kind` is one of `set` / `unset` / `atomic-inc`.

## Folder endpoints

Mailbox-level operations: listing, identity, sizes, repair, and create / rename / delete / expunge.

Common request body:

```json
{ "user": "alice@x.com", "folder": "INBOX", "namespace": "personal" }
```

`namespace` defaults to `personal` when omitted. Other valid values are the slugs taken from the configured namespace prefixes (for example `shared`, `public`).

::: tip
`NS` is the namespace slug, taken from its prefix, not from its type. A namespace declared `type: shared` with `prefix: "Public/"` is addressed as `--namespace public`; `--namespace shared` reports that no such namespace is configured.
:::

### `POST /api/backend/folder/list`

Returns every folder visible in the namespace.

```json
{
  "folders":     ["INBOX", "Sent", "Trash"],
  "not_created": ["Trash"],
  "special_use": { "Sent": "\\Sent", "Trash": "\\Trash" }
}
```

A mailbox the namespace configures with `auto` (see
[Namespaces](./NAMESPACE.md#configured-mailboxes-mailboxes)) is listed even when
no server has made it yet. `not_created` names those mailboxes. The listing is
a read and makes nothing; the first IMAP, JMAP or LMTP open makes them. For an
account with no mail home yet, the list holds only the configured mailboxes.
`special_use` is the configured attribute of each listed name, for the personal
namespace.

CLI: `yarctl backend folder list <user> [--namespace NS]`

### `POST /api/backend/folder/info`

Folder metadata. `guid` is the 16-byte rename-stable identifier
stamped at folder creation — survives RENAME and is used as the
ACL/metadata key namespace.

```json
{
  "name":           "INBOX",
  "created":        true,
  "guid":           "ab12...ef",
  "uid_validity":   1747000000,
  "next_uid":       42,
  "messages":       7,
  "unseen":         3,
  "highest_modseq": 19
}
```

A configured mailbox that no server has made yet answers without an identity,
rather than with one made up:

```json
{ "name": "Sent", "created": false, "configured": true }
```

`folder/guid` answers `404` for such a mailbox: it has no GUID until it is made.

CLI: `yarctl backend folder info <user> <folder>`

### `POST /api/backend/folder/guid`

Convenience extraction of `guid` from the info payload — useful for
piping into ACL / METADATA CLIs that need the GUID directly.

```json
{ "folder": "INBOX", "guid": "ab12...ef" }
```

CLI: `yarctl backend folder guid <user> <folder>`

### `POST /api/backend/folder/stats`

`folder/info` plus an on-disk rollup (sum of physical message
sizes from `UserMailbox.List`).

```json
{
  "name":            "INBOX",
  "guid":            "ab12...ef",
  "uid_validity":    1747000000,
  "next_uid":        42,
  "messages":        7,
  "unseen":          3,
  "highest_modseq":  19,
  "size_bytes":      1234567,
  "on_disk_count":   7
}
```

CLI: `yarctl backend folder stats <user> <folder>`

### `POST /api/backend/folder/repair`

Rebuilds one folder's index from storage, then compacts it. The reply combines both steps:

```json
{ "rebuild": { "folder": "INBOX", "scanned": 42, "uids_preserved": 40, "uids_assigned": 2, "orphans_dropped": 0, "duration_ms": 37 },
  "optimize": { "folder": "INBOX", "duration_ms": 4 } }
```

If the rebuild fails, the compaction is skipped and the rebuild's error is returned. For mdbox the rebuild answers `501`, as `index/rebuild` does.

CLI: `yarctl backend folder repair <user> <folder> [--namespace NS]`

### `POST /api/backend/folder/create`

Creates a new folder under the named namespace. When `special_use`
is set AND the namespace is `personal`, the folder is registered
with that RFC 6154 attribute via the special-use store so a
subsequent `LIST` surfaces it (matches the IMAP CREATE-SPECIAL-USE
flow). 409 when the folder already exists.

```json
{
  "user":        "alice@x.com",
  "folder":      "Archive",
  "namespace":   "personal",
  "special_use": "\\Archive"
}
```

Response (200):

```json
{ "status": "ok" }
```

When the folder is created but `special_use` registration fails,
the response is 200 with a `special_use_error` field — the folder
exists, the operator just needs to follow up to set the attr.

**Authorisation:** admin path — bypasses ACL. backend-api itself is gated
by the bearer token, `allowed_nets` and, with internal TLS, mTLS; see
[Transport](#transport).

CLI: `yarctl backend folder create <user> <folder> [--namespace NS] [--special-use ATTR]`

### `POST /api/backend/folder/delete`

Removes a folder, its index state, and any `yarilo-acl` file +
namespace-wide list entries pointing at it. The mailbox blob
storage handles the on-disk teardown; per-mailbox ACL cleanup is
non-fatal — when it fails the operation still returns 200 with a
warning logged so the admin can correlate.

```json
{ "user": "alice@x.com", "folder": "Old", "namespace": "personal" }
```

Response (200): `{ "status": "ok" }`. 404 on missing folder.

CLI: `yarctl backend folder delete <user> <folder> [--namespace NS]`

### `POST /api/backend/folder/rename`

Renames a folder within one namespace (cross-namespace rename is
not supported). The `yarilo-acl` file is moved across index dirs
and the namespace-wide index entries are rewritten. INBOX cannot
be renamed via backend-api (reference-style move-messages semantics
not implemented here yet).

```json
{
  "user":       "alice@x.com",
  "old_folder": "Drafts",
  "new_folder": "OldDrafts",
  "namespace":  "personal"
}
```

Response (200): `{ "status": "ok" }`. 404 on missing source, 409 on
destination conflict, 400 when `old_folder == "INBOX"`.

CLI: `yarctl backend folder rename <user> <old> <new> [--namespace NS]`

### `POST /api/backend/folder/expunge`

Removes every message currently flagged `\Deleted` from a folder
(matches the IMAP EXPUNGE semantic). When `uids` is set, only
those specific UIDs are considered (matches UID EXPUNGE / UIDPLUS).
Returns the expunged UID list plus the count.

```json
{
  "user":      "alice@x.com",
  "folder":    "Trash",
  "namespace": "personal",
  "uids":      [42, 43]
}
```

Response (200):

```json
{ "status": "ok", "expunged": [42, 43], "count": 2 }
```

404 on missing folder. Per-message removal errors are logged at
Warn and the operation continues with the next message — partial
expunge is surfaced via the returned `expunged` list (count may be
smaller than requested).

CLI: `yarctl backend folder expunge <user> <folder> [--namespace NS] [--uids 1,2,3]`

## ACL endpoints

Access control on mailboxes (RFC 4314), and the namespace-wide index that lists every entry a user has. Every ACL endpoint is `POST` and takes:

```json
{ "user": "alice@x.com", "namespace": "personal", "folder": "Shared/Team" }
```

plus the fields named below. An entry is `{ "identifier": "bob@x.com", "rights": "lrsw", "negative": false }`; an identifier prefixed with `-` on the CLI is a negative entry.

| Endpoint | Extra request fields | Reply |
|:---|:---|:---|
| `/api/backend/acl/list` | — | `{"entries": [{"mailbox", "identifier", "rights"}, …]}` |
| `/api/backend/acl/get` | `root` | `{"folder", "acl": [entry, …]}` |
| `/api/backend/acl/set` | `acl` (whole list), `root` | `{"status": "ok"}` |
| `/api/backend/acl/apply` | `identifier`, `rights`, `mode`, `root` | `{"status": "ok"}` |
| `/api/backend/acl/delete` | `identifier` (optional), `root` | `{"status": "ok"}` |
| `/api/backend/acl/rebuild` | `folders` or `all`, `dry_run` | see below |
| `/api/backend/acl/materialise` | `folders`, `apply` | `{"status", "added", "skipped", "applied"}` |

A change that targets the mailbox owner's own rights, or the `owner` keyword, answers `409`: the owner always holds full rights.

CLI: `yarctl backend acl {list|get|set|delete|rebuild|materialise} …`

**The namespace root** — the ACL a shared namespace needs before anyone can
create a mailbox in it — is addressed with `--root` on the CLI and
`"root": true` on the wire, never by omitting the folder. Folder is required
everywhere else, so a dropped argument fails instead of becoming a grant on
the whole namespace.

**A named folder must exist.** `get`, `set` and `delete` answer `404 folder
not found` for a mailbox that is not there, matching what the IMAP ACL
commands have answered since 2.3.62. Previously a misspelt name was written
as given, and the store created the directory on the way — a typo became a
mailbox with permissions and no messages. `--root` names no folder, so it is
not affected.

**`apply` changes one entry atomically.** `POST /api/backend/acl/apply`
(`yarctl backend acl set`) modifies a single identifier — `"mode": "add" |
"remove" | "replace"`, default replace, empty rights with replace removes the
entry (RFC 4314 §3.1). The read-modify-write runs on the server inside the
folder lock, so a concurrent IMAP `SETACL` between the read and the write
cannot be lost. The CLI used to `get` the whole ACL, edit it and `set` it back
across two unlocked calls, which lost a concurrent write and made the client
own the canonical identifier form; `set`/`delete` of a single identifier now
route through `apply`. Full-ACL replace stays on `/acl/set` for callers that
genuinely mean to write the whole file.

**`materialise` repairs inheritance.** `POST /api/backend/acl/materialise`
(`yarctl backend acl materialise <user> <folder>…`) writes what each mailbox
inherits into its own ACL, for mailboxes created before inheritance was
materialised at creation. It is a **dry run unless `"apply": true`**, it only
ever adds — an entry already in the file is left exactly as it is and reported
under `skipped` — and a second run adds nothing. It is not automatic on
purpose: a mailbox orphaned by the old rule and one whose ACL deliberately
omits an identifier are the same file on disk. Both lists name the rights as
well as the identifier — the operator is being asked to tell a repair from a
widening, and bare identifiers print the two the same. The mailboxes are named
explicitly; there is no namespace-wide sweep, so widening a whole namespace is
not one keystroke.

**`rebuild` is the exception, deliberately.** It reseeds the index from files
already on disk, creates nothing, and is run precisely when the state is
already inconsistent — refusing the whole batch over one stale name would
fail on the state it repairs. It reports instead: `folders` counts the
mailboxes actually reseeded, and `skipped` lists the rest with a reason
(`folder not found` or `no ACL`). A batch whose names are all typos answers
`200` with an empty `rebuilt`, which is the honest answer to "reseed nothing".

**`rebuild` merges; `rebuild --all` replaces.** A named folder list reseeds
exactly those folders and leaves every other folder's index rows untouched —
repairing one mailbox must not delete the index for the rest (#1151). Passing
`"all": true` (CLI `--all`) instead addresses every folder in the namespace and
*replaces* the index, which is the only form that clears rows for folders that
no longer exist. `all` and `folders` are alternatives (`400` together), and the
reply echoes `"all"` so the mode that ran is visible. `--all` is also the answer
to drift the operator cannot enumerate — the drifted index was what would have
told them which folders to name.

**`--all` includes the namespace root, and reports it separately.** The root
carries its own ACL (`yarilo-acl-root`) and its own index rows, and it is not a
folder — no folder listing contains it. A replace built from folders alone would
delete the bootstrap grant a shared namespace cannot work without, so `--all`
addresses the root explicitly. In the reply, `rebuilt` lists **folders** (and
`folders` counts them) while the index was replaced from *all of them plus the
root*; the root's own outcome is the `root` boolean — `false` there means the
root simply holds no ACL, never "not found", since it has no name to look up.
A namespace with no folders is not a special case: `--all` then hands the
replace a genuinely complete set (the root alone) and every other row is
cleared, which is the maximal orphan case and precisely the repair. Blanking on
a *failed* enumeration would be the hazard, and that answers `500` first.

**`rebuild --dry-run` reports instead of writing.** `"dry_run": true` runs the
same walk and diffs it against the index: per folder, `missing` (in the file,
not the index), `stale` (in the index, not the file) and `mismatched` (both,
different rights), with `in_sync` summarising. Scope follows the write it
previews — a named subset compares those folders, `--all` compares everything.
This is the answer to "did my deployment drift, and where" (#1154), which was
otherwise answerable only by comparing `list` against `get` folder by folder —
presuming the folder list the drifted index was supposed to provide.

**The namespace root is a first-class address everywhere.** `"root": true`
works on `get`, `set`, `apply` and `delete` alike (CLI `--root` on each). On
the request side it must be a field: after JSON decoding an absent `folder`
and `folder: ""` are the same empty string, so the intent has no other
spelling. On the reply side there is no such ambiguity — **an empty `mailbox`
(or `folder` in the drift report) IS the namespace root**: that is its name
in the store, no folder can be called `""`, and this sentence is its
definition (#1163). The root's rows are the ones that inherit to every
mailbox under them.

### `POST /api/backend/acl/registry/list` and `POST /api/backend/acl/registry/rebuild`

The owner-discovery registry (#1168): a dict in the reference's shared-boxes
key space, synced wherever the `yarilo-acl-list` index is written. `list`
answers "which owners may this caller discover" for the bare user plus
`anyone` grants (group grants resolve against the session identity, which the
admin plane does not have — the reply says so). `rebuild` reprojects one
owner's rows from their namespace index; `acl rebuild --all` does the same as
a side effect, since the registry hangs off the index write. Both answer 400
when `acl_sharing_map` is not configured.

CLI: `yarctl backend acl registry list <user>`,
`yarctl backend acl registry rebuild <owner> --namespace NS`.

## Quota endpoints

Quota counters (RFC 9208) as the server computes them from the index.

### `GET /api/backend/quota/show?user=USER`

Usage and limits. Limits come from the user's `quota_rule` in userdb when `backend_api.auth_master_addr` is configured. Storage is in KiB; an unlimited limit is `-1`, with a percentage of `0`.

```json
{ "user": "alice@x.com",
  "storage_value": 51200, "storage_limit": 5242880, "storage_percent": 0,
  "message_value": 7, "message_limit": -1, "message_percent": 0 }
```

### `POST /api/backend/quota/recalc`

Rescans every folder and rewrites the stored counters — the repair for a counter that has drifted. Body: `{ "user", "namespace" }`. Reply: `{ "user", "storage_bytes", "messages" }`. `404` when the user has no mail home yet; an unknown namespace is `400`, as on every other route.

### `GET /api/backend/quota/clone/list` and `GET /api/backend/quota/clone/get?backend=NAME&user=USER`

Inspect a configured quota mirror. `list` returns `{"backends": [...]}`. `get` returns `{ "backend", "user", "storage_bytes", "storage_found", "messages", "messages_found", "malformed" }`. The mirror is advisory; `show` stays authoritative.

CLI: `yarctl backend quota {show|recalc|clone list|clone get} …`


## User endpoints

### `POST /api/backend/user/info`

Returns what backend-api resolves locally — the username, the template-resolved home, the effective mail and INBOX paths, and every configured namespace with whether its on-disk root exists — plus the `userdb` block when `backend_api.auth_master_addr` is configured.

```json
{
  "username":        "alice@x.com",
  "home":            "/var/mail/vhosts/x.com/alice",
  "mail_path":       "/var/mail/vhosts/x.com/alice/Maildir",
  "mail_inbox_path": "/var/mail/vhosts/x.com/alice/Maildir",
  "namespaces": [
    { "name": "personal", "type": "personal", "prefix": "", "home": "/var/mail/vhosts/x.com/alice", "location": "", "exists": true }
  ],
  "userdb": {
    "uid": 1001, "gid": 1001,
    "home": "/var/mail/vhosts/x.com/alice",
    "mail_location": "maildir:~/Maildir",
    "quota_rule": ["*:storage=5G"]
  }
}
```

With `auth_master_addr` unset, `userdb` is absent. With it set:

- a user userdb does not know answers `200 {"error": "user not found: …"}`;
- a failed userdb call answers `503`, so the local view is not mistaken for a complete one.

CLI: `yarctl backend user info <user>`

### `POST /api/backend/user/iterate`

Enumerates every username the yarilo-auth userdb backend can
surface. Thin wrapper over `pkg/authclient`'s `IterateUsers`; the
response is a sorted username array.

```json
{ "users": ["alice@x.com", "bob@x.com", "carol@x.com"] }
```

Returns 503 when `backend_api.auth_master_addr` is unset (no userdb
to enumerate); returns 502 when the master-protocol call fails
(reason text in the JSON `error` field).

CLI: `yarctl backend user iterate`

### `POST /api/backend/user/usage`

Walks every folder in every implemented namespace and reports
per-folder message + byte totals plus the rollups.

```json
{
  "user": "alice@x.com",
  "folders": [
    { "namespace": "personal", "folder": "INBOX", "messages": 7, "size_bytes": 1234567 }
  ],
  "total_messages":   7,
  "total_size_bytes": 1234567
}
```

CLI: `yarctl backend user usage <user>`

## Index endpoints

### `POST /api/backend/index/dump`

Walks an existing folder's index and returns every record. Use the optional `limit` field to cap the response size.

```json
// request
{ "user": "alice@x.com", "folder": "INBOX", "namespace": "personal", "limit": 100 }

// response
{
  "folder":         "INBOX",
  "folder_guid":    "ab12...ef",
  "uid_validity":   1747000000,
  "next_uid":       42,
  "highest_modseq": 19,
  "truncated":      false,
  "records": [
    { "uid": 1, "filename": "1747000000.M...", "flags": ["\\Seen"], "keywords": [], "modseq": 5, "size": 1234, "vsize": 1234, "guid": "..." }
  ]
}
```

CLI: `yarctl backend index dump <user> <folder> [--limit N]`

### `POST /api/backend/index/rebuild`

Regenerates the fileindex for one folder from the on-disk storage
(driver-specific `Scan`). The new index preserves every UID that
the old index already knew for the same filename and assigns fresh
UIDs (from the current `next_uid`) to filenames the index has not
seen — so client UID caches stay valid for everything they could
already see.

Driver support:

| Driver | Behaviour |
|:---|:---|
| `maildir` | Walks `cur/` + `new/`, parses flags + size from filename. Flags from disk win over the previous index (the filename is the source of truth for maildir). |
| `sdbox` | Walks `u.<seq>` files, reads GUID + size + Received date from the per-file trailer. Flags are left empty in the scan — the rebuild keeps prior index flags. |
| `mdbox` | Returns `501`: its storage is folder-agnostic. Use `index/rebuild-storage`. |

```json
// request
{ "user": "alice@x.com", "folder": "INBOX", "namespace": "personal" }

// response
{
  "folder":           "INBOX",
  "folder_guid":      "ab12...ef",
  "scanned":          42,
  "uids_preserved":   40,
  "uids_assigned":    2,
  "orphans_dropped":  0,
  "duration_ms":      37
}
```

Optional `"reset_uids": true` is rejected with `501` today —
nuking UIDs forces every client to full resync via UIDVALIDITY
bump, so the v1 path is `DELETE + CREATE` via IMAP. Will land
once the design for UIDVALIDITY semantics is locked.

The endpoint takes the cross-process mailbox lock
(`locks.MailboxKey`) for the whole rebuild so concurrent
IMAP writers cannot race the snapshot.

CLI: `yarctl backend index rebuild <user> <folder> [--namespace NS]`

### `POST /api/backend/index/rebuild-storage`

The mdbox storage-wide rebuild: reconcile the shared map against the physical `m.<N>` files, reset every folder index to the surviving messages, recompute reference counts, and drop map records whose message is gone. It refuses on an incomplete scan or an unmounted alt tier. Run it with delivery to that account quiesced.

Body: `{ "user", "namespace", "restore_orphans" }`. `restore_orphans` re-files unreferenced messages carrying an `ORIG_MAILBOX` tag back into their folder. Reply: `{ "scanned", "folders_rebuilt", "expunged", "unreferenced_zeroref", "orphans_restored", "files_normalised", "rebuild_count", "duration_ms", "note" }`.

Other drivers answer `400`; use `index/rebuild` per folder.

CLI: `yarctl backend index rebuild-storage <user> [--namespace NS] [--restore-orphans]`

### `POST /api/backend/index/check`

Reads every folder of the account and reports index records whose size reads back as their own storage key, the trace of a record tail written at a width the index did not announce. Read-only unless `"fix": true`, which rebuilds each such record's storage key, size and GUID from the message in storage.

Body: `{ "user", "namespace", "fix" }`. Reply: `{ "user", "checked", "shifted", "repaired", "skipped", "folders": [{ "folder", "checked", "shifted", "repaired", "skipped" }], "failed", "duration_ms", "note" }`.

CLI: `yarctl backend index check <user> [--namespace NS] [--fix]`

### `POST /api/backend/index/rebuild-guid-store`

Writes the per-account GUID store from the folder indexes: one record per copy of a message, which is what a JMAP id resolves through. The store is derived; run this when it is missing, behind, or written by an older build.

Body: `{ "user", "namespace" }`. Reply: `{ "folders", "copies" }`.

CLI: `yarctl backend index rebuild-guid-store <user> [--namespace NS]`

### `POST /api/backend/index/optimize`

Compacts the index log into the base index. No semantic change — records, UIDs and modseqs stay identical; only the on-disk layout shrinks. A fast no-op when the log holds only its header.

```json
// request
{ "user": "alice@x.com", "folder": "INBOX", "namespace": "personal" }

// response
{ "folder": "INBOX", "duration_ms": 4,
  "before": { "base_bytes": 8192, "log_bytes": 4096 },
  "after":  { "base_bytes": 9216, "log_bytes": 64 } }
```

With `"all": true` instead of a folder, every folder of the account is compacted, and the per-user map where the driver keeps one. The reply is then `{ "user", "folders": [...], "failed": [...], "map_folded", "map_before", "map_after", "folded_count", "failed_count", "total_ms" }`.

CLI: `yarctl backend index optimize <user> {<folder> | --all} [--namespace NS]`

### `POST /api/backend/index/cache-purge`

Rewrites a folder's `yarilo.index.cache` as a **new generation** holding only
the records live messages point at, and reclaims the rest. The reply carries
`carried` (records moved), `reclaimed_bytes` and `duration_ms`.

CLI: `yarctl backend index cache-purge <user> <folder> [--namespace NS]`.

> **The cache only grows on its own — purging is an operator action in v1.**
> The file is append-only: every envelope or body structure a client asks for
> is parsed once and appended, and expunging the message leaves its record
> behind. There is no automatic trigger yet (the reference purges on
> thresholds — deleted-record count, size); the only automatic bound is the
> format's own offset ceiling, which refuses further appends rather than
> corrupting anything, so a folder that reaches it simply stops caching until
> purged. Run this after a large expunge, or periodically on busy folders.
>
> **A generation is only ever left by entering the next one.** That holds for
> the failure paths too: an unreadable cache is dropped *and* the generation
> moved, because stamps left in the index would otherwise apply to whatever is
> written at those offsets next — a fully decodable record belonging to
> another message, which no validity check can catch. Generations are seeded
> from the clock rather than counted, since a rebuild reapplies the default
> extensions and would otherwise hand back a number already used.
>
> **A purge is a new generation, never an edit.** Survivors are written to a
> new file with a new `file_seq`, and the index's `cache` extension has its
> `reset_id` moved to match in one write — which invalidates every stale
> offset at once, with no walk over records. Every crash point lands on a
> state readers already treat as "no cache, rebuild lazily", so an interrupted
> purge costs a reparse, never a wrong answer. It takes the same per-mailbox
> lock the session-side cache window takes.

## mdbox endpoints

### `POST /api/backend/mdbox/purge`

Compacts the storage tree: every `m.<N>` file holding at least one zero-reference record is rewritten without those records, or unlinked when all of them are dead. Body: `{ "user", "namespace" }`. Reply: `{ "files_scanned", "files_rewritten", "files_unlinked", "records_kept", "records_expunged", "bytes_reclaimed" }`.

### `POST /api/backend/mdbox/altmove`

Moves messages to the alt (cold) tier, or back with `"reverse": true`. `before` (RFC 3339) limits it to messages whose internal date precedes it. Requires `storage.mdbox_alt_storage_path`. Body: `{ "user", "namespace", "before", "reverse" }`. Reply: `{ "candidates", "moved", "files_created", "files_unlinked", "bytes_moved" }`.

CLI: `yarctl backend mdbox {purge|altmove} …`

## Message endpoint

### `POST /api/backend/message/get`

Returns the content of one stored message. Body: `{ "user", "folder", "namespace", "uid" | "guid", "mode" }`; exactly one of `uid` and `guid`.

- `"mode": "mime"` answers `text/plain`: the headers and each part's headers, with part bodies elided.
- `"mode": "raw"` answers `message/rfc822`: the message byte for byte.

No flag is set and no counter moves. Every call is recorded on the backend, with the number of bytes handed over.

CLI: `yarctl backend mailbox message get {mime|raw} <user> <folder> {--uid N | --guid G} [--namespace NS] [--out FILE]`

## Subscriptions endpoints

Per-user IMAP SUBSCRIBE state. Reuses
`internal/userstate/subs.Store` — same on-disk format (sorted folder
names, tmp+rename atomicity) and the same `locks.SubscriptionsKey`
as IMAP, so concurrent sessions see admin writes immediately.

| Endpoint | Request | Response |
|:---|:---|:---|
| `POST /api/backend/subscriptions/list` | `{user, namespace?}` | `{"subscriptions": [...]}` |
| `POST /api/backend/subscriptions/add` | `{user, folder, namespace?}` | `{"status": "ok"}` |
| `POST /api/backend/subscriptions/remove` | `{user, folder, namespace?}` | `{"status": "ok"}` |

CLI: `yarctl backend subscriptions {list|add|remove} <user> [<folder>] [--namespace NS]`


### `POST /api/backend/subscriptions/migrate`

Folds a namespace's old per-namespace subscription file into the subscriber's
own, for a namespace that no longer keeps one (`subscriptions: false`, and always
so for an owner-templated namespace). Dry run unless `"apply": true`.

Those rows were written into the **owner's** store, and every one names a mailbox
in the owner's own space, so folding restores the owner's subscriptions exactly;
the owner also inherits any a peer created, all pointing at mailboxes they
already see. Authorship was never recorded, so a peer's subscription cannot be
returned to the peer — peers re-subscribe themselves. Deleting the file instead
would have removed the owner's own subscriptions silently.

Idempotent: the sources are removed only after every row is in the destination,
so a failure leaves the run repeatable, and a second run finds nothing. Both
historical names are read — the current one and the pre-#1159 path form.

Reply: `sources` (files read), `folded` (keys added), `already` (keys the
destination held).

CLI: `yarctl backend subscriptions migrate <user> --namespace NS [--apply]`

## SpecialUse endpoints

Per-user RFC 6154 special-use overrides. Reuses
`internal/userstate/specialuse.Store` — same on-disk format and
the same lock key as IMAP `CREATE (USE ...)`.

Only the personal namespace carries special-use — RFC 6154
`\Sent` / `\Drafts` / etc. do not extend to shared or public.

| Endpoint | Request | Response |
|:---|:---|:---|
| `POST /api/backend/specialuse/list` | `{user}` | `{"overrides": {...}, "defaults": {...}}` |
| `POST /api/backend/specialuse/get` | `{user, folder}` | `{"folder", "attr", "source": "override"\|"default"\|"none"}` |
| `POST /api/backend/specialuse/set` | `{user, folder, attr}` | `{"status": "ok"}` |
| `POST /api/backend/specialuse/delete` | `{user, folder}` | `{"status": "ok"}` |

CLI: `yarctl backend specialuse {list|get|set|delete} <user> [<folder>] [<attr>]`

## Metadata endpoints

RFC 5464 METADATA admin surface backed by the configured `metadata`
dict (same one IMAP GETMETADATA / SETMETADATA reads/writes). Keys
follow the GUID-namespaced layout from `pkg/mailbox/attribute.go`,
so admin writes are visible to the next IMAP round-trip.

Request envelope (every metadata endpoint accepts it):

```json
{
  "user":      "alice@x.com",
  "folder":    "INBOX",
  "namespace": "personal",
  "scope":     "private",
  "entry":     "/private/comment",
  "value":     "<base64>",
  "as_user":   "alice@x.com"
}
```

- Empty `folder` targets server scope (vendor-prefixed under INBOX's GUID).
- `scope` is `private` or `shared` for `list`; `get`/`set`/`delete`
  derive it from the leading `/private/` or `/shared/` in `entry`.
- `as_user` matters for shared/public folders under `/private/`
  scope where each user has their own slice; defaults to `user`.

| Endpoint | Notes |
|:---|:---|
| `POST /api/backend/metadata/list` | Iterates every entry under the chosen scope; values base64-encoded. |
| `POST /api/backend/metadata/get` | Returns `{found, value}` for one entry. |
| `POST /api/backend/metadata/set` | `value` is base64. Wraps a single dict transaction. |
| `POST /api/backend/metadata/delete` | Unset one entry under one dict transaction. |

CLI: `yarctl backend metadata {list|get|set|delete} <user> [<folder>] --entry /private/<name> [...]`

## Sessions, who and warden

### `POST /api/backend/who`

Active-session listing. Data source is `yarilo-warden` — backend-api dials it per request, runs `WHO`, then closes.

```json
// request (all fields optional)
{ "service": "imap", "user": "alice@x.com", "group_by": "user", "all": false }

// response (default group_by="user")
{
  "total": 2,
  "groups": [
    {
      "user":  "alice@example.com",
      "total": 1,
      "sessions": [
        { "id": "s1", "user": "alice@example.com", "ip": "1.1.1.1", "service": "imap", "connected_at": "2026-05-31T15:00:00Z", "folder": "INBOX", "backend": "10.0.0.1" }
      ]
    }
  ]
}

// response when group_by="none"
{ "total": 2, "sessions": [ ... flat list ... ] }
```

- Filters: `service=imap|pop3|submission|lmtp` and `user=<exact>`.
- `all: false` (the default) lists only this backend's sessions; `true` lists every backend's.
- `folder` is the SELECTed IMAP mailbox, empty when none or not IMAP; `backend` is the backend pod the session routed to.

**What "active" means:** entries register on login-pod `CONNECT` and clear on `DISCONNECT`. LMTP deliveries do not go through warden and are not listed. A login-pod crash can leave stale entries behind.

Returns `501` when `warden_service.listen` is empty.

CLI: `yarctl backend who [list] [--protocol P] [--user U] [--all] [--output table|json]`; the CLI picks `group_by` from `--output`.

### `POST /api/backend/who/count`

Aggregated counts. Same filters as `/who` plus an optional
breakdown dimension.

```json
// request
{ "service": "imap", "user": "alice@x.com", "by": "" }

// response
{ "total": 1, "service": "imap", "user": "alice@x.com" }

// request — breakdown by protocol
{ "by": "protocol" }

// response
{
  "total":       5,
  "by_protocol": { "imap": 3, "pop3": 1, "submission": 1 }
}

// request — breakdown by user
{ "by": "user" }

// response
{
  "total":   5,
  "by_user": { "alice@x.com": 2, "bob@x.com": 3 }
}
```

`all` works as on `/who`.

CLI:

```
yarctl backend who count                          # global total
yarctl backend who count imap                     # total for protocol
yarctl backend who count --user alice@x.com       # total for user
yarctl backend who count --by protocol            # breakdown by protocol
yarctl backend who count --by user                # breakdown by user
yarctl backend who count --all                    # every backend
```

### `POST /api/backend/sessions/kick`

Closes one session. Body: `{ "session_id", "user", "protocols" }`. backend-api hands the kick to `yarilo-warden`, which emits it on each protocol's channel; only the owner of that id reacts. `protocols` narrows the channels; `user` is recorded for the audit log only.

Reply: `{ "emitted_to": [...], "errors": [...] }`. It means the kick was emitted, not that the session is confirmed closed. `503` when `warden_addr` is not configured, `502` when warden cannot be reached.

CLI: `yarctl backend sessions kick <sess-id> [--user U] [--protocols imap,pop3,...]`

### `GET /api/backend/warden/dump`

The connection accounting `yarilo-warden` holds: who is connected, from where, and how the per-user and per-IP limits stand. `503` when `warden_addr` is not configured, `502` when warden fails.

CLI: `yarctl backend warden dump [--output table|json]`

## Full-text search endpoints

All four take query parameters and reach `yarilo-fts`. GUID and UIDVALIDITY are resolved from the index, so callers name only the user and folder. Each answers `501` when backend-api has no `fts_addr`, and `502` when the FTS service fails.

| Endpoint | Parameters | Reply |
|:---|:---|:---|
| `GET /api/backend/fts/status` | `user`, `folder` | `{ "user", "folder", "last_indexed_uid", "settings_checksum", "documents", "copies", "messages", "unrecorded_copies" }` |
| `POST /api/backend/fts/rescan` | `user`, `folder` (optional: every folder) | `{ "user", "folders" }` |
| `POST /api/backend/fts/optimize` | `user` | `{ "status", "user" }` |
| `GET /api/backend/fts/lookup` | `user`, `folder`, repeatable `header=NAME:VALUE`, `body`, `text` | `{ "user", "folder", "terms", "impossible", "definite", "maybe" }` |

`lookup` asks the index what an IMAP `SEARCH` would, with the criteria ANDed. See [FTS](./FTS) for the index itself.

CLI: `yarctl backend fts {status|rescan|optimize|lookup} …`

## OpSettings shape

Used in the `op` field of every endpoint that mutates or reads
per-user state. All fields optional; an empty `op` is equivalent
to no `op` field at all.

```json
{
  "username": "alice@example.com",
  "home_dir": "/var/mail/vhosts/example.com/alice",
  "expire_secs": 3600
}
```
