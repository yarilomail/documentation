# yarilo-director HTTP admin API

Director-plane admin endpoints exposed by `yarilo-director` on port
`9103` (default). The API speaks plain HTTP. Every endpoint requires a Bearer
token; an IP allow-list can be added on top.

For the storage-plane admin API (dict / acl / quota / folder),
see [BACKEND-API.md](BACKEND-API.md) — different binary
(`yarilo-backend-api`), different port (`:9105`), different token.

Both are reachable from the same `yarctl` CLI — director ops
via `--url` / `--token`, storage ops via `--backend-url` /
`--backend-token`.

---

## Authentication

Every request must include:

```
Authorization: Bearer <token>
```

The token is auto-generated into the k8s Secret `<release>-director-api-token` on first
Helm install. To read it:

```sh
kubectl get secret yarilo-director-api-token -o jsonpath='{.data.token}' | base64 -d
```

To rotate: delete the Secret and run `helm upgrade`.

---

## IP allow-list

The allow-list is empty by default, so the Bearer token is the only gate. Service and pod CIDRs differ between clusters, so no default can be right for every one.

To restrict callers by address as well, set `components.director.api.allowed_nets`:

```yaml
components:
  director:
    api:
      allowed_nets:
        - "10.96.0.0/12"
        - "10.244.0.0/16"
```

The address is checked before the token: a caller outside the list gets `403` whatever token it sends.

::: warning
An empty `director_service.api.token` disables token checking. The chart always sets one.
:::

---

## CLI

`yarctl` needs no flags in the pods where the chart wires it up. Inside the director pod it calls `http://localhost:9103` with `DIRECTOR_API_TOKEN`. In the `yarilo-backend-api` pods the chart sets `YARILO_ADMIN_URL` to the `<release>-director-api` Service and `YARILO_ADMIN_TOKEN` to the API token.

Run a command in the director pod:

```sh
kubectl exec -it <director-pod> -- yarctl director status
```

Environment variables (set automatically in the container):

| Variable | Default | Description |
|:---|:---|:---|
| `YARILO_ADMIN_URL` | `http://localhost:9103` | API base URL (flag `--url`) |
| `YARILO_ADMIN_TOKEN` | — | Bearer token (flag `--token`; fallback: `DIRECTOR_API_TOKEN`) |

The `--tls-*` flags of `yarctl` have no effect here: the director API does not serve HTTPS.

---

## Endpoints

### Status & Diagnostics

#### `GET /api/director/status`

