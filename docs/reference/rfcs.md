---
description: "The RFCs yarilo implements, by service: IMAP, POP3, Submission, LMTP, JMAP, Sieve and ManageSieve, authentication, message format and the policy server, each with its state."
---

# RFC support

The standards each yarilo service implements, and how far. A row is **yes** only when the code serves it and, for an extension a client discovers, the server advertises it: a command a client is never told about is, to that client, absent.

| | meaning |
|:---|:---|
| **yes** | implemented and advertised where the protocol advertises |
| **partial** | usable with the limit given in the note |
| **no** | not implemented; listed because clients or other servers commonly use it |

Drafts and vendor protocols that yarilo also speaks are listed at the end of each section, without a number. [Feature coverage](/architecture/parity) is the same picture by feature rather than by standard.

## IMAP

Served by `yarilo-imap`, through `yarilo-imap-login`. Extensions marked *after login* are in `CAPABILITY` once the client is authenticated.

| RFC | Title | State | Notes |
|:---|:---|:---|:---|
| [9051](https://www.rfc-editor.org/rfc/rfc9051) | IMAP4rev2 | yes | |
| [3501](https://www.rfc-editor.org/rfc/rfc3501) | IMAP4rev1 | yes | |
| [2177](https://www.rfc-editor.org/rfc/rfc2177) | IDLE | yes | |
| [2342](https://www.rfc-editor.org/rfc/rfc2342) | NAMESPACE | yes | after login; see [Namespaces](/storage/namespace) |
| [2971](https://www.rfc-editor.org/rfc/rfc2971) | ID | yes | before login always; after login while `imap_id_send` is non-empty; with `imap_id_retain`, the client's `ID` goes to the [policy server](/auth/policy) as `device_id` |
| [3516](https://www.rfc-editor.org/rfc/rfc3516) | BINARY | yes | after login |
| [3691](https://www.rfc-editor.org/rfc/rfc3691) | UNSELECT | yes | after login |
| [4314](https://www.rfc-editor.org/rfc/rfc4314) | ACL | yes | after login, with `acl.enabled` (off by default) |
| [4315](https://www.rfc-editor.org/rfc/rfc4315) | UIDPLUS | yes | after login |
| [4731](https://www.rfc-editor.org/rfc/rfc4731) | ESEARCH | yes | after login |
| [4959](https://www.rfc-editor.org/rfc/rfc4959) | SASL-IR | yes | |
| [5161](https://www.rfc-editor.org/rfc/rfc5161) | ENABLE | yes | after login |
| [5182](https://www.rfc-editor.org/rfc/rfc5182) | SEARCHRES | yes | after login |
| [5256](https://www.rfc-editor.org/rfc/rfc5256) | SORT, THREAD | yes | after login: `SORT`, `THREAD=REFERENCES`, `THREAD=ORDEREDSUBJECT` |
| [5258](https://www.rfc-editor.org/rfc/rfc5258) | LIST-EXTENDED | yes | after login |
| [5464](https://www.rfc-editor.org/rfc/rfc5464) | METADATA | yes | after login, when a `metadata` dict is configured |
| [5465](https://www.rfc-editor.org/rfc/rfc5465) | NOTIFY | partial | after login; annotation and metadata events are not reported |
| [5819](https://www.rfc-editor.org/rfc/rfc5819) | LIST-STATUS | yes | after login |
| [6154](https://www.rfc-editor.org/rfc/rfc6154) | SPECIAL-USE, CREATE-SPECIAL-USE | yes | after login |
| [6851](https://www.rfc-editor.org/rfc/rfc6851) | MOVE | yes | after login |
| [6855](https://www.rfc-editor.org/rfc/rfc6855) | UTF8=ACCEPT | yes | after login |
| [7162](https://www.rfc-editor.org/rfc/rfc7162) | CONDSTORE, QRESYNC | yes | after login |
| [7888](https://www.rfc-editor.org/rfc/rfc7888) | LITERAL+ | yes | |
| [8438](https://www.rfc-editor.org/rfc/rfc8438) | STATUS=SIZE | yes | after login |
| [8474](https://www.rfc-editor.org/rfc/rfc8474) | OBJECTID | yes | after login: `MAILBOXID`, `EMAILID`, `THREADID` |
| [9208](https://www.rfc-editor.org/rfc/rfc9208) | QUOTA | yes | after login, while `imap_quota` is on (the default) |
| [3348](https://www.rfc-editor.org/rfc/rfc3348) | CHILDREN | no | not advertised |
| [3502](https://www.rfc-editor.org/rfc/rfc3502) | MULTIAPPEND | no | |
| [4467](https://www.rfc-editor.org/rfc/rfc4467) | URLAUTH | no | |
| [4469](https://www.rfc-editor.org/rfc/rfc4469) | CATENATE | no | |
| [4978](https://www.rfc-editor.org/rfc/rfc4978) | COMPRESS=DEFLATE | no | |
| [5255](https://www.rfc-editor.org/rfc/rfc5255) | I18NLEVEL | no | SORT and THREAD collate with `i;unicode-casemap`, but the extension is not advertised |
| [5267](https://www.rfc-editor.org/rfc/rfc5267) | ESORT, CONTEXT=SEARCH, CONTEXT=SORT | no | |
| [5957](https://www.rfc-editor.org/rfc/rfc5957) | SORT=DISPLAY | no | |
| [7889](https://www.rfc-editor.org/rfc/rfc7889) | APPENDLIMIT | no | not advertised; the size limit still applies |
| [8437](https://www.rfc-editor.org/rfc/rfc8437) | UNAUTHENTICATE | no | |
| [8508](https://www.rfc-editor.org/rfc/rfc8508) | REPLACE | no | |
| [8514](https://www.rfc-editor.org/rfc/rfc8514) | SAVEDATE | no | |
| [8970](https://www.rfc-editor.org/rfc/rfc8970) | PREVIEW | no | |

See [IMAP](/protocols/imap) for the settings.

## POP3

Served by `yarilo-pop3`, through `yarilo-pop3-login`.

| RFC | Title | State | Notes |
|:---|:---|:---|:---|
| [1939](https://www.rfc-editor.org/rfc/rfc1939) | POP3 | yes | |
| [2449](https://www.rfc-editor.org/rfc/rfc2449) | Extension mechanism | yes | `CAPA` with `TOP`, `UIDL`, `USER`, `RESP-CODES`, `PIPELINING`; `EXPIRE` and `LOGIN-DELAY` are not advertised |
| [2595](https://www.rfc-editor.org/rfc/rfc2595) | STLS | yes | on a listener with STARTTLS |
| [3206](https://www.rfc-editor.org/rfc/rfc3206) | SYS and AUTH response codes | yes | `AUTH-RESP-CODE` |
| [5034](https://www.rfc-editor.org/rfc/rfc5034) | SASL authentication | yes | |
| [1460](https://www.rfc-editor.org/rfc/rfc1460) | `LAST` | yes | with `pop3_enable_last`; the command was dropped from POP3 by RFC 1725 |
| [6856](https://www.rfc-editor.org/rfc/rfc6856) | UTF8 | no | |

See [POP3](/protocols/pop3).

## Submission

Served by `yarilo-submission`, through `yarilo-submission-login`, which answers `EHLO` until the client has authenticated. The client keeps that answer for the session, so it lists the extensions `yarilo-submission` serves, with the same limits.

| RFC | Title | State | Notes |
|:---|:---|:---|:---|
| [5321](https://www.rfc-editor.org/rfc/rfc5321) | SMTP | yes | |
| [6409](https://www.rfc-editor.org/rfc/rfc6409) | Message submission | yes | relayed to an external MTA |
| [3207](https://www.rfc-editor.org/rfc/rfc3207) | STARTTLS | yes | port 587 |
| [8314](https://www.rfc-editor.org/rfc/rfc8314) | Implicit TLS | yes | port 465 |
| [4954](https://www.rfc-editor.org/rfc/rfc4954) | AUTH | yes | |
| [6152](https://www.rfc-editor.org/rfc/rfc6152) | 8BITMIME | yes | |
| [1870](https://www.rfc-editor.org/rfc/rfc1870) | SIZE | yes | the `submission_max_mail_size` limit |
| [2920](https://www.rfc-editor.org/rfc/rfc2920) | PIPELINING | yes | |
| [2034](https://www.rfc-editor.org/rfc/rfc2034) | ENHANCEDSTATUSCODES | yes | |
| [3030](https://www.rfc-editor.org/rfc/rfc3030) | CHUNKING | yes | |
| [9422](https://www.rfc-editor.org/rfc/rfc9422) | LIMITS | yes | `RCPTMAX` when `submission_max_recipients` is set |
| [3461](https://www.rfc-editor.org/rfc/rfc3461) | DSN | no | |
| [3030](https://www.rfc-editor.org/rfc/rfc3030) | BINARYMIME | no | |
| [4468](https://www.rfc-editor.org/rfc/rfc4468) | BURL | no | |
| [6531](https://www.rfc-editor.org/rfc/rfc6531) | SMTPUTF8 | no | |
| [8689](https://www.rfc-editor.org/rfc/rfc8689) | REQUIRETLS | no | |

Also spoken: `XCLIENT` (Postfix), toward a relay that advertises it and from peers in `general.xclient.trusted_nets`. See [Submission](/protocols/submission).

## LMTP

Served by `yarilo-lmtp`, through `yarilo-lmtp-login`, which answers `LHLO` itself.

| RFC | Title | State | Notes |
|:---|:---|:---|:---|
| [2033](https://www.rfc-editor.org/rfc/rfc2033) | LMTP | yes | |
| [6152](https://www.rfc-editor.org/rfc/rfc6152) | 8BITMIME | yes | |
| [1870](https://www.rfc-editor.org/rfc/rfc1870) | SIZE | yes | the `quota_mail_size` limit when set |
| [2920](https://www.rfc-editor.org/rfc/rfc2920) | PIPELINING | yes | |
| [2034](https://www.rfc-editor.org/rfc/rfc2034) | ENHANCEDSTATUSCODES | yes | |
| [3030](https://www.rfc-editor.org/rfc/rfc3030) | CHUNKING | yes | |
| [9422](https://www.rfc-editor.org/rfc/rfc9422) | LIMITS | yes | `RCPTMAX` when `lmtp_max_recipients` is set |
| [3461](https://www.rfc-editor.org/rfc/rfc3461) | DSN | partial | `ORCPT` is accepted; `DSN` is not advertised |
| [6531](https://www.rfc-editor.org/rfc/rfc6531) | SMTPUTF8 | no | |

Also spoken: `XCLIENT` (Postfix), from peers in `general.xclient.trusted_nets`. See [LMTP](/protocols/lmtp).

## JMAP

Served by `yarilo-jmap`, through `yarilo-jmap-login`.

| RFC | Title | State | Notes |
|:---|:---|:---|:---|
| [8620](https://www.rfc-editor.org/rfc/rfc8620) | JMAP core | yes | session, request envelope, back-references, blob upload and download |
| [8620 §7.3](https://www.rfc-editor.org/rfc/rfc8620#section-7.3) | Push over EventSource | yes | a write on any pod reaches the stream as a `yarilo-locks` event; off with `jmap_push_poll: 0`, see [Push](/protocols/jmap#push) |
| [8621](https://www.rfc-editor.org/rfc/rfc8621) | JMAP for Mail | yes | `Mailbox/queryChanges` and `Email/queryChanges` answer `cannotCalculateChanges`, which the RFC allows |
| [8621 §7](https://www.rfc-editor.org/rfc/rfc8621#section-7) | Submission | yes | when a relay is configured; identities are read-only |
| [8621 §8](https://www.rfc-editor.org/rfc/rfc8621#section-8) | Vacation response | yes | with Sieve vacation on |
| [9425](https://www.rfc-editor.org/rfc/rfc9425) | JMAP for Quotas | yes | read-only |
| [9661](https://www.rfc-editor.org/rfc/rfc9661) | JMAP for Sieve scripts | yes | |
| [8620 §7.2](https://www.rfc-editor.org/rfc/rfc8620#section-7.2) | PushSubscription | no | |
| [8887](https://www.rfc-editor.org/rfc/rfc8887) | JMAP over WebSocket | no | |

See [JMAP](/protocols/jmap#capabilities).

## Sieve and ManageSieve

Scripts run at delivery; `sieve_extensions` narrows the set a deployment offers.

| RFC | Title | State | Notes |
|:---|:---|:---|:---|
| [5804](https://www.rfc-editor.org/rfc/rfc5804) | ManageSieve | yes | |
| [5228](https://www.rfc-editor.org/rfc/rfc5228) | Sieve | yes | `fileinto`, `reject`, `envelope`, `encoded-character` |
| [3894](https://www.rfc-editor.org/rfc/rfc3894) | `copy` | yes | |
| [5173](https://www.rfc-editor.org/rfc/rfc5173) | `body` | yes | |
| [5183](https://www.rfc-editor.org/rfc/rfc5183) | `environment` | yes | |
| [5229](https://www.rfc-editor.org/rfc/rfc5229) | `variables` | yes | |
| [5230](https://www.rfc-editor.org/rfc/rfc5230) | `vacation` | yes | |
| [5231](https://www.rfc-editor.org/rfc/rfc5231) | `relational` | yes | |
| [5232](https://www.rfc-editor.org/rfc/rfc5232) | `imap4flags` | yes | |
| [5233](https://www.rfc-editor.org/rfc/rfc5233) | `subaddress` | yes | |
| [5235](https://www.rfc-editor.org/rfc/rfc5235) | `spamtest`, `spamtestplus`, `virustest` | yes | report "not scanned" until a status header is configured |
| [5260](https://www.rfc-editor.org/rfc/rfc5260) | `date`, `index` | yes | |
| [5293](https://www.rfc-editor.org/rfc/rfc5293) | `editheader` | yes | |
| [5429](https://www.rfc-editor.org/rfc/rfc5429) | `ereject` | yes | |
| [5435](https://www.rfc-editor.org/rfc/rfc5435) | `enotify` | yes | |
| [5436](https://www.rfc-editor.org/rfc/rfc5436) | `mailto` notification method | yes | |
| [5463](https://www.rfc-editor.org/rfc/rfc5463) | `ihave` | yes | |
| [5490](https://www.rfc-editor.org/rfc/rfc5490) | `mailbox`, `mboxmetadata`, `servermetadata` | yes | |
| [5703](https://www.rfc-editor.org/rfc/rfc5703) | `foreverypart`, `mime`, `extracttext`, `replace`, `enclose` | yes | |
| [6131](https://www.rfc-editor.org/rfc/rfc6131) | `vacation-seconds` | yes | |
| [6609](https://www.rfc-editor.org/rfc/rfc6609) | `include` | yes | |
| [6785](https://www.rfc-editor.org/rfc/rfc6785) | IMAP events (`imapsieve`) | yes | |
| [7352](https://www.rfc-editor.org/rfc/rfc7352) | `duplicate` | yes | |
| [8579](https://www.rfc-editor.org/rfc/rfc8579) | `special-use` | yes | |
| [8580](https://www.rfc-editor.org/rfc/rfc8580) | `fcc` | yes | |
| [9042](https://www.rfc-editor.org/rfc/rfc9042) | `mailboxid` | yes | |

Also implemented: `regex` (draft), and the `vnd.yarilo.*` extensions. See [Sieve](/features/sieve).

## Authentication

SASL mechanisms run in `yarilo-auth` and are offered by every protocol that authenticates.

| RFC | Title | State | Notes |
|:---|:---|:---|:---|
| [4422](https://www.rfc-editor.org/rfc/rfc4422) | SASL | yes | |
| [4616](https://www.rfc-editor.org/rfc/rfc4616) | PLAIN | yes | |
| [5802](https://www.rfc-editor.org/rfc/rfc5802) | SCRAM-SHA-1, SCRAM-SHA-1-PLUS | yes | |
| [7677](https://www.rfc-editor.org/rfc/rfc7677) | SCRAM-SHA-256, SCRAM-SHA-256-PLUS | yes | |
| [9266](https://www.rfc-editor.org/rfc/rfc9266) | `tls-exporter` channel binding | yes | the `-PLUS` mechanisms, over TLS 1.3 |
| [7628](https://www.rfc-editor.org/rfc/rfc7628) | OAUTHBEARER | yes | with an OAuth2 passdb |
| [7662](https://www.rfc-editor.org/rfc/rfc7662) | Token introspection | yes | |
| [7519](https://www.rfc-editor.org/rfc/rfc7519) | JWT | yes | `local` mode |
| [6749](https://www.rfc-editor.org/rfc/rfc6749) | OAuth 2.0 password grant | yes | for PLAIN and LOGIN, with `oauth2_grant_url` |
| [2195](https://www.rfc-editor.org/rfc/rfc2195) | CRAM-MD5 | no | |
| [2831](https://www.rfc-editor.org/rfc/rfc2831) | DIGEST-MD5 | no | |
| [4752](https://www.rfc-editor.org/rfc/rfc4752) | GSSAPI (Kerberos) | no | |
| [4422 App. A](https://www.rfc-editor.org/rfc/rfc4422#appendix-A) | EXTERNAL | no | |

Also implemented: `LOGIN` (draft) and `XOAUTH2` (Google). See [SCRAM](/auth/scram) and [OAuth 2.0](/auth/oauth2).

## Message format and transport

| RFC | Title | State | Notes |
|:---|:---|:---|:---|
| [5322](https://www.rfc-editor.org/rfc/rfc5322) | Internet Message Format | yes | |
| [2045](https://www.rfc-editor.org/rfc/rfc2045)–[2049](https://www.rfc-editor.org/rfc/rfc2049) | MIME | yes | |
| [2231](https://www.rfc-editor.org/rfc/rfc2231) | MIME parameter continuations | yes | parameters keep their order and spelling |
| [8446](https://www.rfc-editor.org/rfc/rfc8446) | TLS 1.3 | yes | TLS 1.2 is the default minimum |
| [6066](https://www.rfc-editor.org/rfc/rfc6066) | TLS `server_name` (SNI) | partial | the name picks between `ssl_server_cert_file` and `ssl_server_alt_cert_file`, by the names each covers; there are no certificates per name. The policy server gets it as `%{local_name}` |

Also spoken: the HAProxy PROXY protocol on any listener with `haproxy_protocol`, and the Postfix policy delegation protocol in `yarilo-quota-status`. Behind a PROXY header, the client it names is the connection's remote address, and the proxy itself is what the policy server gets as `%{real_remote_ip}` and `%{real_remote_port}`.

## Policy server

`yarilo-auth` calls an HTTP [policy server](/auth/policy) before and after each login.

| RFC | Title | State | Notes |
|:---|:---|:---|:---|
| [9110](https://www.rfc-editor.org/rfc/rfc9110) | HTTP semantics | yes | `POST`, over HTTP/1.1 or, through TLS, HTTP/2 |
| [8259](https://www.rfc-editor.org/rfc/rfc8259) | JSON | yes | the request body and the answer |
| [7617](https://www.rfc-editor.org/rfc/rfc7617) | Basic authentication | partial | `auth_policy_server_api_header` is sent as written, so `Authorization: Basic …` works; yarilo does not encode it |
| [9562](https://www.rfc-editor.org/rfc/rfc9562) | UUID | yes | version 4, from `%{generate:uuid}` in a request template |
| [4648](https://www.rfc-editor.org/rfc/rfc4648) | Base64, base64url and base16 | yes | the `base64` and `unbase64` template filters, `url=1` for the URL alphabet and `pad=0` without padding; `hexlify` and `unhexlify` for base16 |

