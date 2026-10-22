# Director configuration

`yarilo-director` keeps the routing state of a cluster: which backend serves each user. Login pods ask it with a `LOOKUP` before they open a session to a backend.

The director does not accept client connections. TLS, the PROXY protocol, XCLIENT and authentication all happen in the login pods; see [General settings](/installation/general) and [Deployment](/installation/deployment).

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
- With more than one replica, the directors form a ring of their own to share membership, the backend set and sticky assignments. See [Ring formation](#ring-formation).

## Listening ports

The director listens on three ports:

| Key | Default | Used by |
|:---|:---|:---|
| `director_service.listen` | `:9102` | Login pods (`LOOKUP`) and other directors (ring protocol). |
| `director_service.api.listen` | `:9103` | The admin API; see [Director API](/architecture/director_api). |
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
| `write_timeout` | `10` | Seconds a single push or reply write may take. `0` = no bound. |
| `shutdown.session_grace_period` | `30` | Seconds to wait after `SIGTERM` before exiting. |
| `peers` | `[]` | Seed list for a one-time ring join. Empty at `replicas > 1` derives the headless `-director-ring` Service. |
| `backend_expire` | `30` | Seconds a self-registered backend may go without a heartbeat before it leaves the ring. |
| `backend_unreachable_reporters` | `2` | Distinct login pods that must report a backend unreachable before it is evicted early. |
| `backend_unreachable_window` | `5` | Seconds within which those reports must arrive. |
| `join_allowed_nets` | `[]` | CIDRs a ring join is accepted from. Empty allows all. |
| `anti_entropy_interval` | `3` | Seconds between re-broadcasts of the member and tombstone list over every ring connection. `0` turns it off. |
| `tombstone_ttl` | `600` | Seconds a dead member's tombstone is kept. `0` keeps it for good. |

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
| `vhosts` | Ring weight, `1`–`100`. Omit for the default (`100`). `0` routes no users to it (under `assignment_policy: least_sessions` it drains). |

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

The certificate the chart makes for the `director` role carries it, along with `<release>-director` and the role SAN `director.role.yarilo.internal`. With cert-manager, `components.director.internalTLS.certificate.enabled: true` renders the same names; a Secret of your own in `components.director.internalTLS.secretName` must carry them too. The director port also checks the role per command: ring commands only from `director`, registration only from `backend-reg` ([Peer roles](/installation/deployment#peer-roles)).

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

These keys are described in [Deployment](/installation/deployment):

| Key | Default | Description |
|:---|:---|:---|
| `assignment_policy` | `hash` | How a new user gets a backend: `hash`, `least_sessions` or `domain`. See [placement policy](/installation/deployment#initial-placement-policy). |
| `director_domain_expire` | `900` | Seconds a domain keeps its backend with no session on it, under `domain`. |
| `director_domain_rebalance_percent` | `0` (chart: `20`) | How far the busiest backend of a tag may rise above the quietest before one domain moves. `0` never moves one. |
| `director_domain_rebalance_interval` | `60` | Seconds between rebalance checks. |
| `director_domain_rebalance_cooldown` | `600` | Seconds a moved domain is left alone. |
| `user_kick_delay` | `2` | Seconds an admin-initiated kick waits. `0` kicks immediately. See [kick pacing](/installation/deployment#kick-pacing). |
| `max_parallel_kicks` | `100` | Sessions kicked per batch when a backend goes down. `0` kicks all at once. |

## Session routing & sticky assignments

Every login proxy (imap/pop3/submission/managesieve/lmtp) routes sessions one of two ways: `backend_addr` (standalone, a fixed backend) or `director_addr` (director mode, per-session `LOOKUP` via yarilo-director) — at least one is required, and `backend_addr` wins when both are set, in all five components. `backend_port` overrides the port a director `LOOKUP` returns when it differs from the backend's protocol-specific containerPort.

**Migration note:** lmtp-login previously had the *opposite* precedence — `director_addr` won when both were set. If your `lmtpLogin` Helm values set both `backend_addr` and `director_addr`, the login pod now logs a startup warning and silently switches from director routing to the static backend. Remove `backend_addr` from `lmtpLogin` values to keep director routing.

`director_service.username_hash_lowercase` (default `true`, Helm: `components.director.username_hash_lowercase`) lowercases usernames before they're hashed for ring routing or used as keys for sticky assignments and admin (`USER-MOVE`) overrides — without it, two spellings of the same account (`User@d.test` / `user@d.test`) can hash to different values and land on different backends, defeating sticky routing. Migration note: enabling this on an already-running cluster changes hashes for mixed-case usernames — their existing sticky entries just expire naturally via `user_expire`, no special migration step is needed.

> **Sharing mailboxes between users of a domain?** Set
> `assignment_policy: domain`: a domain is placed on the backend with
> the fewest connections and every user of it follows, with no hash template to
> get right. A user's sticky entry holds only while it names the domain's
> backend: after a move, users who logged in before it follow at their next
> login instead of riding their entry to the old backend. The older
> pairing below still works and stays supported.
>
> **The older pairing:** set `username_hash: "%Ld"`
> **and** `assignment_policy: hash`. The default hashes the whole address, so
> users of one domain land on different backends — harmless where those
> backends share one PV, fatal where each has its own storage. And
> `least_sessions` never reads the username at all, so it silently defeats the
> hash template. See [Owner/shared namespaces](/storage/owner_shared_ns#routing-within-a-farm-users-who-share-must-land-on-one-backend).

`director_service.username_hash` (default `""`, Helm: `components.director.username_hash`) is the username→hash-key template, which uses the reference's username-hash expression syntax, so an existing template migrates **verbatim** — `%Lu` stays `%Lu`. Supported variables: `%u` (whole username), `%n` (local part, before the first `@`), `%d` (domain, after the first `@`), each with an optional `%L` lowercase modifier, plus `%%` for a literal percent. This is a real routing lever, not just config parity: `%Ld` hashes on the **domain only** so a whole domain (and its shared mailboxes/ACLs) lands on one backend, and `%Ln` hashes on the local part only for alias-domain installs. A domain-less username follows the reference semantics — `%n` is the whole username, `%d` is empty (so a `%d` template routes every domain-less account to one backend). When `username_hash` is set it — not `username_hash_lowercase` — governs case-folding (the ingress no longer pre-lowercases, so `%u` is truly case-sensitive), and the `USER-KICKED` payload keeps the session's original-case username so login-side kick matching still lands. An empty value derives the template from `username_hash_lowercase` (`%Lu` / `%u`) for byte-identical back-compat with clusters that predate `username_hash`. An invalid template aborts director startup. (yarilo's uint32 fold is little-endian — deliberately not byte-compatible with the reference's ring, a scenario our architecture never produces; we borrow the routing semantics, not the byte layout.)

**`%d` domain-hash — read before you use it.** The hash is applied **within a tag**, not globally: every `LOOKUP` carries a per-user tag (tag = NFS shard) and the ring is tag-scoped (`LookupBackendByTag`), exactly like the reference's per-tag lookup. So a `%Ld` template routes a domain to **one backend per tag** — if the domain's mailboxes are spread across tags (the tag is assigned per user by userdb, independent of the hash), those users land on different tag rings and different backends; `%d` does **not** collapse a multi-tag domain onto a single host. The failure mode to avoid is putting one large domain entirely in **one** tag: there `%Ld` pins the whole domain to a single backend with **no load rebalancing** (yarilo, like the reference, distributes only by consistent hashing + vhost capacity weighting; it never auto-spreads a hot key). The cure is spreading the domain across tags via userdb, not changing the hash. Use `%Ld` only when a domain's shared mailboxes/ACLs genuinely must be storage-local within a tag.

**Backend evacuation — graceful vs force.** `yarctl director backends flush <ip|all>` drains a backend. By default the drain is **graceful and throttled**: the host is taken out of the ring and its users are migrated in a self-clocked window of at most `director_service.max_parallel_moves` (default `5`, Helm: `components.director.max_parallel_moves`) confirmed-kills — each user's old sessions must confirm gone before the next user is pulled in, so a planned drain (rolling upgrade, maintenance) spreads the re-login across the surviving pods instead of stampeding them all at once. `--force` restores the pre-#849 behaviour (kick every session immediately); `--max-parallel N` overrides the window for one run. Re-login is deterministic without a proactive pin move: the evacuating host is already excluded from the ring, so a kicked user's re-`LOOKUP` rehashes to the same surviving backend it would have been moved to, and the confirmed-kill hold makes that re-`LOOKUP` wait until the old session is gone (no split-writer window). The drain is orchestrated by the single director that receives the request; if that director is lost mid-drain the operator re-runs `flush` (drain-state is not replicated across directors — matching the reference, where the originating director drives the drain). Matches the reference's forced-flush and max-parallel drain behaviour.

**Per-user flush hook.** `director_service.flush_program` (default `""` = disabled, Helm: `components.director.flush_program`) is an optional external executable run once per user **after** a deliberate relocation — an admin `USER-MOVE` or a graceful evacuation — has been confirmed ring-wide, i.e. after that user's old sessions are gone. Operators hook mailbox-cache flush, external session cleanup, metrics, etc. It is called as `flush_program FLUSH <username> <username_hash> <old_backend> <new_backend>` (`new_backend` is empty when the user was kicked with no surviving backend to land on). It is **best-effort and asynchronous** with a bounded timeout: a slow or failing hook is logged and never blocks the ring/`LOOKUP` path or fails the move (the routing change already committed). The bound is `director_service.flush_program_timeout` (seconds, default `10`, Helm: `components.director.flush_program_timeout`); `0` selects the default rather than disabling the bound. Raise it for a hook that legitimately takes longer — and note what best-effort means for diagnosing one: a run that exceeds the bound is killed, and the only trace is a `WARN` on the director (`flush hook failed (best-effort, move already committed)` with `err="signal: killed"`). Nothing surfaces on the hook's own side, so a script that always overruns simply never completes, silently, until someone reads the director's log. Only the director that **originated** the move runs it — mass/reactive paths (`backend-down` auto-kick, `--force` flush) deliberately do not trigger it, and a move that creates a fresh pin with no prior host is skipped. The hook runs at the same point as the reference's flush hook, after the ring-wide `USER-KILLED-EVERYWHERE`; the program runs in the director pod's context, `exec.Command` only (no fork). A unix-socket hook variant is a possible future follow-up. An **offline** user — one with no active sessions when the move starts — confirms after `user_kill_confirm_grace` (~1s) instead of waiting out `user_kill_timeout`, so the hook fires promptly for the common admin case of moving a user who isn't currently connected; a user with live sessions still confirms only once those sessions have drained.

### Tag sharding models

Every director `LOOKUP` carries a mandatory tag field — there is no full-ring mode: `""` selects the untagged backend pool, not "any tag." Two sharding models are supported:

- **Static (dedicated login fleet per tag pool).** Each login component's `director_tag` (Helm: `components.<login>.director_tag`, e.g. `components.imapLogin.director_tag`) restricts that component's lookups to one tag-pool — set this when running a dedicated login Deployment per tag pool, per the tag-based sharding model in [Deployment](/installation/deployment). In a deployment with no tags configured at all, every backend is untagged, so the default `director_tag: ""` behaves exactly like the old (buggy) full-ring lookup — untagged/standalone deployments see no behavior change.
- **Shared (per-user tag from passdb/userdb).** One login fleet serving users of every tag-pool: a `director_tag` extra field on the passdb or userdb response (SQL: an ordinary column in `passdb_sql_query`/`userdb_sql_query`, same generic column-forwarding as `allow_nets` — no driver code change needed) picks the tag for that one user's `LOOKUP`, overriding the component's static `director_tag`. IMAP/POP3/Submission/ManageSieve pick it up from the AUTH response; LMTP resolves it with a per-recipient userdb lookup before the director `LOOKUP`. A user with no `director_tag` field falls back to the component's static value.

## Ring formation

Director replicas form a ring on their own. Members are ordered by IP and port, and each one dials only its right neighbour, never every other member. Any member count serves requests, and a single director is a ring of one.

### Joining the ring

`components.director.peers` is a list of seeds. A new director sends `DIRECTOR-JOIN` to them, and membership then spreads around the ring.

Left empty with more than one replica, the seed is the headless `<release>-director-ring:9102` Service. Each cycle the seed name is resolved and every address but the director's own is polled. The ClusterIP `<release>-director` Service is only for the login pods' `LOOKUP`: as a seed it would load-balance, and a director could dial itself.

The seed is polled every `seed_poll_interval` seconds (default `2`; a negative value polls once). Once the ring holds `min_members` directors (default `3`), the interval becomes `seed_poll_idle_interval` (default `2`). Raising it saves polling, and a dead member is evicted more slowly.

`components.director.ring_secret` (generated into the Secret `<release>-director-ring-secret`) authenticates every join and every ring connection. Without it a director never joins and runs alone. When `join_allowed_nets` is set, only those addresses may join. Every director must run a release that speaks the same join proof, so a ring being upgraded re-forms once the rollout completes.

### Keeping the view consistent

- Every ring connection exchanges the member list and the list of removed members (tombstones).
- Every `anti_entropy_interval` seconds (default `3`), each director re-sends its view over every live ring connection. This repairs a view that has diverged.
- A tombstone expires after `tombstone_ttl` seconds (default `600`).
- An event is forwarded over every live ring connection except the one it came in on.

### Detecting a dead member

- Both neighbours of a director watch it: the right side through its dial, the left side through the connection it accepted. A few short probes confirm a loss before it is declared.
- Each ring connection exchanges `PING`/`PONG` every `ping_interval` seconds (default `30`). A peer silent for `ping_interval + ping_timeout` (default `10`) counts as lost.
- A director that closes a connection on purpose says why with `QUIT`, so the other end does not mistake it for a death.
- On SIGTERM a director announces its own removal, sends `QUIT` on every ring connection and refuses new joins. A director killed outright is detected by its neighbours.

### Sharing sticky assignments

On every ring connection a director sends its sticky user assignments, so a restarted director starts with the cluster's routing state, not an empty one. A new assignment made by a `LOOKUP` travels around the ring as `USER-ASSIGN`.

Assignments are ordered by a logical clock, not by wall time: the higher sequence wins, and a tie goes to the lower director id. When a merge moves a user to another backend, the director whose assignment lost kicks that user's sessions on the old backend, so one mailbox is never served by two backends.
