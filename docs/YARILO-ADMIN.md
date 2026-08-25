# yarctl

Unified operator CLI for yarilo. Two top-level planes:

| Plane | Talks to | What | Subcommands |
|:---|:---|:---|:---|
| `director` | `yarilo-director` `:9103` | ring / backends / users / peers | `director status / dump / map / backends / users / ring` |
| `backend` | `yarilo-backend-api` `:9105` | per-backend storage state | `backend dict / folder / user / index / subscriptions / specialuse / metadata / who` (acl / quota land in their feature phases) |

Both planes speak JSON over plain HTTP with Bearer-token auth plus an IP
allow-list (they are in-cluster ClusterIP services, not internet-facing).
See [DIRECTOR-API.md](DIRECTOR-API.md) and [BACKEND-API.md](BACKEND-API.md)
for the wire references.

---

## Quick start

```sh
# exec into the director pod
kubectl exec -it <director-pod> -- yarctl director status

# or from outside the cluster (set URL + token explicitly)
yarctl --url http://10.0.0.1:9103 --token <token> director status
```

---

## Configuration

No flags needed when running inside the director pod.
The container already has the required environment variables set.

| Variable | Default | Description |
|:---|:---|:---|
| `YARILO_ADMIN_URL` | `http://localhost:9103` | Director API base URL (used by `director` subcommand) |
| `YARILO_ADMIN_TOKEN` | — | Director Bearer token (fallback: `DIRECTOR_API_TOKEN`) |
| `YARILO_BACKEND_API_URL` | `http://localhost:9105` | Backend API base URL (used by `backend <service>` subcommands) |
| `YARILO_BACKEND_API_TOKEN` | — | Backend API Bearer token (fallback: `BACKEND_API_TOKEN`) |

To read the auto-generated tokens from outside the pod:

```sh
kubectl get secret yarilo-director-api-token -o jsonpath='{.data.token}' | base64 -d
kubectl get secret yarilo-backend-api-token   -o jsonpath='{.data.token}' | base64 -d
```

---

## Global flags

```
yarctl [--url URL] [--token TOKEN] \
             [--backend-url URL] [--backend-token TOKEN] \
             <resource> <action> [args...]
```

Global flags (`-O`, `--url`, `--token`, `--backend-url`, `--backend-token`, …)
are **position-independent** — they may appear before the plane, between the
plane and the command, or trailing. All of these are equivalent:

```sh
yarctl -O json director ring status
yarctl director ring status -O json
yarctl director -O json ring status
```

| Flag | Default | Used by | Description |
|:---|:---|:---|:---|
| `--url` | `$YARILO_ADMIN_URL` or `http://localhost:9103` | `director` | Director API base URL |
| `--token` | `$YARILO_ADMIN_TOKEN` or `$DIRECTOR_API_TOKEN` | `director` | Director Bearer token |
| `--backend-url` | `$YARILO_BACKEND_API_URL` or `http://localhost:9105` | `backend <service>` | Backend API base URL |
| `--backend-token` | `$YARILO_BACKEND_API_TOKEN` or `$BACKEND_API_TOKEN` | `backend <service>` | Backend API Bearer token |

The two URLs are separate by design: director-plane ops (ring,
backends, users, peers) live on `yarilo-director:9103`; backend-plane
ops (dict / acl / quota / folder / user / mailbox) live on
`yarilo-backend-api:9105`. Each binary holds the state its plane
exposes — director state lives in director's process; backend state
(NFS + dicts) lives on backend pods.

---

## Command index

Every family the tool exposes, and where each is documented. `yarctl` is
organised as **planes** — `director`, `backend`, `auth` — with a few shorthands
that skip the prefix.

