# Authentication configuration

Yarilo authenticates IMAP/POP3/Submission credentials against an ordered chain of `passdb` entries. The first passdb that returns a definitive result (success or failure for a known user) wins. Unknown users fall through to the next entry. A temporary failure — a database that does not answer — stops the chain there: the login is answered as a temporary failure, not passed to the next entry.

---

## `auth.passdb`

A list of passdb entries. Each entry has a `driver` and a `dsn`. Order matters — entries are tried left-to-right.

<!-- @settings auth.passdb[].driver auth.passdb[].dsn auth.passdb[].passwd_file_path auth.passdb[].passdb_sql_query auth.passdb[].userdb_sql_query auth.passdb[].userdb_sql_iterate_query auth.passdb[].passdb_default_password_scheme auth.passdb[].skip_schema auth.passdb[].max_open_conns auth.passdb[].max_idle_conns auth.passdb[].conn_max_lifetime auth.passdb[].conn_max_idle_time auth.passdb[].username_filter -->

```yaml
auth:
  passdb:
    - driver: sqlite
      dsn: /var/lib/yarilo/users.db
```

---

## SQL passdb

All three SQL backends share one schema:

```sql
CREATE TABLE yarilo_users (
    username  TEXT/VARCHAR(255) PRIMARY KEY,
    password  TEXT/VARCHAR(255) NOT NULL,
    home      TEXT/VARCHAR(255) NOT NULL DEFAULT '',
    mail      TEXT/VARCHAR(255) NOT NULL DEFAULT '',
    enabled   INTEGER/TINYINT(1) NOT NULL DEFAULT 1
);
```

Yarilo runs `CREATE TABLE IF NOT EXISTS` on startup — fresh installs work without manual migration. Existing tables are left untouched.

### SQLite

Pure-Go driver (`modernc.org/sqlite`), no cgo. Best for single-node deployments and dev environments.

```yaml
auth:
  passdb:
    - driver: sqlite
      dsn: /var/lib/yarilo/users.db
```

### MySQL / MariaDB

DSN format (`go-sql-driver/mysql`): `user:password@tcp(host:3306)/dbname?charset=utf8mb4&parseTime=true`.

```yaml
auth:
  passdb:
    - driver: mysql
      dsn: "yarilo:${DB_PASSWORD}@tcp(db.internal:3306)/yarilo?charset=utf8mb4"
```

### PostgreSQL

DSN format (`pgx`): standard `postgres://user:password@host:5432/dbname?sslmode=require` URL.

```yaml
auth:
  passdb:
    - driver: postgres
      dsn: "postgres://yarilo:${DB_PASSWORD}@db.internal:5432/yarilo?sslmode=require"
```

---

## passwd-file passdb

A flat, colon-separated user file (classic `/etc/passwd` layout) that serves
**both** passdb and userdb roles — a self-hosted deployment can authenticate
and resolve mail storage without any database.

```yaml
auth:
  passdb:
    - driver: passwd-file
      passwd_file_path: /etc/yarilo-passwd/passwd
      passdb_default_password_scheme: CRYPT
```

> **Kubernetes note.** Mount the file from a Secret/ConfigMap into its **own**
> directory — do **not** place it under `/etc/yarilo`, which is already the
> rendered-config mount. A `subPath` file mounted inside that directory fails
> with `not a directory` and crash-loops every pod. With the Helm chart, supply
> the content via `extraVolumes` / `extraVolumeMounts` at a distinct path
> (e.g. `/etc/yarilo-passwd`) and point `passwd_file_path` at it:
>
> ```yaml
> extraVolumeMounts:
>   - name: passwd-file
>     mountPath: /etc/yarilo-passwd
>     readOnly: true
> extraVolumes:
>   - name: passwd-file
>     secret:
>       secretName: yarilo-passwd-file
> ```

### File format

One user per line:

```
user:password:uid:gid:gecos:home:shell:extra_fields
```

- Only `user` and `password` are required.
- `uid` / `gid` / `gecos` / `shell` are parsed for layout compatibility but
  **ignored** — yarilo derives privilege drop from config and storage paths from
  the home template, not per-user uid/gid.
