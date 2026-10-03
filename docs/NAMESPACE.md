---
description: "How yarilo implements IMAP NAMESPACE (RFC 2342, RFC 9051): personal, other users' and shared namespaces, hierarchy separators, prefixes and config keys."
---

# Namespaces — IMAP NAMESPACE (RFC 2342 / RFC 9051 §6.3.10)

yarilo supports the three RFC 9051 namespace classes:

| Class | Typical prefix | Purpose |
|:---|:---|:---|
| **Personal** | `""` | The user's own mailboxes (INBOX + everything created via CREATE). |
| **Other Users** | `user/` | Read/write access to another user's mailboxes, gated by ACL. |
| **Shared** | `Shared/` | Folders shared between groups of users (or all users), gated by ACL. |
| **Public** (a variant of Shared) | `Public/` | Folders accessible to every authenticated user. |

This page covers **NS-1a** (wire-protocol, `v1.20`) + **NS-1b**
(storage routing, `v1.21`). With NS-1b shipped, **Personal and
Shared/Public** mailboxes carry real storage; **Other Users**
(`user/<owner>/...`) is declared but `SELECT` under that prefix
returns `NO "Other Users namespace requires ACL-1 + NS-3"`.

Access control (RFC 4314) is implemented and enforced on every path, and
it is **off by default** (`acl.enabled: false`). A shared, public or other
users namespace needs it: with ACL off every authenticated user would read,
write and expunge everything under it, so a configuration that declares one
with `acl.enabled: false` is refused at startup, naming the namespace and the
key. A folder everyone may read is a grant of `anyone lrs`, not ACL turned
off.

