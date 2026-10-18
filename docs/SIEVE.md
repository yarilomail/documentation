# Sieve Mail Filtering

Yarilo implements server-side mail filtering via the Sieve language (RFC 5228). Scripts are stored per-user and executed on every incoming LMTP delivery. Script management is available via the ManageSieve protocol (RFC 5804) on port 4190.

## Supported extensions

`fileinto`, `reject`, `ereject`, `vacation`, `vacation-seconds`, `imap4flags`, `copy`, `envelope`, `body`, `date`, `index`, `regex`, `relational`, `encoded-character`, `environment`, `mailbox`, `special-use`, `mailboxid`, `fcc`, `editheader`, `variables`, `include`, `duplicate`, `ihave`, `enotify`, `subaddress`, `spamtest`, `spamtestplus`, `virustest`, `foreverypart`, `mime`, `extracttext`, `replace`, `enclose`, `mboxmetadata`, `servermetadata`, `imapsieve`, `vnd.yarilo.debug`, `vnd.yarilo.environment`, `vnd.yarilo.pipe`, `vnd.yarilo.filter`, `vnd.yarilo.execute`, `vnd.yarilo.report`

`foreverypart` / `mime` / `extracttext` (RFC 5703) provide per-MIME-part
processing: `foreverypart { … }` walks the parts depth-first (with `break
[:name]`), `header`/`exists :mime` inspect the current part's headers with the
`:type` / `:subtype` / `:contenttype` / `:param` / `:anychild` selectors, and
`extracttext [:first N] [MODIFIER] var` captures the current part's UTF-8 text
(with the RFC 5229 value modifiers) into a variable. `replace [:mime] [:subject
s] [:from s] <text>` rewrites the current part (or the whole message outside a
loop); `enclose [:subject s] [:headers list] <text>` wraps the message in a
multipart/mixed cover plus the original as `message/rfc822`. A rewritten message
is delivered in place of the original. Octet-exact preservation of a pre-existing
`multipart/signed` part across a `replace` is a known limitation.

`mailboxid` (RFC 9042) resolves folders by their stable `MAILBOXID` (RFC 8474
OBJECTID) rather than by name: `fileinto :mailboxid "<id>" "<fallback>"` delivers
to the folder carrying `<id>` if it still exists, otherwise to the positional
`<fallback>` mailbox (honouring `:create`); the `mailboxidexists "<id>"...` test
is true only when every listed id resolves to an accessible folder. Ids survive
RENAME, so a script keeps targeting the right folder after the user renames it.

`spamtest` / `spamtestplus` / `virustest` (RFC 5235) are backed by a configured status header (see `sieve_spamtest_status_header` / `sieve_virustest_status_header` below); with no header configured the tests report "not scanned".

`imapsieve` (RFC 6785) runs Sieve scripts on **IMAP events** — message `APPEND`, `COPY`/`MOVE`, and flag change (`STORE`) — not just LMTP delivery. A script is bound to a mailbox through the IMAP METADATA annotation `/shared/imapsieve/script` (`SETMETADATA "<mailbox>" (/shared/imapsieve/script "<name>")`), or server-wide under INBOX; the value names a script in `imapsieve_script_dir`. Admin `imapsieve_global_before` / `imapsieve_global_after` scripts wrap the bound one. Bound scripts live in `imapsieve_script_dir`; in the Helm chart, set `sieve.imapsieve_scripts` (a `name: content` map) and a ConfigMap is rendered and mounted read-only at `imapsieve_script_dir` in the IMAP pods. Scripts require `["imapsieve", "environment"]` and branch on the event via `environment "imap.cause"` (`APPEND` / `COPY` / `FLAG`); the RFC 6785 items `imap.mailbox`, `imap.email`, `imap.user`, `imap.changedflags` and the vendor `vnd.yarilo.mailbox-from` / `vnd.yarilo.mailbox-to` (COPY source/destination) are also available. Enable it with `imapsieve_enabled`; all three causes — `APPEND`, `COPY` and `FLAG` — are wired.