- `home` (column 6) populates the userdb `home` field.
- `extra_fields` (column 8 onward) are space-separated `key=value` pairs.
  Keys with a `userdb_` prefix populate the userdb (`userdb_mail`,
  `userdb_quota_rule`, …); bare keys are passdb-side (`allow_nets`, `nologin`, …).
- Lines that are empty or begin with `#` or `:` are skipped.
- The file is reloaded automatically when its mtime or size changes.

Passwords carry a `{SCHEME}` prefix or a crypt(3) marker; unmarked values assume
`passdb_default_password_scheme` (default `CRYPT` = crypt(3) autodetection). The same
scheme set as the SQL passdb applies, including `{SCRAM-SHA-256}` verifiers.

```
# comment
alice@example.com:{BCRYPT}$2b$12$...:1000:1000::/mail/alice::userdb_mail=maildir:~/Maildir userdb_quota_rule=*:storage=2G
bob@example.com:{SHA512-CRYPT}$6$salt$hash
```

---

## static passdb

One shared credential and a set of templated fields applied to **every** user.
Serves both passdb and userdb roles. For tests, single-mailbox installs, and
proxy front-ends. Because it matches every username it must be placed **last**
in the chain, and given a `username_filter` unless every name really is a user:
without one, a userdb lookup — delivery, quota-status — finds any address, so
mail to a name nobody has is accepted.

```yaml
auth:
  passdb:
    - driver: sqlite
      dsn: /var/lib/yarilo/users.db
    - driver: static            # catch-all — last in the chain
      static_password: "${YARILO_STATIC_PASSWORD}"
      passdb_default_password_scheme: BCRYPT
      fields:
        userdb_home: "/var/vmail/%d/%n"
        userdb_mail: "maildir:/var/vmail/%d/%n/Maildir"
```

<!-- @settings auth.passdb[].static_password auth.passdb[].nopassword auth.passdb[].fields auth.passdb[].userdb_static_allow_all_users -->

Only one account, the rest from SQL:

```yaml
auth:
  passdb:
    - driver: mysql
      dsn: "${YARILO_DB_DSN}"
    - driver: static
      username_filter: "smoke@example.test"
      static_password: "${YARILO_STATIC_PASSWORD}"
```

Proxy front-end (accept any credential, let the backend verify):

```yaml
auth:
  passdb:
    - driver: static
      nopassword: true
      fields:
        proxy: "y"
        host: "backend.internal"
```

---

## Password schemes

The `password` column accepts a `{SCHEME}hash` prefix. Without a prefix, the format is autodetected from common crypt(3) markers.

| Scheme | Prefix | Hash format | Notes |
|:---|:---|:---|:---|
| Bcrypt | `{BCRYPT}` / `{BLF-CRYPT}` | `$2a$.../`$2b$.../`$2y$...` | Recommended for new deployments. |
| SHA-512 crypt | `{SHA512-CRYPT}` | `$6$salt$hash` | Linux user import path. |
| crypt(3) | `{CRYPT}` | `$2…$` or `$6$…` | Picks bcrypt or SHA-512 crypt by the hash marker. The passwd-file default. |
| SCRAM-SHA-256 | `{SCRAM-SHA-256}` | `iter,salt,stored_key,server_key` | Serves SCRAM and PLAIN/LOGIN from one value; see [SCRAM](/auth/scram). |
| SCRAM-SHA-1 | `{SCRAM-SHA-1}` | `iter,salt,stored_key,server_key` | As above, for clients without SHA-256. |
| Plain | `{PLAIN}` / `{CLEARTEXT}` | literal | **Dev only.** Never store production passwords in plain text. |

Autodetection (no `{SCHEME}` prefix):

| Stored value starts with | Treated as |
|:---|:---|
| `$2a$` / `$2b$` / `$2y$` | BCRYPT |
| `$6$` | SHA512-CRYPT |
| anything else | `passdb_default_password_scheme` — `PLAIN` for SQL unless set |

### Generating a bcrypt hash

```sh
htpasswd -nbB alice@example.com "topsecret"
# alice@example.com:$2y$05$LhJ...
```

### Generating a SHA-512 crypt hash

