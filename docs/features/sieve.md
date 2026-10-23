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

Settings live under `sieve:` and keep the `sieve_` prefix there, matching the config keys. The chart's values use the same names under `sieve:`.

<!-- @settings sieve.sieve_enabled sieve.sieve_max_script_size sieve.sieve_max_redirects sieve.sieve_max_num_scripts sieve.sieve_max_storage sieve.sieve_max_actions sieve.sieve_global sieve.sieve_global_scripts sieve.sieve_vacation_enabled sieve.sieve_vacation_min_period sieve.sieve_vacation_max_period sieve.sieve_vacation_default_period sieve.sieve_vacation_default_subject sieve.sieve_vacation_default_subject_template sieve.sieve_vacation_use_original_recipient sieve.sieve_vacation_check_recipient sieve.sieve_vacation_send_from_recipient sieve.sieve_vacation_to_header_ignore_envelope sieve.sieve_spamtest_status_header sieve.sieve_spamtest_max_value sieve.sieve_virustest_status_header sieve.sieve_virustest_max_value sieve.sieve_submission_host sieve.sieve_submission_ssl sieve.sieve_submission_timeout sieve.sieve_submission_auth_secret sieve.sieve_default_name sieve.sieve_extensions sieve.sieve_global_extensions sieve.sieve_scripts_driver sieve.sieve_scripts_dict -->

## ManageSieve

`protocol.managesieve` holds the protocol's own limits; the script size is `sieve.sieve_max_script_size` above.

<!-- @settings protocol.managesieve.max_invalid_commands protocol.managesieve.managesieve_max_line_length -->

A script body over `sieve_max_script_size` gets `NO (QUOTA/MAXSIZE)` before it is read, closing the connection the same way.

### Script limits

Three limits apply to a stored script, judged in this order:

- `sieve_max_script_size` bounds its size: `NO (QUOTA/MAXSIZE) "Script is too large (max N bytes)."`
- `sieve_max_num_scripts` bounds how many scripts a user keeps: `NO (QUOTA/MAXSCRIPTS) "Script count quota exceeded (max N scripts)."`
- `sieve_max_storage` bounds the bytes of all the user's scripts together: `NO (QUOTA/MAXSTORAGE) "Script storage quota exceeded (max N bytes)."`

`PUTSCRIPT` of a name the user already has replaces that script: it adds nothing to the count, and only its new size is charged to the storage. A new name past a limit is refused. `0` lifts any of the three.