| Family | What it manages | Documented |
|:---|:---|:---|
| `director` | ring, backends, per-user routing, peers | [below](#director) |
| `backend dict` | key-value store operations | [below](#backend-dict) |
| `backend acl` | RFC 4314 access control | [below](#backend-acl) |
| `backend quota` | RFC 9208 counters and clones | [below](#backend-quota) |
| `backend folder` | listing, GUIDs, repair, create/rename/delete | [below](#backend-folder) |
| `backend user` | userdb queries, per-folder usage, enumeration | [below](#backend-user) |
| `backend index` | index dump, rebuild, fold, cache purge | [below](#backend-index) |
| `backend mdbox` | map purge, alt-storage moves | [below](#backend-mdbox) |
| `backend subscriptions` | IMAP SUBSCRIBE state | [below](#backend-subscriptions) |
| `backend specialuse` | RFC 6154 special-use attributes | [below](#backend-specialuse) |
| `backend metadata` | RFC 5464 annotations | not yet; this row is the record |
| `backend who` | active sessions | not yet; this row is the record |
| `backend sessions` | kick a session by id | not yet; this row is the record |
| `fts` | search index status, rescan, optimize | [FTS](/FTS) |
| `auth` | auth-cache flush, SCRAM verifier generation | not yet; this row is the record |
| `warden` | connection accounting dump | not yet; this row is the record |
| `wait` | block until endpoints answer | not yet; this row is the record |

Run any family with no command to get its usage; the text there is the same one
this page documents.

## Commands

### `director status`

Ring state overview: backends and peers.

```sh
yarctl director status
```

```json
{
  "backends": [
    {"ip": "10.0.0.1", "port": 993, "tag": "ssd", "up": true, "vhosts": 100}
  ],
  "peers": ["10.0.0.2:9102"]
}
```

---

### `director dump`

Full state: backends, active user→backend entries, peers.

```sh
yarctl director dump
```

---

### `director map`

Show user→backend mappings. Without `--user` returns all active entries from userDir.
With `--user` performs a live ring lookup.

```sh
yarctl director map
yarctl director map --user alice@example.com
```

---

### `director backends list`

List all backends in the ring.

```sh
yarctl director backends list
```

---

### `director backends add`

Add a backend to the ring.

```sh
yarctl director backends add <ip> --port <port> [--tag <tag>] [--vhosts <n>]
```

```sh
yarctl director backends add 10.0.0.3 --port 993 --tag ssd
yarctl director backends add 10.0.0.4 --port 993 --tag ssd --vhosts 200
```

---

### `director backends remove`

Remove a backend from the ring.

```sh
yarctl director backends remove <ip>
```

```sh
yarctl director backends remove 10.0.0.3
```

---

### `director backends update`

Update the virtual node weight of a backend.

```sh
yarctl director backends update <ip> --vhosts <n>
```

```sh
yarctl director backends update 10.0.0.3 --vhosts 200
```

---

### `director backends up`

Mark a backend as up (resumes routing to it).

```sh
yarctl director backends up <ip>
```

---

### `director backends down`

Mark a backend as down / flush (stops new routing, existing sessions continue).

```sh
yarctl director backends down <ip>
```

---

### `director backends flush`

Flush a specific backend or all backends at once.

```sh
yarctl director backends flush <ip|all>
```

```sh
yarctl director backends flush 10.0.0.3
yarctl director backends flush all
```

---

### `director users move`

Force-assign a user to a specific backend, overriding consistent-hash routing.

```sh
yarctl director users move <user> --backend <ip:port>
```

```sh
yarctl director users move alice@example.com --backend 10.0.0.1:993
```

---

### `director users kick`

Kick a user — all active sessions for that user are terminated.

```sh
yarctl director users kick <user>
```

```sh
yarctl director users kick alice@example.com
```

---

### `director ring status`

Show the ring topology **as the queried replica sees it** (ring membership is
per-replica, so this is one replica's own view). For every member it prints the
computed left/right neighbors in `(ip,port)` order, and for this replica's
direct neighbors the live edge — role (`left`/`right`, or `both` at N=2 where a
single connection serves both directions), state (`connected`/`reconnecting`)
and uptime. It also prints each member's dedup watermark (highest `seq`
processed from that origin; `-` when none has been heard) and any tombstones
(members known dead on this replica, with the tombstone age).

```sh
yarctl director ring status
```

```
ring status: 3 directors (self 10.0.0.2:9102)
IDX  ADDR              LEFT | RIGHT                       LINK                  SEQ
0    10.0.0.1:9102     10.0.0.3:9102 | 10.0.0.2:9102      left connected 4m12s  41
1  * 10.0.0.2:9102     10.0.0.1:9102 | 10.0.0.3:9102      (self)                42
2    10.0.0.3:9102     10.0.0.2:9102 | 10.0.0.1:9102      right connected 4m12s 40
```

Use `-O json` for the structured object (`schemaVersion`, `self`, `size`,
`members[]`, `tombstones[]`) — suitable for programmatic topology assertions.

#### `--all` — cross-replica view with a health verdict

Because ring membership is per-replica, `--all` makes the queried director
aggregate every replica's own view server-side (one authorized fan-out to
peers' admin APIs) and returns a matrix plus a `healthy` verdict:

```sh
yarctl director ring status --all
```

```
ring topology: UNHEALTHY (3 replicas, 1 issue)
REPLICA           REACHABLE  SIZE  SELF-NEIGHBORS (L | R)
10.0.0.1:9102     yes        3     10.0.0.3:9102 | 10.0.0.2:9102
10.0.0.2:9102     yes        3     10.0.0.1:9102 | 10.0.0.3:9102
10.0.0.3:9102     no         -     -
issues:
  [error] peer-unreachable: 10.0.0.3:9102 is in membership but its view could not be collected
assumptions:
  - peer API endpoints derived as <ring-ip>:9103 — assumes uniform api.listen across replicas
  - admin API is plain HTTP guarded by Bearer token + api.allowed_nets; fan-out source is a director pod IP
```

The verdict flips to `UNHEALTHY` on `error`-severity issues — `peer-unreachable`
(a member whose view could not be collected — never reported as healthy),
`view-size-mismatch`, `asymmetric-edge` (A.right=B but B does not see A as its
left), and `tombstone-divergence`. `seq-lag` is `warn`-only and does **not**
fail the verdict (watermarks legitimately differ during activity). `-O json`
returns `{schemaVersion, healthy, issues[], replicas[], assumptions[]}`.

**Precondition:** the fan-out derives each peer's API endpoint from its ring IP
plus this replica's `api.listen` port, so all directors must share the same
`api.listen` (true for a Helm release sharing one ConfigMap), and `api.allowed_nets`
(if set) must include the director pod CIDR.

---

### `director ring add`

Dynamically add a peer director. Active until pod restart — for permanent peers
use `components.director.peers` in Helm values.

```sh
yarctl director ring add <addr>
```

```sh
yarctl director ring add 10.0.0.4:9102
```

---

### `director ring remove`

Disconnect a peer director.

```sh
yarctl director ring remove <addr>
```

```sh
yarctl director ring remove 10.0.0.4:9102
```


---

## Backend plane

Everything under `yarctl backend <service>` talks to `yarilo-backend-api`
(default `http://localhost:9105`, or `$YARILO_BACKEND_API_URL`). Override per
invocation with `--backend-url` and `--backend-token`.

Commands that name a mailbox take `--namespace NS` (default `personal`). A
command that writes says so in its **Effect** line; the rest only read.

### `backend dict`

Direct access to the key-value stores the server keeps its non-mail state in —
quota counters, metadata annotations, ACL indexes. An escape hatch for
inspection and repair, not a routine tool: writing here bypasses the code that
normally maintains these rows.

```
yarctl backend dict drivers
yarctl backend dict exists NAME
yarctl backend dict lookup [op-flags] NAME KEY
yarctl backend dict iterate [--recurse] [--no-value] [--exact] [--sort-key] [--sort-value] NAME PATH
yarctl backend dict set [--value-stdin] [op-flags] NAME KEY [VALUE]
yarctl backend dict unset [op-flags] NAME KEY
yarctl backend dict atomic-inc [op-flags] NAME KEY DELTA
yarctl backend dict expire-scan NAME
yarctl backend dict commit-batch [op-flags] NAME
```

`NAME` is a configured dict (`metadata`, `quota`, …); `exists` answers whether
it resolves. Op-flags carry the identity a dict operation runs under:
`--user USER`, `--home DIR`, `--expire-secs N` (default TTL for writes).

`iterate` streams NDJSON, so it is safe over a large prefix.
`commit-batch` reads a TAB-delimited script from stdin —
`set\tKEY\tBASE64`, `unset\tKEY`, `atomic-inc\tKEY\tDELTA` — and applies it
as one batch.

```sh
yarctl backend dict lookup metadata priv/box/abc123/comment
yarctl backend dict iterate --recurse --sort-key metadata priv/
yarctl backend dict atomic-inc quota priv/quota/storage 1024
```

**Effect:** `set`, `unset`, `atomic-inc`, `expire-scan` and `commit-batch`
write; `expire-scan` drops rows whose TTL has passed. The rest read.

### `backend acl`

Access control on mailboxes (RFC 4314), including the namespace-wide index that
lists every entry a user has.

```
yarctl backend acl list   <user>
yarctl backend acl get    <user> <mailbox>
yarctl backend acl get    --root <user>
yarctl backend acl set    <user> <mailbox> <identifier> <rights>
yarctl backend acl set    --root <user> <identifier> <rights>
yarctl backend acl delete <user> <mailbox> [<identifier>]
yarctl backend acl delete --root <user> [<identifier>]
```

`--root` targets the namespace root rather than a mailbox. An identifier
prefixed with `-` is a **negative** entry (rights subtracted). `set` upserts one
entry, replacing any existing line for the same identifier; `delete` without an
identifier drops the whole file.

```sh
yarctl backend acl set alice@example.com Shared/Team bob@example.com lrsw
yarctl backend acl get alice@example.com Shared/Team
```

**Effect:** `set` and `delete` rewrite the mailbox's ACL file and the index.

### `backend quota`

Quota counters (RFC 9208) as the server computes them from the index.

```
yarctl backend quota show   <user>
yarctl backend quota recalc <user> [--namespace NS]
yarctl backend quota clone list
yarctl backend quota clone get <backend> <user>
```

`show` reports current usage. **Limits print as 0 (unlimited) from this
endpoint** — `quota_rule` values live in the userdb layer, so read them there.
`recalc` rescans every folder and rewrites the counters, which is the repair for
a counter that has drifted. `clone` inspects a configured mirror; the mirror is
advisory and `show` remains authoritative.

```sh
yarctl backend quota show alice@example.com
yarctl backend quota recalc alice@example.com
```

**Effect:** `recalc` rewrites the stored counters. The rest read.

### `backend folder`

Mailbox-level operations: listing, identity, sizes, repair, and the create /
rename / delete trio.

```
yarctl backend folder list    <user> [--namespace NS]
yarctl backend folder info    <user> <folder> [--namespace NS]
yarctl backend folder guid    <user> <folder> [--namespace NS]
yarctl backend folder stats   <user> <folder> [--namespace NS]
yarctl backend folder repair  <user> <folder> [--namespace NS]
yarctl backend folder create  <user> <folder> [--namespace NS] [--special-use ATTR]
yarctl backend folder delete  <user> <folder> [--namespace NS]
yarctl backend folder rename  <user> <old> <new> [--namespace NS]
yarctl backend folder expunge <user> <folder> [--namespace NS] [--uids 1,2,3]
```

`guid` prints the rename-stable identifier — the one `MAILBOXID` reports and
the one a Sieve script targets with `fileinto :mailboxid`. `stats` is `info`
plus on-disk totals. `repair` rebuilds the folder's index from what is on disk
and compacts its log.

`--special-use` on `create` is personal-namespace only (RFC 6154). `rename`
does not support INBOX. `expunge` without `--uids` drops every message flagged
`\Deleted` in the folder.

```sh
yarctl backend folder list alice@example.com
yarctl backend folder guid alice@example.com Archive
yarctl backend folder expunge alice@example.com Trash
```

**Effect:** `repair`, `create`, `delete`, `rename` and `expunge` write; `delete`
also removes the folder's ACL state. The rest read.

### `backend user`

What the server knows about an account.

```
yarctl backend user info    <user>
yarctl backend user usage   <user>
yarctl backend user iterate
```

`info` prints the username, the resolved home, the configured namespaces and —
when `backend_api.auth_master_addr` points at `yarilo-auth` — the userdb block
plus a `userdb_status` of `ok`, `not_found` or `error`. That status is the
useful part when an account behaves as though it does not exist.

`usage` gives per-folder message and byte totals across every namespace.
`iterate` enumerates every username the userdb backend can list, and answers
`503` when no auth address is configured — enumeration is a userdb capability,
not a local one.

```sh
yarctl backend user info alice@example.com
yarctl backend user usage alice@example.com
```

**Effect:** none; all three read.

### `backend index`

The per-folder index: what it holds, and how to rebuild it when it stops
matching the storage underneath.

```
yarctl backend index dump            <user> <folder> [--namespace NS] [--limit N]
yarctl backend index rebuild         <user> <folder> [--namespace NS]
yarctl backend index rebuild-storage <user> [--namespace NS] [--restore-orphans]
yarctl backend index optimize        <user> <folder> [--namespace NS]
yarctl backend index optimize        <user> --all [--namespace NS]
yarctl backend index cache-purge     <user> <folder> [--namespace NS]
```

`dump` prints every record — UID, flags, modseq, size, GUID.

`rebuild` regenerates **one folder's** index from the storage on disk, keeping
the UIDs of filenames the index already knows. It is for maildir and sdbox and
answers `501` for mdbox, whose storage is folder-agnostic.

`rebuild-storage` is the mdbox equivalent, and it is the heavier tool:
reconcile the shared map against the physical `m.<N>` files, reset every folder
index to the surviving messages, recompute reference counts, and drop map
records whose message is gone. It refuses to run on an incomplete scan or an
unmounted alt tier. **Run it with delivery to that account quiesced.**
`--restore-orphans` re-files unreferenced messages carrying an `ORIG_MAILBOX`
tag back into their folder; off by default, because the tag proves the message
was once there, not that it is lost now.

`optimize` folds the index log into the base index — no semantic change, safe
while nothing is reading the folder. With `--all` it folds every folder of the
account, and the per-user map where the driver keeps one.

`cache-purge` rewrites the message cache as a new generation holding only what
live messages point at. The cache is append-only and never shrinks by itself;
there is no automatic trigger, so this is an operator action.

```sh
yarctl backend index dump alice@example.com INBOX --limit 20
yarctl backend index optimize alice@example.com --all
```

**Effect:** everything except `dump` rewrites index state.

### `backend mdbox`

The two mdbox-specific storage operations.

```
yarctl backend mdbox purge   <user> [--namespace NS]
yarctl backend mdbox altmove <user> [--namespace NS] [--before RFC3339] [--reverse]
```

`purge` compacts the storage tree: every `m.<N>` file holding at least one
zero-reference record is rewritten without those records, or unlinked when all
of them are dead. The map is rewritten atomically, and folder indexes pointing
at live records keep working without per-folder I/O.

`altmove` moves messages to the alt (cold) tier, or back with `--reverse`.
`--before` limits it to messages whose internal date precedes an RFC 3339
timestamp. Requires `storage.mdbox_alt_storage_path`.

```sh
yarctl backend mdbox altmove alice@example.com --before 2025-01-01T00:00:00Z
yarctl backend mdbox purge alice@example.com
```

**Effect:** both rewrite storage. `purge` is what actually reclaims the space an
expunge released.

### `backend subscriptions`

IMAP `SUBSCRIBE` state, through the same on-disk format and lock key the IMAP
command uses — so an admin write is visible to a live session immediately.

```
yarctl backend subscriptions list    <user> [--namespace NS]
yarctl backend subscriptions add     <user> <folder> [--namespace NS]
yarctl backend subscriptions remove  <user> <folder> [--namespace NS]
yarctl backend subscriptions migrate <user> --namespace NS [--apply]
```

`migrate` folds a namespace's old per-namespace subscription file into the
user's own, because subscriptions follow the subscriber rather than the
namespace. It is a **dry run unless `--apply`** is given.

**Effect:** `add`, `remove`, and `migrate --apply` write.

### `backend specialuse`

RFC 6154 attributes — which folder is Sent, which is Trash — as overrides on
top of the configured defaults.

```
yarctl backend specialuse list   <user>
yarctl backend specialuse get    <user> <folder>
yarctl backend specialuse set    <user> <folder> <attr>
yarctl backend specialuse delete <user> <folder>
```

`get` reports the resolved attribute **and its source**: `override`, `default`
or `none` — which is the difference between a user's own choice and the
server's configuration, and the thing to check when a client files into the
wrong folder. `delete` drops the override so the default applies again.

Only the personal namespace carries overrides; the attributes do not extend to
shared or public mailboxes.

```sh
yarctl backend specialuse set alice@example.com Sent '\Sent'
```

**Effect:** `set` and `delete` write.


---

## Output

All commands print pretty-printed JSON to stdout. Exit code `0` on success, `1` on error.