```sh
mkpasswd -m sha-512 -S NaClNaCl topsecret
# $6$NaClNaCl$...
```

---

## Adding a user (SQLite example)

```sh
sqlite3 /var/lib/yarilo/users.db <<EOF
INSERT INTO yarilo_users (username, password, enabled)
VALUES (
  'alice@example.com',
  '{BCRYPT}$2y$05$LhJOlnSj4N8u7CC8mvjLeOZjzPGq8GwS9ux/dRrK7uW5UlMnG7r4q',
  1
);
EOF
```

---

## Multiple passdbs

Yarilo tries each entry in order until one returns a result (OK or fail for a known user). Unknown users are passed to the next entry. Useful for: hot-migrating between databases, or shadowing one source with another for testing.

```yaml
auth:
  passdb:
    - driver: sqlite
      dsn: /var/lib/yarilo/legacy.db     # checked first
    - driver: postgres
      dsn: "postgres://...:5432/main"    # falls through to here
```

---

## Custom queries

`passdb_sql_query`, `userdb_sql_query`, and `userdb_sql_iterate_query` accept any SELECT and can connect yarilo to an existing schema. The query may reference these variables, which are substituted **as parameterised values** (no string interpolation, no injection risk):

| Variable | Long form | Meaning | Example |
|:---|:---|:---|:---|
| `%u` | `%{user}` | Full username | `alice@example.com` |
| `%n` | `%{username}` | Local part (before `@`) | `alice` |
| `%d` | `%{domain}` | Domain (after `@`) | `example.com` |
| `%s` | `%{protocol}`, `%{service}` | The protocol of the login or delivery | `imap` |
| `%r` | `%{remote_ip}`, `%{rip}` | The client's address | `192.0.2.10` |
| `%l` | `%{local_ip}`, `%{lip}` | The address the client connected to | `198.51.100.1` |

Not every query sees every variable:

| Query | Variables |
|:---|:---|
| `passdb_sql_query` (and a master-user `masterdb` entry) | all |
| `userdb_sql_query` | `%u` `%n` `%d` `%s` |
| `userdb_sql_iterate_query` | none |

A query naming a variable it cannot have, or an unknown `%{...}`, stops the
configuration from loading: bound as empty, it would silently change what the
query matches.

> **Do not quote the variables in your YAML.** They are rewritten to `?` (sqlite/mysql) or `$1`, `$2`, … (postgres) at runtime. Writing `'%u'` produces literal `'?'` which the DB will treat as a string, not a placeholder.

### Contract

- **`passdb_sql_query` must return a `password` column.** Columns are matched **by name, not position**, so the order is free; use `AS` aliases to map an existing schema (`pw_hash AS password`). `home`, `mail` and `enabled` are optional — an absent `enabled` counts as active. `password` is the only value used downstream when `userdb_sql_query` is also set.
- **`userdb_sql_query` must return:** `home`, `mail`. It answers every userdb lookup — after a login, and on its own for LMTP delivery, quota-status and the backend API, where no password is involved. **Unset, it is not taken from `passdb_sql_query`:** the built-in query against `yarilo_users` runs, and on your own schema every such lookup fails. Set it whenever `passdb_sql_query` is set.
- **`userdb_sql_iterate_query` must return one column:** `username`.

> **PostgreSQL with a `BOOLEAN` enabled column.** The built-in `yarilo_users`
> schema declares `enabled` as `INTEGER`, so the default queries filter with
> `WHERE enabled = 1`. Point yarilo at an existing Postgres schema that types
> the column `BOOLEAN` and that clause fails with `operator does not exist:
> boolean = integer` — write `WHERE enabled = true` in your own
> `passdb_sql_query` / `userdb_sql_query`. MySQL is unaffected: its `BOOLEAN` is
> `TINYINT(1)`, so `= 1` is valid. The Go-side check is dialect-agnostic and
> accepts `1` / `true` / `t` / `yes` / `on` either way.

### Disabling versus blocking login

Two passdb columns stop a login, and they mean different things.

**`enabled` disables the account.** The SQL passdb reads it before it checks the
password: a false value is refused there, and for login the user does not
exist. Delivery is decided by `userdb_sql_query` alone, so unless that query
also filters on the column, mail keeps arriving for a disabled account:

| `enabled` filtered in | Login | Delivery |
|:---|:---|:---|
| `passdb_sql_query` and `userdb_sql_query` | refused | refused: the user is unknown to LMTP |
| `passdb_sql_query` only | refused | accepted: mail keeps arriving |

```sql
-- passdb_sql_query, both shapes
SELECT password, active AS enabled FROM mailbox WHERE username = %u
-- userdb_sql_query, first shape only
SELECT home, maildir AS mail FROM mailbox WHERE username = %u AND active = 1
```

**`nologin` blocks the login and keeps the account.** The password is verified
first; then the login is refused with exactly the answer a wrong password gets,
and the log carries `reason=nologin`. Delivery and the userdb record are
untouched. Typical uses: freezing an account during an incident, and archive or
technical mailboxes that receive mail but are never opened.

`nologin` comes from any passdb column or expression of that name. True is
`1` / `yes` / `y` / `true` / `t` / `on` (case-insensitive); anything else,
an empty value or `NULL` included, lets the login through. A schema with an
`active` column usually has no `nologin`, so the operator adds one of these:

```sql
-- a column
ALTER TABLE mailbox ADD nologin TINYINT(1) NOT NULL DEFAULT 0;
SELECT password, active AS enabled, nologin FROM mailbox WHERE username = %u

-- or an expression, with no schema change
SELECT password, active AS enabled,
       CASE WHEN username IN ('archive@example.com') THEN 'yes' END AS nologin
FROM mailbox WHERE username = %u
```

### Per-protocol access

`%s` lets one account be refused one protocol and keep the others: one column
per protocol, read through `CASE`. A variable is a value, never part of the SQL
text, so `allow_%s` cannot name a column; `CASE %s` is the form that works.

```sql
SELECT password, home, mail FROM mailbox
 WHERE username = %u AND active = 1
   AND CASE %s WHEN 'imap'       THEN imap_enabled
               WHEN 'pop3'       THEN pop3_enabled
               WHEN 'submission' THEN submission_enabled
               ELSE 1 END = 1
```

`%s` takes these values:

| Protocol | `%s` |
|:---|:---|
| IMAP | `imap` |
| POP3 | `pop3` |
| Submission | `submission` |
| Postfix over the SASL login | `smtp` |

The Submission service names itself `submission` everywhere it reports a
service: auth logs (`proto=submission`), the policy server's `service`, the
auth cache. Releases before 2.4.3 used `smtp` there.

**Upgrading from a release before 2.4.3:** while the rollout runs, Submission
logins fail wherever a new and an old component meet, a new proxy with an old
backend or the reverse; this is the StatefulSet rollout window, minutes. Other
protocols and delivery are not affected.
| ManageSieve | `sieve` |
| LMTP delivery | `lmtp` |
| JMAP | `jmap` |

**Where the rule goes decides what it covers.**

| Rule in | Password and SCRAM logins | Token logins (OAUTHBEARER, XOAUTH2, JMAP Bearer) | Delivery |
|:---|:---|:---|:---|
| `passdb_sql_query` | covered | not covered: no password query runs | not covered |
| `userdb_sql_query` | covered | covered | covered (`lmtp`) |

When `userdb_sql_query` uses `%s`, every login, whatever proved it, runs that
query with the login's protocol before it is accepted. That is one more database
query per login: on our test stand it added about 1.6 ms to the mean
authentication time and nothing measurable to throughput. Without `%s` in
`userdb_sql_query`, no extra query runs. To cover every way in,
put the rule there, or in both queries. Lookups that are neither a login nor a
delivery (shared folders, the backend API) carry no protocol: `%s` is empty for
them, so keep an `ELSE 1` branch, which lets them through.

A login refused by a rule gets exactly the answer and delay of a wrong
password; the server log carries `reason=protocol`. A delivery refused by a rule
in `userdb_sql_query` is refused as an unknown recipient.

`%r` and `%l` restrict by address the same way, for example
`AND (allowed_ip = '' OR allowed_ip = %r)`; for networks rather than single
addresses, the `allow_nets` field below takes CIDR lists. A passdb that reads
`%r` or `%l` caches its answer per address.