`mboxmetadata` / `servermetadata` (RFC 5490 §4) expose IMAP METADATA (RFC 5464) annotations to scripts: `metadata "<mailbox>" "<entry>" "<value>"` / `metadataexists "<mailbox>" "<entry>"...` read per-mailbox annotations, and `servermetadata "<entry>" "<value>"` / `servermetadataexists "<entry>"...` read server-scoped ones. Entry names are the wire-format `/private/…` or `/shared/…` paths; values come from the same dict the IMAP `GETMETADATA`/`SETMETADATA` commands use, so a script sees exactly what a client set. Delivery-time lookups are scoped to the recipient's personal namespace. `extlists` is **not** advertised yet — its backing data source is not wired.

## Configuration

### `yarilo.yaml` — top-level `sieve:` section

| Key | Type | Default | Description |
|:----|:-----|:--------|:------------|
| `sieve_enabled` | bool | `false` | Activate Sieve execution on LMTP delivery |
| `sieve_max_script_size` | int | `65536` | Maximum compiled script size in bytes. One limit for delivery and ManageSieve alike — the pre-beta duplicate `protocol.managesieve.max_script_size` is accepted as an alias of this key, and the two set to different values refuse startup. |
| `sieve_max_redirects` | int | `32` | Maximum `redirect` actions per message (RFC 5228 §6.2) |
| `sieve_max_num_scripts` | int | `0` | Maximum scripts one user may store. `0` = unlimited. See [ManageSieve](#managesieve) |
| `sieve_max_storage` | int | `0` | Maximum bytes of one user's stored scripts. `0` = unlimited |
| `sieve_max_actions` | int | `32` | Maximum total actions per script (`fileinto`/`redirect`/`keep`/...). `0` = unlimited. Guards runaway scripts |
| `sieve_global` | string | `""` | Directory of the scripts `include :global` names, `<name>.sieve` each. Users cannot write it. Empty: none |
| `sieve_vacation_enabled` | bool | `true` | Permit the `vacation` extension (RFC 5230) |
| `sieve_vacation_min_period` | int | `86400` | Shortest reply interval in seconds; a shorter `:days`/`:seconds` is raised to it. `0` = no minimum |
| `sieve_vacation_max_period` | int | `5184000` | Longest reply interval in seconds (60 days); a longer one is lowered to it. `0` = no maximum |
| `sieve_vacation_default_period` | int | `604800` | Interval when the script gives none (7 days). It is kept within the minimum too, so `0` replies to every message only with `sieve_vacation_min_period: 0` |
| `sieve_vacation_default_subject` | string | `""` | Subject of a reply to a message without one, when the script gives none. Empty = `Automated reply` |
| `sieve_vacation_default_subject_template` | string | `""` | Subject of a reply when the script gives none, with `%{subject}` for the message's subject. Empty = `Auto: %{subject}` |
| `sieve_vacation_use_original_recipient` | bool | `false` | Count the LMTP original recipient (ORCPT) as the user's address. Only a relay that sends ORCPT gives one; see [LMTP](./LMTP#original-recipient-orcpt) |
| `sieve_vacation_check_recipient` | bool | `true` | Reply only to a message that names the user in `To`, `Cc`, `Bcc` or `Resent-*` |
| `sieve_vacation_send_from_recipient` | bool | `false` | Send the reply with the recipient as envelope sender instead of `<>` |
| `sieve_vacation_to_header_ignore_envelope` | bool | `false` | Address the reply to the first address in `Sender`, `Resent-From` or `From`, even when it is not the envelope sender |
| `sieve_spamtest_status_header` | string | `""` | Header carrying the spam score for `spamtest` (RFC 5235), e.g. `X-Spam-Score`. Empty = test reports "not scanned" |
| `sieve_spamtest_max_value` | float | `10` | Raw header value mapped to the top of the 0..10 (0..100 with `:percent`) scale |
| `sieve_virustest_status_header` | string | `""` | Header carrying the virus verdict for `virustest` (RFC 5235). Empty = "not scanned" |
| `sieve_virustest_max_value` | float | `5` | Raw header value mapped to the top of the 0..5 virus scale |
| `sieve_submission_host` | string | `""` | Upstream MTA for outbound mail (`host[:port]`, default port 25). Empty = redirect and vacation are silently dropped |
| `sieve_submission_ssl` | string | `"no"` | Transport security: `no` \| `smtps` \| `starttls` |
| `sieve_submission_timeout` | int | `30` | Connect and command timeout in seconds |
| `sieve_submission_auth_secret` | string | `""` | Name of a Kubernetes Secret containing `user` and `password` keys for SMTP AUTH. Leave empty for unauthenticated relay |
| `sieve_default_name` | string | `"yarilo"` | Name of the per-user default script, seeded as `<name>.sieve` on first delivery |
| `sieve_extensions` | list | `[]` | Extensions users may `require`. Empty allows all; a non-empty list is enforced at `PUTSCRIPT` and at delivery |
| `sieve_scripts_driver` | string | `""` (= `fs`) | Where scripts are stored: `fs` = files in the user's home; `redis` = the dict named by `sieve_scripts_dict` |
| `sieve_scripts_dict` | string | `""` | Name of the dict in `dicts:` used when `sieve_scripts_driver: redis`. Ignored for `fs` |

All keys keep the `sieve_` prefix even under the `sieve:` section, matching the config koanf tags.

### Helm `values.yaml` — top-level `sieve:` section

The `values.yaml` keys are identical to the `yarilo.yaml` keys above (same `sieve_` prefix):

| Key | Default | Description |
|:----|:--------|:------------|
| `sieve.sieve_enabled` | `false` | Enable Sieve |
| `sieve.sieve_max_script_size` | `65536` | Max script size (bytes) |
| `sieve.sieve_max_redirects` | `32` | Max redirect actions per message |
| `sieve.sieve_max_num_scripts` | `0` | Max scripts per user (`0` = unlimited) |
| `sieve.sieve_max_storage` | `0` | Max script bytes per user (`0` = unlimited) |
| `sieve.sieve_max_actions` | `32` | Max total actions per script (`0` = unlimited) |
| `sieve.sieve_global` | `""` | Directory of the `include :global` scripts |
| `sieve.sieve_global_scripts` | `{}` | Global scripts by name; a ConfigMap mounted at `sieve_global` in lmtp and imap |
| `sieve.sieve_vacation_enabled` | `true` | Enable vacation extension |
| `sieve.sieve_vacation_min_period` | `86400` | Shortest reply interval, seconds (`0` = none) |
| `sieve.sieve_vacation_max_period` | `5184000` | Longest reply interval, seconds (`0` = none) |
| `sieve.sieve_vacation_default_period` | `604800` | Interval when the script gives none |
| `sieve.sieve_vacation_default_subject` | `""` | Subject for a message without one |
| `sieve.sieve_vacation_default_subject_template` | `""` | Subject template with `%{subject}` |
| `sieve.sieve_vacation_use_original_recipient` | `false` | The ORCPT counts as the user's address (see [LMTP](./LMTP#original-recipient-orcpt)) |
| `sieve.sieve_vacation_check_recipient` | `true` | Reply only when the user is a header recipient |
| `sieve.sieve_vacation_send_from_recipient` | `false` | Envelope sender of the reply is the recipient |
| `sieve.sieve_vacation_to_header_ignore_envelope` | `false` | Reply `To` from the sender headers alone |
| `sieve.sieve_spamtest_status_header` | `""` | Spam-score header for `spamtest` (empty = unbacked) |
| `sieve.sieve_spamtest_max_value` | `10` | Top of the spam-score scale |
| `sieve.sieve_virustest_status_header` | `""` | Virus-verdict header for `virustest` (empty = unbacked) |
| `sieve.sieve_virustest_max_value` | `5` | Top of the virus-score scale |
| `sieve.sieve_submission_host` | `""` | Upstream MTA address (`host[:port]`) |
| `sieve.sieve_submission_ssl` | `"no"` | TLS mode: `no` / `smtps` / `starttls` |
| `sieve.sieve_submission_timeout` | `30` | Timeout in seconds |
| `sieve.sieve_submission_auth_secret` | `""` | Name of a Kubernetes Secret with `user` and `password` keys for SMTP AUTH. Leave empty for unauthenticated relay |

## ManageSieve

`protocol.managesieve` holds the protocol's own limits; the script size is `sieve.sieve_max_script_size` above.

| Key | Default | Description |
|:---|:---|:---|
| `max_invalid_commands` | `3` | Unknown commands before authentication after which the server says `BYE` and closes. |
| `managesieve_max_line_length` | `65536` | Bytes in a command line or a literal, a script's body aside. A larger literal is refused before it is read: `NO "Literal size too large."`, and when the client is already sending it (`{N+}`), `BYE` and close. Before authentication the bound is 8192 bytes. |

A script body over `sieve_max_script_size` gets `NO (QUOTA/MAXSIZE)` before it is read, closing the connection the same way.

### Script limits

Three limits apply to a stored script, judged in this order:

- `sieve_max_script_size` bounds its size: `NO (QUOTA/MAXSIZE) "Script is too large (max N bytes)."`
- `sieve_max_num_scripts` bounds how many scripts a user keeps: `NO (QUOTA/MAXSCRIPTS) "Script count quota exceeded (max N scripts)."`
- `sieve_max_storage` bounds the bytes of all the user's scripts together: `NO (QUOTA/MAXSTORAGE) "Script storage quota exceeded (max N bytes)."`

`PUTSCRIPT` of a name the user already has replaces that script: it adds nothing to the count, and only its new size is charged to the storage. A new name past a limit is refused. `0` lifts any of the three.

The same limits hold for [JMAP](./JMAP#sieve-scripts).

`HAVESPACE` (RFC 5804 §2.5) asks the same question without uploading. Check whether a 2 KiB script fits as `vacation`:

```
HAVESPACE "vacation" 2048
```

The reply is `OK "Putscript would succeed."` or the same `NO (QUOTA/...)` that `PUTSCRIPT` would give. A size of `0` gets `NO "Cannot upload empty script."`.

::: note
2.4.3 and earlier had no `HAVESPACE`, answering it with `NO "Unknown command: HAVESPACE"`, and refused an oversized script with `QUOTA/MAXSCRIPTSIZE`, a code RFC 5804 does not define.
:::

`RENAMESCRIPT` onto a name the user already has gets `NO (ALREADYEXISTS)` and changes neither script; the check runs under the same lock as the rename, so a concurrent session cannot slip a script in between.

A script name is 1 to 256 characters of valid UTF-8 without control characters, `/`, `\`, U+00FF, U+2028 or U+2029, and is neither `.` nor `..`. Any command naming a script otherwise gets `NO "Invalid script name."`.

## Testing for an extension (`ihave`)

`ihave` (RFC 5463) answers from `sieve_extensions`: it is true only for extensions the build supports and the list allows (an empty list allows every supported one). `variables` and `encoded-character` are never reported.

```sieve
require ["ihave", "fileinto"];
if ihave "editheader" {
  addheader "X-Seen" "yes";
}
fileinto "Archive";
```

- Under a false `ihave` the block never runs, and the script is still accepted. It may hold commands of extensions this server does not have or allow.
- Under a true `ihave` the block may use what the test names, held to `sieve_extensions` like a `require`d extension. Only that block may use it.
- Only a bare `ihave` as the whole test of an `if` / `elsif` opens its block. Inside `allof`, `anyof` or `not`, and in the `else` after `not ihave`, the test still answers, but the block opens nothing: a command there needs its extension in `require`, or the script is refused.
- `require "ihave"` opens nothing else: any other command still needs its extension in `require`. This holds at delivery, in imapsieve, in included scripts, and at ManageSieve `PUTSCRIPT` / `CHECKSCRIPT` and JMAP `SieveScript/set` / `SieveScript/validate`.

Before 2.4.4, with `ihave` in `sieve_extensions`, `require "ihave"` let a script use every extension of the build, whatever the list said ([#2297](https://github.com/yarilomail/yarilo/issues/2297)). Installations whose `sieve_extensions` did not list `ihave`, the default included, were not affected.

## Including scripts

`include` (RFC 6609) runs another of the user's own scripts at delivery and in imapsieve:

```sieve
require "include";
include :personal "vacation";
```

- The script is read from the same store as the active one (`sieve_scripts_driver`). A script given with no location is `:personal`.
- An included script is held to `sieve_extensions` like the active one. One that uses a forbidden extension, or does not compile, fails the run.
- A missing script fails the run, unless the include is `:optional`. `:once` includes a script at most once per run. A script that includes itself, directly or through others, fails the run.
- `:global` reads `<sieve_global>/<name>.sieve`. The name is a script name, never a path. A global script is held to `sieve_extensions` like any other; extensions only global scripts may use are [#2290](https://github.com/yarilomail/yarilo/issues/2290). With `sieve_global` empty, a `:global` include finds nothing: `:optional` skips it, a plain one fails the run.

To ship global scripts with the chart, list them under `sieve.sieve_global_scripts`. They become a ConfigMap mounted read-only at `sieve_global` in the lmtp and imap containers:

```yaml
sieve:
  sieve_global: "/etc/yarilo/sieve-global"
  sieve_global_scripts:
    spam: |
      require "fileinto";
      if header :contains "X-Spam-Flag" "YES" { fileinto "Junk"; }
```

A user's script includes one with `include :global "spam";`.

A failed run delivers the message to INBOX (implicit keep) and logs why.

## Outbound mail — redirect and vacation

When `sieve_submission_host` is configured, yarilo dispatches outbound mail for:

- **`redirect`** — forwards the original message verbatim to the redirect address, preserving the original envelope-from (RFC 5228 §4.2).
- **`vacation`** — sends an RFC 5230 auto-reply to the original sender with a null envelope-from (`<>`) to prevent mail loops.

### Vacation replies

A reply goes only to mail addressed to the user. The user's address must be in `To`, `Cc`, `Bcc`, `Resent-To`, `Resent-Cc` or `Resent-Bcc`, as the envelope recipient, as the original recipient (with `sieve_vacation_use_original_recipient`, when the relay gives an ORCPT; see [LMTP](./LMTP#original-recipient-orcpt)), or as one of the script's `:addresses` (RFC 5230 §4.5). Turn `sieve_vacation_check_recipient` off to reply to any message. A reply is never sent to the user's own address or to one of `:addresses` (§4.6).

The reply:

- comes `From` the address that matched, unless the script gives `:from`;
- goes `To` the sender as named in `Sender`, `Resent-From` or `From`, with the display name, else to the envelope sender;
- has the script's `:subject`, else `Auto: ` and the message's subject (or `sieve_vacation_default_subject_template`), else `Automated reply` (or `sieve_vacation_default_subject`) when the message has none;
- carries `In-Reply-To` and `References` from the message, so it threads under it (§5.8);
- is `text/plain; charset=utf-8`, unless the script gives `:mime`, in which case the reason is sent as written, with its own MIME headers;
- has the envelope sender `<>`, or the recipient with `sieve_vacation_send_from_recipient`.

A line break in a script's `:subject` or `:from` becomes a space, so a script cannot add headers to the reply.

### Vacation dedup (RFC 5230 §4.5)

Yarilo enforces a per-sender reply interval. It is the action's `:days` or `:seconds`, or `sieve_vacation_default_period` (7 days) when it gives none, kept between `sieve_vacation_min_period` (1 day) and `sieve_vacation_max_period` (60 days). Only an interval that is still `0` after that, which takes `sieve_vacation_min_period: 0`, records nothing, so every message is answered. The last-sent timestamp lives where the scripts live, and there is no separate vacation dict:

- `sieve_scripts_driver: fs` (the default): in `.yarilo.sieve-vacation` in the user's home;
- a dict scripts driver: in that dict under `priv/sieve/vacation/<handle>/<sender>`. Dict drivers with TTL support (Redis) expire the entry automatically; other drivers use the stored timestamp for manual comparison.

Vacation replies are skipped when:
- The sender address is empty or `<>`.
- The message has any of `List-Id`, `List-Owner`, `List-Subscribe`, `List-Post`, `List-Unsubscribe`, `List-Help`, `List-Archive`, or `Precedence: bulk/list/junk`.
- The message has an `Auto-Submitted:` set to any value other than `no`.
- The message has `X-Auto-Response-Suppress:` with `All` or `OOF`.
- The sender is a system address: `MAILER-DAEMON`, `LISTSERV`, `majordomo`, a local part containing `-request`, or one starting with `owner-`.

### Duplicate dedup (RFC 7352)

The `duplicate` test records tracking IDs with the action's TTL. The backend is
chosen by **`sieve_duplicate_driver`**:

- **`file`** (default) — a per-user file in the home directory (name:
  `sieve_duplicate_file`, default `.yarilo.sieve-duplicate`). The whole
  check-and-record runs under the per-home Sieve lock, so it is atomic; on
  shared storage the file is **cross-pod**.
- **`memory`** — per-process; single-node / dev only.
- **`redis`** — the dict named `sieve_duplicate` in `dicts:` (also cross-pod),
  keyed by `priv/<user>/sieve/duplicate/<handle>/<sha256(id)>`.

Defaults follow RFC 7352: the tracking id is the `Message-ID` header (absent →
the test is false and records nothing); `:header` / `:uniqueid` / `:handle` /
`:seconds` / `:last` override it. The period defaults to ~7 days and is capped
at `sieve_duplicate_max_period` (default 7 days; a larger `:seconds` is silently
clamped; `0` = no limit).

### Notifications (RFC 5435 `enotify`)

The `enotify` extension (RFC 5435) allows scripts to send notifications via an external method URI. Yarilo supports the `mailto:` method — the notification is sent as an email via the same `sieve_submission_host` as redirect and vacation.

```sieve
require ["enotify"];
notify :message "New mail arrived" "mailto:admin@example.com";
```

The `mailto:` URI may include `subject` and `body` query parameters:

```
mailto:admin@example.com?subject=Alert&body=You+have+mail
```

- **From**: the delivery envelope recipient (your mailbox address).
- **Subject**: from the URI `subject=` parameter; defaults to `Notification` if absent.
- **Body**: `ActionNotify.Message` (`:message` argument in the script), or URI `body=` parameter if the script provides no message.
- **Envelope-from**: `<>` (null) to prevent mail loops.
- **Auto-Submitted**: `auto-generated`.

Methods other than `mailto:` (e.g. `xmpp:`, `sms:`) are logged at `WARN` level and silently dropped.

### Kubernetes secret for SMTP AUTH

Create the secret once:

```sh
kubectl create secret generic sieve-smtp-auth \
  --from-literal=user=relay_user \
  --from-literal=password=relay_password
```

Reference it in `values.yaml`:

```yaml
sieve:
  sieve_enabled: true
  sieve_submission_host: "relay.example.com:587"
  sieve_submission_ssl: "starttls"
  sieve_submission_auth_secret: "sieve-smtp-auth"
```

## Yarilo-specific extensions

Yarilo ships six proprietary Sieve extensions under the `vnd.yarilo.*` namespace. They must be listed in the `require` statement of any script that uses them.

---

### `vnd.yarilo.debug` — script-level debug logging

Appends timestamped messages to `.yarilo.sieve.log` in the user's home directory. Intended for troubleshooting script logic without touching system logs.

```sieve
require ["vnd.yarilo.debug"];
debug_log "fileinto triggered for ${subject}";
```

The log file is created on first write with mode `0600`. Each line is `<RFC 3339 UTC timestamp>  <message>`. No configuration required.

---

### `vnd.yarilo.environment` — operator-defined environment items

Exposes delivery-time variables to scripts via the standard `environment` test. Built-in items:

| Item name | Value |
|:----------|:------|
| `vnd.yarilo.username` | Full login name (`user@domain`) |
| `vnd.yarilo.default-mailbox` | Always `INBOX` |
| `vnd.yarilo.config.<key>` | Operator-defined string from `sieve.sieve_environment` |

```sieve
require ["environment"];
if environment :is "vnd.yarilo.username" "alice@example.com" {
    fileinto "VIP";
}
```

Operator config in `yarilo.yaml`:

```yaml
sieve:
  sieve_environment:
    tenant: "acme"
    region: "eu-west-1"
```

Exposed as `vnd.yarilo.config.tenant` and `vnd.yarilo.config.region`.

---

### `vnd.yarilo.pipe` — pipe message to an external program

Feeds the full RFC 5322 message to an external program. The program receives no output — exit code determines success. Useful for archiving, indexing, or side-effect triggering.

```sieve
require ["vnd.yarilo.pipe"];
pipe "archive-mail" ["--folder" "inbox"];
```

**Program resolution** (tried in order):
1. Unix socket `<sieve_pipe_socket_dir>/<name>` — if the path is a socket file, yarilo connects and writes the message; socket output is discarded.
2. Executable `<sieve_pipe_bin_dir>/<name>` — launched as a subprocess.

World-writable executables are refused.

**Environment variables** injected into subprocesses:

| Variable | Value |
|:---------|:------|
| `USER` | Delivery recipient login name |
| `SENDER` | Envelope sender address |
| `RECIPIENT` | Envelope recipient address |
| `HOME` | Process home directory |
| `HOST` | Hostname |

**Configuration** (`yarilo.yaml` / `values.yaml`):

| Key | Default | Description |
|:----|:--------|:------------|
| `sieve_pipe_bin_dir` | `/usr/lib/yarilo/sieve-pipe` | Directory of allowed pipe executables |
| `sieve_pipe_socket_dir` | `sieve-pipe` | Directory of allowed pipe sockets (searched first) |
| `sieve_pipe_exec_timeout` | `10` | Subprocess timeout in seconds |
| `sieve_pipe_input_eol` | `crlf` | Line endings written to stdin: `crlf` or `lf` |

---

### `vnd.yarilo.filter` — rewrite message through an external program

Like `pipe`, but the program's stdout replaces the message body. If the program exits non-zero or produces no output, the original message is passed through unchanged.

```sieve
require ["vnd.yarilo.filter"];
if filter "add-disclaimer" [] {
    fileinto "Filtered";
}
```

The `filter` action returns `true` if the program exited 0 and produced output. The same program resolution and environment variable rules as `vnd.yarilo.pipe` apply.

**Configuration** (`yarilo.yaml` / `values.yaml`):

| Key | Default | Description |
|:----|:--------|:------------|
| `sieve_filter_bin_dir` | `/usr/lib/yarilo/sieve-filter` | Directory of allowed filter executables |
| `sieve_filter_socket_dir` | `sieve-filter` | Directory of allowed filter sockets (searched first) |
| `sieve_filter_exec_timeout` | `10` | Subprocess timeout in seconds |
| `sieve_filter_input_eol` | `crlf` | Line endings written to stdin: `crlf` or `lf` |

---

### `vnd.yarilo.execute` — run a program and capture its output

Runs a program with optional stdin and makes its stdout available to the script. Unlike `pipe`/`filter`, the program does not receive the full message unless the script explicitly passes content. Exit code is exposed as a boolean result.

```sieve
require ["vnd.yarilo.execute", "variables"];
if execute :input "check" "quota-check" [] {
    # exit 0 — quota OK
} else {
    reject "Quota exceeded";
}
```

The `execute` action returns `true` on exit 0. For Unix socket targets, non-empty output implies success (sockets have no exit code).

The same program resolution and environment variable rules as `vnd.yarilo.pipe` apply.

**Configuration** (`yarilo.yaml` / `values.yaml`):

| Key | Default | Description |
|:----|:--------|:------------|
| `sieve_execute_bin_dir` | `/usr/lib/yarilo/sieve-execute` | Directory of allowed execute programs |
| `sieve_execute_socket_dir` | `sieve-execute` | Directory of allowed execute sockets (searched first) |
| `sieve_execute_exec_timeout` | `10` | Subprocess timeout in seconds |
| `sieve_execute_input_eol` | `crlf` | Line endings written to stdin: `crlf` or `lf` |

### `vnd.yarilo.report` — send an ARF abuse report

Generates an [RFC 5965](https://www.rfc-editor.org/rfc/rfc5965) Abuse Reporting Format (ARF) message about the current message and submits it to a target address (via `sieve_submission_host`, the same path as `redirect`/`vacation`). The report is a `multipart/report; report-type=feedback-report` with a human-readable part, a `message/feedback-report` machine part, and the reported message (full, or headers-only with `:headers_only`).

```sieve
require ["vnd.yarilo.report"];
report "abuse" "User reported this as spam" "abuse@example.com";
report :headers_only "not-spam" "False positive" "fbl@example.com";
```

The `feedback-type` is an RFC 5965 registry token (`abuse`, `fraud`, `not-spam`, …). `report` is a side-effect action: it does **not** cancel implicit keep, so the message is still delivered.

**Configuration** (`yarilo.yaml` / `values.yaml`):

| Key | Default | Description |
|:----|:--------|:------------|
| `sieve_report_user_agent` | `yarilo` | `User-Agent` field written into the `message/feedback-report` part |

---

## Default script

On first delivery for a new user, yarilo seeds a default `yarilo.sieve` script:

```sieve
keep;
```

Operators can replace this via ManageSieve, or by writing the script where `sieve_scripts_driver` keeps it: a file in the user's home (`fs`, the default) or the dict named by `sieve_scripts_dict` (`redis`).
