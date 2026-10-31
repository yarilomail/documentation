# General configuration

The `general` section defines infrastructure settings shared across all listeners. Individual services can override `ssl` per-listener with their own `ssl:` block.

## How numeric settings read

The defaults in these pages are the binary's, and the Helm chart's `values.yaml` carries the same numbers. From 2.4.2:

- A key left out keeps its default, in `yarilo.yaml` and in each entry of a list (`oauth2`, `quota_warnings`, `mail_servers`).
- An explicit `0` turns a setting off (a cache, a delay, a limit, an interval that may stop), as each table says. Where off makes no sense (a timeout that must bound, a pool size, a poll interval), an explicit `0` stops the process at startup with the key's name.
- A negative value is refused, except where a page says otherwise (`lmtp_user_concurrency_limit: -1` is unlimited).

---

## `hostname` (top level)

What this installation calls itself.

<!-- @settings hostname -->

Four things read it:

- the domain part of a `Message-ID` synthesised at delivery (see [LMTP](/protocols/lmtp)),
- the LMTP `LHLO` banner,
- the `Received:` header added at delivery,
- submission's banner and `Message-ID` domain - unless `protocol.submission.hostname` is set, which overrides **submission alone**.

```yaml
hostname: mail.example.com
```

**Set it on a cluster.** The default is each process's own hostname, which is
right for a single node and wrong for several: every pod would answer with a
different name, and the identifiers they write would disagree about where the
mail came from. The correct value is the name your mail is seen under, and it is
a decision that cannot be defaulted into.

Leaving it explicitly empty is possible and produces a placeholder name in those
headers. That is deliberate: a missing setting should be visible in the mail
rather than silently plausible.

---

## `chart_version` (top level, chart-managed)

Written by the Helm chart, not by an operator. It carries the chart's own
version so a process can say whether the ConfigMap beside it was rendered by the
same release it was built from - `helm upgrade --set image.tag=X` pairs a binary
with whatever chart is on disk, and a chart older than the binary silently fails
to render keys the binary reads.

<!-- @settings chart_version -->

**Do not set it.** There is no such value in `values.yaml`, so a Helm deployment
cannot reach it. A hand-written `yarilo.yaml` that carries a different value gets
a warning at start and nothing else: refusing to start over a version string
would be a worse failure than the one being reported.

---

## `general.ssl`

Shared TLS certificate. Used by every TLS-enabled listener that does not define its own `ssl:` override.

<!-- @settings general.ssl -->

**TLS ALPN matching (the reference parity).** TLS listeners advertise ALPN protocol identifiers per IANA RFC 7301: `imap` for IMAP/IMAPS, `pop3` for POP3/POP3S, `smtp` for Submission/Submissions. Clients that send ALPN must match - mismatching connections are refused. Clients without ALPN are accepted (backward-compatibility). LMTP is internal-only and does not enforce ALPN.

```yaml
general:
  ssl:
    ssl_server_cert_file: /etc/ssl/yarilo/cert.pem
    ssl_server_key_file:  /etc/ssl/yarilo/key.pem
    ssl_server_alt_cert_file: /etc/ssl/yarilo/ecdsa.pem   # optional
    ssl_server_alt_key_file:  /etc/ssl/yarilo/ecdsa.key
    ssl_min_protocol: TLS1.2
    ssl_prefer_server_ciphers: false
```

`${ENV_VAR}` substitution is supported in all path values - no secrets in config files.

---

## `general.haproxy`

HAProxy PROXY protocol v1/v2. When `haproxy_protocol: true` is set on a service, the real client IP is extracted from the `PROXY` header. Connections from addresses outside `haproxy_trusted_networks` ignore the header (the TCP source IP is used instead).

<!-- @settings general.haproxy -->

```yaml
general:
  haproxy:
    timeout: 3
    haproxy_trusted_networks:
      - 127.0.0.1/32
      - 10.0.0.0/8
      - 172.16.0.0/12
```

Enable per-listener with `haproxy_protocol: true` in the service config. See [Services configuration](/architecture/services).

---

## `general.xclient`

SMTP XCLIENT command for trusted relay infrastructure. A relay behind which yarilo sits can pass the real client IP, hostname, and helo string via XCLIENT before the mail transaction begins.

Only a peer inside `trusted_nets` is believed. The same list decides who is told about XCLIENT at all: submission-login and lmtp-login list `XCLIENT` in their EHLO/LHLO reply only to such a peer. A peer outside it that sends XCLIENT anyway gets the same reply as a trusted one, and its address is not applied, so the reply does not reveal who is trusted.

**Supported XCLIENT attributes:** `ADDR`, `PORT`, `HELO`, `LOGIN`, `PROTO`, `SESSION`, `TTL`, `FORWARD`, plus the reference extensions `DESTADDR` (alias: `DESTIP`) and `DESTPORT` for the destination the client originally connected to (load-balancer awareness).

<!-- @settings general.xclient -->

Name your proxies' networks:

```yaml
general:
  xclient:
    trusted_nets:
      - 10.0.0.0/8
```

Enable per-listener with `xclient_protocol: true` in the service config. See [Services configuration](/architecture/services). A listener with `xclient_protocol: true` while `trusted_nets` is empty logs a warning at start: no forwarded address will be believed. The same applies to the JMAP backend's trust mode 2, which reads this list.

::: warning Upgrading
An installation that relied on the earlier default `127.0.0.1/32, 10.0.0.0/8` without writing it out now trusts nobody. A chart-rendered config writes the list explicitly, so it keeps what its values say.
:::

---

## `general.limits`

<!-- @settings general.limits -->

```yaml
general:
  limits:
    mail_max_userip_connections: 10
```

---

## `general.startup_dial_retries`

<!-- @settings general.startup_dial_retries -->

```yaml
general:
  startup_dial_retries: 3
```

## `login.login_proxy_timeout`

Read by the IMAP, POP3, Submission and ManageSieve login proxies.

<!-- @settings login.login_proxy_timeout -->

```yaml
login:
  login_proxy_timeout: 30
```

## `login` transient retries

Read by the IMAP, POP3, Submission and ManageSieve login proxies.

<!-- @settings login.transient_retries login.transient_relogin_cap -->

## Startup waits

A process that starts while a dependency rolls waits for it instead of exiting into a restart loop. The wait applies at startup only; requests do not use it.

<!-- @settings auth_service.auth_startup_wait locks_client.locks_client_startup_wait -->

## `auth_client` pool

Userdb lookups from session processes reuse pooled connections to yarilo-auth.

<!-- @settings auth_client -->

## `internal_tls` session resumption

<!-- @settings internal_tls.session_cache_size internal_tls.session_cache_ttl -->

A negative value is refused at startup for every key above.
