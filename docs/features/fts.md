# Full-text search

Full-text search answers IMAP `SEARCH BODY`, `SEARCH TEXT` and `SEARCH HEADER`, and JMAP `Email/query` text filters, from a per-user index instead of reading every message.

## How it works

The `yarilo-fts` service owns the index: it is the only process that opens a user's index files, so each index has one writer. With the Helm chart's default it runs in the backend pod beside the sessions, which keeps a user's index on the same pod as the user's mail. The engine is `flatcurve`, built on Xapian.

Messages are indexed when they arrive. With `fts_autoindex` on, LMTP delivery and `APPEND` queue them at once; otherwise a search queues what is missing.

A search runs in these steps:

- Text criteria are looked up in the index. Flags, dates, sizes and other criteria are evaluated from the mail index, and the two results are intersected.
- When messages are not indexed yet and `fts_search_add_missing` allows it, they are queued first and the search waits for them, up to `fts_search_timeout`. If the index makes no progress for about two seconds, the search stops waiting.
- When the index cannot answer, IMAP falls back to reading the messages (`fts_search_read_fallback`, on by default). JMAP has no such fallback: a lagging index answers `serverUnavailable` and a failed lookup `serverFail`. See [JMAP](/protocols/jmap).
- With `fts_search_strict`, candidate messages are read again and checked against the RFC substring rule.

A message that cannot be read or parsed is skipped, and indexing carries on with the next one. The skip is logged at `WARN` with the folder and the UID, counted in `fts_index_skipped_total{reason}`, and the folder is marked for repair.

## Configuration

Set the options under `fts:`:

```yaml
fts:
  ## Master switch + explicit engine selection. fts_engine is REQUIRED when
  ## enabled: there is no implicit default — startup fails fast on a missing
  ## or unknown engine name, so the active engine is always stated in config.
  enabled: false
  fts_engine: ""                    # required when enabled: "flatcurve"

  ## Where the service runs.
  fts_mode: remote                  # remote (k8s) | embedded (tests/CLI)
  fts_addr: ""                      # e.g. "yarilo-fts:9106"; the chart's default is localhost (co-located)
  fts_listen: ":9106"               # yarilo-fts: where it serves
  fts_auth_master_addr: ""          # yarilo-fts: userdb of the user being indexed (storage identity)
  fts_max_conns: 4                  # connections per session process — see below
  fts_storage_type: local           # local | nfs — what the index sits on; nfs skips directory fsyncs
  fts_handle_idle_timeout: 300      # an idle per-user index handle is closed, releasing its write lock; 0 never closes one

  ## Indexing behaviour.
  fts_autoindex: false
  fts_autoindex_max_recent_msgs: 0
  fts_message_max_size: 0           # 0 = unlimited
  fts_header_includes: []
  fts_header_excludes: []
  fts_commit_limit: 500             # batch size, any engine

  ## Search behaviour.
  fts_search_add_missing: body-search-only
  fts_search_read_fallback: true    # IMAP reads the messages when the index cannot answer
  fts_search_timeout: 30            # seconds — an integer; "30s" fails to load
  fts_search_first_index_grace: 10  # seconds to wait for a mailbox with nothing indexed yet
  fts_search_strict: false          # RFC substring verification of candidates
  fts_search: true                  # false = SEARCH-only degrade, indexing keeps running

  ## Language chain.
  language_filters: [lowercase, stopwords, snowball]   # default ON
  fts_flatcurve_prefix_search: "yes"   # yes | no | N | N-M — see below
  languages: [en]                   # >1 enables per-part detection
  fts_language_filters_override: {} # per-language override, e.g. {uk: [lowercase, stopwords]}
  fts_detection_sample_bytes: "1k"  # bytes sampled per part; 0 is refused
  fts_detection_min_runes: 10       # reliability threshold; 0 detects on any sample
  language_tokenizer_generic_token_maxlen: 30   # must be positive
  language_tokenizer_address_token_maxlen: 250  # must be positive
  language_tokenizer_generic_algorithm: simple # tr29 is not implemented and fails at startup
  language_tokenizer_generic_wb5a: false        # TR29-only, errors if true
  language_tokenizer_generic_explicit_prefix: false # TR29-only, errors if true

  ## Attachment decoders.
  fts_decoder_driver: none          # none | script | tika
  fts_decoder_script_addr: ""       # unix:///path/to.sock, or host:port for a decoder Service
  fts_decoder_tika_url: ""
  fts_decoder_max_size: ""          # attachment bytes sent to the decoder per part; empty/0 = unlimited
  fts_decoder_timeout_secs: 30      # one decode call; must be positive
  fts_decoder_max_attempts: 2       # tika attempts against network/5xx; must be positive
  fts_dedup_body_parts: false       # skip a part whose text was already indexed for the same message

  ## Engine-specific: flatcurve (fts_engine: "flatcurve"; the yarilo-fts
  ## binary links libxapian — cgo confined to the fts Deployment image).
  fts_flatcurve_commit_limit: 500
  fts_flatcurve_min_term_size: 2
  fts_flatcurve_optimize_limit: 10  # auto-queues a mailbox at this shard count; 0 disables
  fts_flatcurve_rotate_count: 5000
  fts_flatcurve_rotate_time: 5000  # ms; also rotates on a slow commit; 0 disables
  fts_flatcurve_substring_search: false
```