### Userdb / passdb extra fields

Beyond `home` / `mail`, a lookup may return extra fields — as a SQL column alias, `userdb_sql_query` output, or an auth-socket `key=value` / `userdb_*` pair — that tune per-user mailbox, access, and proxying behaviour. Unset fields fall back to the global config. Comma-separated fields (`groups`, `acl_groups`, `quota_rule`, `allow_nets`) accept multiple values and merge across repeated assignments. Boolean fields accept `1` / `yes` / `y` / `true` / `t` / `on` (case-insensitive). Unknown keys are preserved in `Extra`; `forward_*` keys populate the proxy forward map.

**Identity**

| Field | Meaning |
|:---|:---|
| `username` / `user` | Canonical username (overrides the login for master-user flows). |
| `original_user` | The login as typed before normalisation. |
| `master_user` | On a userdb answer: the master when the login impersonated a user. On a passdb answer, a true value (`master_user=yes`) grants this login master rights — see [Master users](/auth/master_users). |
| `login_user` | Login user for delegated lookups (equals `username` otherwise). |

**System identity & groups**

| Field | Meaning |
|:---|:---|
| `uid` / `gid` | System user/group id for privilege drop. |
| `home` | User home directory. |
| `chroot` | Chroot directory. |
| `system_groups_user` | Username override for system group lookup. |
| `groups` | Supplementary group names (comma-separated). Matched against `group=` / `group-override=` ACL entries. |
| `client_cert_present` | Bool: TLS client-cert auth was used. |

**ACL evaluation**

