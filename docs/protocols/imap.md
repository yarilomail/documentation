---
description: "IMAP configuration for yarilo: IMAP4rev2 (RFC 9051) with IMAP4rev1 compatibility, supported extensions, listener ports, TLS modes and protocol settings."
---

# IMAP configuration

Yarilo implements IMAP4rev2 (RFC 9051) with backward compatibility to IMAP4rev1 (RFC 3501).

Listeners: `services.imaps` (implicit TLS, port 993) and `services.imap` (STARTTLS, port 143).
See [Services configuration](/architecture/services) for listener-level settings (port, ssl_mode, haproxy_protocol, etc.).

---

## `protocol.imap`

Protocol-level behaviour, shared across both IMAP listeners.

<!-- @settings protocol.imap -->

### `imap_logout_format` variables

| Variable | Description |
|:---|:---|
| `%{deleted}` | Number of messages marked `\Deleted` in the session. |
| `%{expunged}` | Number of messages expunged (removed from disk). |
| `%{fetch_hdr_count}` | Number of header fetch operations. |
| `%{fetch_hdr_bytes}` | Bytes transferred for header fetches. |
| `%{fetch_body_count}` | Number of body fetch operations. |
| `%{fetch_body_bytes}` | Bytes transferred for body fetches. |

Example:

```yaml
protocol:
  imap:
    imap_logout_format: "in=%{fetch_hdr_bytes}+%{fetch_body_bytes} expunged=%{expunged}"
```

---

## Supported IMAP extensions

[Feature coverage](/architecture/parity#imap-extensions) is the exhaustive list of what the server advertises. This table explains the ones that need it.

`IMAP4rev2` also brings `ENABLE`, `SASL-IR`, `LITERAL+`, `SEARCHRES` and `STATUS=SIZE`; `LIST-EXTENDED`, `LIST-STATUS`, `CREATE-SPECIAL-USE` and `SORT` (RFC 5256, without `SORT=DISPLAY`) are advertised too.

| Extension | RFC | Notes |
|:---|:---|:---|
| IDLE | RFC 2177 | Server-push new-mail notifications. |
| MOVE | RFC 6851 | Atomic move (no COPY + STORE + EXPUNGE round-trip). |
| CONDSTORE | RFC 7162 | `MODSEQ` flag, conditional STORE. |
| QRESYNC | RFC 7162 | Fast mailbox resync after reconnect. |
| UIDPLUS | RFC 4315 | `APPENDUID` / `COPYUID` response codes. |
| UNSELECT | RFC 3691 | Close mailbox without expunge. |
| NAMESPACE | RFC 2342 | Shared / Other Users namespaces. |
| QUOTA | RFC 9208 | Per-user storage quota. Advertised while `imap_quota` is on (the default). |
| ACL | RFC 4314 | Per-mailbox access control lists. Advertised only with `acl.enabled`. A body `FETCH` sets `\Seen` only for a reader holding `s`; with `r` alone the body is served and the flag left as it is. |
| BINARY | RFC 3516 | Binary content transfer. |
| THREAD | RFC 5256 | Threading of the searched messages, both algorithms: `THREAD=REFERENCES` (ancestry from `References` / `In-Reply-To`, then joining by base subject) and `THREAD=ORDEREDSUBJECT` (base subject alone). Computed per command from message headers. |
| ESEARCH | RFC 4731 | Extended SEARCH with MIN/MAX/COUNT. |
| NOTIFY | RFC 5465 | Event-based notifications. `NOTIFY SET`/`NONE` parsed with all mailbox filters; the **selected** mailbox honours `SELECTED` / `SELECTED-DELAYED` (MessageNew / MessageExpunge / FlagChange), suppressing the unsolicited responses the client did not request (RFC 5465 §5). **Non-selected** mailbox filters (PERSONAL / INBOXES / SUBSCRIBED / SUBTREE / MAILBOXES) are watched via the `pkg/locks` event bus and their MessageNew / MessageExpunge / FlagChange activity is reported as untagged `* STATUS` (RFC 5465 §6), delivered during IDLE and before the next command's tagged response. The watched set is re-evaluated dynamically: mailboxes created, renamed or subscribed after `NOTIFY SET` join or leave the set live (via the per-user `mlist:` event key). Mailbox-level events — **MailboxName** (create / delete / rename, the last with `OLDNAME`) and **SubscriptionChange** (subscribe / unsubscribe) — are reported as untagged `* LIST` responses (RFC 5465 §5) when requested. `AnnotationChange` / metadata events are not yet reported. |
| SPECIAL-USE | RFC 6154 | `\Sent`, `\Drafts`, `\Trash` folder flags. |
| ID | RFC 2971 | Server identity advertisement. Always offered before login; after login only while `imap_id_send` is non-empty. |
| OBJECTID | RFC 8474 | Stable object identifiers: `MAILBOXID` (SELECT/EXAMINE response code + STATUS item, from the folder GUID), `EMAILID` (FETCH, from the message GUID), `THREADID` (FETCH, the conversation a message belongs to; `NIL` for accounts whose threading data has not been built yet). IDs are 32 lowercase hex chars of the 128-bit GUID; they survive RENAME. |
| METADATA | RFC 5464 | Advertised only when a `metadata` dict is configured. Server and per-mailbox annotations (GETMETADATA / SETMETADATA). State lives in `cfg.Dicts["metadata"]` (`pkg/dict`). Keys: `priv/box/<folder_guid>/<entry>` and `shared/box/<folder_guid>/<entry>`; server-scope entries live under INBOX's GUID with a `vendor/yarilo/pvt/server/` prefix so they cannot collide with INBOX mailbox attributes. |