Helm: by default (`components.backend.coLocated: true`) `yarilo-fts` runs in
the backend pod beside the sessions, and `fts_addr` is `localhost:<port>`, so a
user's sticky pod is the only writer of their index. Only without co-location
does the chart render a separate `<release>-fts` Deployment and Service.

### The index queue

The queue holds **at most one pending pass per mailbox**. A mailbox is the unit
of work, not a request: a pass reads the checkpoint and indexes everything above
it, so two passes over one mailbox do the same work twice — and the second finds
that out only after taking the lock. Under delivery load those duplicates are
what turn a busy mailbox into a stream of contention, which is why coalescing is
a correctness property here rather than an optimisation.

Merging keeps the widest range: the pass covers the highest UID any request
asked for, and the strictest `max_recent` bound. A priority request (a search
catch-up) for a mailbox already queued **moves** it to the front instead of
adding a second entry.

A request that arrives while its mailbox is being indexed is not dropped: the
running pass read its checkpoint before that request existed and will not cover
it, so the mailbox is re-queued when the pass finishes. Every popped mailbox is
released through the same path whatever happens to the pass — including a panic
— because a mailbox left claimed would never be queued again, and its mail would
stay unindexed with nothing in the log to say so.

### Reading ahead

An index pass can read messages ahead of the one it is tokenising, so storage
reads overlap with parsing. **It is off by default**, and that is a measurement
rather than caution:

```
fts_build_seconds  115.5 ms/message
fts_read_seconds     0.34 ms/message   ← 0.3% of a pass
```

Tokenising and base64 decoding dominate; the disk barely appears. Overlapping
reads with parsing therefore recovers almost nothing, while the read-ahead
window holds messages in memory once per worker.

Raise it where reads are genuinely slow — cold alt-tier storage, or an NFS mount
whose cache is not warm. `fts_read_seconds` against `fts_build_seconds` is what
says whether that is your deployment; do not raise it on the assumption that it
must help.

When enabled, four properties hold:

**Advisory.** A depth below two reads one message at a time — the same code
path, not a second one.

**Order is mandatory.** Indexing walks UIDs upwards and the checkpoint advances
monotonically, so a pipeline that reordered would record progress past messages
it never indexed. One producer feeding one channel makes that impossible rather
than unlikely.

**A read failure stays attached to its message**, so a pass skips a message it
can name instead of halting on one it cannot.

**Two ceilings.** Depth bounds messages, `fts_prefetch_max_bytes` bounds what
they hold — and the byte ceiling is per pass, so N workers can hold N windows. A
message larger than the whole ceiling is admitted alone: refusing to index it
would be worse than briefly exceeding a bound whose purpose is limiting
concurrency.

### Parallel indexing

`fts_index_workers` is how many mailboxes are indexed at once. What it can and
cannot buy follows from the engine: `userIndex` holds **one mutex per user**,
taken by every write. Two workers on two mailboxes of the same user therefore
serialise inside the engine — they would occupy two workers to do one user's
work while other users wait.