The same limits hold for [JMAP](/protocols/jmap#sieve-scripts).

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

`ihave` (RFC 5463) answers from the script's set (see below): it is true only for extensions the build supports and the set allows. `variables` and `encoded-character` are never reported.

```sieve
require ["ihave", "fileinto"];
if ihave "editheader" {
  addheader "X-Seen" "yes";
}
fileinto "Archive";
```

- Under a false `ihave` the block never runs, and the script is still accepted. It may hold commands of extensions this server does not have or allow.
- Under a true `ihave` the block may use what the test names, held to the script's set like a `require`d extension. Only that block may use it.
- Only a bare `ihave` as the whole test of an `if` / `elsif` opens its block. Inside `allof`, `anyof` or `not`, and in the `else` after `not ihave`, the test still answers, but the block opens nothing: a command there needs its extension in `require`, or the script is refused.
- `require "ihave"` opens nothing else: any other command still needs its extension in `require`. This holds at delivery, in imapsieve, in included scripts, and at ManageSieve `PUTSCRIPT` / `CHECKSCRIPT` and JMAP `SieveScript/set` / `SieveScript/validate`.

Before 2.4.4, with `ihave` in `sieve_extensions`, `require "ihave"` let a script use every extension of the build, whatever the list said. Installations whose `sieve_extensions` did not list `ihave`, the default included, were not affected.

## Whose script gets which extensions

Two sets, built from `sieve_extensions` (empty: every supported extension) and `sieve_global_extensions`:

| Set | Scripts | Extensions |
|:---|:---|:---|
| A user's | the active script, `include :personal`, scripts uploaded through ManageSieve (`PUTSCRIPT`, `CHECKSCRIPT`) and JMAP (`SieveScript/set`, `SieveScript/validate`) | `sieve_extensions` less `sieve_global_extensions` |
| The administrator's | `sieve_global_before` / `sieve_global_after`, the `imapsieve_scripts` a mailbox binds and `imapsieve_global_before` / `imapsieve_global_after`, `include :global` | `sieve_extensions` and `sieve_global_extensions` |

- **A user's script with a global-only extension** is refused at upload. At delivery it is skipped, as for any extension it may not have. Under `ihave` such an extension is false.
- **The SIEVE capability** of ManageSieve, before login and after, and `sieveExtensions` in JMAP list a user's set. Global-only extensions are not advertised.
- **An include takes its location's set,** whoever includes it. A `:personal` script included by a before script still has only the user's set, `ihave` included, and a `:global` script included by a user's script has the administrator's.
- **Before/after scripts are checked at load.** `sieve_global_before` / `_after` and `imapsieve_global_before` / `_after` are held to the administrator's set when they load. One that uses an extension in neither list is logged (`global script uses a forbidden extension, skipping`) and left out. Before 2.4.4 they were not checked.

```yaml
sieve:
  sieve_extensions: [fileinto, envelope, variables]
  sieve_global_extensions: [vnd.yarilo.pipe, editheader]
```

## Including scripts

`include` (RFC 6609) runs another of the user's own scripts at delivery and in imapsieve:

```sieve
require "include";
include :personal "vacation";
```

- The script is read from the same store as the active one (`sieve_scripts_driver`). A script given with no location is `:personal`.
- An included script is held to its location's set, whoever includes it: a `:personal` one to the user's, a `:global` one to the administrator's (see below). One that uses a forbidden extension, or does not compile, fails the run.
- A missing script fails the run, unless the include is `:optional`. `:once` includes a script at most once per run. A script that includes itself, directly or through others, fails the run.
- `:global` reads `<sieve_global>/<name>.sieve`. The name is a script name, never a path. A global script gets the administrator's set, `sieve_global_extensions` included. With `sieve_global` empty, a `:global` include finds nothing: `:optional` skips it, a plain one fails the run.

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

## Outbound mail from redirect and vacation

When `sieve_submission_host` is configured, yarilo dispatches outbound mail for:

- **`redirect`** — forwards the original message verbatim to the redirect address, preserving the original envelope-from (RFC 5228 §4.2).
- **`vacation`** — sends an RFC 5230 auto-reply to the original sender with a null envelope-from (`<>`) to prevent mail loops.

### Vacation replies

A reply goes only to mail addressed to the user. The user's address must be in `To`, `Cc`, `Bcc`, `Resent-To`, `Resent-Cc` or `Resent-Bcc`, as the envelope recipient, as the original recipient (with `sieve_vacation_use_original_recipient`, when the relay gives an ORCPT; see [LMTP](/protocols/lmtp#original-recipient-orcpt)), or as one of the script's `:addresses` (RFC 5230 §4.5). Turn `sieve_vacation_check_recipient` off to reply to any message. A reply is never sent to the user's own address or to one of `:addresses` (§4.6).

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

### `vnd.yarilo.debug`

Appends timestamped messages to `.yarilo.sieve.log` in the user's home directory. Intended for troubleshooting script logic without touching system logs.

```sieve
require ["vnd.yarilo.debug"];
debug_log "fileinto triggered for ${subject}";
```

The log file is created on first write with mode `0600`. Each line is `<RFC 3339 UTC timestamp>  <message>`. No configuration required.

---

### `vnd.yarilo.environment`

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

### `vnd.yarilo.pipe`

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

<!-- @settings sieve.sieve_pipe_bin_dir sieve.sieve_pipe_socket_dir sieve.sieve_pipe_exec_timeout sieve.sieve_pipe_input_eol -->

---

### `vnd.yarilo.filter`

Like `pipe`, but the program's stdout replaces the message body. If the program exits non-zero or produces no output, the original message is passed through unchanged.

```sieve
require ["vnd.yarilo.filter"];
if filter "add-disclaimer" [] {
    fileinto "Filtered";
}
```

The `filter` action returns `true` if the program exited 0 and produced output. The same program resolution and environment variable rules as `vnd.yarilo.pipe` apply.

**Configuration** (`yarilo.yaml` / `values.yaml`):

<!-- @settings sieve.sieve_filter_bin_dir sieve.sieve_filter_socket_dir sieve.sieve_filter_exec_timeout sieve.sieve_filter_input_eol -->

---

### `vnd.yarilo.execute`

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

<!-- @settings sieve.sieve_execute_bin_dir sieve.sieve_execute_socket_dir sieve.sieve_execute_exec_timeout sieve.sieve_execute_input_eol -->

### `vnd.yarilo.report`

Generates an [RFC 5965](https://www.rfc-editor.org/rfc/rfc5965) Abuse Reporting Format (ARF) message about the current message and submits it to a target address (via `sieve_submission_host`, the same path as `redirect`/`vacation`). The report is a `multipart/report; report-type=feedback-report` with a human-readable part, a `message/feedback-report` machine part, and the reported message (full, or headers-only with `:headers_only`).

```sieve
require ["vnd.yarilo.report"];
report "abuse" "User reported this as spam" "abuse@example.com";
report :headers_only "not-spam" "False positive" "fbl@example.com";
```

The `feedback-type` is an RFC 5965 registry token (`abuse`, `fraud`, `not-spam`, …). `report` is a side-effect action: it does **not** cancel implicit keep, so the message is still delivered.

**Configuration** (`yarilo.yaml` / `values.yaml`):

<!-- @settings sieve.sieve_report_user_agent -->

---

## Default script

On first delivery for a new user, yarilo seeds a default `yarilo.sieve` script:

```sieve
keep;
```

Operators can replace this via ManageSieve, or by writing the script where `sieve_scripts_driver` keeps it: a file in the user's home (`fs`, the default) or the dict named by `sieve_scripts_dict` (`redis`).
