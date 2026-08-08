---
layout: home

hero:
  name: Yarilo
  text: Cloud-native mail server
  tagline: IMAP, POP3, LMTP, Submission, JMAP and Sieve — built in Go for Kubernetes.
  image:
    src: /icon.svg
    alt: Yarilo
  actions:
    - theme: brand
      text: Get Started
      link: /INSTALL
    - theme: alt
      text: Architecture
      link: /ARCHITECTURE
    - theme: alt
      text: GitHub
      link: https://github.com/yarilomail

features:
  - title: Full protocol suite
    details: IMAP4rev1/rev2, POP3, LMTP, Submission and JMAP, with SASL mechanisms including SCRAM, OAuth2 and more.
  - title: Horizontally scalable
    details: Director ring routes users to backends; every deployment shape is a config change, never a different binary.
  - title: Familiar storage
    details: maildir, mdbox and sdbox mailbox formats with quota, namespaces, shared folders and full-text search.
  - title: Kubernetes-first
    details: Helm chart, Prometheus metrics, admin API and CLI tooling for day-2 operations.
---
