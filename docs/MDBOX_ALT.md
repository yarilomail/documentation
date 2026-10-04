# mdbox Alt Storage (Cold Tiering)

yarilo mdbox supports moving messages to a secondary (cold) storage
tier — functionally equivalent to the reference's alt-path setting and its
alt-move command. Messages moved to alt storage remain fully
accessible; the Fetch path transparently falls back to the alt
directory when a file is not found in primary.

## Configuration

```yaml
storage:
  mail_driver: mdbox
  mail_home: "%d/%n"
  mail_alt_path: "/mnt/cold/%d/%n"   # "" = disabled (default)
```

`mail_alt_path` is a path template like `mail_home`, with the same variables
and filters — `%u`, `%n`, `%d`, `%h`, the hash buckets and the `%{…}` forms;
see [Path templates](/STORAGE#path-templates). There is no `%L` modifier: a
lowercased path is written `%{user | lower}`, and a template the server cannot
expand stops startup, naming the key.

The alt directory mirrors the primary mdbox layout:

```
/mnt/cold/example.com/alice/
  storage/
    m.1001, m.1002, ...    ← moved m.<N> files (same naming scheme)
```

File IDs are global across both tiers — the same `m.<N>` ID never
exists in both primary and alt simultaneously.

## Helm

```yaml
# values.yaml
storage:
  mail_alt_path: "/mnt/cold/%d/%n"
```

The chart passes `storage.mail_alt_path` through unchanged. The older
spellings `mdbox_alt_storage_path` and `alt_dir` are pre-beta aliases of the
same key.

A separate PVC (or NFS export) should be mounted at the cold path —
typically a cheaper storage class (HDD-backed, object-gateway, etc.).

## Triggering a move

```sh
# Move all messages older than 2025-01-01 to cold storage:
yarctl backend mdbox altmove alice@example.com \
  --before 2025-01-01T00:00:00Z

# Move all messages (no date filter):
yarctl backend mdbox altmove alice@example.com

# Move back from cold to primary (reverse):
yarctl backend mdbox altmove alice@example.com \
  --before 2025-01-01T00:00:00Z \
  --reverse
```

`--before` accepts RFC 3339 timestamps. Messages whose `InternalDate`
(the `R` field in the dbox v2 trailer — set when the message was first
saved) is strictly before the cutoff are eligible.

## Operational notes

### Fetch transparency

`altmove` marks every message it relocates in the folder index, so a fetch
of a moved message opens the alt file directly, without trying primary
first. The IMAP client sees no difference.

The mark is a hint, not the truth. If it lags — the move finished but the
index was not updated yet — a fetch that finds no primary file (`ENOENT`)
tries the alt file before giving up; any other open error (permissions,
I/O) is returned as-is. In the other direction, a mark whose alt copy is
missing or unreadable falls back to primary rather than being reported as
corruption.

### Refcount and COPY

O(1) IMAP COPY works identically across both tiers: `Copy()` only
bumps the refcount; the copied map_uid continues to point at whichever
tier holds the physical body. A subsequent `altmove` on the copied
map_uid moves both the original and the copy together (they share the
same map_uid).

### Partial file moves

When a source `m.<N>` contains both eligible and ineligible records,
`altmove` splits the file: eligible records go to a new alt `m.<N>`,
ineligible records stay in a new primary `m.<N>`. Two new files are
created; the old source is unlinked. The map index is updated
atomically.

### Interplay with Purge

Run `purge` before `altmove` to avoid compacting zero-ref records
into the alt tier unnecessarily:

```sh
yarctl backend mdbox purge alice@example.com
yarctl backend mdbox altmove alice@example.com --before 2025-01-01T00:00:00Z
```

### Running it on a schedule

`yarctl` is already configured in every container of a backend pod: it
carries the backend-api token and the `admin` client certificate, and, with
a director, it sends each user's command to the pod that owns that user
([yarctl configuration](/YARILO-ADMIN#configuration)). A sweep is therefore
simplest run there, with the cutoff computed by the shell at run time:

```sh
# cold-tier sweep: messages older than 90 days, one user per line on stdin
kubectl exec -i <backend-pod> -c yarilo-backend-api -- sh -c '
  before=$(date -u -d "@$(( $(date +%s) - 90*86400 ))" +%Y-%m-%dT%H:%M:%SZ)
  while read -r user; do
    yarctl backend mdbox altmove "$user" --before "$before"
  done' < users.txt
```

Drive the user list from the passdb (the SQL `iterate_query`, for example)
and schedule the command where your other operator jobs run.

A Kubernetes CronJob of its own needs what that container already has: the
backend-api URL and token, the `admin` client certificate from the
`<release>-admin-internal-tls` Secret with its CA and server name, and the
director admin URL so commands are routed by user. Without the routing, the
job talks to one backend-api and becomes a second writer for every user that
pod does not own.

## On-disk format and the reference

A moved `m.<N>` file has the same format as a primary one — the same dbox v2
record layout — and the alt tier mirrors the primary layout, so the records
in it parse in either direction ([mdbox on-disk layout](/STORAGE#mdbox-on-disk-layout-rotation)).

A store is still not interchangeable between the servers, because
the index that says which message lives where is each server's own. An mdbox
store of the reference is taken over by
[adoption](/MIGRATION#adoption-this-server-takes-over-the-store-in-place):
on first open this server converts the index and the other server can no
longer serve the store. The reverse is not possible — the reference cannot
read a yarilo index.