So dispatch hands each worker a **different user**: a worker takes the
highest-priority mailbox whose user is not already being indexed, and skips the
rest. Nothing is lost — a skipped mailbox is dispatched as soon as its user is
released — and one user with many mailboxes cannot occupy every worker.

A consequence worth recognising before it is diagnosed as a stall: workers can
sit idle while the queue is deep, because everything queued belongs to users
already running. `fts_pop_skipped_total` tells those two apart, and
`rate(fts_worker_busy_seconds_total[5m])` shows how much of the worker budget is
actually in use.

That is a counter rather than a gauge on purpose. A pass takes tens of
milliseconds and a scrape happens every 15-30 seconds, so a gauge of "workers
busy now" is sampled between passes almost every time: it reads zero whether the
service is saturated or idle. A metric that cannot answer the question it was
added for is worse than none, because the question then looks answered.

The useful lever is not this number. Indexing is CPU-bound — `fts_build_seconds`
is almost all of a pass — so worker count is bounded by the CPU the container is
given, and `components.fts.resources.limits.cpu` defaults to `1`. A second
worker under a one-CPU limit adds scheduling and a second prefetch window, not
throughput. Raise the CPU limit and the worker count together, or add pods.

### Locking

An index pass takes a lock keyed `fts:<user>:<folder>`, not the mailbox lock.
The two are different resources with different writers: the mail index is
written by every session, the full-text index only by `yarilo-fts`. The lock
exists solely so two full-text passes over one mailbox — after a ring move, for
instance — cannot race the checkpoint's read-modify-write.

Sharing the mailbox key made every pass queue behind unrelated session writes.
Under load that was not theoretical: the lock is taken without waiting, so a
busy mailbox meant an immediate failure, and the pass was dropped rather than
retried. The mail-index reads a pass needs (`OpenFolder`,
`GetMessages`, the present-UID snapshot) deliberately happen **outside** the
lock, so nothing was relying on the wider scope.

A pass that still loses its lock — genuine contention between two full-text
writers — is requeued with a bounded backoff rather than dropped, and counted
in `fts_index_deferred_total`. A pass abandoned after exhausting its retries
increments `fts_index_dropped_total`, which is expected to stay at zero: every
increment is mail that is not in the index and will not be until something else
queues that mailbox.

### Telemetry

| Metric | Answers |
|:---|:---|
| `fts_index_lag_uids` | how much mail is not in the index — the largest gap between a mailbox's highest UID and its checkpoint |
| `fts_index_lag_seconds` | how old the oldest unindexed message is |
| `fts_index_queue_depth` | mailboxes waiting for a pass |
| `fts_queue_wait_seconds` | how long they waited — separates "deep queue" from "deep queue that is not draining" |
| `fts_queue_merged_total` | requests folded into a queued pass: duplicate work, and duplicate lock contention, that did not happen |
| `fts_queue_requeued_total` | mailboxes put back because a request arrived mid-pass |
| `fts_fetch_seconds` | opening a message — **not** reading it |
| `fts_read_seconds` | time actually blocked reading a message's bytes |
| `fts_build_seconds` | the whole of indexing one message |
| `fts_build_stage_seconds{stage}` | where that time went: `parse`, `decode`, `tokenize`, `write` |
| `fts_prefetch_inflight_bytes` | bytes read ahead and not yet indexed |
| `fts_prefetch_stall_seconds` | the reader waiting for window space — growth means the ceiling is the bottleneck, not the disk |
| `fts_message_bytes` | the size those two are relative to; 200ms on 30MB and on 3KB are different diagnoses |
| `fts_index_deferred_total` | passes requeued after losing the lock |
| `fts_index_dropped_total` | passes given up on. **Expected zero** |
| `fts_worker_busy_seconds_total` | total time workers spent inside passes; `rate()` divided by `fts_index_workers` is utilisation |
| `fts_pop_skipped_total` | mailboxes passed over because their user was already being indexed — this is what separates "idle because there is no work" from "idle because the work belongs to busy users" |

