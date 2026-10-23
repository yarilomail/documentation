---
description: "Running weakforced as yarilo's auth policy server: deploying it on Kubernetes, a policy against password guessing, connecting yarilo-auth, and turning it on in stages."
---

# wforce Integration

[weakforced](https://github.com/PowerDNS/weakforced) (wforce) is a policy server
that counts login failures and answers whether a login may go on. This page
deploys it next to yarilo on Kubernetes with a policy against password
guessing, connects `yarilo-auth` to it and turns it on in stages.

[Auth Policy](/auth/policy) describes what `yarilo-auth` sends and how it acts
on the answer.

## How the two work together

For each login, `yarilo-auth`:

1. asks wforce `allow` before checking the password;
2. checks the password;
3. after a successful check, asks `allow` again;
4. sends wforce `report` with the outcome.

wforce keeps its counts from the reports and answers `allow` with one of:

- `0`: the login goes on;
- a positive number: the login goes on after that many seconds (a tarpit);
- `-1`: the login is refused, with a message for the client.

wforce never sees a password. It gets `pwhash`, a short salted hash that tells
different passwords apart; see [`pwhash`](/auth/policy#pwhash).

## Deploying wforce

wforce needs two secrets: the password of its HTTP API and a key for its
own replication. Generate both into a Secret:

```sh
kubectl create namespace wforce
kubectl -n wforce create secret generic wforce \
  --from-literal=password="$(openssl rand -hex 24)" \
  --from-literal=key="$(openssl rand -base64 32)"
```

Deploy wforce with the policy in a ConfigMap; [the policy](#the-policy) below
is the `wforce.conf` it mounts:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: {name: wforce, namespace: wforce, labels: {app: wforce}}
spec:
  replicas: 1
  selector: {matchLabels: {app: wforce}}
  template:
    metadata: {labels: {app: wforce}}
    spec:
      containers:
        - name: wforce
          image: powerdns/wforce:v3.2.0
          args: [wfwrapper]
          env:
            - {name: WFORCE_CONFIG_FILE, value: /etc/wforce/wforce.conf}
            - name: WFORCE_HTTP_PASSWORD
              valueFrom: {secretKeyRef: {name: wforce, key: password}}
            - name: WFORCE_KEY
              valueFrom: {secretKeyRef: {name: wforce, key: key}}
          ports: [{name: http, containerPort: 8084}]
          readinessProbe: {tcpSocket: {port: http}, periodSeconds: 5}
          volumeMounts:
            - {name: conf, mountPath: /etc/wforce/wforce.conf, subPath: wforce.conf, readOnly: true}
      volumes:
        - name: conf
          configMap: {name: wforce}
---
apiVersion: v1
kind: Service
metadata: {name: wforce, namespace: wforce}
spec:
  selector: {app: wforce}
  ports: [{name: http, port: 8084, targetPort: http}]
```

Create the ConfigMap from the file:

```sh
kubectl -n wforce create configmap wforce --from-file=wforce.conf
```

- wforce keeps its counts in memory. A restart forgets them, and two replicas
  count apart unless wforce replication is set up, so run one.
- The API is plain HTTP and admits private networks only. Keep it inside the
  cluster.
- After a change to the ConfigMap, restart the Deployment:
  `kubectl -n wforce rollout restart deploy/wforce`.

## The policy

The policy has three rules against password guessing:

| Attack | Counted per | Answer |
|:---|:---|:---|
| one login guessed from one address | address and login | tarpit 3 s past 3 different failed passwords |
| many logins tried from one address | address | refusal past 50 different failed passwords |
| one login guessed from many addresses | login | tarpit 10 s past 20 different failed passwords |

Save it as `wforce.conf`:

```lua
addListener("0.0.0.0:8084", false, "", "", {})
setWebserverPassword(os.getenv("WFORCE_HTTP_PASSWORD"))
setKey(os.getenv("WFORCE_KEY"))

local field_map = {}
field_map["diffFailedPasswords"] = "hll"
newStringStatsDB("OneHourDB", 600, 6, field_map)

-- One login guessed from one address: tarpit.
local login_ip_tarpit_after, login_ip_tarpit_secs = 3, 3
-- Many logins tried from one address (spraying): refuse the address.
local ip_refuse_after = 50
-- One login guessed from many addresses: tarpit the login, never lock it out.
local login_tarpit_after, login_tarpit_secs = 20, 10

function report(lt)
   if not lt.success and not lt.policy_reject then
      local sdb = getStringStatsDB("OneHourDB")
      sdb:twAdd(lt.remote, "diffFailedPasswords", lt.pwhash)
      sdb:twAdd(lt.remote:tostring() .. ":" .. lt.login, "diffFailedPasswords", lt.pwhash)
      sdb:twAdd(lt.login, "diffFailedPasswords", lt.pwhash)
   end
end
setReport(report)

function allow(lt)
   local sdb = getStringStatsDB("OneHourDB")
   if sdb:twGet(lt.remote, "diffFailedPasswords") > ip_refuse_after then
      return -1, "Too many failed logins, try again later", "spraying from this address", {}
   end
   if sdb:twGet(lt.remote:tostring() .. ":" .. lt.login, "diffFailedPasswords") > login_ip_tarpit_after then
      return login_ip_tarpit_secs, "", "guessing this login from this address", {}
   end
   if sdb:twGet(lt.login, "diffFailedPasswords") > login_tarpit_after then
      return login_tarpit_secs, "", "guessing this login from many addresses", {}
   end
   return 0, "", "", {}
end
setAllow(allow)

function reset(type, login, ip)
   local sdb = getStringStatsDB("OneHourDB")
   if string.find(type, "ip") then sdb:twReset(ip) end
   if string.find(type, "login") then sdb:twReset(login) end
   if string.find(type, "ip") and string.find(type, "login") then
      sdb:twReset(ip:tostring() .. ":" .. login)
   end
   return true
end
setReset(reset)
```

This policy:

- **Counts different failed passwords over the last hour.** It keeps six
  windows of ten minutes. A client retrying one stale password counts once,
  so a phone with an old password does not lock its owner out.
- **Counts approximately.** The counts are estimates, and they can fall short
  of the real number by about a tenth. Leave a margin above the number you
  mean to stop at.
- **Tarpits a login guessed from many addresses rather than refusing it.** A
  refusal there would let anyone lock a user out by failing their login from
  enough addresses.
- **Only tarpits in the check before the password.** The check after a
  successful login can refuse it but never delays it.

A refusal's message reaches the client: IMAP answers
`NO [AUTHENTICATIONFAILED] Too many failed logins, try again later`.

### Counting the real client address

A login process behind a load balancer or proxy sees the proxy's address.
With the PROXY protocol (`haproxy_protocol`) or a trusted forwarder
(`general.xclient.trusted_nets`), `yarilo-auth` sends wforce the client's
address in `remote`. Without either, every login seems to come from the proxy,
and the per-address rules refuse everyone at once.

## Connecting yarilo

`yarilo-auth` sends wforce's password as HTTP basic authentication, and salts
`pwhash` with a nonce of its own. Put both in a Secret in yarilo's namespace:

```sh
WFORCE_PASSWORD=$(kubectl -n wforce get secret wforce -o go-template='{{.data.password|base64decode}}')
kubectl -n yarilo create secret generic yarilo-auth-policy \
  --from-literal=api_header="Authorization: Basic $(printf 'wforce:%s' "$WFORCE_PASSWORD" | base64 | tr -d '\n')" \
  --from-literal=hash_nonce="$(openssl rand -hex 24)"
unset WFORCE_PASSWORD
```

Point the chart at wforce and name the Secret:

```yaml
components:
  auth:
    policy:
      url: http://wforce.wforce.svc.cluster.local:8084/
      api_header_secret_ref: {name: yarilo-auth-policy, key: api_header}
      hash_nonce_secret_ref: {name: yarilo-auth-policy, key: hash_nonce}
      log_only: true
```

The values stay out of the config ConfigMap; see [Helm](/auth/policy#helm).
`log_only: true` starts in shadow mode, the first stage below.

Keep the nonce once it is set. A new nonce changes every `pwhash`, so the
counts in wforce start over.

## Turning it on in stages

### Shadow mode

With `log_only: true`, `yarilo-auth` asks wforce and logs what it would do,
but every login goes on without a delay:

```yaml
components:
  auth:
    policy:
      log_only: true
```

wforce logs a line for every tarpit and refusal it answers, with the reason
from the policy:

```sh
kubectl -n wforce logs deploy/wforce | grep allowLog
```

Run it for a few days and check that the logins it would slow down or refuse
are attacks, not your users. Raise a limit where it catches real users.

### Enforcing, failing open

Turn `log_only` off and keep `reject_on_fail` off:

```yaml
components:
  auth:
    policy:
      log_only: false
      reject_on_fail: false
```

wforce's answers now apply. When wforce cannot be reached or answers something
malformed, logins go on without it.

### Enforcing, failing closed

Set `reject_on_fail: true` once wforce is monitored and you would rather refuse
logins than let them through unchecked:

```yaml
components:
  auth:
    policy:
      reject_on_fail: true
```

An unreachable wforce now refuses every login. `yarilo_auth_policy_errors_total`
counts the calls that failed; alert on it.

## Checking the policy

Forward wforce's API to your machine:

```sh
kubectl -n wforce port-forward svc/wforce 18084:8084 &
WFORCE_PASSWORD=$(kubectl -n wforce get secret wforce -o go-template='{{.data.password|base64decode}}')
```

Ask what wforce would answer a login:

```sh
curl -s -u wforce:"$WFORCE_PASSWORD" -H 'Content-Type: application/json' \
  -d '{"login":"alice@example.com","remote":"192.0.2.10","pwhash":"ab0","protocol":"imap","tls":true,"attrs":{}}' \
  'http://127.0.0.1:18084/?command=allow'
```

It answers like this:

```json
{"msg": "", "r_attrs": {}, "status": 0}
```

Read the counts for an address or a login:

```sh
curl -s -u wforce:"$WFORCE_PASSWORD" -H 'Content-Type: application/json' \
  -d '{"ip":"192.0.2.10"}' 'http://127.0.0.1:18084/?command=getDBStats'
```

### Letting a user back in

Clear the counts of a login, an address, or both:

```sh
curl -s -u wforce:"$WFORCE_PASSWORD" -H 'Content-Type: application/json' \
  -d '{"login":"alice@example.com","ip":"192.0.2.10"}' 'http://127.0.0.1:18084/?command=reset'
```

The counts also clear on their own an hour after the last failure.

### Watching yarilo's side

`yarilo-auth` exports `yarilo_auth_policy_decisions_total` by check and result
(`ok`, `delayed`, `refused`), and its `auth: ok` and `auth: fail` log lines
carry `policy_result` and `policy_penalty`. See
[Observability](/auth/policy#observability).
