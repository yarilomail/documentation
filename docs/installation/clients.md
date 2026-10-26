---
description: "The mail applications tested against yarilo, with the versions, what was checked and what to know about each: Bulwark Mail and Twake Mail over JMAP, and any IMAP and Submission client."
---

# Mail applications

yarilo speaks standard protocols, so any client of them can be used. This page
lists the applications tested against yarilo, what was checked with each, and
what an operator or a user needs to know about them.

## Web applications over JMAP

Both are separate web applications that the operator hosts and points at
yarilo's JMAP endpoint. A browser calls yarilo from the application's own
origin, so that origin must be listed in
[`jmap_cors_allow_origins`](/protocols/jmap#protocol.jmap.jmap_cors_allow_origins).
Sending needs a Submission relay, as for any JMAP client (see
[Sending mail](/protocols/jmap#sending-mail)).

| Application | Version tested | Status |
|:---|:---|:---|
| [Bulwark Mail](https://github.com/bulwarkmail/webmail) | 1.17.1 | works |
| [Twake Mail](https://github.com/linagora/tmail-flutter) (web) | 0.40.2 | works, with the notes below |

Tested on yarilo 2.4.5 in October 2026.

### Bulwark Mail

Checked: sign-in, the folder list, reading, flags, marking a folder read,
creating a folder and moving mail into it, sending, the storage quota, and new
mail appearing without a reload.

- New mail arrives over the JMAP EventSource stream; nothing extra is needed.
- The storage quota is shown at the bottom of the side panel.

### Twake Mail

Checked: sign-in, the folder list, reading, flags, folders, creating an
identity, sending, the storage quota, and new mail appearing without a reload.

- Sending needs an identity created in the application. Twake Mail sends
  only from identities the user may delete, and the account's own address is
  not one of them. Create one once under **Settings → Profiles → Identities →
  Create new identity**, with the account's address; see
  [Identities](/protocols/jmap#identities).
- New mail without a reload needs the WebSocket ticket, on by default:
  Twake Mail opens the WebSocket only with one. With
  [`jmap_websocket_ticket_ttl: 0`](/protocols/jmap#protocol.jmap.jmap_websocket_ticket_ttl)
  the application works but shows new mail only after a reload. See
  [Tickets for browser clients](/protocols/jmap#tickets-for-browser-clients).
- The storage quota appears in the side panel only above 80% of the limit; it
  is always under **Settings → Storage**.
- The mobile application was not tested.

## Contacts and calendars

yarilo serves mail only. Neither application offers contacts or calendars
against it, since yarilo does not advertise them.

## Other clients

Desktop and mobile mail applications connect over IMAP and Submission
(and POP3 where it is enabled), with the hosts and ports the operator
publishes. They are not listed here because none has been tested as a whole
yet; how each finds its settings is on
[Mail client autoconfiguration](/installation/autoconfig).
