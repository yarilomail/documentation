# Dict — yarilo's key-value abstraction

`pkg/dict` is the general key-value store every yarilo feature that needs
durable per-user or per-mailbox state sits on top of. A single contract
(`Dict` + `Tx` + `Iterator`) is satisfied by multiple drivers; the
choice of driver (`file`, `redis`, `sql`, `memory`, `fail`) is made via
YAML config, not code. The drivers run in the `yarilo-dict` service
(mTLS, port 9107); a session binary names a dict and reaches it through
`pkg/dict/proxy`, and needs `dict_service.dict_addr` set to start — see
[The dict service](#the-dict-service).

See [ARCHITECTURE.md §Dict abstraction](ARCHITECTURE.md#dict-abstraction)
for the design rationale; this document is the operator reference for
configuring and operating dicts.

---

## Concepts

| Term | Meaning |
|:---|:---|
| **Dict** | A named key-value store instance, declared once in `yarilo.yaml` under `dicts:` |
| **Driver** | The backing implementation (`file`, `redis`, `sql`, `memory`, `fail`) |
| **Settings** | Driver-specific configuration map (path / addr / dsn / ...) |
| **Namespace** | `priv/` (per-user) and `shared/` (per-resource) key prefixes — application convention; not enforced by drivers |
| **OpSettings** | Per-call context: username, home dir, TTL — passed by callers, used by drivers; through the dict service the TTL travels with the transaction |

## YAML schema

```yaml
dicts:
  <name>:
    driver: file|redis|sql|memory|fail
    settings:
      # driver-specific (see below)
    expire_secs: 0          # default TTL for writes (drivers with TTL support)
    username: ""            # default OpSettings.Username
    home_dir: ""            # default OpSettings.HomeDir
```

`<name>` is the logical identifier yarilo features look up
(e.g. `metadata`, `quota_count`, `acl`). Multiple named dicts may share
one backing service through different prefixes/namespaces.

## The dict service

`yarilo-dict` opens the `redis` and `sql` dicts and serves them over internal
mTLS; the session processes link no engine and reach it by name. The `file`
driver is the exception: the process that uses it opens it itself (see
[file](#file)).

```yaml
dict_service:
  dict_listen: ":9107"     # yarilo-dict: where it serves
  dict_addr: "yarilo-dict:9107"   # every other process: where to find it
  dict_max_conns: 8
```

| Key | Read by | Default | Meaning |
|:---|:---|:---|:---|
| `dict_listen` | `yarilo-dict` | — | Listen address. Required: the service exits at startup without it |
| `dict_addr` | session processes | — | `host:port` of `yarilo-dict`. Required as soon as a `redis` or `sql` dict is configured; empty with only `file` dicts is fine |
| `dict_max_conns` | session processes | `8` | Connections one process keeps to one named dict. An iteration holds its connection until it ends, so `1` makes every other operation on that dict wait behind it |

The chart renders all three from `components.dict` (`enabled`, `listen`,
default `:9107`, `max_conns`, default `8`) and derives `dict_addr` from the
release's own `yarilo-dict` Service, so the port cannot disagree between the
listener and the clients.

---

## Drivers

### file

JSON file. Atomic temp-file + rename on every commit.

The path is a template expanded **per operation** from the operation's
user (`%u`, `%h`, `%n`, `%d`, `%i`), so one configured dict gives every
user a file of their own. A path naming `%h` is refused on any operation
that carries no home, rather than resolving to a path shared by everyone.

Safe across processes: a commit takes a lock on `<path>.lock`, re-reads
the document under the lock and then rewrites it, so two pods writing the
same user's file keep each other's keys. Reads take no lock — they stat
the file and reload when its stamp has moved.

Unlike `redis` and `sql`, this driver is opened by the process that uses
it, not by `yarilo-dict`: it links no engine. It is the default for
annotations.

```yaml
dicts:
  metadata:
    driver: file
    settings:
      path: "%h/yarilo-metadata.json"
      lock_method: ""          # flock (default), fcntl or dotlock
```

Settings:

| Key | Type | Required | Meaning |
|:---|:---|:---|:---|
| `path` | string | yes | Filesystem path; `%u`/`%h`/`%n`/`%d`/`%i` are expanded per operation |
| `lock_method` | string | no | Write lock transport: `flock` (default), `fcntl`, `dotlock`. Match the mail volume's `storage_lock_method` |

### memory

In-process `map[string]row`. Lost on process exit. For unit tests and
short-lived dev runs.

```yaml
dicts:
  scratch:
    driver: memory
```

No settings.

### fail

Every operation returns `ErrFailDriver`. Used in code paths that need a
non-nil `dict.Dict` even when the feature is disabled.

```yaml
dicts:
  disabled-metadata:
    driver: fail
    settings:
      message: "metadata feature disabled by admin"   # optional
```

### redis

Production cluster backend. SET/GET/DEL, MULTI/EXEC for transactions,
INCRBY for atomic counters, EXPIRE for TTL, SCAN for iteration. One
Redis string per dict key. Prefix-isolated so multiple named dicts can
share one Redis instance.

```yaml
dicts:
  metadata:
    driver: redis
    settings:
      addr: "yarilo-redis.yarilo.svc.cluster.local:6379"
      password: ""                # optional AUTH
      db: 0                       # logical database
      prefix: "yarilo:metadata:"  # prepended to every key on the wire
      dial_timeout: "5s"          # Go duration string
    expire_secs: 86400            # default TTL: 1 day
```

Settings:

| Key | Type | Required | Default | Meaning |
|:---|:---|:---|:---|:---|
| `addr` | string | yes | — | `host:port` |
| `password` | string | no | `""` | AUTH; empty = no auth |
| `db` | int | no | `0` | Logical database |
| `prefix` | string | no | `""` | Per-dict key prefix, taken literally. A `%`-variable is refused at startup: the dict opens once per process, so nothing would expand it, and a per-user key already carries `priv/<user>/` |
| `dial_timeout` | string | no | `5s` | Go duration |

### sql

Production cluster backend. PostgreSQL, MySQL or SQLite via `database/sql`.
One row per dict key. Auto-creates the table on first Open. Per-namespace
to allow multiple dicts in one schema. See **Mapped mode** below for a
column-per-key layout (quota_clone).

```yaml
dicts:
  metadata:
    driver: sql
    settings:
      driver: postgres            # | mysql | sqlite
      dsn: "postgres://yarilo:secret@pg.yarilo.svc:5432/yarilo?sslmode=disable"
      table: "dict_kv"            # default
      namespace: "metadata"       # per-dict namespace within the table
```

Settings:

| Key | Type | Required | Default | Meaning |
|:---|:---|:---|:---|:---|
| `driver` | string | yes | — | `sqlite`, `postgres` or `mysql` |
| `dsn` | string | yes | — | `database/sql` DSN |
| `table` | string | no | `dict_kv` | Table name; must match `[A-Za-z0-9_]+` (generic mode) |
| `namespace` | string | no | `""` | Per-dict key prefix within the shared table (generic mode) |
| `maps` | list | no | — | Column bindings; presence enables **mapped mode** (see below) |
| `max_open_conns` | int | no | mysql `25`, postgres `8`, sqlite `1` | Connections the dict's pool may hold, in use and idle; `0` = unlimited |
| `max_idle_conns` | int | no | = `max_open_conns` | Idle connections kept for reuse; `0` keeps none |
| `conn_max_lifetime` | int | no | `300` | Seconds before a connection is recycled, so it does not stay pinned to a server that failed over; `0` = never |
| `conn_max_idle_time` | int | no | `60` | Seconds an idle connection is kept before it is closed; `0` = never. A negative value in any of these four fails the dict at open |

Schema (auto-created):

```sql
CREATE TABLE dict_kv (
    namespace TEXT NOT NULL,
    k         TEXT NOT NULL,
    v         BLOB NOT NULL,         -- BYTEA on postgres
    expires   BIGINT,                -- unix seconds; NULL = no TTL
    PRIMARY KEY (namespace, k)
);
CREATE INDEX dict_kv_expires_idx ON dict_kv(expires) WHERE expires IS NOT NULL;
```

`ExpireScan` runs `DELETE FROM dict_kv WHERE namespace = $1 AND expires <= $2`.

#### Mapped mode (column mapping)

By default the sql driver stores every key in the generic `(namespace, k, v)`
layout, so a quota_clone target writes two rows per user. Setting `maps` switches
the dict to **mapped mode**: each key binds to a table **column**, producing a
clean per-user schema an external reader (billing, dashboards) can query
directly. Keys mapped to the same table share one row (the `username_field` is
the primary key), so different columns of the same user coexist.

```yaml
dicts:
  quota_clone_mysql:
    driver: sql
    settings:
      driver: mysql               # sqlite | postgres | mysql
      dsn: "${YARILO_DB_DSN}"
      maps:
        - { key: "priv/quota/storage",  table: quota, username_field: username, value_field: bytes }
        - { key: "priv/quota/messages", table: quota, username_field: username, value_field: messages }
```

The operator owns the table — mapped mode does **not** auto-create it (column
types are the operator's choice):

```sql
CREATE TABLE quota (username VARCHAR(255) PRIMARY KEY, bytes BIGINT, messages BIGINT);
-- one row per user: (u1@d00001.test, 860809, 13)
```

> **Every column other than `username_field` must be nullable (or carry a
> `DEFAULT`).** A `Set` inserts only `(username_field, value_field)`, so the
> first write for a new user leaves sibling columns unset — a `NOT NULL` sibling
> would reject that insert. `Unset` also relies on the column being nullable.

Mapped mode is validated at startup: `New` runs a
`SELECT <value_field> FROM <table> LIMIT 0` for every map, so a typo in a table/column name or a forgotten
`CREATE TABLE` fails at Open rather than silently on the first write. Per-key
TTL (`expire_secs`) and `ExpireScan` are unavailable in mapped mode (mapped
columns carry no expiry) and return an error.

Each map entry:

| Field | Required | Meaning |
|:---|:---|:---|
| `key` | yes | Dict key to map (matched exactly) |
| `table` | yes | Target table; must match `[A-Za-z0-9_]+` |
| `username_field` | yes | Column holding the user (primary key); scoped by `OpSettings.Username` |
| `value_field` | yes | Column the key's value is written to / read from |

Behaviour in mapped mode:

- **Set** → single-column upsert keyed on `username_field` (`ON DUPLICATE KEY UPDATE` / `ON CONFLICT DO UPDATE`).
- **Lookup** → `SELECT <value_field> FROM <table> WHERE <username_field> = ?`; a `NULL` column reads as "not found".
- **Unset** → sets the column to `NULL` (the row is shared by sibling columns and is never deleted).
- **AtomicInc** / **Iterate** → unsupported (error); quota_clone uses only Set.
- A username is required; an unmapped key errors.

---

## CLI — `yarctl backend dict`

`yarctl backend dict` is a client of `yarilo-backend-api`, which owns the
configured dicts. The CLI never opens a dict itself: it names one, and the
operation runs in the backend-api process against that dict's driver. A dict
the backend-api configuration does not declare cannot be reached, and there
is no ad-hoc driver mode. How `yarctl` finds and authenticates to the
backend-api is in [yarctl](/YARILO-ADMIN#backend-plane).

Per-op identity, accepted by every command that runs an operation:

| Flag | Maps to |
|:---|:---|
| `--user USER` | `OpSettings.Username` |
| `--home DIR` | `OpSettings.HomeDir` |
| `--expire-secs N` | `OpSettings.ExpireSecs` |

The backend-api does not look a home up from the user: a `file` dict whose
path names `%h` needs `--home` as well as `--user`, or the operation is refused.

### Commands

```sh
yarctl backend dict drivers                                       # drivers registered on backend-api
yarctl backend dict exists NAME                                   # does NAME resolve to a configured dict?

yarctl backend dict lookup [op-flags] NAME KEY                    # print value
yarctl backend dict iterate [op-flags] [--recurse] [--no-value] [--exact] \
                            [--sort-key|--sort-value] NAME PATH   # list rows

yarctl backend dict set [--value-stdin] [op-flags] NAME KEY [VALUE]   # write
yarctl backend dict unset [op-flags] NAME KEY                     # delete
yarctl backend dict atomic-inc [op-flags] NAME KEY DELTA          # integer add (delta may be negative)

yarctl backend dict expire-scan NAME                              # drop TTL-expired rows

yarctl backend dict commit-batch [op-flags] NAME < script.txt     # multi-op atomic transaction
```

`iterate` is streamed from the server, so it is safe over a large prefix. It
prints one `KEY<TAB>VALUE` line per row, or the key alone with `--no-value`.
A value that is not printable text is shown as `base64:…`. Writes print `ok`;
`atomic-inc` on a key that does not exist prints `not-found`.

### `commit-batch` script format

TAB-delimited, one op per line. Empty lines and `#`-prefixed lines are
ignored. Values are base64-encoded so binary content survives.

```
# Initialise per-user quota counters
set	priv/quota/storage	MA==
set	priv/quota/messages	MA==

# Bump storage by 1 KiB (delta is plain text, not base64)
atomic-inc	priv/quota/storage	1024

unset	priv/old/key
```

Pipe the script:

```sh
yarctl backend dict commit-batch --user alice@example.com quota < initialise.dict
```

### Example session

```sh
$ HOME_DIR=/var/mail/example.com/alice@example.com

$ yarctl backend dict set --user alice@example.com --home $HOME_DIR metadata priv/box/INBOX/comment "first message arrived"
ok

$ yarctl backend dict lookup --user alice@example.com --home $HOME_DIR metadata priv/box/INBOX/comment
first message arrived

$ yarctl backend dict iterate --user alice@example.com --home $HOME_DIR --recurse --sort-key metadata priv/
priv/box/INBOX/comment	first message arrived
```

---

## Choosing a driver

| Topology | Recommended driver |
|:---|:---|
| Per-user state on the mail volume (annotations, and the default) | `file`, one file per user under `%h` |
| Standalone single-pod helm release | `file` |
| State that must live off the mail volume, shared by all pods | `redis` (shared Redis Service) |
| Already running Postgres for other yarilo state | `sql` driver, `postgres` mode |
| Unit tests | `memory` |
| "Feature disabled" wiring | `fail` |

The choice is config-only — switching from `file` to `redis` is a
`yarilo.yaml` edit, not a rebuild. What does change with it is who opens
the dict: `file` is opened by the session, an engine by `yarilo-dict`. This is the
**config-not-binary** rule that every yarilo storage decision honours.
