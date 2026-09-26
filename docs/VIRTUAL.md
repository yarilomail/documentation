# Virtual Mailboxes

A virtual mailbox holds no messages of its own. It shows messages that live in
other folders of the same user, chosen by a rule: all mail in INBOX and the
archive, every unread message, every flagged one. Reading, flagging, searching
and expunging in a virtual mailbox act on the real message in its folder.

## Enabling

Virtual mailboxes live in a personal namespace of their own, with a
`virtual:` location: the user's own virtual mailboxes, over the user's own
folders.

Declare the namespace beside the one that holds INBOX:

```yaml
namespaces:
  - type: personal
    prefix: ""
    separator: "/"
    inbox: true
  - type: personal
    prefix: "Virtual/"
    separator: "/"
    list: "yes"
    subscriptions: false
    location: "virtual:%h/virtual"
```

`%h` is the user's home directory. Every directory under
`<home>/virtual/` that holds a configuration file is one mailbox, named after
its path: `<home>/virtual/All/yarilo-virtual` is `Virtual/All`, and
`<home>/virtual/Work/Open/yarilo-virtual` is `Virtual/Work/Open`. A directory
without a configuration file is not a mailbox.

A virtual mailbox is made by writing its configuration file, and removed or
renamed with its directory. A client cannot do either: `CREATE`, `DELETE` and
`RENAME` in the virtual namespace are answered `NO [CANNOT]`.

The configuration file is `yarilo-virtual`. A file named `dovecot-virtual`
from an existing installation is read when `yarilo-virtual` is absent, and is
never written, so a migrated store keeps its virtual mailboxes as they were.

## The configuration file

One folder per line. An indented line that follows is an IMAP `SEARCH`
rule, and applies to every folder named since the previous rule. Blank lines
and lines starting with `#` are ignored.

Collect every unread message in INBOX and the archive, in
`<home>/virtual/Unread/yarilo-virtual`:

```text
INBOX
Archive/*
  unseen
```

Show everything except the trash and the spam folder, in
`<home>/virtual/All/yarilo-virtual`:

```text
*
-Trash
-Junk
```

The line forms:

| Line | Meaning |
|:---|:---|
| `INBOX` | this folder; `INBOX` in any case |
| `Archive/*` | a pattern: `*` matches across the hierarchy, `%` stops at the separator |
| `-Trash` | take what this pattern matches out of the set, whatever else named it |
| `!Saved` | the folder that `APPEND`, `COPY` and `MOVE` into the virtual mailbox store to; one per file, a name rather than a pattern |
| `/shared/comment:keep*` | keep a folder a pattern brought in only if its annotation matches the mask; see below |
| `-/shared/comment:skip*` | keep it only if the annotation does not match, or is not set |
| `+Folder` | read as `Folder`; see below |
| indented text | the `SEARCH` rule for the folders named since the last rule, for example `unseen`, `flagged`, `since 1-Jan-2026`, `subject "invoice"` |

The rule is parsed when the configuration is read, by the same parser `SEARCH`
uses. A file that cannot be read makes the mailbox fail to open until it is
fixed, rather than silently matching nothing: the client is answered
`NO [SERVERBUG]`, and the log names the file, the line and the error. Rules
on the message text (`TEXT`, `BODY`,
`SUBJECT`, other headers) are answered by the [full-text index](/FTS) when it
is enabled, without reading message bodies; text criteria nested under `NOT`
or `OR` are checked by reading the messages.

### Selecting folders by annotation

A line starting with `/` filters the folders that the patterns bring in by
their [METADATA](/IMAP) annotation (RFC 5464):

```text
Projects/*
/shared/vendor/example/state:active*
```

This keeps each folder under `Projects` whose `/shared/vendor/example/state`
annotation starts with `active`, and drops the others.

- The entry is a METADATA entry name and starts with `/private/` or
  `/shared/`. It is read from the same store as `GETMETADATA` reads, so a
  value a client sets with `SETMETADATA` is what the filter sees.
- The text after `:` is a mask: `*` matches any run of characters and `?`
  exactly one; everything else must match exactly, case included.
- A line starting with `-` inverts the test: the folder is kept when the
  annotation does not match the mask, including when it is not set.
- With several annotation lines, a folder is kept when any one of them keeps
  it.
- The filter applies only to folders that a pattern brought in. A folder named
  exactly on its own line is always kept.
- Annotation lines take no `SEARCH` rule, and `!` cannot be combined with
  one: a save folder is a name.

A changed annotation takes effect at the next synchronisation. A `NOOP` in
the open mailbox shows the folder's messages arriving, or leaving.

