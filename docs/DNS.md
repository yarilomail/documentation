---
description: "The DNS records a mail domain needs — A/AAAA, MX, SPF, DKIM, DMARC and PTR — with examples, why nameserver redundancy matters, and how to verify with dig."
---

# DNS records for a mail domain: MX, SPF, DKIM, DMARC and PTR

The DNS records a mail domain needs before yarilo can receive and send mail
reliably, and why the nameservers serving them need redundancy of their own.
For the cluster-side setup see the [Installation Guide](./INSTALL).

## Why DNS matters for mail

Every hop of a message starts with a DNS lookup. A sending server resolves the
recipient domain's MX record, then the A/AAAA record of the host it names.
Receiving servers look up SPF, DKIM and DMARC to decide whether to accept the
message, and check the PTR record of the connecting IP.

If any of those lookups fails, the message is not lost immediately — sending
servers queue and retry for hours or days — but delivery stalls, bounces
appear, and reputation suffers. A mail domain is only as reachable as its DNS.

## Required records

The minimum set for a production domain served by yarilo behind an inbound
MTA. Replace `example.com` and `mail.example.com` with your own names.

| Record | Name | Purpose |
|:---|:---|:---|
| A / AAAA | `mail.example.com` | Address of the public mail host (the LoadBalancer IP) |
| MX | `example.com` | Names the host that accepts inbound mail on port 25 |
| TXT (SPF) | `example.com` | Which hosts may send mail for the domain |
| TXT (DKIM) | `<selector>._domainkey.example.com` | Public key used to verify message signatures |
| TXT (DMARC) | `_dmarc.example.com` | Policy for messages that fail SPF or DKIM |
| PTR | reverse of the mail host IP | Maps the sending IP back to `mail.example.com` |

### Address record

Point the public hostname at the LoadBalancer IP your cluster assigned:

```
mail.example.com.   3600  IN  A     203.0.113.10
mail.example.com.   3600  IN  AAAA  2001:db8::10
```

This is the hostname clients connect to for IMAP, POP3 and submission, and the
hostname the TLS certificate is issued for.

### MX record

Name the host that accepts inbound mail for the domain:

```
example.com.   3600  IN  MX  10 mail.example.com.
```

The MX target must be a hostname with an A/AAAA record, never an IP address
and never a CNAME. In a yarilo deployment this host runs the inbound MTA that
delivers to `yarilo-lmtp` — see [LMTP](./LMTP).

### SPF

Declare which hosts may send mail for the domain:

```
example.com.   3600  IN  TXT  "v=spf1 mx -all"
```

`mx` authorises the MX hosts; add `ip4:` / `ip6:` entries for any relay that
sends on the domain's behalf. Use `-all` (fail) once every sender is listed.

### DKIM

Publish the public key of the signing MTA under a selector:

```
mail._domainkey.example.com.   3600  IN  TXT  "v=DKIM1; k=rsa; p=MIIBIjANBg..."
```

The selector (`mail` here) is chosen in the MTA's DKIM configuration. Rotate
keys by publishing a new selector before switching the signer to it.

### DMARC

Tell receivers what to do with messages that fail SPF and DKIM alignment:

```
_dmarc.example.com.   3600  IN  TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"
```

Start with `p=none` to collect reports, then move to `quarantine` and
`reject` once the reports show only legitimate senders.

### PTR

The reverse record is set by whoever controls the IP range — your hosting
provider or cloud console, not your domain's zone:

```
10.113.0.203.in-addr.arpa.   3600  IN  PTR  mail.example.com.
```

The PTR must resolve back to the same hostname the MTA announces in its
`EHLO`. Many receivers reject or greylist connections from IPs without a
matching PTR.

## Optional records

| Record | Name | Purpose |
|:---|:---|:---|
| SRV | `_imaps._tcp`, `_submission._tcp` | Client autodiscovery (RFC 6186) |
| TXT | `_mta-sts.example.com` | MTA-STS policy for enforced inbound TLS |
| TXT | `_smtp._tls.example.com` | TLS-RPT reporting address |
| TLSA | `_25._tcp.mail.example.com` | DANE, only with a DNSSEC-signed zone |

MTA-STS needs more than the TXT record: the policy itself is a text file
served over HTTPS at `https://mta-sts.example.com/.well-known/mta-sts.txt`,
so the record alone has no effect until that host is up.

Autodiscovery lets mail clients find the IMAP and submission hosts from the
address alone:

```
_imaps._tcp.example.com.        3600  IN  SRV  0 1 993  mail.example.com.
_submission._tcp.example.com.   3600  IN  SRV  0 1 587  mail.example.com.
```

## Nameserver redundancy

The records above live on authoritative nameservers, and those are a single
point of failure that is easy to overlook. If the only nameserver for
`example.com` is down — host maintenance, a provider outage, a DDoS on the
DNS host — every lookup above fails at once. Inbound mail queues at the
sender, outbound mail is rejected for a missing SPF or PTR match, and clients
cannot even resolve `mail.example.com` to log in. The mail server itself may
be perfectly healthy.

RFC 2182 recommends at least two authoritative nameservers on separate
networks, and most registries refuse to delegate a domain to fewer than two.
Running one nameserver and listing it twice under different names does not
count: both names fail together.

A secondary nameserver keeps a live copy of the zone through AXFR zone
transfers and keeps answering while the primary is unavailable. It can be a
second server you operate in a different network, or a hosted secondary DNS
service that pulls the zone from your primary — see
[DNS redundancy and secondary nameservers](https://seconddns.com/docs/guides/dns-redundancy)
for how zone transfers and SOA refresh timers keep the copies in sync.

::: tip Checking the delegation
List the nameservers the registry has on file and confirm each answers for
the zone:

```sh
dig NS example.com +short
dig @ns1.example.com example.com SOA +short
dig @ns2.example.com example.com SOA +short
```

Both SOA answers must return the same serial. A lagging serial means zone
transfers are not reaching the secondary — see
[Understanding AXFR zone transfers](https://seconddns.com/docs/guides/axfr-zone-transfer)
for how a transfer is requested and where it typically fails.
:::

## Verifying the records

Check each record from outside your network before sending the first message:

```sh
dig MX example.com +short
dig TXT example.com +short
dig TXT mail._domainkey.example.com +short
dig TXT _dmarc.example.com +short
dig -x 203.0.113.10 +short
```

This sequence:

- confirms the MX points at a resolvable host
- shows the SPF and DMARC policies as receivers see them
- proves the DKIM key is published under the selector the signer uses
- verifies the PTR resolves back to the mail hostname

::: note
DNS changes propagate at the speed of the record's TTL. Lower the TTL to a
few minutes before a planned change, then raise it again once the change has
settled.
:::
