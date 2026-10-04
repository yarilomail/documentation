---
description: "End-to-end smoke test for a live yarilo instance — authenticate, deliver over LMTP, read over IMAP and POP3: how to run it, what it checks, reading failures."
---

# End-to-end smoke test

Drives a live yarilo instance through the full happy-path mail flow:
authenticate → deliver → read.

| Step | What it exercises |
|:---|:---|
| Submission AUTH PLAIN over STARTTLS | passdb chain, bcrypt verify, STARTTLS handshake |
| Submission AUTH LOGIN over STARTTLS | legacy SASL LOGIN mechanism (Outlook, Android MUAs) |
| LMTP delivery | storage write path, auto-provisioning of new mailboxes |
| IMAPS LOGIN command | IMAP native `LOGIN user password` (RFC 3501) |
| IMAPS AUTHENTICATE PLAIN | IMAP SASL PLAIN via AUTHENTICATE |
| POP3S USER/PASS | POP3 native `USER` + `PASS` |
| POP3S AUTH PLAIN (SASL) | POP3 SASL PLAIN via AUTH (RFC 5034), with initial response |

The harness lives in [`app/smoketest-e2e`](https://github.com/yarilomail/yarilo/tree/main/app/smoketest-e2e) and runs against any yarilo deployment exposing the listeners — local binary, docker compose, or staging cluster.

---

## Running it

The harness needs a running stack: sessions authenticate through
`yarilo-auth`, so a single server process cannot stand in for one. Locally,
that is the [Docker Compose](DOCKER-COMPOSE) stack, with a user created as
described in [Creating the first user](DOCKER-COMPOSE#creating-the-first-user).
The binary is not in the image; run it from a checkout:

```sh
go run ./app/smoketest-e2e \
  -host 127.0.0.1 -user user@example.test -pass changeit \
  -submission-port 587 -lmtp-port 24 -imaps-port 993 -pop3s-port 995
```

LMTP on 24 is published on the loopback interface only, so run it on the
Docker host. Each step prints `[PASS]` or `[FAIL]` with its name, in the
order of the table above.

The compose stack's certificate is self-signed, and `-insecure` defaults to
`true`, so the command above does not verify it. Against a deployment with a
real certificate, pass `-insecure=false`: leaving the flag out does **not**
turn verification on.

`app/smoketest-e2e/seed` writes a bcrypt user into a SQLite userdb file, for a
stack whose `yarilo-auth` reads one you can reach from the host.

---

## CLI flags

```
-host          target hostname           (default: 127.0.0.1)
-user          mailbox login             (default: alice@smoke.local)
-pass          password                  (default: wonderland)
-submission-port  STARTTLS submission    (default: 9587)
-lmtp-port        plain TCP LMTP         (default: 9024)
-imaps-port       IMAPS                  (default: 9993)
-pop3s-port       POP3S                  (default: 9995)
-insecure         skip TLS verify         (default: true — pass -insecure=false to verify)
-timeout          per-step timeout        (default: 10s)
```

Against a real deployment, point `-host` at the public hostname, use the standard ports `587 / 24 / 993 / 995`, and pass `-insecure=false`.

---

## What auto-provisioning means

When LMTP receives a message for a user whose Maildir doesn't exist, it creates `INBOX/{cur,new,tmp}/` and proceeds. This matches the reference's behavior — LMTP is internal, the upstream MTA has already vetted recipients.

If you want strict recipient validation at the LMTP layer (instead of trusting the MTA), file an issue — there's currently no `lmtp_reject_unknown_recipients` knob.

---

## Exit codes

| Code | Meaning |
|:---|:---|
| 0 | All seven steps passed. |
| 1 | One or more steps failed (details on stderr). |

## The per-rollout gate (`app/smoketest`)

The two sections below describe `app/smoketest`, the per-rollout gate covered
in [Testing](TESTING), not the end-to-end harness above.

### JMAP header forms and property validation

The last JMAP check is the only one that **writes**. It appends its own message
to a folder of its own, `YariloSmoke`, reads it back through every `header:*`
form of RFC 8621 §4.1.3, and removes both afterwards.

It brings its own message because the alternative is depending on whatever
happens to be in the mailbox — which differs per deployment, so a green run
would mean different things in different places.

**The folder rather than INBOX** because the check runs on every rollout, and a
message left behind changes the mailbox every other measurement is taken
against. Cleanup is best effort and **reported when it fails**: leaving the
folder is recoverable, not knowing it was left is not.

It needs `-jmap-user` and `-jmap-pass`, and it is skipped without them.

What it asserts beyond the forms themselves:

- the response carries **only** the requested properties — an unprojected answer
  states `hasAttachment: false` for a message that has one;
- a missing header is answered `null` and is **present** in the object, checked
  separately from its value because in Go a missing key and a null value are
  both `nil`;
- a misspelled property is refused with `invalidArguments` — silence there is
  indistinguishable from a property yarilo has not implemented;
- `headers` lists every field in the order the message carries them.

### What the gate writes, and what it removes

It writes. Run it against an account whose mail you are willing to have touched
in the ways below, and nothing else.

| check | writes | removes |
|:---|:---|:---|
| sieve checks | one message per check, delivered by LMTP | its own message, by the unique subject it sent |
| sieve `fileinto` and friends | messages into folders they create | those folders' contents |
| FTS | one message with a unique marker | nothing |
| JMAP header forms | one message in `YariloSmoke` | that message and the folder |

**It does not empty INBOX**, and must not. It did until #1056: a helper selected
INBOX, searched for everything and expunged it, twenty-five times per run.
Nothing in the flags or in this document said the account had to be disposable,
and the loss was silent — the delete ignored its error and the helper returned
nothing on any failure path.

Every check identifies its own message by a unique subject or marker, which is
what it needed all along; the clearing was defensive and destructive at once.
`TestNothingEmptiesTheInbox` reads the source and fails on any function that
selects INBOX, searches `ALL` and deletes the result — deleting a message the
check itself sent stays allowed, because the fault was the breadth and not the
delete.
