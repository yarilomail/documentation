---
description: "Yarilo is a cloud-native mail server in Go for Kubernetes: IMAP, POP3, LMTP, Submission, JMAP and Sieve. Install, configure, deploy, migrate and operate it."
---

# Yarilo Documentation

Yarilo is a mail server written in Go and built for Kubernetes. It serves IMAP, POP3, LMTP, Submission, JMAP and ManageSieve, filters mail with Sieve, and stores it in maildir, sdbox or mdbox.

One set of binaries covers every shape, from a single node to a director ring in front of several backends. Moving between shapes is a change to the configuration, not to the software.

## Getting a server running

- [Installation](/installation/) — the first working instance, with Docker Compose or the Helm chart.
- [DNS for a mail domain](/installation/dns) — MX, SPF, DKIM, DMARC and PTR records.
- [General configuration](/installation/general) — how `yarilo.yaml` is laid out, TLS and hostnames.

## Configuring mail

- Protocols: [IMAP](/protocols/imap), [POP3](/protocols/pop3), [LMTP](/protocols/lmtp), [Submission](/protocols/submission) and [JMAP](/protocols/jmap).
- [Authentication](/auth/) — password databases, [SCRAM](/auth/scram), [OAuth 2.0](/auth/oauth2) and [master users](/auth/master_users).
- [Mailbox storage](/storage/) — formats, [namespaces](/storage/namespace) and [quota](/storage/quota).
- [Sieve](/features/sieve) and [full-text search](/features/fts).

## Running it in production

- [Deployment](/installation/deployment) — the Helm chart, sizing, and the standalone and director layouts.
- [Architecture](/architecture/) — the services and how a user is routed to a backend.
- [yarctl](/operations/yarilo_admin) for day-to-day administration, and [smoke tests](/operations/smoke) after each rollout.

## Moving from another server

- [Migration](/installation/migration) — converting existing mailboxes and keeping message identifiers stable.
- [Feature coverage](/architecture/parity) — what is implemented, feature by feature, and what is not.

## Reference

- [All settings](/reference/settings) — every `yarilo.yaml` key with its type, default and chart value.
- [RFC support](/reference/rfcs) — the standards each service implements, and how far.

Source code and issues live on [GitHub](https://github.com/yarilomail).
