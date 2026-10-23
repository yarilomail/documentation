# JMAP configuration

The session resource, the request envelope and the Mail and Quota methods listed
under [Capabilities](#capabilities) are served, reading and writing. Push is
served over EventSource ([Push](#push)); WebSocket and Web Push are not yet.

JMAP runs as two binaries, not one. `yarilo-jmap-login` faces clients and
`yarilo-jmap` owns the user's state; see
[Deployment](/installation/deployment) for the topology and the reasoning behind it.

| Binary | Faces | Terminates client TLS | Runs the passdb chain |
|:---|:---|:---:|:---:|
| `yarilo-jmap-login` | the internet | yes | yes |
| `yarilo-jmap` | the login pod only | no | no |

---

## Listeners

| Service key | Port | Served by | Protocol |
|:---|:---|:---|:---|
| `jmap` | `8443` | `yarilo-jmap-login` | HTTPS, client-facing |
| `jmap_be` | `10443` | `yarilo-jmap` | HTTP over internal mTLS |

`10443` sits in the backend data range next to `10143`/`10110`/`10587`/`10024`
and deliberately clear of `8080`, which is the telemetry port on every
component pod.

---

## Authentication

`yarilo-jmap-login` authenticates every request in `yarilo-auth` with the
service name `jmap`, so the passdb chain, penalties, the policy server, userdb
fields and `nologin` apply as they do for IMAP:

| `Authorization` | Run as | Configure |
|:---|:---|:---|
| `Basic` | a password login | any passdb ([AUTH](/auth/)) |
| `Bearer` | an OAUTHBEARER login, the token naming the user | an OAuth2 passdb ([OAuth2](/auth/oauth2)) |

A `401` lists the schemes that can succeed: `Basic realm="jmap"`, and
`Bearer realm="jmap"` only while `yarilo-auth` runs OAUTHBEARER. A refused
token adds `error="invalid_token"`. With `auth_allow_cleartext: false` both
schemes are refused over plain HTTP. A `503` means `yarilo-auth` could not
answer; the client retries the same credentials.

---

## Trust between the two

The backend runs no authentication of its own: the login layer already ran the
passdb chain and asserts the user in `X-Yarilo-User`. It therefore honours those
headers only from a peer it has been configured to trust. Three modes, evaluated
in order, all default-deny:

| # | Configure | Anchor | Anything else |
|:--|:---|:---|:---|
| 1 | `internal_tls.enabled: true` | the peer's certificate | `403` |
| 2 | `services.jmap_be.xclient_protocol: true` + `general.xclient.trusted_nets` | the peer's address | `403` |
| 3 | neither | none | `403` on every request |

Mode 2 reuses `general.xclient.trusted_nets`, the same list that already decides
whether a forwarded client IP is believed for XCLIENT and `IMAP ID
x-originating-ip` — `Forwarded` is the HTTP member of that family, not a new
mechanism.

In mode 3 the listener still binds and answers `403` with a named cause, and the
backend logs `no trust anchor for the login hop` once at startup. A dead port
would read as a network fault and send the operator looking in the wrong place.

`allow_nets` is not enforced here: the login pod checks it against the real
client before proxying, exactly as it does for the byte-pipe protocols.

---

## `protocol.jmap`

Every limit is advertised in the session resource as well as enforced, because
clients batch against what is published.

<!-- @settings protocol.jmap -->

The session `state` string is derived from these values, so changing one
invalidates a client's cached session and nothing else does.

---

## Helm

```yaml
components:
  jmap:                    # the backend container
    enabled: true
    listeners:
      jmap:
        containerPort: 10443
        xclient: false     # trust mode 2; leave off when internalTLS is on

  jmapLogin:               # the client-facing proxy
    enabled: true
    backend_port: 10443    # the JMAP container's port, not the pod's
    director_addr: "yarilo-director:9102"
    tls:
      secretName: jmap-tls

protocol:
  jmap:
    jmap_base_url: "https://mail.example.com"
```

Under the co-located backend model (`components.backend.coLocated: true`, the
director shape) `yarilo-jmap` renders as one more container in the backend pod
and shares its pod IP, so a user reaches every protocol on the address the ring
resolved. With `coLocated: false` (the standalone shape) it renders as its own
Deployment plus a headless Service, like the other backends.

---

## The API endpoint

`POST /jmap/api/` runs a batch of method calls. Two things about it are worth
stating because they are choices, not consequences of the RFC:

**Core is not implicit.** A client must name every capability it relies on in
`using`, including `urn:ietf:params:jmap:core`. A method whose capability is
absent is answered with `unknownMethod` — the same answer as a method that does
not exist (RFC 8620 §3.2). That is what lets the server gain capabilities
without changing how an older client behaves.

**Failures have two levels.** A request-level fault — malformed JSON, a missing
`methodCalls`, an unknown capability, an exceeded request limit — aborts the
batch and returns a problem document. A method-level fault becomes an `error`
response for that one call, and the rest of the batch still runs; a client
matches responses to calls by `callId`, never by position.

**No method executes until the entire envelope is read and parsed; streaming
execution is forbidden.** A request is either rejected whole or run whole, which
is what makes the request-level problems above meaningful. It also fixes the
boundary for the mutating methods that arrive later: a batch cannot be applied
halfway because the client's connection died mid-body.

Back-references (§3.7) resolve against the responses produced so far, so a
reference forward, or into a call answered with `error`, is
`invalidResultReference` by construction. The path is a JSON Pointer (RFC 6901)
extended with `*`, which maps the remainder over an array and flattens one
level.

An object created earlier in the same request can be named by its creation id
with a `#` in front (RFC 8620 §5.3): `"emailId": "#d"` after an `Email/set` or
`Email/import` that created `d`, `"mailboxIds": {"#b": true}` after a
`Mailbox/set` that created `b`. This works in every argument that takes an id:
`ids` of a `/get`, the keys of `update` and the entries of `destroy`, filters
such as `inMailbox`, and properties such as `parentId`, `emailId` and
`identityId`. A creation id used twice names the item created last. One that
names nothing is treated as an id that does not exist (`notFound`,
`invalidProperties`). A client that sends `createdIds` gets the map back with
what the request created added to it, and can use those creation ids too.

Within one `Mailbox/set`, a create whose `parentId` names another create of the
same call is created after its parent, whatever order the creation ids come
in. Creates whose parents form a cycle, and any create below them, are refused
with `invalidProperties` on `parentId`.

### Request limits

| Bound | Enforced by | Refusal |
|:---|:---|:---|
| `jmap_max_size_request` | `yarilo-jmap-login`, at the edge | `413` with a `limit` problem naming `maxSizeRequest` |
| `jmap_max_size_upload` | `yarilo-jmap-login` on the upload path, and `yarilo-jmap` | `413` with a `limit` problem naming `maxSizeUpload` |
| `jmap_max_objects_in_set` | `yarilo-jmap` | `requestTooLarge` for a `Foo/set` or `Email/import` over the limit, before anything is written |
| `jmap_max_calls_in_request` | `yarilo-jmap` | `400` with a `limit` problem naming `maxCallsInRequest` |

The body cap runs in the login pod so an oversized request is refused before it
is proxied and no backend ever reads it. The backend keeps the same cap as a
floor: a request arriving there oversized means the hop was bypassed. Every
limit problem carries the `limit` member (§3.6.1) — "too big" is useless without
naming the bound.

The clean refusal needs a declared length. A request whose `Content-Length`
exceeds the cap is answered with the `limit` problem before anything is read; a
chunked body, or one that understates its length, is instead cut off by the
reader as it is proxied, so that client sees a broken response rather than a
problem document. The excess never reaches a backend either way, and a client
sending `Content-Length` — which is every real JMAP client — always gets the
parseable answer.

---

## Mailboxes

JMAP exposes the **personal namespace** only; shared and public namespaces are
not served over JMAP. See [Changing mailboxes](#changing-mailboxes) for
`Mailbox/set`.

| JMAP member | Source |
|:---|:---|
| `id` | the folder GUID from the index — stable across a rename, which the name is not |
| `name` | the leaf name; hierarchy travels in `parentId`, so a client never learns the delimiter |
| `role` | IMAP special-use, per-user overrides layered over `imap_special_use_defaults`; `INBOX` is `inbox` without carrying an attribute |
| `totalEmails` / `unreadEmails` | the folder's own counters, the same ones `STATUS` reports |
| `totalThreads` / `unreadThreads` | real conversation counts, from the account's threading state. Equal to the message counts on an account the [thread backfill](/installation/migration#thread-backfill-conversations-for-existing-accounts) has not reached, where every message is still its own conversation |
| `isSubscribed` | the same subscriptions file IMAP reads, so one `SUBSCRIBE` shows in both protocols |
| `myRights` | full rights in the personal namespace; a `\NoSelect` container reports no read, add, remove or submit |

A `\NoSelect` container appears in the list with a `container:` id. It holds no
mail, but omitting it would leave its children pointing at a parent the client
never saw.

Both methods read control files under the cross-process lock, so a concurrent
IMAP `SUBSCRIBE` or `CREATE (USE ...)` cannot be observed half-applied. The
backend refuses to start without a locks client for that reason.

### State strings

`Mailbox/get` returns `state` and `Mailbox/query` returns `queryState`; both are
a digest of the mailbox set. They tell a client that something moved, never
what. `canCalculateChanges` is `false` and stays false until `Mailbox/changes`
lands, so a client refetches rather than diffing — the same non-incremental
contract `Email/query` will start with.

### What is refused rather than approximated

A filter operator (`AND`/`OR`/`NOT`) is answered with `unsupportedFilter`, and a
sort on any property other than `sortOrder`, `name` or `parentId` with
`unsupportedSort`. Silently matching everything, or returning a different order
than the one asked for, would render the wrong list in a client that had no way
to know.

---

## Emails

`Email/get` answers by id — a null `ids` is refused, since it
would select every message the account has and no limit would bound the cost.

| JMAP member | Source |
|:---|:---|
| `id`, `blobId` | the message GUID — the same identity IMAP reports as `EMAILID` (RFC 8474), so one message is one object whichever protocol reaches it |
| `threadId` | the conversation the message belongs to — the id of its first message, so it survives the message being moved, expunged and redelivered, or migrated. On an account the [thread backfill](/installation/migration#thread-backfill-conversations-for-existing-accounts) has not reached, a message is its own conversation and this is its own id |
| `mailboxIds`, `keywords`, `size`, `receivedAt` | the index |
| envelope fields, body parts, `preview` | the message itself, parsed on demand |
| `keywords` | IMAP system flags translated to the JMAP vocabulary — `\Seen` is `$seen` |

### A message that cannot be parsed still exists

Malformed MIME headers are ordinary in real mail — spam, broken clients,
truncated delivery. Such a message is returned with the properties the index
carries (`id`, `mailboxIds`, `keywords`, `size`, `receivedAt`) and with the
header-derived ones empty. It is **not** reported as `notFound`: `Email/query`
lists it, download serves its bytes and IMAP shows it, so calling it absent
would leave a client unable to reconcile its own view of the account.

A message whose file cannot be read at all is the other condition and keeps its
own answer — there the store cannot produce it, download answers `404` too, and
the methods agree that it is absent. The distinction is what keeps the three
consistent: they disagree about how much of a message can be rendered, never
about whether it is there.

### The message is opened only when it is needed

A request naming only index-backed properties — `id`, `mailboxIds`, `keywords`,
`size`, `receivedAt` — never opens the message. Everything else comes from the
parsed message, so naming any of them reads it — except the envelope fields
listed below, which are served from the index cache once something has parsed
them. A request naming no properties gets the full default set, which reads
the message.

Body *values* are separate again: they are returned only for
`fetchTextBodyValues` / `fetchHTMLBodyValues` / `fetchAllBodyValues`. The
structural lists (`textBody`, `htmlBody`, `attachments`) are metadata and cost
the parse but not the content.

### Envelope fields come from the index cache

Envelope fields are parsed once per message and kept in the per-folder index
cache, so a second request for them does not open the message again. The
cache is shared with IMAP: one file, one set of invalidation rules, and a
message cached by an IMAP `FETCH (ENVELOPE)` is already cached for
`Email/get`.

What it covers, and what it does not:

| property | served from the cache |
|:---|:---|
| `subject`, `sentAt`, `messageId`, `inReplyTo`, `from`, `sender`, `to`, `cc`, `bcc`, `replyTo` | yes |
| `references` | no |
| `headers`, `header:*` | no |

The covered set is exactly what a mailbox listing asks for — `id`, `subject`,
`from`, `receivedAt` — which is the request a client repeats most.

**A request that mixes covered and uncovered properties opens the message.**
Serving one message's answer from two sources costs the complexity of both
and saves nothing: the message is opened either way. So `subject` alone is
served from the cache, and `subject` with `references` is parsed whole.

**Why the cache holds a parsed envelope rather than the raw header block.**
Raw headers would cover everything above, including `references` and
`header:*`. The choice is asymmetric: a parsed envelope can gain a raw-header
field later — the format carries a field table, so a new field is an
addition — while starting from raw headers makes "parse from memory" the
base semantics for both protocols, and going back to parsed values means
migrating what is already stored. The reference caches parsed values too, and
our format is byte-compatible with that model. Uncovered properties parse
exactly as they did before the cache existed, so nothing is slower than it
was.

### Body value size

`jmap_max_body_value_bytes` is the server's ceiling on one returned body value.
The client's own `maxBodyValueBytes` (RFC 8621 §4.2.2) wins when smaller; a
client naming none gets the ceiling rather than the whole body, because the
ceiling bounds the operator's work rather than expressing a client preference.

Every truncated value carries `isTruncated: true`. A server may return less than
the whole part; it may not do so silently. The cut lands on a UTF-8 rune
boundary, and an HTML value additionally drops a trailing partial tag rather
than emitting markup a client renders as text.

**Worst-case arithmetic, so the two knobs are visibly multiplied:**

```
returned body bytes  <=  jmap_max_objects_in_get x jmap_max_body_value_bytes
                     =   500 x 256K  =  128M   (at the defaults)
```

Reading and parsing the raw messages is **not** bounded by the ceiling — that
cost is proportional to the messages themselves. It is the same cost an IMAP
`FETCH BODY[]` of the same messages incurs, so no new surface appears: an
authenticated user is reading their own mail either way. What the ceiling bounds
is the response, and with it the memory held per request.

---

## Finding and downloading messages

`Email/query` answers the conditions the mail index carries: `inMailbox`,
`inMailboxOtherThan`, `before`, `after`, `minSize`, `maxSize`, `hasKeyword`,
`notKeyword`. Sort is `receivedAt` (default, newest first) or `size`; the id
breaks every tie, so two runs of the same query agree and a client paging with
`position` never sees a message twice or misses one.

**Full-text conditions are answered from the search index.** `text`, `body`,
`subject`, `from`, `to`, `cc`, `bcc` and `header` are resolved by asking
yarilo-fts once per mailbox in scope. Without a search service configured they
are still refused by name — `unsupportedFilter` listing the offending
conditions, so a client can drop exactly those and retry rather than receive a
confidently wrong result set.

A candidate the engine can only over-approximate is confirmed against the
message before it reaches the client, the same invariant IMAP `SEARCH` holds,
and with the same substring semantics — so the two surfaces agree on what a
match is.

### How wide a search may go

`jmap_max_query_folders` (default 64) bounds one request's fan-out. It counts
only the mailboxes a full-text condition would search: a query without one does
not fan out and never sees the limit.

Exceeding it is `invalidArguments` naming both numbers — the count and the
limit — so a client knows how far to narrow `inMailbox`. The alternative,
searching the first 64 and answering, would return part of an account's mail in
a shape indistinguishable from all of it.

This is not the same budget as `fts_max_conns`, which bounds how many
connections one **process** keeps to yarilo-fts. One is what a request may take,
the other what a process may take; a single query uses at most half the pool, so
a second concurrent query is not starved by the first.

### When the index cannot answer

Three outcomes, deliberately distinct, because a client is entitled to treat
`serverFail` as final and show an empty result:

| Condition | Answer | Meaning |
|:---|:---|:---|
| The index is behind the mailbox | `serverUnavailable` | Retry: indexing is catching up and will finish. |
| No connection to yarilo-fts is free | `serverUnavailable` | Retry: the service is alive, the local pool is busy. |
| The lookup failed, or a mailbox has no GUID | `serverFail` | Retry will not help. |

A lagging mailbox is queued for priority indexing when `fts_search_add_missing`
is set, and the query waits — one budget for the whole request, not one per
mailbox — before answering `serverUnavailable`.

::: warning fts_search_read_fallback does not apply here
On IMAP that setting falls back to an exact scan when the index cannot answer.
`Email/query` never reads message bodies, so there is no scan to fall back to:
on this surface a failed lookup is refused whatever the setting says. See
[FTS](/features/fts).
:::

## Search snippets

`SearchSnippet/get` returns the highlighted fragments for a list of message ids
and the filter they were found with.

The search engine reports no term positions, so the highlighting is produced by
the server: the message is read again and whole tokens whose expansion meets the
query's are wrapped in `<mark>`. Whole tokens, never substrings — the terms are
stems, and marking whatever begins with one would cut unrelated words in half.

The `preview` is a window around the first hit, not the head of the message: a
match at character 5000 would otherwise return the opening lines with nothing
highlighted in them, stated as a search result. The window opens at a word
boundary and carries `…` at whichever end is not the message's own.

Either field may be `null`, per field rather than per message: a hit in the
subject returns a highlighted subject and a `null` preview. That is what RFC
8621 §5.1 allows and it is the honest answer — an invented fragment would claim
a match that is not in it.

The fragment is escaped **before** the markup is added, so a message carrying
`<script>` or a literal `<mark>` cannot smuggle either into a client. The
preview is taken from `text/plain`, or from HTML with its tags stripped;
matching still searches every text part, since a hit may be anywhere the index
looked.

The id count is bounded by `jmap_max_objects_in_get` — every id costs a message
read, which is the budget that key already names — and exceeding it is
`requestTooLarge`.

### Result size

`jmap_query_max_limit` (default 256) is the ceiling on returned ids. The
client's own `limit` wins when smaller; a client naming none gets the ceiling
rather than the whole result set. RFC 8620 §5.5 permits this provided the
response says so, and it does: `limit` in the response is the value that was
applied, which is what tells a client to page with `position`.

### Query state

`queryState` is a digest of everything that determines the result:

- the filter and the sort — two queries with different arguments describe
  different lists and must not share a state a client could cache one against
  the other;
- the **composition** of the folder set in scope — creating or deleting a
  folder changes the result without moving any surviving folder's modseq;
- each in-scope folder's `UIDVALIDITY` and `HIGHESTMODSEQ` — these move on
  delivery, flag change and expunge.

A filter naming one mailbox reads only that mailbox, so a delivery elsewhere
does not move this query's state. It is deliberately coarser than a change log:
a flag change in a folder the query reads moves the state even when the filter
does not depend on flags. `canCalculateChanges` stays `false` until a change
journal exists, so a client refetches rather than diffing.

### Download

`GET /jmap/download/{accountId}/{blobId}/{name}` streams a blob: a whole
message, one part of it, or an upload.

Every body part of `Email/get` carries its own `blobId`. A part downloads as its
decoded content, so an attachment comes back as the bytes that were attached.

The blob is resolved against the authenticated user's own mail **before**
anything is opened, so a blobId belonging to somebody else is a `404` that never
touched their file — ownership is a precondition, not a check applied to an open
handle. Another account's blob and a nonexistent one answer identically, so the
response confirms nothing a caller guessed.

The body is copied straight through: a large attachment is never held whole in
the backend or in the login proxy in front of it. It is served as
`application/octet-stream` with an attachment disposition and `nosniff`, so a
crafted message can never render in the origin that serves the API.

---

## Uploading and importing

To upload a blob, `POST` its bytes to the session's `uploadUrl`:

```sh
curl -u u1@example.com:secret --data-binary @message.eml \
  -H 'Content-Type: message/rfc822' https://mail.example.com/jmap/upload/u1@example.com/
```

The answer is `201` with `accountId`, `blobId`, `type` and `size`. This upload:

- names the blob after its content, so the same bytes get the same `blobId` and
  start its lifetime again;
- is kept for `jmap_upload_ttl` seconds, then removed;
- is refused with `507` when the account's storage limit has no room for it
  together with the uploads it already holds;
- is visible to its own account only: another account's `blobId` is not found.

Uploads are not mail. They do not count in `Quota/get` or IMAP `GETQUOTA`.

To store a blob as a message, use `Email/import` (RFC 8621 §4.8) with its
`blobId`, the `mailboxIds` to put it in, and optionally `keywords` and
`receivedAt`. The blob may be an upload, an existing message or one of its
parts. An import is stored as a delivery is: quota, full-text indexing,
threading and IDLE notifications follow it.

## Changing emails

`Email/set` (RFC 8621 §4.6) creates, updates and destroys.

- **create** builds a message from its properties: the address, subject, date
  and id headers, and a body given as `bodyStructure` or as `textBody`,
  `htmlBody` and `attachments`. A part's content is a `bodyValues` entry or a
  `blobId`. `Date` and `Message-ID` are added when not given.
- **update** sets `keywords`, whole or one at a time (`keywords/$seen`), and
  `mailboxIds`, whole or one at a time (`mailboxIds/<id>`). Moving keeps the
  Email's id. A message is never left in no mailbox.
- **destroy** removes the Email from every mailbox it is in.

A move does not count against the quota; a copy into another mailbox does. Each
object fails on its own: one refused id does not fail the rest of the call.

## Changing mailboxes

`Mailbox/set` (RFC 8621 §2.5) creates, renames, moves and destroys mailboxes.
Names are checked as IMAP `CREATE` checks them, and `isSubscribed` writes the
subscription list IMAP reads.

| Refusal | When |
|:---|:---|
| `alreadyExists` | the name is taken |
| `forbidden` | renaming or destroying INBOX |
| `mailboxHasChild` | destroying a mailbox with children |
| `mailboxHasEmail` | destroying a mailbox with mail, without `onDestroyRemoveEmails` |
| `overQuota` | `quota_mailbox_count` is reached |

A renamed mailbox keeps its id and its access rights.

---

## Capabilities

| Capability | RFC | State |
|:---|:---|:---|
| Core — session | RFC 8620 §2 | served |
| Core — request envelope, back-references, `Core/echo` | RFC 8620 §3–§4 | served |
| Mail — `Mailbox/get`, `Mailbox/query`, `Mailbox/set` | RFC 8621 §2 | served |
| Mail — `Email/get` (envelope, bodies, preview) | RFC 8621 §4 | served |
| Mail — `Email/query` (index and full-text conditions) | RFC 8621 §4.4 | served |
| Core — blob upload and download | RFC 8620 §6 | served |
| Mail — `Email/import` | RFC 8621 §4.8 | served |
| Mail — `SearchSnippet/get` | RFC 8621 §5 | served |
| Mail — `Thread/get`, `Thread/changes` | RFC 8621 §3 | served from the account's threading state; a merge is reported in `Email/changes` as well, since a client groups by the `threadId` it holds |
| Mail — `Mailbox/changes` | RFC 8621 §2 | served |
| Mail — `Email/changes` | RFC 8621 §4 | served |
| Mail — `Mailbox/queryChanges`, `Email/queryChanges` | RFC 8620 §5.6 | registered; answers `cannotCalculateChanges` |
| Mail — `Email/set` | RFC 8621 §4.6 | served: create, keywords, `mailboxIds`, destroy |
| Quota — `Quota/get`, `Quota/changes`, `Quota/query`, `Quota/queryChanges` | RFC 9425 | served, read-only |
| Sieve — `SieveScript/get`, `/set`, `/query`, `/validate` | RFC 9661 | served |
| Vacation — `VacationResponse/get`, `/set` | RFC 8621 §8 | served with Sieve scripts when `sieve_vacation_enabled` is on and `sieve_extensions` allows `vacation` |
| Submission — `Identity/get`, `/changes`, `/set`; `EmailSubmission/get`, `/changes`, `/query`, `/queryChanges`, `/set` | RFC 8621 §6–§7 | served when a relay is configured; identities read-only |
| Push over EventSource | RFC 8620 §7.3 | served; see [Push](#push) |
| Push over WebSocket | RFC 8887 | not implemented |
| Push subscriptions (Web Push) | RFC 8620 §7.2 | not implemented |

The protocol layer lives in `pkg/jmapcore`, which imports nothing from yarilo
and is meant to be extracted as a standalone library.

## Push

`GET /jmap/eventsource/` streams `StateChange` events (RFC 8620 §7.3). It is
the `eventSourceUrl` of the session resource and passes through
`yarilo-jmap-login`.

### Stream parameters

| Parameter | Values |
|:---|:---|
| `types` | type names, comma-separated, or `*` |
| `closeafter` | `state` or `no` |
| `ping` | seconds; `0` sends none |

`*` means every type the server answers: `Email`, `Mailbox`, `Thread` and
`Quota`, plus `Identity`, `EmailSubmission`, `SieveScript` and
`VacationResponse` where they are served. An unknown name is left out, and a
request naming no known type is answered `204`.

`closeafter=state` ends the stream after the first `state` event. A `ping`
event carries `{"interval":N}`.

### Resuming after a disconnect

A `state` event carries the types whose state moved, with their new state
strings, and an `id`. The id is a sequence of the pod that serves the stream;
it means nothing on another pod.

To resume, reconnect with `Last-Event-ID` set to the last id received. Whatever
its value, the current state of every requested type is sent at once, so nothing is missed
while the client was away, even if the account moved to another backend
meanwhile.

Without `Last-Event-ID` the stream starts from the current state and sends
only later changes.

### What moves a type

Every write announces itself through `yarilo-locks`, whatever the protocol
made it, and every pod with an open stream for the account hears it at once.
A stream recomputes only the types the write can move and sends those whose
state changed:

| Write | Types |
|:---|:---|
| a message or its flags: delivery, `APPEND`, `STORE`, copy, move, expunge | `Email`, `Thread`, `Mailbox`, `Quota` |
| a folder created, renamed or deleted; a subscription; a special-use role; an ACL change | `Mailbox` |
| a Sieve script, including the vacation script | `SieveScript`, `VacationResponse` |
| a new conversation in the threading state | `Thread` |
| an `EmailSubmission` record kept or dropped | `EmailSubmission` |

`jmap_push_poll` is a safety net under the events: every that many seconds a
stream recomputes all its types, which catches a write made while the pod had
lost its channel to `yarilo-locks`. A lost channel is asked for again every
two seconds, and once it is back every type is recomputed. With
`jmap_push_poll: 0` the endpoint answers `204`.

`Identity` is read from userdb and has no write path in Yarilo. It moves only
when userdb does, which no event announces; the recompute picks it up.

### Kicks

The stream outlives the proxy's request timeouts, and a kick ends it: a
session kick from the admin API, or a director `USER-KICKED` for the user,
including a move to another backend. The client reconnects with
`Last-Event-ID` and reaches the user's new backend.

## Quota

`urn:ietf:params:jmap:quota` (RFC 9425) is advertised in the session resource
and per account. A client that speaks only JMAP can read the limit it is being
enforced against, which it previously could not.

One account is one quota root, and the objects are read-only: limits come from
the userdb, not from the client.

| Object | Reported when |
|:---|:---|
| `resourceType: "octets"` | a storage limit is set for the account |
| `resourceType: "count"` | a message-count limit is set (`quota_messages`) |

Both carry `scope: "account"`, `types: ["Mail"]` and the root name
`quota_name` gives IMAP. `hardLimit` is the limit **after** the site-wide
scaling (`quota_storage_percentage`, `quota_storage_extra`), so it is the number
a save is actually judged against, and `warnLimit` is the nearest configured
`quota_warning` threshold below it.

Nothing is reported when the quota engine is off, when `quota_hidden` is set, or
when the user has no limits and `quota_ignore_unlimited` is set — the same three
gates IMAP `GETQUOTA` answers on. A limit nobody enforces is not announced.

`used` is the same count `GETQUOTA` reports, from the same sweep of the
account's folders: two accountings would be two answers to one question. The
units differ because the protocols do — RFC 9208 counts kibibytes, RFC 9425
octets — and the smoke check converts one to the other rather than tolerating a
difference.

### State and changes

The state string carries the numbers themselves, so `Quota/changes` says which
root moved by comparing the state a client holds against the current one, with
no per-client history kept on the server. A state this server did not issue is
answered with `cannotCalculateChanges`, which sends the client back to
`Quota/get`.

`Quota/queryChanges` answers for real, unlike the Mailbox and Email ones, which
are registered and answer `cannotCalculateChanges`: this result set is the
account's own roots, which the state already names, so there is no previous
result to remember.

## Sieve scripts

`urn:ietf:params:jmap:sieve` (RFC 9661) manages the same scripts as
[ManageSieve](/features/sieve#managesieve). Both protocols read and write one store, so
a script uploaded over JMAP is listed by `LISTSCRIPTS` at once, and the reverse.

To store a script, upload its text as a blob, then create it from that blob:

```json
["SieveScript/set", {
  "accountId": "alice@example.com",
  "create": {"c1": {"name": "filters", "blobId": "U…"}},
  "onSuccessActivateScript": "#c1"
}, "0"]
```

- The script is checked with the parser and the `sieve_extensions` list that `PUTSCRIPT` uses. A script that does not parse, uses an extension not allowed, or is not UTF-8 gets `invalidSieve`.
- The created script's `blobId` names its stored text. Download it from `downloadUrl`, as `GETSCRIPT` would.
- A create without a name gets one from the server, returned in `created`.
- A create or rename onto a name the account already has gets `alreadyExists` with `existingId`, decided under the store's lock, so a concurrent ManageSieve session cannot be overwritten. An update that renames and replaces the content renames first: a refused name changes nothing.

### Limits

The account capability carries the [`sieve:` section](/features/sieve) limits that ManageSieve enforces:

| Capability field | Key |
|:---|:---|
| `maxSizeScript` | `sieve_max_script_size` |
| `maxNumberScripts` | `sieve_max_num_scripts` |
| `maxNumberRedirects` | `sieve_max_redirects` |
| `sieveExtensions` | `sieve_extensions` |

A limit set to `0` is sent as `null`, no limit. `notificationMethods` is `["mailto"]` while `enotify` is allowed; `externalLists` is `null`.

A script over `sieve_max_script_size` gets `tooLarge`. A new script past `sieve_max_num_scripts`, or one that would take the user's scripts past `sieve_max_storage`, gets `overQuota`. A replaced script is charged for its new size only.

`maxSizeScriptName` is 512 octets, the RFC's floor. A name also stays within the ManageSieve limit of 256 characters, so a name of 257 to 512 one-byte characters is refused although it fits the advertised octets.

### Activation and state

`onSuccessDeactivateScript` runs before `onSuccessActivateScript`, and both only when every create, update and destroy in the call succeeded. The active script cannot be destroyed (`sieveIsActive`); deactivate it in an earlier call.

A script's `id` is kept across a rename. The state string is a counter that every change moves, through either protocol, so `ifInState` and `oldState`/`newState` see a ManageSieve change. RFC 9661 defines no `SieveScript/changes`, so none is served.

A script written to the store behind both protocols, such as a file placed in the home directory, gets an id and moves the state the next time the list is read.

## Vacation response

`VacationResponse` (RFC 8621 §8) is a Sieve script under the hood, managed for the account: `urn:ietf:params:jmap:vacationresponse`, in the same store as the scripts of ManageSieve and `SieveScript`. ManageSieve lists it like any other script.

The script carries the object in a header comment, and below it the rule the object stands for:

- `isEnabled` is a test the rule starts with;
- `fromDate` and `toDate` bound it with `currentdate` (they need `date` and `relational` among `sieve_extensions`, when that list is set);
- `subject` is the reply's subject; one with a control character, a line break included, is refused;
- `textBody` and `htmlBody` are its body. With `htmlBody`, the reply is `multipart/alternative`, and its text part is `textBody` or, when that is null, the text of `htmlBody`. With neither, a default message is sent.

The reply itself is sent as for any Sieve `vacation`; see [Sieve](/features/sieve#vacation-replies).

### When it is enabled

A response is enabled when its `isEnabled` is true and the script runs. The script runs either when it is the account's active script, or when the active script includes it at its top level:

```sieve
require "include";
include :personal "urn:ietf:params:jmap:vacationresponse";
# the rest of the user's own rules
```

`VacationResponse/set` with `isEnabled: true` behaves by what is active:

- **No script is active:** the managed script becomes the active one.
- **The active script already includes the managed one:** nothing else changes.
- **The user's own script is active and does not include it:** the update is refused with `forbidden`. The user's script is never deactivated to make room; add the `include` line above to it, through ManageSieve or `SieveScript/set`, and enable again.

`get` answers `isEnabled: false` whenever the script does not run, whatever was set: for instance after another script was activated through ManageSieve.

### Edited by hand

The managed script can be read and changed through ManageSieve, as any script. If its header comment is missing or no longer parses, `get` answers a response that was never set (disabled, every property null), and the next `set` writes the script anew from what it is given.

The one object's id is `singleton`. `create` and `destroy` answer `singleton` (§8).

## Sending mail

`urn:ietf:params:jmap:submission` is advertised only when `submission_relay_host` is set. Mail goes the way [Submission](/protocols/submission) sends it: the same relay, the same login as the user, the same `submission_max_mail_size` and `submission_max_recipients`.

### Identities

The account's identities are its login, when it is an address, then the userdb field `identity_aliases`, each once whatever its case. They are read-only: `Identity/set` refuses every object with `forbidden`. An identity's `id` is fixed by its address, so a client may keep it.

### Sending a draft

Create an `EmailSubmission` naming an identity and an Email:

```json
["EmailSubmission/set", {
  "accountId": "alice@example.com",
  "create": {"s1": {"identityId": "I…", "emailId": "M…"}},
  "onSuccessUpdateEmail": {"#s1": {"keywords/$draft": null}}
}, "0"]
```

The draft can be created in the same request, by an `Email/set` call before this one, and named as `"emailId": "#<its creation id>"`.

- Without an `envelope`, the sender is the address in the last `Sender` header, else in `From`, and the recipients are `To`, `Cc` and `Bcc` without repeats. A sender the identity does not allow is replaced by the identity's address.
- The `From` header must be the identity's address (`forbiddenFrom`); a given `envelope.mailFrom` must be too (`forbiddenMailFrom`). Envelope parameters other than `SIZE` are refused.
- The `Bcc` header is removed before sending, and a `Received` header with `with HTTP` is added when `submission_add_received_header` is on.
- The message is sent at once: `undoStatus` is `final`, `maxDelayedSend` is `0`, and cancelling answers `cannotUnsend`.
- `onSuccessUpdateEmail` and `onSuccessDestroyEmail` run one `Email/set`, whose response comes right after the `EmailSubmission/set` one.

A refusal by the relay that is final (5xx) answers `forbiddenToSend` with the relay's reply. A temporary one (4xx, a relay that does not answer) fails the whole call with `serverFail` while nothing in the call has been sent yet, so the client sends again later. Once a message of the call has gone out, the sent ones are reported in `created` as usual, and the one the relay refused, with every one after it, comes back in `notCreated` with type `serverFail`: retry those, not the whole call.

### Records

`EmailSubmission/get` and `/query` read the records of what was sent, kept `jmap_submission_ttl_seconds` (default 86400) in the user's control directory and dropped when older. `0` keeps none: mail is still sent, and `get` finds nothing. Destroying a record does not touch the mail.

### Limits

Sending over JMAP is held to the same per-user-and-address connection limit as every protocol: `yarilo-jmap-login` counts each connection against `mail_max_userip_connections`, as `yarilo-submission-login` does for SMTP.

---

## Smoke check

```sh
smoketest -host mail.example.com -jmap -jmap-user u1@example.com -jmap-pass secret
```

The checks:

1. an anonymous request is refused with `401`;
2. an authenticated one returns a session resource carrying `capabilities`;
3. a batch of two `Core/echo` calls runs, the second reading the first's result
   through a back-reference;
4. a body one byte over `jmap_max_size_request` is refused by the login layer
   with a `limit` problem;
5. `Mailbox/get` returns a mailbox carrying the `inbox` role, with unique ids
   and every `parentId` naming a mailbox in the same response;
6. `Mailbox/query` filtered by `role:inbox` matches exactly one mailbox, says
   `canCalculateChanges: false`, and a back-referenced `Mailbox/get` in the same
   batch resolves to that mailbox;
7. `Email/query` finds an id, a back-referenced `Email/get` reads it, and the
   blob it names downloads as a non-empty `application/octet-stream`;
8. a download for another account's blob is refused with `404`;
9. a delivered message is found by a `text` condition and read back, and a
   marker that was never delivered finds nothing — the second half is what
   makes the first mean the condition was applied;
10. a round trip through a JMAP client library: a message is uploaded and
    imported, marked read, moved to a new mailbox and destroyed, and a second
    client sees each step in `Email/changes`.

Check 7 needs at least one message in the account. Check 9 needs `-fts-user`,
which states that full-text search is configured, and delivery flags —
`-delivery-host`, `-delivery-port`, `-delivery-proto`; see
[Testing](/operations/testing).

Check 4 sends `-jmap-max-size-request` + 1 bytes; pass the deployment's own
value if it differs from the 10M default.
