# General configuration

The `general` section defines infrastructure settings shared across all listeners. Individual services can override `ssl` per-listener with their own `ssl:` block.

---

## `hostname` (top level)

What this installation calls itself. It is not inside `general:` — it sits at
the top level of `yarilo.yaml`, because more than one section needs it.

| Key | Default | Description |
|:---|:---|:---|
| `hostname` | the host's own name (`os.Hostname()`) | The name yarilo answers with and stamps into mail. |

Four things read it:

- the domain part of a `Message-ID` synthesised at delivery (see [LMTP](LMTP)),
- the LMTP `LHLO` banner,
- the `Received:` header added at delivery,
- submission's banner and `Message-ID` domain — unless `protocol.submission.hostname` is set, which overrides **submission alone**.

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
same release it was built from — `helm upgrade --set image.tag=X` pairs a binary
with whatever chart is on disk, and a chart older than the binary silently fails
to render keys the binary reads.

**Do not set it.** There is no such value in `values.yaml`, so a Helm deployment
cannot reach it. A hand-written `yarilo.yaml` that carries a different value gets
a warning at start and nothing else: refusing to start over a version string
would be a worse failure than the one being reported.

---

## `general.ssl`

Shared TLS certificate. Used by every TLS-enabled listener that does not define its own `ssl:` override.

| Key | Default | Description |
|:---|:---|:---|
| `ssl_server_cert_file` | — | Path to PEM certificate (or full chain). `${ENV_VAR}` expanded at startup. |
| `ssl_server_key_file` | — | Path to PEM private key matching `ssl_server_cert_file`. |
| `ssl_server_alt_cert_file` | — | Optional second certificate (e.g. ECDSA) for dual-cert SNI. |
| `ssl_server_alt_key_file` | — | Private key for `ssl_server_alt_cert_file`. |
| `ssl_min_protocol` | `TLS1.2` | Minimum TLS version: `TLS1.2` \| `TLS1.3`. |
| `ssl_prefer_server_ciphers` | `false` | Use server cipher-suite preference order. |

**TLS ALPN matching (the reference parity).** TLS listeners advertise ALPN protocol identifiers per IANA RFC 7301: `imap` for IMAP/IMAPS, `pop3` for POP3/POP3S, `smtp` for Submission/Submissions. Clients that send ALPN must match — mismatching connections are refused. Clients without ALPN are accepted (backward-compatibility). LMTP is internal-only and does not enforce ALPN.

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

`${ENV_VAR}` substitution is supported in all path values — no secrets in config files.

---

## `general.haproxy`

HAProxy PROXY protocol v1/v2. When `haproxy_protocol: true` is set on a service, the real client IP is extracted from the `PROXY` header. Connections from addresses outside `haproxy_trusted_networks` ignore the header (the TCP source IP is used instead).

| Key | Default | Description |
|:---|:---|:---|
| `timeout` | `3` | Seconds to wait for the PROXY header. Connection closed if header not received in time. |
| `haproxy_trusted_networks` | `["127.0.0.1/32", "10.0.0.0/8"]` | CIDRs whose PROXY headers are accepted. |

```yaml
general:
  haproxy:
    timeout: 3
    haproxy_trusted_networks:
      - 127.0.0.1/32
      - 10.0.0.0/8
      - 172.16.0.0/12
```

Enable per-listener with `haproxy_protocol: true` in the service config. See [SERVICES.md](SERVICES.md).

---

## `general.xclient`

SMTP XCLIENT command for trusted relay infrastructure. A relay behind which yarilo sits can pass the real client IP, hostname, and helo string via XCLIENT before the mail transaction begins. Only connections from `trusted_nets` are allowed to send XCLIENT.

**Supported XCLIENT attributes:** `ADDR`, `PORT`, `HELO`, `LOGIN`, `PROTO`, `SESSION`, `TTL`, `FORWARD`, plus the reference extensions `DESTADDR` (alias: `DESTIP`) and `DESTPORT` for the destination the client originally connected to (load-balancer awareness).

| Key | Default | Description |
|:---|:---|:---|
| `trusted_nets` | `["127.0.0.1/32", "10.0.0.0/8"]` | CIDRs allowed to issue XCLIENT. |

```yaml
general:
  xclient:
    trusted_nets:
      - 127.0.0.1/32
      - 10.0.0.0/8
```

Enable per-listener with `xclient_protocol: true` in the service config. See [SERVICES.md](SERVICES.md).

---

## `general.limits`

| Key | Default | Description |
|:---|:---|:---|
| `mail_max_userip_connections` | `10` | Max simultaneous connections per user+IP pair, counted across all IMAP and POP3 listeners. `0` = unlimited. |

```yaml
general:
  limits:
    mail_max_userip_connections: 10
```