`fts_fetch_seconds` timed only the open for a long time while the body streamed
into the tokeniser, so every byte of storage I/O was being counted as parsing —
which made the read share look like 7% of a pass when the real figure was
unknown. `fts_read_seconds` is what settles that.

`fts_build_seconds` answers "is indexing CPU-bound" — it is, overwhelmingly.
`fts_build_stage_seconds` answers the next question, which is what the CPU is
doing:

- `parse` — reading the MIME structure;
- `decode` — extracting text from attachments, including anything handed to an
  external decoder;
- `write` — feeding terms to the engine;
- `tokenize` — the remainder.

Those first three are timed directly. Tokenising is **derived**: reading a text
part is interleaved with tokenising it, because the reader feeds the tokeniser
through a callback, and separating them would require every layer to subtract
its children. So `tokenize` is the pass time that is not parsing, decoding or
writing — accurate as a share, not as an isolated measurement, and named here
rather than left to look measured.

The split matters because the fixes differ. Decoding an attachment that yields
no useful terms and tokenising a body cost the same in the total, and one is a
question about `fts_message_max_size` and the decoder settings — what is worth
indexing at all — while the other is a question about the tokeniser.

The two lag gauges are the ones a user feels: "search does not find recent
mail". Everything else is a proxy for them.

They carry no per-user or per-mailbox labels — a few hundred users times their
folders would put that cardinality into Prometheus. The per-mailbox detail is
kept in process and only the worst case is published, sampled every 30 seconds;
for a specific user, use the logs.

### Connections to the service

How many connections a session process keeps to `yarilo-fts`. It matters more
than the name suggests: **one connection serialises request and response
pairs**, so a caller that issues several lookups at once gets them queued, not
run in parallel. Until this is above one, a search fanning out over several
folders is sequential however the caller is written.

The service has always handled each connection on its own goroutine — the
client side was the bottleneck. Connections open on demand, so a pool of four
costs nothing until four calls actually overlap.

A caller that finds every connection busy waits up to the dial timeout and then
gets a distinct "no free connection" error, so an operator can tell "the service
is busy" from "the service failed". Setting it to `1` reproduces the previous
single-connection behaviour exactly.

### Migrating a configuration

Config keys are named to track the reference's own `fts_flatcurve_*` /
`fts_*` naming closely, but a few values and shapes need translation, not a
literal copy:

- **`fts_message_max_size`**: yarilo's `0` means unlimited. The reference
  rejects a literal `0` at startup and spells "no limit" as the keyword
  `unlimited` — copying a numeric `0` across from a reference config that
  actually meant "reject anything over 0 bytes" (not the common case, but
  possible) would silently flip its meaning; copying the reference's
  `unlimited` keyword across as literal text would fail to parse here.
  Translate `unlimited` → `0`, and any other reference value across as
  the same byte count.
- **Time values**: the reference uses TIME strings (`"30s"`, `"5s"`, …).
  yarilo uses bare integers with the unit fixed in the key name —
  `fts_search_timeout` (seconds), `fts_flatcurve_rotate_time`
  (milliseconds). Strip the unit suffix and convert if the reference value
  used a different unit than the yarilo key expects (e.g. reference
  `"5s"` → yarilo `fts_flatcurve_rotate_time: 5000`, not `5`).
- **`fts_decoder_driver`**: yarilo's "disabled" value is the literal string
  `none`; the reference uses an empty string. An empty string here is
  also accepted as "disabled" (see `decoder.New`), so this is forgiving,
  but `none` is the canonical yarilo spelling going forward.
- **`fts_decoder_script_addr`**: a superset of the reference's plain
  socket-path value — accepts `unix:///path/to.sock` (a bare reference
  socket path becomes `unix://` + that same path) or `host:port` for a
  standalone Deployment/Service the reference has no equivalent topology
  for.

### Differences from the reference

Deliberate differences from the reference, kept because the tradeoff was
evaluated and accepted — not gaps to close silently:

