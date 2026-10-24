---
description: "yarilo-autoconfig tells Thunderbird and Outlook which hosts and ports to use for an address: what it serves, how to deploy it, the DNS records a domain publishes, and which clients still need manual setup."
---

# Mail client autoconfiguration

`yarilo-autoconfig` tells a mail client which hosts and ports to use for an
address, so the user types only the address and the password. It answers two
formats:

- the autoconfig XML that Thunderbird (desktop and Android) and FairEmail
  read;
- the POX Autodiscover answer that classic Outlook for Windows reads.

It is a separate service with its own
[repository](https://github.com/yarilomail/yarilo-autoconfig), image and Helm
chart. It does not talk to yarilo and keeps no list of domains: every address
gets the same hosts from its configuration, and addresses are never looked up,
so the service cannot be used to find out which mailboxes exist.

## Which clients configure themselves

| Client | How it finds the settings |
|:---|:---|
| Thunderbird, Thunderbird for Android | the domain's MX record, then `autoconfig.` on the MX domain |
| FairEmail | the same autoconfig XML, and RFC 6186 SRV records |
| Outlook (classic, Windows) | the `_autodiscover._tcp` SRV record, after one confirmation prompt |
| New Outlook for Windows, Outlook mobile | manual setup |
| Gmail app, Samsung Email | manual setup |
| Apple Mail (iOS, iPadOS, macOS) | manual setup |

Users of the clients marked manual enter the IMAP and SMTP hosts and ports
from the [settings](#settings) themselves.

## Choosing the host names

Thunderbird reaches the service only through the domain's MX record. It takes
the first MX host, drops its first label and asks `autoconfig.` on what is
left. With MX `mx.example.net` the service must answer at
`autoconfig.example.net`:

- renaming `mx` to `mx01` changes nothing;
- moving the MX under another domain moves the autoconfig host with it.

A domain whose first MX is not yours, such as a third-party spam filter,
sends Thunderbird to that provider instead and gets no autoconfiguration.

Outlook reaches the service through an SRV record that points at
`autodiscover.` on your domain, so serve both names:

- `autoconfig.example.net`
- `autodiscover.example.net`

## Deploying the service

Install the chart from the repository, with the two hosts every answer points
at:

```sh
git clone https://github.com/yarilomail/yarilo-autoconfig.git
helm upgrade --install yarilo-autoconfig ./yarilo-autoconfig/helm -n mail \
  --set config.imap_host=imap.example.net \
  --set config.smtp_host=smtp.example.net \
  --set ingress.enabled=true \
  --set ingress.tlsSecretName=autoconfig-tls \
  --set 'ingress.hosts={autoconfig.example.net,autodiscover.example.net}'
```

This installs:

- two replicas of the service, with a PodDisruptionBudget;
- an Ingress for both hosts, serving the certificate in `autoconfig-tls`;
- health and metrics on a separate port that the Ingress does not expose.

The chart refuses to render without `config.imap_host` and
`config.smtp_host`. The service itself refuses to start on an invalid value
and lists every problem in its log.

## Settings

Each key under `config:` in the chart becomes the environment variable of the
same name in upper case (`imap_host` becomes `IMAP_HOST`). An empty value
keeps the default.

| Value | Default | Meaning |
|:---|:---|:---|
| `config.imap_host` | none | IMAP host, implicit TLS (required) |
| `config.imap_port` | `993` | |
| `config.smtp_host` | none | submission host (required) |
| `config.smtp_implicit_tls_port` | `465` | `0` = not offered |
| `config.smtp_starttls_port` | `587` | `0` = not offered |
| `config.pop3_host` | empty | empty = POP3 not offered |
| `config.pop3_port` | `995` | |
| `config.display_name` | `Mail` | provider name the client shows |
| `config.dav_url` | empty | target of the `/.well-known/caldav` and `/.well-known/carddav` redirects |
| `config.jmap_url` | empty | target of the `/.well-known/jmap` redirect |
| `logLevel` | empty | `debug` logs each answer with its domain, never the address |

Submission with implicit TLS is offered before STARTTLS, as RFC 8314
recommends. Thunderbird gets both, port 465 first. Outlook takes a single SMTP
entry: 465, or 587 when implicit TLS is off. IMAP and POP3 are offered with
implicit TLS only.

The `.well-known` redirects are a convenience for a user who types the
autoconfig host into a calendar or JMAP client. Real discovery for those
protocols uses SRV records pointing at the services themselves.

## DNS records for a mail domain

Every domain whose users should be configured automatically publishes these
records. Replace `customer.example` with the mail domain and `example.net`
with your provider domain:

```
customer.example.                     IN  MX   10 mx.example.net.
_autodiscover._tcp.customer.example.  IN  SRV  0 0 443 autodiscover.example.net.
_imaps._tcp.customer.example.         IN  SRV  0 1 993 imap.example.net.
_submissions._tcp.customer.example.   IN  SRV  0 1 465 smtp.example.net.
_submission._tcp.customer.example.    IN  SRV  10 1 587 smtp.example.net.
```

These records:

- let Thunderbird find `autoconfig.example.net` through the MX;
- send Outlook to `autodiscover.example.net`;
- give RFC 6186 clients the IMAP and submission hosts, with implicit TLS
  preferred.

::: warning No autodiscover host on the mail domain
Do not create `autodiscover.customer.example` in any form, including a
wildcard record. Outlook tries that name before the SRV record, stops at the
certificate error it gets there and never reads the SRV record.
:::

Outlook shows a prompt the first time it follows the SRV record to another
domain, asking whether to let `autodiscover.example.net` configure the
account. That prompt is expected.

See [DNS for a mail domain](/installation/dns) for the records every mail
domain needs regardless of autoconfiguration.

## Verifying

Fetch the Thunderbird answer the way Thunderbird does:

```sh
curl -s 'https://autoconfig.example.net/mail/config-v1.1.xml?emailaddress=alice@customer.example'
```

Fetch the Outlook answer:

```sh
curl -s https://autodiscover.example.net/autodiscover/autodiscover.xml \
  -H 'Content-Type: text/xml' \
  --data '<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006"><Request><EMailAddress>alice@customer.example</EMailAddress><AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema></Request></Autodiscover>'
```

Check the records of a mail domain:

```sh
dig MX customer.example +short
dig SRV _autodiscover._tcp.customer.example +short
dig A autodiscover.customer.example +short
```

The last command must return nothing.