Every synchronisation reads the annotation of each folder a pattern brought
in, once per annotation line. With the default file-backed metadata store,
this costs a check of the file's modification time. With a Redis or SQL
metadata store, it costs one query per folder and line on each check.

### `+Folder`

`+` asks for `\Recent` to be cleared on the folder's messages when the
virtual mailbox is opened. yarilo does not track `\Recent`: no message is
ever reported as recent, so there is nothing to clear. The line is read as
the folder name without the `+`.

## What the mailbox holds

Membership is decided when the mailbox is synchronised, not when it is
searched: `EXISTS` counts exactly the messages the rules keep. A message
filed in two of the folders is two messages here, each with its own flags, as
it is two messages in those folders.

A message keeps its UID for the life of the mailbox's `UIDVALIDITY`. When a
rule in the configuration changes, the set is defined differently: the
mailbox is rebuilt, its old messages are expunged and the ones the new rules
keep are added under new UIDs.

### When it is synchronised

On `SELECT`, and afterwards whenever the session looks for changes: every
`NOOP` and the end of every command, an `IDLE` wake-up, `STATUS` of the
mailbox, and `EXPUNGE` in it. So an open virtual mailbox follows its folders
without being selected again.

Each pass first compares every folder's `UIDVALIDITY`, `UIDNEXT` and
`HIGHESTMODSEQ` with what the previous pass saw. A folder where nothing moved
is not read, and a pass where no folder moved writes nothing and takes no
lock. A folder that moved is read in full. A folder whose `UIDVALIDITY`
changed starts its messages over; the other folders keep theirs.

### How a message leaves

- Its copy was expunged in its folder: it leaves at once, and the client is
  told with `EXPUNGE`, or `VANISHED` under QRESYNC.
- Its folder left the set: the folder was deleted or renamed, or an
  annotation line no longer keeps it. Its messages leave at once.
- It stopped matching its rule, as a message read in an "unread" mailbox
  does: it stays while the mailbox is open, and leaves at the next `EXPUNGE`
  in the virtual mailbox or the next `SELECT` of it. A message does not
  vanish while it is being read.

## Storing into a virtual mailbox

`APPEND`, `COPY` and `MOVE` into a virtual mailbox store the message in the
folder its `!` line names, with the flags given. The answer carries no
`APPENDUID` or `COPYUID`, because the new UID belongs to that folder, not to
the virtual mailbox. The virtual mailbox shows the message at its next
synchronisation if its rules keep it.

A virtual mailbox without a `!` line stores nothing, and one whose `!` folder
does not exist cannot store either: both answer `NO [CANNOT]`. A refused
`MOVE` leaves the message where it was.

## Working in a virtual mailbox

| Command | What it does |
|:---|:---|
| `FETCH` | reads the real message: body, envelope, structure and `BINARY` sections are the copy's |
| `SEARCH` | text criteria are answered by one full-text lookup over all the mailbox's folders. A folder the index has not caught up with is read in full rather than answered from an incomplete index |
| `COPY` | copies the real message to the destination; `COPYUID` names the virtual mailbox's UIDs as the source |
| `MOVE` | moves the real message: it arrives in the destination and leaves its own folder, and so the virtual mailbox too |
| `STORE` | changes the flags of the real message, in its folder. `+FLAGS` and `-FLAGS` apply as changes, so a flag another client set on that message meanwhile is kept; the reply shows the flags the message ended with, and its `MODSEQ` in the virtual mailbox moves |
| `EXPUNGE` | removes the real messages marked `\Deleted` from their folders, and drops what stopped matching |
| `SORT`, `THREAD` | order by what the real messages say: their headers, dates and sizes, read from their own folders |
| `IDLE`, `NOTIFY` | hear changes in the mailbox's folders, not only in the virtual mailbox itself |
| `CONDSTORE`, `QRESYNC` | the virtual mailbox has its own modseq; changes to its messages, and messages leaving, are reported like in any mailbox |

::: warning EXPUNGE deletes the real message
A message marked `\Deleted` and expunged in a virtual mailbox is gone from
its real folder too. Tell users who treat a virtual mailbox as a view.
:::

A `STORE` made in a virtual mailbox is a flag change in two mailboxes, so an
[imapsieve](/SIEVE) script bound to the message's own folder runs on it, and
then a script bound to the virtual mailbox runs too. Either script acts on the
real message.

The full-text index never indexes a virtual mailbox itself: its messages are
indexed once, in their own folders.

## Limits

- A folder that moved is read in full on the next pass, not only its messages
  that changed since the previous one.
- The folders an `IDLE` listens to are fixed when `IDLE` starts; a folder that
  joins the mailbox's set meanwhile is heard from the next `IDLE`.
