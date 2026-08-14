# Master users

A master user is an administrative identity allowed to log into another
user's mailbox with its own password — the target's password is never
involved. Typical uses: mailbox migrations, support access, automated
per-user maintenance.

The feature is off by default. With it off, any login that names a second
identity is refused before the password database is consulted.

## Configuration

Enable the feature and give it a master password database:

```yaml
auth:
  master_users:
    enabled: true
    auth_master_user_separator: "*"
    masterdb:
      - driver: mysql
        dsn: "${YARILO_DB_DSN}"
        skip_schema: true
        passdb_sql_query: |
          SELECT password, active AS enabled
          FROM masters
          WHERE username = %u
```

| Setting | Default | Notes |
|:---|:---|:---|
| `enabled` | `false` | Master switch. Off refuses every impersonation attempt before the chain runs. |
| `masterdb` | — | A dedicated passdb chain for master credentials. Same drivers and fields as `auth.passdb` (`sql`, `passwd-file`, …). |
| `auth_master_user_separator` | `*` | Separator for the legacy login form below. Empty disables that form; the SASL form keeps working. |

Grants come from either of two places: a hit in `masterdb`, or a `master`
flag on an ordinary passdb entry. A user found in neither is refused as a
master regardless of its password.

## Logging in as another user

Two forms are accepted.

**SASL authzid** (preferred). RFC 4616 PLAIN carries three fields; the first
names the target, the second the master:

```
AUTHENTICATE PLAIN base64(target \0 master \0 master-password)
```

**Separator form** — for clients that cannot send an authzid (older Outlook,
some mobile MUAs, and POP3's `USER`/`PASS`, which has no authzid at all):

```
LOGIN target*master master-password
USER target*master        (POP3)
```

Both resolve to the same thing: the session authenticates with the master's
credentials and then acts entirely as the target — the director routes by the
target, connection accounting counts the target, and an administrative kick
for the target finds the session.

::: tip Prefer the authzid form
The separator form exists as a compatibility workaround: a username that
legitimately contains the separator character becomes ambiguous, and the raw
login string is visible wherever the client string is logged. Use SASL
authzid whenever the client can send it.
:::

## Isolation

A master session sees exactly the target's mailbox — the master has no
mailbox of its own. Writes land in the target's state: a flag set by the
master is visible to the target's own next login.

## Audit

Every master login is written with both identities, so an impersonation is
never invisible in the log:

```
auth: ok  user=u1@example.com  master_user=admin-master  result=ok
```

The client-typed string (for the separator form, `target*master`) appears
only in the lines that quote what the client sent.