| Field | Meaning |
|:---|:---|
| `acl_user` | Override the identity used when **evaluating ACLs** (the reference's `acl_user`). Typically set on a master-user session so ACL checks resolve as the impersonated user rather than the login. Empty = evaluate as the login user. |
| `acl_groups` | Group names (comma-separated) used alongside `acl_user` for ACL evaluation. |

> `acl_user` / `acl_groups` only affect **non-owner** namespaces (shared / public / other-users). A user always has full rights in their own personal namespace regardless of the override.

**Mail storage**

| Field | Meaning |
|:---|:---|
| `mail` / `mail_location` | Per-user mail location (`maildir:~/Maildir`, `mdbox:…`), with `:INDEX=`, `:CONTROL=`, `:ALT=`, `:VOLATILEDIR=` modifiers. |
| `mail_path` | Base mailbox path (derived from `mail` when unset). |
| `mail_inbox_path` | Explicit INBOX path override. |
| `mail_volatile_path` / `mail_index_path` / `mail_control_path` / `mail_alt_path` | Direct overrides for the corresponding mail-location modifier (win over modifiers embedded in `mail`). The names are the reference implementation's too, so a userdb query written for it works unchanged. |
| `mail_uid` / `mail_gid` | Ownership for mail files, distinct from the system `uid`/`gid`. |
| `mailbox_format` / `mail_driver` | `maildir` \| `sdbox` \| `mdbox` — the storage backend that opens this user's mail. Wins over the driver prefix in `mail`. A name yarilo does not implement is refused and the prefix stands. |
| `mail_attribute_dict` | Dict URL backing RFC 5464 METADATA. |

Each of these paths can carry the same variables as the corresponding
configuration key — `%u` / `%{user}`, `%h` / `~/`, hash buckets, and the rest. See
[Path templates](/storage/#path-templates).

> **One value, three places.** The four path fields can arrive as a modifier inside `mail`
> (`:INDEX=…`) or as the explicit field (`mail_index_path` — one spelling now, ours and the reference's alike).
> An explicit field always beats the modifier, whichever spelling the field uses — so
> moving a userdb query from one spelling to the other never changes which source wins.

**How a userdb answer is applied.** One order, for every protocol — IMAP, POP3 and
delivery (LMTP, JMAP, FTS, quota-status) share the code that does it:

1. the separate path fields are expanded against the user and written onto the session;
2. `mail` / `mail_location` is parsed: its driver prefix is stamped, and its modifiers
   fill in only the paths step 1 left blank;
3. the explicit driver field (`mail_driver` / `mailbox_format`) is stamped last, so it
   wins over the prefix.

A `mail_location` that cannot be parsed leaves the user on the globally configured backend
rather than failing the login, and a driver name yarilo does not implement is refused with
the stamped one left in place. Both are logged.

> **`mailbox_format` used to be inert.** Before 2.3.133 the field was parsed, carried and
> reported by the backend API — and never consulted. A userdb answering `mdbox` opened the
> user with the globally configured driver. If you set it and saw no effect, that is why;
> it works now, so check that its value is the one you want before upgrading.

**Quota**

| Field | Meaning |
|:---|:---|
| `quota_rule` | Per-user quota rule, e.g. `*:storage=5G` or `*:messages=100000` (repeatable). |
| `quota_over_flag` | Value marking the user as over quota. |

**Login control**

| Field | Meaning |
|:---|:---|
| `allow_nets` | Allowed source IP/CIDR list (comma-separated); empty = no restriction. |
| `identity_aliases` | Addresses besides the login the user sends as, separated by spaces or commas; JMAP offers each as an Identity (see [JMAP](/protocols/jmap#sending-mail)). An entry that is not an address is dropped with a warning naming the user. |
| `nologin` | Bool: refuse the login after the password is verified, with a wrong password's answer; the account and its delivery stay. See [Disabling versus blocking login](#disabling-versus-blocking-login). |
| `noauthenticate` | Bool: auth disabled for this user. |
| `nodelay` | Bool: bypass auth-penalty backoff. |
| `pass_expired` | Bool: password expired, client must reset. |
| `nopassword` | Bool: accept any password (passdb). |
| `enabled` | SQL filter column (`WHERE enabled = 1`, or `= true` on a Postgres `BOOLEAN`); not stored as a field. Optional: an absent column counts as active. Disables the account for login only; see [Disabling versus blocking login](#disabling-versus-blocking-login) for delivery. |

**Proxy / director** (see [Director configuration](/architecture/director))

| Field | Meaning |
|:---|:---|
| `proxy` / `proxy_maybe` | Bool: proxy this session (unconditionally / only if remote). |
| `host` / `port` | Upstream backend address. |
| `destuser` | Username to present to the upstream. |
| `proxy_mech` | SASL mechanism for the upstream login. |
| `proxy_timeout` | In place of the global value for this user: [`login_proxy_timeout`](/installation/general#login-login-proxy-timeout) in the IMAP/POP3/Submission/ManageSieve login proxies, [`lmtp_proxy_timeout`](/protocols/lmtp#protocol-lmtp-proxy) in `yarilo-lmtp-login`. A bare number is seconds (`30`); otherwise a number and a unit, `ms`, `s`, `m`, `h`, `d` or `w`, spelled out or not, any case (`500ms`, `2m`, `30 secs`). At most 2³² ms; missing or `0` keeps the global value. The auth service passes the value on unread; a value the proxy cannot read refuses the login (`NO [UNAVAILABLE]`) or fails the recipient (`550 5.3.5`). |
| `proxy_redirect_reauth` | Bool: re-auth on redirect. |
| `proxy_nopipelining` | Bool: disable command pipelining to the upstream. |
| `ssl` / `starttls` | Upstream TLS mode / bool STARTTLS. |

**Connection limits**

| Field | Meaning |
|:---|:---|
| `mail_max_userip_connections` | Max concurrent connections per user+IP. |
| `mail_max_user_connections` | Max concurrent connections per user. |

**Misc**

| Field | Meaning |
|:---|:---|
| `service` | Restrict the entry to a named service. |
| `local_name` | TLS SNI name this entry applies to. |
| `forward_*` | Arbitrary key forwarded to the proxy backend (populates the forward map). |
| *(any other key)* | Preserved verbatim in `Extra`. |

### Example: map an existing schema

```yaml
auth:
  passdb:
    - driver: postgres
      dsn: "postgres://yarilo:${DB_PASSWORD}@db.internal:5432/mailapp"
      skip_schema: true
      passdb_sql_query: |
        SELECT pw_hash AS password, maildir AS home, mail_path AS mail, active AS enabled
        FROM mailbox_users WHERE email = %u
      userdb_sql_query: |
        SELECT maildir AS home, mail_path AS mail
        FROM mailbox_users WHERE email = %u
      userdb_sql_iterate_query: |
        SELECT email FROM mailbox_users WHERE active = true
      passdb_default_password_scheme: BCRYPT
```

Every column an existing schema names differently needs an `AS` alias:
`password` for the passdb, `home` and `mail` for the userdb. A query that
returns `pw_hash` without the alias authenticates nobody, because the lookup is
by column name. `WHERE active = true` rather than `= 1` because this schema
types the column `BOOLEAN`; see the note above.

### Example: PostfixAdmin

PostfixAdmin's `mailbox` table already names its password column `password`, so
only `active` needs an alias. `skip_schema` keeps yarilo-auth from creating its
own `yarilo_users` table alongside it. A single `passdb` entry serves both roles:
`passdb_sql_query` answers authentication, `userdb_sql_query` answers the userdb lookup,
and every column the latter returns is mapped by name onto a userdb field, so
`quota_rule` and the rest arrive as aliases.

```yaml
auth:
  passdb:
    - driver: mysql
      dsn: "${YARILO_DB_DSN}"
      skip_schema: true
      passdb_default_password_scheme: BCRYPT
      passdb_sql_query: |
        SELECT password, active AS enabled, allow_nets
        FROM mailbox
        WHERE username = %u
      userdb_sql_query: |
        SELECT CONCAT(home, mpath) AS home,
               CONCAT(mbtype, ':~/', maildir,
                      ':INDEX=~/index',
                      ':VOLATILEDIR=/tmp/yarilo-volatile/%2.256Nu/%u') AS mail,
               CONCAT('*:bytes=', quota_bytes, ':messages=', quota_messages) AS quota_rule
        FROM mailbox
        WHERE username = %u
      userdb_sql_iterate_query: |
        SELECT username
        FROM mailbox
        WHERE active = 1
        ORDER BY username
```

`username`, `password`, `active`, `maildir` and `quota` are stock PostfixAdmin;
`mpath`, `mbtype`, `quota_bytes`, `quota_messages` and `allow_nets` are columns
this schema adds. Note that `%2.256Nu` and the second `%u` sit inside a quoted
SQL string and are left alone — substitution skips quoted sections, so those
reach the mail layer as templates, while the bare `%u` in the `WHERE` becomes a
bound parameter.

**On PostgreSQL the same queries work with one token changed:**

```sql
-- passdb_sql_query, userdb_sql_query: unchanged. CONCAT() exists in PostgreSQL and
-- takes non-text arguments, and a BOOLEAN arriving as "enabled" is read as
-- active either way, because that check happens in Go rather than in SQL.

-- userdb_sql_iterate_query: PostfixAdmin types active as BOOLEAN on PostgreSQL and
-- TINYINT(1) on MySQL, and PostgreSQL rejects boolean = integer outright.
SELECT username
FROM mailbox
WHERE active            -- was: WHERE active = 1
ORDER BY username
```

Leaving `= 1` in place breaks only enumeration: mail keeps flowing while
`yarctl backend user iterate` fails, which makes the cause easy to miss.

### Example: split passdb across hot/cold sources

```yaml
auth:
  passdb:
    # Fast cache table — recent logins, refreshed by app.
    - driver: postgres
      dsn: "postgres://yarilo:${DB_PASSWORD}@cache.internal:5432/auth"
      skip_schema: true
      passdb_sql_query: |
        SELECT pw_hash AS password, '/srv/' || %n AS home, '' AS mail, 1 AS enabled
        FROM auth_cache WHERE email = %u
      userdb_sql_query: |
        SELECT '/srv/' || %n AS home, '' AS mail
        FROM auth_cache WHERE email = %u

    # Authoritative store — falls through when not in cache.
    - driver: mysql
      dsn: "yarilo:${DB_PASSWORD}@tcp(db.internal:3306)/billing"
      skip_schema: true
      passdb_sql_query: |
        SELECT password, mail_home AS home, '' AS mail, enabled
        FROM users WHERE email = %u
      userdb_sql_query: |
        SELECT mail_home AS home, '' AS mail
        FROM users WHERE email = %u AND enabled = 1
```

Each entry carries its own `userdb_sql_query`: without one, delivery to a user
of that source would look them up in `yarilo_users`.

---

## Attempts, delays and the auth cache

Settings of `yarilo-auth` itself, under `auth:`.

<!-- @settings auth.auth_max_attempts auth.auth_failure_delay auth.internal_failure_delay_ms auth.cache -->

A cached answer outlives a password change or a deleted user until its TTL
runs out; `yarctl auth cache flush [<user-mask> …]` evicts entries at once
([yarctl](/operations/yarilo_admin#auth)). Further layers — the cross-pod penalty and an
external policy server — are on [Auth penalty](/auth/penalty) and
[Auth policy](/auth/policy).

---

## Helm

The chart builds `auth:` from `components.auth`. Two differences from the
keys on this page matter:

- **Names.** In `components.auth.passdb[]` the chart reads the older names:
  `passwd_file`, `password_query`, `user_query`, `iterate_query` and
  `default_pass_scheme`. `driver`, `dsn`, `skip_schema`, `static_password`,
  `nopassword` and `fields` are the same, and so are the pool settings
  `max_open_conns`, `max_idle_conns`, `conn_max_lifetime` and
  `conn_max_idle_time`. From 2.4.2 a key under the name this page uses fails
  the render and names the chart's; in 2.4.1 it is dropped without a warning,
  and the pool settings are not passed on at all. The same
  holds for `components.auth.oauth2[]` (the names without `oauth2_`, with
  `scopes` and `extra_fields` for `oauth2_scope` and `oauth2_fields`) and for
  `components.auth.policy` (`url`, `api_header`, `hash_truncate_bits`,
  `check_before`, … for the `auth_policy_*` keys).
- **Delays and cache.** `auth_max_attempts` and `internal_failure_delay_ms`
  keep their names, `auth_failure_delay` is `failure_delay`, and the cache is
  `cache.cache_size` (default `"100M"`, so the cache is on), `cache.ttl_seconds`
  and `cache.negative_ttl_seconds`. From 2.4.2 a `failure_delay` or
  `internal_failure_delay_ms` of `0` reaches the config; in 2.4.1 it is
  rendered as the default.

```yaml
components:
  auth:
    passdb:
      - driver: mysql
        dsn: "${YARILO_DB_DSN}"
        skip_schema: true
        password_query: |
          SELECT password, active AS enabled FROM mailbox WHERE username = %u
        user_query: |
          SELECT home, maildir AS mail FROM mailbox WHERE username = %u
    failure_delay: 2
    cache:
      cache_size: "100M"
```

---

## Postfix SASL integration (`yarilo-sasl-login`)

Postfix does not talk to `yarilo-auth`. A separate service, `yarilo-sasl-login`
(port 12345), speaks Postfix's SASL protocol and relays each exchange to
`yarilo-auth`, which runs the mechanism. Enable it with
`components.saslLogin.enabled: true`.

Postfix `main.cf`:

```
smtpd_sasl_type = dovecot
smtpd_sasl_path = inet:yarilo-sasl-login.<namespace>.svc:12345
smtpd_sasl_auth_enable = yes
smtpd_sasl_security_options = noanonymous
```

Where to publish it, and how to restrict who reaches it, depends on where
Postfix runs: see [MTA-facing services](/installation/deployment#mta-facing-services-sasl-login-and-quota-status).

---

## Testing

Unit tests for the SQL passdb cover SQLite end-to-end (via `t.TempDir()`). MySQL and PostgreSQL smoke tests are opt-in via env vars and skipped otherwise:

```sh
YARILO_TEST_MYSQL_DSN="yarilo:secret@tcp(localhost:3306)/yarilo_test?charset=utf8mb4" \
YARILO_TEST_POSTGRES_DSN="postgres://yarilo:secret@localhost:5432/yarilo_test?sslmode=disable" \
go test ./internal/auth/sql/
```

These tests require pre-created empty databases (`yarilo_test`). The schema is auto-created by `New()`.