- **Subject is indexed via the no-stemming data chain**, unlike the
  reference, which stems Subject/Comments/Keywords like body text.
  Prefix-wildcard search (flatcurve's own `Xapian::Query(OP_WILDCARD, ...)`
  shape, unconditional on every term) compensates when the query word's
  stem happens to be a PREFIX of the indexed unstemmed word (e.g. English
  `run` as a prefix of indexed `running`) — but not when a language's
  stemming rule doesn't produce a prefix relationship (e.g. Russian
  `бежать`/`бегу` share no common prefix with their stem; German
  compounding can move the stem to the middle of the surface form). A
  Subject search in those languages may miss an inflected form the
  reference's stemmed index would have caught.
- **No ICU normalizer yet**: no diacritics folding, so `café` does not
  match a search for `cafe`.
- **Mid-token `*` tokenizes differently**: the reference treats `*` as a token-continuation
  character in its generic tokenizer (not a break), so `foo*bar` is one
  token there; yarilo's tokenizer treats `*` as a break character, so
  `foo*bar` becomes two tokens (`foo`, `bar`). No practical recall impact
  — if anything, treating `*` as a break is the softer behavior (it can
  only ever match MORE, never fewer, real-world messages containing a
  literal asterisk mid-word) — kept as a known, accepted divergence rather
  than fixed, since replicating it exactly would need `*` to stop being a
  break character everywhere, which has its own tokenization
  consequences elsewhere in the break table.
- **RELEVANCY excludes score-less UIDs from normalization** (`internal/imap/fts.go`'s
  `relevancyScores`): a UID matched by a stripped non-FTS criterion but
  absent from the engine's own score map is floored at `1`, not folded
  into the min-max range via an implicit `0.0` the way the reference's
  plain map lookup would — that implicit zero would otherwise drag the
  whole result set's low end down and compress every genuine score toward
  100. An improvement over the reference's own behavior, not a gap.
