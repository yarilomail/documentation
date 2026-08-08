# Yarilo Documentation

Yarilo is a cloud-native mail server written in Go: IMAP, POP3, LMTP, Submission, JMAP and Sieve, designed for Kubernetes.

## Where to start

- [Installation](./INSTALL) — get a working instance up.
- [General Configuration](./GENERAL) — `yarilo.yaml` structure and core settings.
- [Architecture Overview](./ARCHITECTURE) — services, deployment topologies, the director ring.
- [Deployment](./DEPLOYMENT) — Helm chart and production layouts.

## Highlights

- **Full protocol suite** — IMAP4rev1/rev2, POP3, LMTP, Submission and JMAP, with SASL mechanisms including SCRAM and OAuth2.
- **Horizontally scalable** — the director ring routes users to backends; every deployment shape is a config change, never a different binary.
- **Familiar storage** — maildir, mdbox and sdbox mailbox formats with quota, namespaces, shared folders and full-text search.
- **Kubernetes-first** — Helm chart, Prometheus metrics, admin API and CLI tooling for day-2 operations.

Browse the full documentation using the sidebar. Source code and issues live on [GitHub](https://github.com/yarilomail).