All backends in the ring. `sessions` is the number of sessions on the backend as this director sees them. Director membership is under [`GET /api/director/ring`](#get-api-director-ring).

```json
{
  "backends": [
    {"ip": "10.0.0.1", "port": 993, "tag": "ssd", "up": true, "vhosts": 100, "sessions": 42}
  ]
}
```

CLI: `yarctl director status`

---

#### `GET /api/director/dump`

Full state dump: backends, user→backend assignments, ring members and session records.

```json
{
  "backends": [
    {"ip": "10.0.0.1", "port": 993, "tag": "ssd", "up": true, "vhosts": 100, "sessions": 42, "last_up": 1747000000, "last_down": 0}
  ],
  "users": [
    {"hash": 3141592653, "host": "10.0.0.1:993", "weak": false, "expires_at": 1747001800}
  ],
  "peers": ["10.0.0.1:9102", "10.0.0.2:9102"],
  "sessions": [
    {"id": "a1b2c3", "user": "alice@example.com", "backend": "10.0.0.1", "proto": "imap", "local": true},
    {"id": "d4e5f6", "user": "bob@example.com", "backend": "10.0.0.1", "proto": "pop3", "local": false, "origin": "<director run>"}
  ]
}
```

In `sessions`:

- `local` is `true` for a session whose login connection is attached to this director. A record replicated from another director is counted here but never kicked from here.
- `origin` is present only on such a replicated record. It names the director run it came from, in the same form the director's purge log lines use.

CLI: `yarctl director dump`

---

#### `GET /api/director/map[?user=USER]`

The call has three forms:

- Without `user`, it returns every user→backend assignment.
- With `user` and `peek`, it reads the stored assignment and changes nothing.
- With `user` alone, it resolves the user the way a login `LOOKUP` does: the sticky assignment first, then the ring.

```json
// GET /api/director/map
{"users": [{"hash": 3141592653, "host": "10.0.0.1:993", "weak": false}]}

// GET /api/director/map?user=alice@example.com&peek=1
{"user": "alice@example.com", "pinned": true, "backend": "10.0.0.1", "host": "10.0.0.1:993", "weak": false}
{"user": "bob@example.com", "pinned": false}

// GET /api/director/map?user=alice@example.com
{"user": "alice@example.com", "backend": "10.0.0.1", "port": 993, "tag": "ssd", "sticky": true}
```

::: warning
The form without `peek` can assign a user who has no assignment yet, for example under `assignment_policy: least_sessions`. Use `peek` for read-only inspection.
:::

The resolving form returns `503` when no backend is available.

CLI: `yarctl director map [--user alice@example.com]`. With `--user`, the CLI sends `peek`.

---

### Backends

#### `GET /api/director/backends`

List all backends currently in the ring.

```json
{"backends": [...]}
```

CLI: `yarctl director backends list`

---

#### `POST /api/director/backends`

Add a backend to the ring. Broadcasts `RING-CHANGE up` to all connected directors.

```json
// Request
{"ip": "10.0.0.3", "port": 993, "tag": "ssd", "vhosts": 100}

// Response
{"status": "ok"}
```

CLI: `yarctl director backends add 10.0.0.3 --port 993 --tag ssd`

---

#### `PATCH /api/director/backends/{ip}`

Update virtual node weight of an existing backend.

```json
// Request
{"vhosts": 200}

// Response
{"status": "ok"}
```

CLI: `yarctl director backends update 10.0.0.3 --vhosts 200`

---

#### `DELETE /api/director/backends/{ip}`

Remove backend from the ring. Broadcasts `RING-CHANGE down`. An unknown IP also returns `{"status": "ok"}`.

CLI: `yarctl director backends remove 10.0.0.3`

---

#### `POST /api/director/backends/{ip}/up`

Mark backend as up (resumes new session routing). Broadcasts `RING-CHANGE up`.

CLI: `yarctl director backends up 10.0.0.3`

---

#### `POST /api/director/backends/{ip}/down`

Mark backend as down (flush — stops new routing, keeps in registry). Broadcasts `RING-CHANGE flush`.

CLI: `yarctl director backends down 10.0.0.3`

---

#### `POST /api/director/backends/{ip}/flush`

Evacuate a backend, or every backend with `all` as `{ip}`. Its users are kicked and re-route to the surviving backends.

By default the evacuation is a graceful, throttled drain: users are moved in a window of at most `max_parallel` confirmed kills. The query parameters change that:

| Parameter | Effect |
|:---|:---|
| `force=true` | Kick every session at once. |
| `max_parallel=N` | Window size for this run. The default is `director_service.max_parallel_moves`. |

Drain one backend:

```sh
POST /api/director/backends/10.0.0.3/flush
```

```json
{"status": "ok", "mode": "graceful", "users_queued": 120, "max_parallel": 5}
```

Force-evacuate every backend:

```sh
POST /api/director/backends/all/flush?force=true
```

```json
{"status": "ok", "mode": "force"}
```

See [Deployment](./DEPLOYMENT) for when to drain and when to force.

CLI: `yarctl director backends flush 10.0.0.3 [--force] [--max-parallel N]`

---

### Users

#### `POST /api/director/users/{user}/move`

Assign a user to a specific backend. The assignment is a sticky pin with the usual `user_expire` lifetime, not a permanent override. The user's sessions on the old backend are kicked, and `USER-MOVED` is broadcast to login pods and around the ring.

```json
// Request — either form works:
{"backend": "10.0.0.1:993"}
{"ip": "10.0.0.1", "port": 993}

// Response
{"status": "ok"}
```

CLI: `yarctl director users move alice@example.com --backend 10.0.0.1:993`

---

#### `POST /api/director/users/{user}/kick`

Kick a user: the director clears the user's sticky assignment and broadcasts `USER-KICKED`, so the login pods end that user's sessions. The next login is routed afresh.

The response comes immediately, but the kick itself waits `director_service.user_kick_delay` seconds (default `2`) so an in-flight command on the old backend can finish. New `LOOKUP`s for the user are held until the old sessions are confirmed gone.

CLI: `yarctl director users kick alice@example.com`

---

### Ring (Director Peers)

#### `GET /api/director/ring`

Ring topology as **this replica** sees it (membership is per-replica). Each
member carries its computed `left`/`right` neighbors (`(ip,port)` order; `null`
at N=1). `link` is present only for this replica's direct neighbors and
describes the live edge — `role` (`left`/`right`, or `both` at N=2 where one
connection serves both directions), `state` (`connected`/`reconnecting`) and
`since` (RFC3339, `null` while reconnecting). `seq` is the dedup watermark
(highest seq processed from that origin; `null` when none heard). `tombstones`
lists members known dead on this replica with the tombstone age.

```json
{
  "schemaVersion": 1,
  "self": "10.0.0.2:9102",
  "size": 3,
  "members": [
    {"addr": "10.0.0.1:9102", "index": 0, "self": false, "left": "10.0.0.3:9102", "right": "10.0.0.2:9102", "seq": 41, "link": {"role": "left", "state": "connected", "since": "2026-07-27T09:56:42Z"}},
    {"addr": "10.0.0.2:9102", "index": 1, "self": true,  "left": "10.0.0.1:9102", "right": "10.0.0.3:9102", "seq": 42, "link": null},
    {"addr": "10.0.0.3:9102", "index": 2, "self": false, "left": "10.0.0.2:9102", "right": "10.0.0.1:9102", "seq": 40, "link": {"role": "right", "state": "connected", "since": "2026-07-27T09:56:42Z"}}
  ],
  "tombstones": [],
  "backendSetHash": "1a2b3c4d"
}
```

`backendSetHash` (#846) is a stable hash over this replica's routing backend set
(`{ip, port, tag, vhosts, up}`, order-independent). Replicas that agree on
routing share the same hash; a difference is a diverged backend set (a dropped
`RING-CHANGE`), flagged by the `--all` verdict below.

CLI: `yarctl director ring status`

---

#### `GET /api/director/ring/topology`

Cross-replica aggregate. The queried director fans out to every peer's own
`GET /api/director/ring` (one authorized server-side fan-out, shared per-release
Bearer token) and returns each replica's view plus a health verdict. `healthy`
is `false` when any `error`-severity issue is present: `peer-unreachable` (a
member whose view could not be collected — never silently dropped),
`view-size-mismatch`, `backend-set-divergence` (replicas hashing their routing
backend set differently — #846), `asymmetric-edge`, `tombstone-divergence`.
`seq-lag` is
`warn` only and does not affect `healthy`. `assumptions` records that peer API
endpoints are derived from each ring IP + this replica's `api.listen` port
(uniform-`api.listen` assumption).

```json
{
  "schemaVersion": 1,
  "healthy": false,
  "issues": [
    {"severity": "error", "type": "peer-unreachable", "detail": "10.0.0.3:9102 is in membership but its view could not be collected"}
  ],
  "replicas": [
    {"addr": "10.0.0.1:9102", "reachable": true, "status": { /* RingStatus */ }},
    {"addr": "10.0.0.2:9102", "reachable": true, "status": { /* RingStatus */ }},
    {"addr": "10.0.0.3:9102", "reachable": false, "error": "director/topology: get 10.0.0.3:9103 ..."}
  ],
  "assumptions": ["peer API endpoints derived as <ring-ip>:9103 — assumes uniform api.listen across replicas", "..."]
}
```

CLI: `yarctl director ring status --all`

---

#### `POST /api/director/ring` and `DELETE /api/director/ring`

Both return `410 Gone`. Ring membership is self-organizing: a director joins by pointing `director_service.peers` at a seed, and a member is removed automatically when its neighbor finds it dead. There is nothing for an operator to add or remove. See [Ring formation](./DIRECTOR#ring-formation-design-history).

`yarctl director ring add` and `ring remove` print this explanation.

---

## Error responses

All errors return JSON with an `error` field and appropriate HTTP status code.

| Code | Meaning |
|:---|:---|
| `400` | Invalid request body or missing required field |
| `401` | Missing or invalid Bearer token |
| `403` | Client IP not in `allowed_nets` |
| `404` | Backend not found (update, up, down, flush) |
| `410` | Ring add/remove: membership is self-organizing |
| `503` | No backends available (map lookup) |

```json
{"error": "backend not found"}
```

---

## Helm values

| Value | Default | Description |
|:---|:---|:---|
| `components.director.api.port` | `9103` | API listen port |
| `components.director.api.allowed_nets` | `[]` | Allowed client CIDRs. Empty allows every address. |