- **Rescan does targeted deletes against the exact missing-UID list**
  (`internal/fts/flatcurve/engine.go`'s `Rescan`), rather than the
  reference's delete-everything-above-the-lowest-missing-UID reindex
  storm. An operator comparing behaviour with the reference should not
  read it as a fault.

---

## Prefix search

`fts_flatcurve_prefix_search` decides which search terms are expanded as
prefixes: `yes`, `no`, `N` (terms of at least N characters) or `N-M`. Lengths
count characters, not bytes, so the rule is the same in every script.

A prefix search asks the index for every term beginning with what was typed —
which is what makes `corp` find `corporate`, and what makes `co` name a large
part of the index. Measured against a vocabulary of 2000 words sharing prefixes:

| term length | expanded | exact | |
|---:|---:|---:|---:|
| 2 | 1 179 µs | 45 µs | **26×** |
| 4 | 1 181 µs | 45 µs | **26×** |
| 6 | 98 µs | 45 µs | 2.2× |
| 8 | 48 µs | 51 µs | — |

**The default expands every term**, which is what the engine did before the
setting existed, and it is *unmeasured as a default*. The measurement above
establishes the shape and not a threshold: what a prefix costs depends on how
many terms it matches, and length is only a proxy for that. In a vocabulary
where four characters name everything, a minimum of four saves nothing. Measure
against a real index before narrowing it.

`fts_flatcurve_substring_search` stores suffixes at index time, and a stored
suffix is only reachable by expanding the query — so `no` disables substring
search in effect. That combination is corrected at startup with a log line
rather than served as an index nothing can query.

An unparseable value also expands everything, and says so. A search engine that
narrows its own matching on a typo would be reported as missing mail.

## Term length is counted in characters

`fts_flatcurve_min_term_size` (the indexing gate) and
`fts_flatcurve_prefix_search` (the query gate) both count characters.

Counted in bytes, one setting would be a different rule per script:

| term | characters | bytes | dropped at `min_term_size: 2`, counting bytes |
|:---|---:|---:|:---|
| `a` | 1 | 1 | yes |
| `я` | 1 | 2 | **no** |
| `日` | 1 | 3 | **no** |

Single Cyrillic and CJK characters would be indexed while single Latin ones
were not, and a higher setting would widen the gap. Counting characters makes
the default of `2` the same rule in every script.

Indexes built by older versions counted bytes. They keep the single-character
non-Latin terms they already carry until the mailbox is re-indexed, as with any
change to what is indexed.

The byte bound on term *length* (`maxTermBytes`) is unaffected and stays in
bytes, deliberately: it is about how much room a term takes on disk, not about
whether it is worth having.

## Excluding mailboxes from autoindexing

`fts_autoindex_exclude` lists mailboxes autoindexing skips. Each entry is either
a special-use flag written with its backslash, or a name with `*` and `?`
wildcards:

```yaml
fts_autoindex_exclude: ["\\Junk", "\\Trash", ".EXPUNGED", ".EXPUNGED/*"]
```

Junk and trash are why it exists. They take high volumes of large,
attachment-heavy mail, they are almost never searched, and indexing cost is
dominated by tokenisation — so keeping them current spends the most expensive
part of the pipeline on content nobody queries.

**It applies to autoindexing and nothing else.** An explicit rescan indexes the
mailbox, and so does the catch-up a search triggers, so an excluded folder is
*un-pre-indexed* rather than unsearchable. That distinction is the point: an
exclusion that made a mailbox unfindable would be a different feature with a
different name.

**`*` does not cross the hierarchy separator** — the one the deployment
configures, not always `/`. Write patterns in the separator your namespace uses:
with `separator: "."`, `EXPUNGED.*` names the children and `EXPUNGED` names the
folder itself, so list both when both are meant.

The separator is taken from the personal namespace, deployment-wide. A namespace
configured with a different delimiter is matched by the personal one's, which is
a limitation of resolving it once rather than per user — the same trade the
special-use lookup makes below, for the same reason.

**A malformed pattern is dropped with a log line at startup.** One that cannot
be parsed matches nothing, and a pattern matching nothing is indistinguishable
from one nobody wrote; the rest of the list keeps working, so a single typo does
not disable every exclusion configured.

**A flag resolves against `imap_special_use_defaults`, not the per-user
special-use file.** Reading the per-user file takes the cross-process lock, and
the autoindex hook runs on every delivery — a network round trip to decide
something that changes once in a mailbox's life. A user who applied `\Junk` to a
folder of their own naming is therefore not covered by the flag form; a name
pattern is the fallback.

**`fts_autoindex_skipped_total`** counts what the setting refuses. Without it an
over-broad pattern looks exactly like an index that has quietly stopped being
written, which is the failure mode of every silent filter.

## Skipping folders nobody reads

`fts_autoindex_max_recent_msgs` skips autoindexing for a folder holding more recent messages than the limit. `0`, the default, sets no limit.

Recent is counted as IMAP counts it: messages no session has selected since they arrived. See [Recent messages](/protocols/imap#recent-messages). A folder that keeps receiving mail nobody opens, such as a spam trap or an archive of a mailing list, grows past the limit and stops costing tokenisation. Once a client selects it, the count drops, and the next delivery indexes everything the folder holds.

Like the exclusion list, the limit applies to autoindexing only. A rescan, and the catch-up a search triggers, index the folder whatever its count. When a search catch-up and an autoindex request for the same folder are queued together, the folder is indexed.

`fts_autoindex_skipped_recent_total` counts the passes the limit skips.

## Where the index lives

`fts_index_root` is a location template, expanded per user with `~/`, `%h`,
`%u`, `%n` and `%d` like every other storage location. Empty keeps FTS data
inside the mail index tree, which is where it has always gone.

```yaml
fts_index_root: "/srv/fts/%d/%n"
```

It exists because the two kinds of data have different requirements and there
was no way to say so. **FTS data is derived** — it can be deleted and rebuilt,
and mail cannot — and it is **write-heavy**, index writes being about a third of
the pipeline. Placing them on different volumes is a legitimate deployment shape
that could not previously be described.

**A template naming no user is refused at startup.** The per-folder subpath
below the root separates mailboxes, not accounts, so `/srv/fts` would put two
people's INBOX index at one path. That is not over-indexing, which heals on the
next pass; it is two accounts writing the same files.

**Changing it moves nothing.** The old data stays where it was and the index
rebuilds at the new location on demand — which is safe precisely because the
data is derived, and is also why the old `fts-flatcurve` directories have to be
removed by hand if the space matters.
