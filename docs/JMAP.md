# JMAP configuration

> **Status: in progress.** The session resource (RFC 8620 §2), the request
> envelope (§3) and the read-only `Mailbox` methods (RFC 8621 §2) are served
> end-to-end; the remaining data methods land in later phases.

JMAP runs as two binaries, not one. `yarilo-jmap-login` faces clients and
`yarilo-jmap` owns the user's state; see
[DEPLOYMENT.md](DEPLOYMENT.md) for the topology and the reasoning behind it.

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

| Key | Default | Description |
|:---|:---|:---|
| `jmap_base_url` | — | Public origin clients reach this deployment on. Prefixes every URL in the session resource, so it must be the externally visible name, not a pod address. |
| `jmap_max_concurrent_requests` | `10` | Simultaneous API calls per session. |
| `jmap_max_calls_in_request` | `16` | Method calls in one batch. |
| `jmap_max_objects_in_get` | `500` | Objects per `Foo/get`. |
| `jmap_max_objects_in_set` | `500` | Objects per `Foo/set`. |
| `jmap_max_size_upload` | `40M` | One blob upload. |
| `jmap_max_size_request` | `10M` | One API request body. |
| `jmap_max_body_value_bytes` | `256K` | Server ceiling on one returned `Email` body value. A smaller client `maxBodyValueBytes` wins; truncated values are marked `isTruncated`. |
| `jmap_query_max_limit` | `256` | Server ceiling on ids returned by one query. A smaller client `limit` wins; the response reports the limit applied. |
| `jmap_max_query_folders` | `64` | Mailboxes one full-text `Email/query` may search. A query over more is refused, never answered from part of them. |
| `jmap_snippet_max_chars` | `256` | Visible characters in a `SearchSnippet` preview. Markup and HTML escapes are not counted; the subject is never cut. |
| `jmap_push_timeout` | `90` | Idle timeout for a push connection, seconds. Unused until the push phase. |
| `jmap_cors_allow_origins` | `[]` | Browser origins allowed to call the endpoint. Empty denies every cross-origin request. Exact match, scheme included. |

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
    internalTLS:
      enabled: true
      secretName: yarilo-internal-tls

  jmapLogin:               # the client-facing proxy
    enabled: true
    backend_port: 10443    # the JMAP container's port, not the pod's
    director_addr: "yarilo-director:9090"
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

### Request limits

| Bound | Enforced by | Refusal |
|:---|:---|:---|
| `jmap_max_size_request` | `yarilo-jmap-login`, at the edge | `413` with a `limit` problem naming `maxSizeRequest` |
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

`Mailbox/get` and `Mailbox/query` are read-only and expose the **personal
namespace** only; shared and public namespaces arrive with the namespace phase.

| JMAP member | Source |
|:---|:---|
| `id` | the folder GUID from the index — stable across a rename, which the name is not |
| `name` | the leaf name; hierarchy travels in `parentId`, so a client never learns the delimiter |
| `role` | IMAP special-use, per-user overrides layered over `imap_special_use_defaults`; `INBOX` is `inbox` without carrying an attribute |
| `totalEmails` / `unreadEmails` | the folder's own counters, the same ones `STATUS` reports |
| `totalThreads` / `unreadThreads` | real conversation counts, from the account's threading state. Equal to the message counts on an account the [thread backfill](/MIGRATION#thread-backfill-conversations-for-existing-accounts) has not reached, where every message is still its own conversation |
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

`Email/get` is read-only. It answers by id — a null `ids` is refused, since it
would select every message the account has and no limit would bound the cost.

| JMAP member | Source |
|:---|:---|
| `id`, `blobId` | the message GUID — the same identity IMAP reports as `EMAILID` (RFC 8474), so one message is one object whichever protocol reaches it |
| `threadId` | the conversation the message belongs to — the id of its first message, so it survives the message being moved, expunged and redelivered, or migrated. On an account the [thread backfill](/MIGRATION#thread-backfill-conversations-for-existing-accounts) has not reached, a message is its own conversation and this is its own id |
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
[FTS](./FTS).
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

`GET /jmap/download/{accountId}/{blobId}/{name}` streams the message.

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

## Capabilities

| Capability | RFC | State |
|:---|:---|:---|
| Core — session | RFC 8620 §2 | served |
| Core — request envelope, back-references, `Core/echo` | RFC 8620 §3–§4 | served |
| Mail — `Mailbox/get`, `Mailbox/query` | RFC 8621 §2 | served, read-only |
| Mail — `Email/get` (envelope, bodies, preview) | RFC 8621 §4 | served, read-only |
| Mail — `Email/query` (index and full-text conditions), blob download | RFC 8621 §4.4, RFC 8620 §6.2 | served, read-only |
| Mail — `SearchSnippet/get` | RFC 8621 §5 | served |
| Mail — `Thread/get`, `Thread/changes` | RFC 8621 §3 | served from the account's threading state; a merge is reported in `Email/changes` as well, since a client groups by the `threadId` it holds |
| Mail — `Mailbox/set`, `Mailbox/changes` | RFC 8621 §2 | later phase |
| Mail — `Email/set`, `Mailbox/set` | RFC 8621 | later phase |
| Push over WebSocket | RFC 8887 | later phase |

The protocol layer lives in `pkg/jmapcore`, which imports nothing from yarilo
and is meant to be extracted as a standalone library.

---

## Smoke check

```sh
smoketest -host mail.example.com -jmap -jmap-user u1@example.com -jmap-pass secret
```

Four checks:

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
   makes the first mean the condition was applied.

Check 7 needs at least one message in the account. Check 9 needs `-fts-user`,
which states that full-text search is configured, and delivery flags —
`-delivery-host`, `-delivery-port`, `-delivery-proto`; see
[Testing](./TESTING).

Check 4 sends `-jmap-max-size-request` + 1 bytes; pass the deployment's own
value if it differs from the 10M default.