With `acl.enabled: true`, rights are checked on `SELECT`, on every read
and write, and on `LIST` — a user without the lookup right does not learn
the mailbox exists. Some enforcement gaps remain for cross-user delivery
([#544](https://github.com/yarilomail/yarilo/issues/544)), so treat that
issue as the list of what is not yet covered rather than as a statement
that nothing is.

---

## YAML schema

```yaml
namespaces:
  - type: personal              # required: personal | other | shared
    prefix: ""                  # mailbox name prefix; "" reserved for personal
    separator: "/"              # one character; different per-namespace allowed
    list: "yes"                 # LIST exposure: yes | children | no
    subscriptions: true         # track SUBSCRIBE state for this namespace
    inbox: true                 # owns the magic "INBOX" mailbox (set on exactly one)
    location: "maildir:%h"      # storage URL; varexpand %u/%h/%n/%d/%i
    hidden: false               # keep out of the NAMESPACE response
    mailboxes:                  # made for every user; see "Configured mailboxes"
      Sent:  { auto: subscribe, special_use: "\\Sent" }
      Junk:  { auto: create,    special_use: "\\Junk" }
```

`location:` may be written as the pair `mail_driver:` and `mail_path:`, the
spelling a 2.4 configuration already has. Giving both forms for one namespace
is refused at startup rather than resolved by precedence.

`mail_index_path:` says where this namespace writes its indexes, the split
spelling of the location's `INDEX=` option. It is what lets one definition
directory be shared, read-only, by every user: the mailboxes are read from
`mail_path` and the indexes written under the user. Set without a store to
put an index in, it is refused at startup.

`hidden: true` takes the namespace out of the `NAMESPACE` response and does
nothing else: `LIST`, `SELECT` and everything under the prefix answer exactly
as before. It is for a namespace a client should not be told to go looking in
on its own, while anything that knows the name may still use it.

`hidden:` and `list:` are often set together but are not the same setting,
and neither reaches into the other's reply:

| | `NAMESPACE` | `LIST "" "*"` | `LIST "" "Virtual/*"` |
|---|---|---|---|
| default | advertised | listed | listed |
| `hidden: true` | not advertised | listed | listed |
| `list: "no"` | advertised | not listed | listed |

A `list: "no"` namespace at the root prefix (`""`) answers only a pattern
with no wildcard in it.

## Configured mailboxes (`mailboxes`)

A namespace can name mailboxes that every user has. A client that does not
set up its own folders (Outlook, older mobile clients) then finds Sent, Drafts
and Trash on its first login, instead of picking places for them on its own.

```yaml
namespaces:
  - type: personal
    prefix: ""
    separator: "/"
    inbox: true
    mailboxes:
      Sent:   { auto: subscribe, special_use: "\\Sent" }
      Drafts: { auto: subscribe, special_use: "\\Drafts" }
      Trash:  { auto: subscribe, special_use: "\\Trash" }
      Junk:   { auto: create,    special_use: "\\Junk" }
```

| Key | Values | Meaning |
|:---|:---|:---|
| `auto` | `no` (default), `create`, `subscribe` | `create` makes the mailbox the first time any server opens or lists the namespace. `subscribe` does the same and subscribes it once. |
| `special_use` | an RFC 6154 attribute (`\Sent`, `\Drafts`, `\Trash`, `\Junk`, `\Archive`, `\All`, `\Flagged`, `\Important`) | The attribute LIST and JMAP roles report for this name. Personal namespace only. |

**When a mailbox is made.** The storage layer makes it the first time a mailbox
is opened or listed for the user, whichever server does it: IMAP `LIST`,
`SELECT` or `STATUS`, JMAP `Mailbox/get`, or an LMTP delivery to it. A
JMAP-only client on a fresh account sees the mailboxes without any IMAP
session first.

**Subscriptions.** `subscribe` writes the subscription once, when the mailbox
is made, and never again. A user who unsubscribes stays unsubscribed. A
mailbox the user created on their own before the server made it is left as it
is: no subscription is added, and its `special_use` still applies. The
subscription file keeps its format: sorted full names, one per line, no
header. If the file in that place belongs to another implementation (a
version-2 file with its header), the server does not convert it to add a
subscription of its own. The mailbox is still made.

**Where `auto` is allowed.** In the personal namespace, in a personal namespace
with its own `location`, and in a shared namespace with a fixed `location`.
Startup refuses it in an owner-templated namespace (its store belongs to
each owner) and in a virtual one (a virtual mailbox is made by its
configuration file).

**`special_use` and `imap_special_use_defaults`.** At startup the two become one
map. A name that both give the same attribute appears once. A name they give
different attributes refuses startup, and the message names the mailbox and
both values. `special_use` outside the personal namespace refuses startup.

**Admin API.** `folder/list` shows configured mailboxes that do not exist yet
as present, with their special use, and makes nothing. It is a read. See
[BACKEND-API](./BACKEND-API.md).

> **Behaviour change.** Earlier versions subscribed every folder a client
> selected. They no longer do: a subscription comes only from `SUBSCRIBE`, or
> from a `subscribe` mailbox when the server makes it. A client that relied on
> `SELECT` to subscribe a folder now has to subscribe it.

### Default (when `namespaces:` is omitted)

```yaml
namespaces:
  - type: personal
    prefix: ""
    separator: "/"
    list: true
```

Equivalent to pre-v1.20 behaviour — the IMAP `NAMESPACE` response is
`* NAMESPACE (("" "/")) NIL NIL`.

### Personal + Shared + Other Users (reference-style)

```yaml
namespaces:
  - type: personal
    prefix: ""
    separator: "/"
    list: true
    inbox: true
    location: "maildir:%h"

  - type: shared
    prefix: "Shared/"
    separator: "/"
    list: true
    location: "maildir:/var/yarilo/shared"

  - type: other                # the reference's "Other Users" namespace
    prefix: "user/%u/"         # %u ⇒ owner-templated (client sees "user/alice/INBOX")
    separator: "/"
    list: true
    location: "maildir:%h"     # %h/%u/%n/%d expand against the OWNER (alice)
```

### Owner-templated namespaces (NS-2, designed)

When a namespace `prefix` contains an owner variable (`%u`, `%n`, or `%d` — e.g.
`user/%u/`), the namespace is **owner-templated**: the `%u/%n/%d/%h` variables
in its `location` expand against the **owner** whose name fills the prefix slot,
not the logged-in user. Accessing `user/alice/Sent` extracts `owner = alice`,
looks alice up in the userdb, and resolves `location` against alice's storage.
The owner's own session has implicit full rights; a peer is gated by the
owner's ACL. Fixed prefixes (no variable, e.g. `Shared/`, `Public/`) are
unaffected and resolve to one path for everyone.

This is **same-farm** in item 3 (#499) — the owner is resolved when its mailbox
carries the same farm tag (same PV) as the session's mailbox (covers standalone
and single-farm backend). An owner on a **different farm tag** (data on another
PV) is NS-3. See [OWNER_SHARED_NS.md](OWNER_SHARED_NS.md) for the full design.

Wire shape (post-AUTHENTICATE):

```
C: A1 NAMESPACE
S: * NAMESPACE (("" "/")) (("user/" "/")) (("Shared/" "/"))
S: A1 OK NAMESPACE completed
```

---

## Per-namespace separator

yarilo follows the reference: each namespace MAY use a different separator.

| Field | Constraint |
|:---|:---|
| `separator` | exactly one character. Missing → defaults to `/`. Multi-char → falls back to `/` with a warning at startup. |

Useful when migrating from a legacy the reference deployment that used `.` for
personal mailboxes (mbox legacy) and `/` for shared:

```yaml
namespaces:
  - type: personal
    prefix: ""
    separator: "."
    list: true
  - type: shared
    prefix: "Shared/"
    separator: "/"
    list: true
```

---

## Storage layout

Each namespace's storage is rooted at its `location:`. The operator
mounts (or pre-creates) the path; yarilo creates the per-folder
maildir tree on the first `CREATE` / `APPEND`.

```
/var/mail/vhosts/<domain>/<user>/          ← personal (per-user, existing layout)
  Maildir/
    .index
    cur/  new/  tmp/
    .Sent/...

/var/yarilo/shared/                        ← shared (one root per install)
  marketing/
    announcements/
      .index
      cur/  new/

/var/yarilo/public/                        ← public (one root per install)
  announcements/...
```

For multi-pod backend deployments the namespace roots must be on
shared storage (NFS/CephFS RWX) so all replicas see the same shared
folder tree. The standalone helm chart leaves shared roots **empty by
default** — operators opt in by populating `cfg.Namespaces` and
mounting a PV at the chosen `location:`.

## Quota interaction (NS-1b + QUOTA-1)

Quota is **owner-paid**: storage consumed in `user/alice/INBOX` counts
against alice's quota, not against the user accessing it. Public/Shared
namespaces have their own system-wide quota root (configured in the
`quota:` block, not here). See [QUOTA.md](QUOTA.md) when QUOTA-1 lands.

---

## Hidden namespaces (`list: false`)

`list: false` keeps a namespace addressable internally (NS-1b storage
routing respects it) without advertising it in the `NAMESPACE` response.
Used for staging — declare and configure backends for a shared
namespace, smoke-test access from privileged accounts, then flip `list`
to `true` to expose it to all users.

---

## What works in NS-1b (`v1.21`)

| Behaviour | Status |
|:---|:---|
| `SELECT Shared/marketing/announcements` opens a mailbox on the shared backend | ✅ |
| `CREATE Shared/team` lands under the configured `location:` (separate filesystem root) | ✅ |
| `APPEND` / `FETCH` / `STORE` / `EXPUNGE` / `SEARCH` on shared mailboxes | ✅ |
| `LIST "" "*"` returns mailboxes from every configured namespace, each row prefixed with its namespace prefix and emitting its own separator | ✅ |
| `SUBSCRIBE Shared/team` persists to a per-namespace subscription file (`subscriptions-shared`) — separate from `subscriptions` (personal) | ✅ |
| `COPY` / `MOVE` between personal and shared namespaces | ✅ |
| `RENAME` within a single namespace | ✅ |
| `GETMETADATA` / `SETMETADATA` on shared folders, with `/private/*` stored **per accessing user** (SHA-256 hash of username), `/shared/*` global to the folder | ✅ |
| `SELECT user/alice/INBOX` (Other Users) | `NO "Other Users namespace requires ACL-1 + NS-3"` |
| `LIST` of `user/*` patterns | returns empty (namespace declared but unimplemented) |

## What does NOT work yet (post-NS-1b)

| Behaviour | Phase that delivers it |
|:---|:---|
| `RENAME` across namespaces (`Personal/foo` → `Shared/foo`) | declined with `NO`; design TBD |
| `Other Users` namespace (`user/alice/INBOX`) actually opens alice's mailbox | ACL-1 + NS-3 |
| Quota debit on writes to `user/alice/*` charges alice (owner-paid) | QUOTA-1 + NS-3 |
| Director routes `user/alice/*` to alice's backend pod in multi-pod deployments | NS-3 |

## Virtual mailboxes

A namespace with `location: "virtual:%h/virtual"` holds virtual mailboxes:
each is defined by a configuration file listing other folders and the `SEARCH`
rules that pick messages from them. See [Virtual Mailboxes](/VIRTUAL).

One definition can serve every user. The definitions live in a directory of
their own, read-only, and `mail_index_path` sends the indexes under each
user's home:

```yaml
namespaces:
  - type: personal
    prefix: "Virtual/"
    separator: "/"
    hidden: true
    list: "no"
    mail_driver: virtual
    mail_path: /etc/yarilo/virtual
    mail_index_path: "%h/index/virtual"
```

The type is `personal` even though the definitions are shared: what the
mailboxes show is the user's own mail, which is what RFC 2342 calls personal.
Only the definition files are common to everyone.

In the chart, `virtualDefinitions:` carries those files, one key per mailbox,
and mounts them at that path in every backend container.

## Mixed storage drivers across namespaces

The `location:` URL's driver prefix is honoured per-namespace.
When a namespace declares a `location:` whose driver differs from
the globally-configured `cfg.Storage.Mailbox`, yarilo constructs a
separate `MailboxBackend` instance of the requested driver and
routes that namespace's ops through it. Namespaces using the same
non-default driver share their backend instance.

Examples that work out of the box:

```yaml
storage:
  mail_driver: maildir              # personal default (existing layout)

namespaces:
  - type: personal
    prefix: ""
    separator: "/"
    list: true
    # personal inherits maildir from storage.mailbox
  - type: shared
    prefix: "Shared/"
    separator: "/"
    list: true
    location: "mdbox:/var/yarilo/shared"   # shared uses mdbox
  - type: shared
    prefix: "Public/"
    separator: "/"
    list: true
    location: "dbox:/var/yarilo/public"    # public uses dbox
```

What it gives you: each namespace gets the storage format best
suited for its access pattern (e.g. mdbox's coalesced storage for
high-volume shared folders, maildir's per-message files for
per-user personal mailboxes that backup tools handle file-by-file).

Constraints:
- `IndexBackend` is uniform (fileindex) across all namespaces;
  yarilo does not switch index implementations per namespace.
- The configured driver in `location:` must be one of
  `maildir`, `dbox`, `mdbox`. Mismatched / unknown driver names
  fail at backend startup so a typo does not silently fall back
  to maildir.
