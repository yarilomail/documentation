# Director configuration

`yarilo-director` keeps the routing state of a cluster: which backend serves each user. Login pods ask it with a `LOOKUP` before they open a session to a backend.

The director does not accept client connections. TLS, the PROXY protocol, XCLIENT and authentication all happen in the login pods; see [General settings](./GENERAL) and [Deployment](./DEPLOYMENT).

## How it works

A session reaches its backend in these steps:

```
mail client
    │  IMAP / POP3 / Submission / ManageSieve / LMTP / JMAP
    ▼
login pod (imap-login, pop3-login, …)
    │  1. TLS, PROXY header, authentication
    │  2. LOOKUP <user> <tag>  ──────────►  yarilo-director
    │                          ◄──────────  backend ip:port
    │  3. dial the backend pod IP directly, send the preamble
    ▼
backend pod (yarilo-imap, yarilo-pop3, …)
```

- The director answers from a consistent-hash ring of backends, weighted by `vhosts`, plus the sticky assignments it has already made.
- Backends join the ring either from the static `mail_servers` list or by registering themselves with a heartbeat.
- With more than one replica, the directors form a ring of their own to share membership, the backend set and sticky assignments. See [Ring formation](#ring-formation-design-history).

## Listening ports

The director listens on three ports:

| Key | Default | Used by |
|:---|:---|:---|
| `director_service.listen` | `:9102` | Login pods (`LOOKUP`) and other directors (ring protocol). |
| `director_service.api.listen` | `:9103` | The admin API; see [Director API](./DIRECTOR-API). |
| `telemetry.listen` | `:8080` (chart) | Prometheus metrics. |

Login pods reach the director through the ClusterIP `<release>-director` Service, set as each login component's `director_addr`. The headless `<release>-director-ring` Service is for the ring only.

## `director_service`

These keys are the routing and lifecycle core. Ring, eviction and placement keys are described in the sections below.

| Key | Default | Description |
|:---|:---|:---|
| `listen` | `":9102"` | Address for `LOOKUP` and the ring protocol. |
| `user_expire` | `900` | Seconds before an idle user→backend assignment expires. Each `LOOKUP` refreshes it. |
| `ping_interval` | `30` | Seconds between keepalive pings to login pods and ring peers. |
| `ping_timeout` | `10` | Seconds to wait for a `PONG` before closing the connection. |
| `write_timeout` | `10` | Seconds a single push or reply write may take. `0` selects the default, a negative value disables the bound. |
| `shutdown.session_grace_period` | `30` | Seconds to wait after `SIGTERM` before exiting. |
| `peers` | `[]` | Seed list for a one-time ring join. Empty at `replicas > 1` derives the headless `-director-ring` Service. |
| `backend_expire` | `30` | Seconds a self-registered backend may go without a heartbeat before it leaves the ring. |
| `backend_unreachable_reporters` | `2` | Distinct login pods that must report a backend unreachable before it is evicted early. |
| `backend_unreachable_window` | `5` | Seconds within which those reports must arrive. |
| `join_allowed_nets` | `[]` | CIDRs a ring join is accepted from. Empty allows all. |

The chart also renders `shutdown.kill_timeout`, but the director does not read it.

Backend eviction:

- A static backend from `mail_servers`, or one added through the admin API, never heartbeats and never expires.
- The last backend of a tag is never evicted, by either the lease or the reports; the director logs it instead.
- A single-replica login fleet cannot produce two distinct reports, so set `backend_unreachable_reporters: 1` there. The lease stays the backstop.

## `director_service.mail_servers`

This is the static backend list loaded at startup. Each `host` resolves to one or more pod IPs through DNS; a headless Service returns one A record per pod, and every IP joins the ring.

| Key | Description |
|:---|:---|
| `host` | Hostname, typically a headless Service such as `yarilo-imap.yarilo-backend.svc.cluster.local`. |
| `port` | Backend port the login pod dials. |
| `tag` | Pool label. Empty is the default pool. |
| `vhosts` | Ring weight, `1`–`100`. Omit for the default. Under `assignment_policy: least_sessions`, `0` means drain. |

Configure two static backends:

```yaml
director_service:
  mail_servers:
    - host: yarilo-imap.yarilo-backend.svc.cluster.local
      port: 993
      tag: ""
    - host: yarilo-lmtp.yarilo-backend.svc.cluster.local
      port: 24
      tag: ""
```

## mTLS

With `internal_tls.enabled: true`, the `director_service.listen` port requires a client certificate from everyone who connects: login pods sending `LOOKUP` and other directors on the ring.

Ring peers are dialled by pod IP, so the dial verifies a fixed server name, `ring_tls_server_name`, which defaults to `<release>-director-ring`. That name must be a SAN in the director's certificate.

The shared internal-tls Secret has no such SAN. Let the chart issue a director-specific certificate with `components.director.internalTLS.certificate.enabled: true`, or provide your own Secret in `components.director.internalTLS.secretName`.

::: warning
With internal TLS on and no ring name in the certificate, peers cannot verify each other and the ring never converges. The director logs an error when this happens.
:::

## Helm values

All director settings live under `components.director` in `helm/values.yaml`. The keys are the config keys in snake_case:

| Helm value | Config key |
|:---|:---|
| `components.director.directorPort` | `director_service.listen` |
| `components.director.api.port` | `director_service.api.listen` |
| `components.director.api.allowed_nets` | `director_service.api.allowed_nets` |
| `components.director.backends[]` | `director_service.mail_servers[]` |
| `components.director.peers` | `director_service.peers` |
| `components.director.internalTLS.ringTlsServerName` | `director_service.ring_tls_server_name` |
| `components.director.<key>` | `director_service.<key>`, for every other key on this page |

`shutdown.session_grace_period` and `shutdown.kill_timeout` are fixed in the chart at `30` and `5` and have no Helm value.

Run three replicas with one static backend:

```yaml
components:
  director:
    enabled: true
    replicas: 3
    backends:
      - host: yarilo-imap.yarilo-backend.svc.cluster.local
        port: 993
        tag: ""
```

This setup:

- seeds the ring from the headless `-director-ring` Service, since `peers` is empty;
- generates the ring secret and the API token into Secrets;
- leaves client listeners to the login components, each pointing `director_addr` at the `-director` Service.

## Placement and kick pacing

These keys are described in [Deployment](./DEPLOYMENT):

| Key | Default | Description |
|:---|:---|:---|
| `assignment_policy` | `hash` | How a new user gets a backend: `hash`, `least_sessions` or `domain`. See [placement policy](./DEPLOYMENT#initial-placement-policy-—-director-service-assignment-policy-797). |
| `director_domain_expire` | `900` | Seconds a domain keeps its backend with no session on it, under `domain`. |
| `director_domain_rebalance_percent` | `0` (chart: `20`) | How far the busiest backend of a tag may rise above the quietest before one domain moves. `0` never moves one. |
| `director_domain_rebalance_interval` | `60` | Seconds between rebalance checks. |
| `director_domain_rebalance_cooldown` | `600` | Seconds a moved domain is left alone. |
| `user_kick_delay` | `2` | Seconds an admin-initiated kick waits. See [kick pacing](./DEPLOYMENT#kick-pacing-—-user-kick-delay-and-max-parallel-kicks-740). |
| `max_parallel_kicks` | `100` | Sessions kicked per batch when a backend goes down. |

## Session routing & sticky assignments

Every login proxy (imap/pop3/submission/managesieve/lmtp) routes sessions one of two ways: `backend_addr` (standalone, a fixed backend) or `director_addr` (director mode, per-session `LOOKUP` via yarilo-director) — at least one is required, and `backend_addr` wins when both are set (#735, unified across all five components including lmtp-login in #741). `backend_port` overrides the port a director `LOOKUP` returns when it differs from the backend's protocol-specific containerPort.

**Migration note (#741):** lmtp-login previously had the *opposite* precedence — `director_addr` won when both were set. If your `lmtpLogin` Helm values set both `backend_addr` and `director_addr`, the login pod now logs a startup warning and silently switches from director routing to the static backend. Remove `backend_addr` from `lmtpLogin` values to keep director routing.

`director_service.username_hash_lowercase` (default `true`, Helm: `components.director.username_hash_lowercase`) lowercases usernames before they're hashed for ring routing or used as keys for sticky assignments and admin (`USER-MOVE`) overrides (#738) — without it, two spellings of the same account (`User@d.test` / `user@d.test`) can hash to different values and land on different backends, defeating sticky routing. Migration note: enabling this on an already-running cluster changes hashes for mixed-case usernames — their existing sticky entries just expire naturally via `user_expire`, no special migration step is needed.

> **Sharing mailboxes between users of a domain?** Set
> `assignment_policy: domain` (#1943): a domain is placed on the backend with
> the fewest connections and every user of it follows, with no hash template to
> get right. The older pairing below still works and stays supported.
>
> **The older pairing:** set `username_hash: "%Ld"`
> **and** `assignment_policy: hash`. The default hashes the whole address, so
> users of one domain land on different backends — harmless where those
> backends share one PV, fatal where each has its own storage. And
> `least_sessions` never reads the username at all, so it silently defeats the
> hash template. See [Owner/shared namespaces](/OWNER_SHARED_NS#routing-within-a-farm-users-who-share-must-land-on-one-backend).

`director_service.username_hash` (default `""`, Helm: `components.director.username_hash`) is the username→hash-key template (#850), which uses the reference's username-hash expression syntax, so an existing template migrates **verbatim** — `%Lu` stays `%Lu`. Supported variables: `%u` (whole username), `%n` (local part, before the first `@`), `%d` (domain, after the first `@`), each with an optional `%L` lowercase modifier, plus `%%` for a literal percent. This is a real routing lever, not just config parity: `%Ld` hashes on the **domain only** so a whole domain (and its shared mailboxes/ACLs) lands on one backend, and `%Ln` hashes on the local part only for alias-domain installs. A domain-less username follows the reference semantics — `%n` is the whole username, `%d` is empty (so a `%d` template routes every domain-less account to one backend). When `username_hash` is set it — not `username_hash_lowercase` — governs case-folding (the ingress no longer pre-lowercases, so `%u` is truly case-sensitive), and the `USER-KICKED` payload keeps the session's original-case username so login-side kick matching (#701) still lands. An empty value derives the template from `username_hash_lowercase` (`%Lu` / `%u`) for byte-identical back-compat with pre-#850 clusters. An invalid template aborts director startup. (yarilo's uint32 fold is little-endian since #738 — deliberately not byte-compatible with the reference's ring, a scenario our architecture never produces; we borrow the routing semantics, not the byte layout.)

**`%d` domain-hash — read before you use it.** The hash is applied **within a tag**, not globally: every `LOOKUP` carries a per-user tag (#737, tag = NFS shard) and the ring is tag-scoped (`LookupBackendByTag`), exactly like the reference's per-tag lookup. So a `%Ld` template routes a domain to **one backend per tag** — if the domain's mailboxes are spread across tags (the tag is assigned per user by userdb, independent of the hash), those users land on different tag rings and different backends; `%d` does **not** collapse a multi-tag domain onto a single host. The failure mode to avoid is putting one large domain entirely in **one** tag: there `%Ld` pins the whole domain to a single backend with **no load rebalancing** (yarilo, like the reference, distributes only by consistent hashing + vhost capacity weighting; it never auto-spreads a hot key). The cure is spreading the domain across tags via userdb, not changing the hash. Use `%Ld` only when a domain's shared mailboxes/ACLs genuinely must be storage-local within a tag.

**Backend evacuation — graceful vs force (#849).** `yarctl director backends flush <ip|all>` drains a backend. By default the drain is **graceful and throttled**: the host is taken out of the ring and its users are migrated in a self-clocked window of at most `director_service.max_parallel_moves` (default `5`, Helm: `components.director.max_parallel_moves`) confirmed-kills — each user's old sessions must confirm gone before the next user is pulled in, so a planned drain (rolling upgrade, maintenance) spreads the re-login across the surviving pods instead of stampeding them all at once. `--force` restores the pre-#849 behaviour (kick every session immediately); `--max-parallel N` overrides the window for one run. Re-login is deterministic without a proactive pin move: the evacuating host is already excluded from the ring, so a kicked user's re-`LOOKUP` rehashes to the same surviving backend it would have been moved to, and the confirmed-kill hold (#847) makes that re-`LOOKUP` wait until the old session is gone (no split-writer window). The drain is orchestrated by the single director that receives the request; if that director is lost mid-drain the operator re-runs `flush` (drain-state is not replicated across directors — matching the reference, where the originating director drives the drain). Matches the reference's forced-flush and max-parallel drain behaviour.

**Per-user flush hook (#848).** `director_service.flush_program` (default `""` = disabled, Helm: `components.director.flush_program`) is an optional external executable run once per user **after** a deliberate relocation — an admin `USER-MOVE` or a graceful evacuation — has been confirmed ring-wide, i.e. after that user's old sessions are gone. Operators hook mailbox-cache flush, external session cleanup, metrics, etc. It is called as `flush_program FLUSH <username> <username_hash> <old_backend> <new_backend>` (`new_backend` is empty when the user was kicked with no surviving backend to land on). It is **best-effort and asynchronous** with a bounded timeout: a slow or failing hook is logged and never blocks the ring/`LOOKUP` path or fails the move (the routing change already committed). The bound is `director_service.flush_program_timeout` (seconds, default `10`, Helm: `components.director.flush_program_timeout`); `0` selects the default rather than disabling the bound. Raise it for a hook that legitimately takes longer — and note what best-effort means for diagnosing one: a run that exceeds the bound is killed, and the only trace is a `WARN` on the director (`flush hook failed (best-effort, move already committed)` with `err="signal: killed"`). Nothing surfaces on the hook's own side, so a script that always overruns simply never completes, silently, until someone reads the director's log. Only the director that **originated** the move runs it — mass/reactive paths (`backend-down` auto-kick, `--force` flush) deliberately do not trigger it, and a move that creates a fresh pin with no prior host is skipped. The hook runs at the same point as the reference's flush hook, after the ring-wide `USER-KILLED-EVERYWHERE`; the program runs in the director pod's context, `exec.Command` only (no fork). A unix-socket hook variant is a possible future follow-up. An **offline** user — one with no active sessions when the move starts — confirms after `user_kill_confirm_grace` (~1s) instead of waiting out `user_kill_timeout`, so the hook fires promptly for the common admin case of moving a user who isn't currently connected (#870); a user with live sessions still confirms only once those sessions have drained.

### Tag sharding models

Every director `LOOKUP` carries a mandatory tag field — there is no full-ring mode (#737): `""` selects the untagged backend pool, not "any tag." Two sharding models are supported:

- **Static (dedicated login fleet per tag pool).** Each login component's `director_tag` (Helm: `components.<login>.director_tag`, e.g. `components.imapLogin.director_tag`) restricts that component's lookups to one tag-pool — set this when running a dedicated login Deployment per tag pool, per `docs/DEPLOYMENT.md`'s tag-based sharding model. In a deployment with no tags configured at all, every backend is untagged, so the default `director_tag: ""` behaves exactly like the old (buggy) full-ring lookup — untagged/standalone deployments see no behavior change.
- **Shared (per-user tag from passdb/userdb, #746).** One login fleet serving users of every tag-pool: a `director_tag` extra field on the passdb or userdb response (SQL: an ordinary column in `passdb_sql_query`/`userdb_sql_query`, same generic column-forwarding as `allow_nets` — no driver code change needed) picks the tag for that one user's `LOOKUP`, overriding the component's static `director_tag`. IMAP/POP3/Submission/ManageSieve pick it up from the AUTH response; LMTP resolves it with a per-recipient userdb lookup before the director `LOOKUP`. A user with no `director_tag` field falls back to the component's static value.

## Ring formation & design history

Director replicas self-organize into a ring at runtime (#750 phase 1 — replaces the earlier static full-mesh `peers` list, #700): members are ordered by `(ip, port)` and each dials only its right neighbor, never a full mesh. Every member count is a fully valid, service-serving state (never refuses service) — a lone director is an ordinary N=1 ring, no peer machinery runs at all. `components.director.peers` is now a **seed list**: each entry is tried in turn for a one-time `DIRECTOR-JOIN`, after which membership maintains itself via propagation. Left empty (the default), at `replicas > 1` the seed auto-derives to the headless `<release>-director-ring:9102` Service (#751/#764) — never the ClusterIP `<release>-director` Service — because only the headless name resolves directly to every ready pod's IP, which is what the DNS fan-out needs to poll each peer; the ClusterIP resolves to a single virtual IP that load-balances dials randomly and reintroduces the formation partition. An explicit list overrides this (non-k8s / manual seeding). `components.director.ring_secret` (auto-generated into Secret `<release>-director-ring-secret`, mirroring the API token) authenticates joins via HMAC-SHA256 — leaving it unset rejects every join attempt outright, so that replica can only ever run standalone. The same secret authenticates every ring connection: the acceptor puts a per-connection nonce in its greeting and the dialer's `PEER` line carries a proof over it; without a valid proof from a `join_allowed_nets` address the connection is an ordinary client and its `MEMBERS` are ignored. All directors must run a release that sends the proof, so a mixed-version ring re-forms only once the rollout completes. `components.director.min_members` (default 3) is an install-time warning only, no runtime effect. Phase 1 covered ring topology, membership propagation and the HMAC join core. Later work added dial-back verification of a joiner and CIDR filtering (`join_allowed_nets`), the user-state snapshot on connect (#772) and periodic anti-entropy, described below.

**#754 (found in the first live 3-replica sandbox test)** fixed a phase-1 regression where killing one ring member left the membership set permanently corrupted: a dead member's tombstone wasn't propagated (an ordering bug meant `DIRECTOR-REMOVE` was announced before the outgoing connection needed to send it existed) and, separately, a plain member-list union on every reconnect could silently resurrect a member some other node had already correctly evicted. Membership now carries a proper tombstone set, exchanged alongside the member list on every ring connection; `Member` ordering also now sorts by parsed IP octets instead of string comparison (`"10.0.0.17" < "10.0.0.6"` as strings, backwards from the real address).

**#755** fixed `yarctl director ...` returning 403 from every pod, including the director pod's own shell — the director admin API token and URL were never plumbed to `yarilo-backend-api` (the standard admin plane) or reliably available for local use. Both are now wired via a shared Helm env-injection helper, and the empty-by-default `api.allowed_nets` (see #759) means the bearer token is the sole gate rather than a cluster-specific CIDR. The `smoketest` binary now carries a `-director-api <url>` check (bearer token from `-director-api-token` or `DIRECTOR_API_TOKEN`/`YARILO_ADMIN_TOKEN`) that fails loudly on a 403/401 and asserts a member list on 200 — run it in-cluster (a Job or `kubectl exec` on `yarilo-backend-api`, where the token env is already injected) since the director API is a ClusterIP; `smoke.yml` gained an optional `director_api` input for the same check from an in-cluster runner.

**#758** replaced the ring's single-edge event-forward path (one connection picked at accept time — `dialConn`, or a `passiveConn` reserved for the N=2 tie-break's passive member) with a broadcast to every currently live ring connection except whichever one an event just arrived on, matching the reference's skip-arrival forwarding instead of a fixed per-connection role that could go stale mid-connection across an N=3→N=2 shrink.

**#759 (found in a live 3-pod simultaneous-start sandbox test)** fixed a load-balanced ClusterIP seed routing a pod's own `DIRECTOR-JOIN` dial back to itself: this looked like an ordinary, immediate join success (a self-join is a harmless no-op), so `joinLoop` stopped retrying the seed forever, leaving the pod stuck as a permanently isolated N=1 that never discovered any real peer. `handleJoin` now rejects a self-dial explicitly, so the existing generic retry keeps dialing the seed until kube-proxy routes it elsewhere. Also dropped `components.director.api.allowed_nets`'s hardcoded kubeadm-shaped default (`10.96.0.0/12` + `10.244.0.0/16`) — wrong for any cluster with different service/pod CIDRs, silently 403ing every request including well-authenticated ones — in favor of an empty default (token-only auth; CIDR filtering is opt-in defense-in-depth once an operator knows their real cluster CIDRs).

**#759 follow-up (live re-test on the first fix)** closed the two remaining formation failures. Convergence speed: a self-dial rejection now retries the seed on a short fixed interval (500ms) instead of walking the exponential backoff — the backoff treated an expected ~1/N outcome of a load-balanced seed as seed failure, stretching one pod's convergence past 60s. Lost `DIRECTOR-ADD` under concurrent formation: every membership-changing path now broadcasts over the *pre-reconcile* connection set before recomputing its right neighbor (`reconcile()` could tear down a live connection the announcement still needed, permanently stranding a directly-connected member at a stale view). And a periodic anti-entropy snapshot (`components.director.anti_entropy_interval`, default 3s) re-broadcasts the member+tombstone `DIRECTOR-LIST` over every live ring connection as a bounded safety net — any split with at least one crossing connection heals within one interval.

**#759 second follow-up (live re-test showed formation still partitioning)** closed the last structural gap: fully disjoint subrings with zero crossing connections, which every connection-bound mechanism above is architecturally blind to. Under concurrent formation each node's single right-neighbor dial is computed from its own divergent view, so the dial graph isn't guaranteed connected — and the one guaranteed crossing point (the shared ClusterIP seed) used to be contacted exactly once. The seed poll is now periodic (`components.director.seed_poll_interval`, default 2s; negative restores one-shot): every member keeps re-fetching the seed's member+tombstone snapshot through the same idempotent union merge, bounding any formation partition's lifetime by the poll interval regardless of dial topology. Re-joins from known members are served as read-only snapshot requests (no `DIRECTOR-ADD` storm). Gated in-process by a formation test that joins N members simultaneously through a mock load-balanced seed with random routing (including self-dials).

**#759 third follow-up (live re-test: healing worked but took ~2 minutes, failing the converge-in-seconds gate)** removed the two latency sources. Poll pacing now gates on the configured cluster target size instead of own-view stability: full cadence while the view holds fewer than `min_members`, easing to `seed_poll_idle_interval` once the expected size is reached (and snapping back on any loss) — the previous stable-view backoff slowed exactly the node that needed healing, because a partitioned node's own view looks perfectly stable. And a hostname seed is now resolved explicitly with the poll fanned out to every resolved address except self each cycle: with the headless `-director-ring` Service as the seed this is a deterministic sweep of all peers (convergence in about one poll interval, zero self-dials) and sidesteps Go's RFC 6724 own-IP-first address ordering that a naive dial of a headless DNS answer hits. A literal-IP or load-balanced seed keeps the previous behavior (server-side self-dial rejection + 500ms fast retry) as the fallback path.

**#764 (live breakthrough after the DNS fan-out landed)** made the chart default the ring seed to the headless Service so the fix can't be defeated by configuration. With the fan-out in place, formation converged with the headless `-director-ring` seed (DNS → all pod IPs) but still partitioned with the ClusterIP `-director` seed (DNS → one virtual IP → load-balanced random routing → self-dials). The seed is now auto-derived to `<release>-director-ring:<directorPort>` whenever `components.director.peers` is empty and `replicas > 1`, so a fresh `replicas=3` install converges with no manual seed and no way to accidentally point the ring at the ClusterIP. `-director` remains the login-pod LOOKUP endpoint only.

**#768 (supersedes the brief all-probes-all liveness)** realigned death detection to the reference's both-neighbors model: a death is detected by the dead node's immediate neighbors — O(1) probes per node regardless of ring size — never by an O(N²) everyone-probes-everyone sweep. The right side was already covered by the dial path; the **left side** now treats losing the accepted connection from the current left neighbor as a death signal too (verified with a few short-deadline probes before declaring, so a benign dial re-target isn't mistaken for a death) — previously the N=2 higher-sorted member, who never dials, was permanently blind to its only peer's death. Both ends of every ring connection also exchange `PING`/`PONG` keepalives on `ping_interval` with a `ping_interval + ping_timeout` read deadline, so a silently-hung peer surfaces as a read error feeding the same death paths; and every deliberate teardown announces itself with `QUIT\t<reason>` (reference parity), so a benign dial re-target is classified instantly instead of via probes. Phantom members from rolling-restart churn converge via anti-entropy spreading the phantom until exactly one node computes it as its right neighbor, dials it, fails, and evicts it for everyone. Tombstones carry a TTL (`components.director.tombstone_ttl`, default 600s) so churn across many rollouts can't grow the set unboundedly — safe because a resurrected-but-unreachable member is re-evicted by its neighbors within seconds regardless.

**#772 (userDir state exchange — snapshot base)** starts closing the routing-STATE half of the ring (the membership half being done). On every ring (re)connect, right after the member `DIRECTOR-LIST`, a director now streams its **userDir snapshot** — `USER\t<hash>\t<backend>\t<seq>\t<by>\t<weak>` per sticky assignment — so a fresh or restarted director inherits current sticky routing state immediately instead of starting empty and re-deriving only from the hash. Assignments carry a **Lamport-clock** stamp `(assign_seq, assign_by)`, not wall-clock (pod clocks are unsynchronized; unix-nano would let the fastest-clock replica win nondeterministically) — a strictly higher seq wins, a tie breaks to the lower director id, deterministic and test-reproducible. A fresh sticky assignment made by a normal `LOOKUP` also propagates live around the ring as a `USER-ASSIGN` event (only the new pin — not the sticky TTL-refresh, which would make every repeat login a broadcast), director↔director by hash, applied under the same Lamport order. When a merge moves a user to a different backend — a same-`assign_seq` conflict where the lower id won and this director lost, or a newer reassignment — the loser kicks its own now-stale sessions for that user off the wrong backend (`USER-KICKED` to the owning login proxy), so a mailbox is never split across two backends; other users on that backend keep running. This completes the #772 userDir state exchange: sticky routing is now consistent across replicas even where it diverges from the deterministic hash, closing the replication half of #708 and the divergence part of #706.

**#770 (graceful leave on SIGTERM)** removes the death-detection latency from planned exits. Before shutting down, a director announces `DIRECTOR-REMOVE` for itself around the ring (peers evict it instantly via the existing tombstone path — zero probe window), sends `QUIT` on every ring connection, and rejects further JOINs (`JOIN-FAIL\tshutting down`) so no fresh joiner can learn the dying member. A hard kill still converges via the #768 neighbor-monitoring path — graceful leave only optimizes the expected k8s rolling-restart / scale-down case.

**#765 (residual after the seed fix: a respawned pod held a recently-dead member)** made the settled-cadence backoff safe by default. Killing a pod on a converged ring respawns a fresh pod that could learn the dying member as *live* during the death-detection window, reaching `min_members` with a stale entry — at which point the previous lazy 30s idle cadence left the dead member in place for up to 30s (live-measured 40s+). The idle cadence is now a separate knob `components.director.seed_poll_idle_interval`, **defaulting to the same 2s as the active cadence** (no effective backoff), because a node cannot locally distinguish "converged" from "stable but holding a dead member". Operators can raise it to trade steady-state polling for slower dead-member eviction; the tombstone-wins merge and per-`DIRECTOR-LIST` tombstone exchange (#754) already guaranteed correctness — this only bounds the latency.
