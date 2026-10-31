#### Manage and protect

# Grok Bot inference hooks

Inference hooks send every governed Grok Bot model request to an AI security
server your organization runs or uses through a security vendor. Cursor signs
each request, waits for an allow or deny verdict, and stops the request on a
deny, so your policy checks prompts and the content Grok Bot gathers before a
model sees them. For Grok Bot's other controls, see
[Grok Bot security](/grok-bot/security).

> **Beta** Inference hooks are in beta and available to all Enterprise teams.
> Team admins can set them up from the dashboard. They cover Grok Bot only. See
> [Coverage](#coverage).

## How it works

* **Each governed model request is checked.** Before Grok Bot calls a model,
  Cursor sends your endpoint a signed `prompt` frame with the conversation so
  far and holds the request until a verdict arrives or the timeout passes. A
  turn that calls the model several times, for example between tool calls,
  sends one frame per call.
* **Your server decides.** `allow` lets the request go to the model. `deny`
  stops it, ends the turn, and the member who sent the message sees a
  [block notice](#what-members-see).
* **Failures follow your mode.** When your endpoint times out, returns an
  error, or answers with something other than a verdict, the [mode](#modes)
  decides whether the request proceeds or is blocked. A failure never counts as
  a deny.
* **Only model inputs are checked.** Your endpoint judges what is about to go
  to the model. A tool call and its result appear in a frame only after the
  tool has run. Grok Bot's reply to a member is a tool call too, so the reply
  reaches the member before any frame contains it. A deny stops the next model
  call, not an action that already happened.

## Set up inference hooks

You need to be a team admin on an Enterprise team.

1. **Prepare your security server.** Create an inference hooks integration in
   your security vendor's console, or host your own server that meets the
   [endpoint requirements](#endpoint-requirements). The setup dialog's
   **Security Vendor** list includes vendor presets with a setup checklist.
2. **Open Inference Hooks.** In the Cursor dashboard, select the team, then
   open [Inference Hooks](https://cursor.com/dashboard/bot/inference-hooks)
   from the **Security & Compliance** section of the Grok Bot page.
3. **Add the endpoint.** Click **Set Up Endpoint**, choose your vendor or
   **Custom Endpoint**, and enter the **Endpoint URL** and any
   **Custom Headers** your server needs, such as its API key. Cursor checks the
   URL when you save.
4. **Copy the signing secret.** The first save that sets an endpoint generates
   a signing secret starting with `whsec_` and shows it once. Paste it into your
   vendor's webhook secret field, or your server's configuration, so it can
   verify each request.
5. **Test the connection.** Click **Test Connection**. Cursor sends a synthetic
   request and shows the verdict or the reason the check failed. A deny here
   means your policy would block the test prompt, so fix that before you
   enforce.
6. **Start in Shadow mode.** New configurations start in **Shadow Mode**. Turn
   on **Enforce Verdicts** to start sending. Your endpoint receives every
   covered request and denials are recorded in the audit log, but nothing is
   blocked. Once the verdicts look right, set **Mode** under
   **Failure Handling** to **Allow the Request** or **Block the Request**.

Setting changes take effect within about a minute, and requests already in
flight finish under the old settings.

While an endpoint is saved, **Enforce Verdicts** is on, and Grok Bot is
covered, in any mode and at any rollout percentage, Grok Bot skips some model
calls it would otherwise make ahead of a turn, so replies can start more
slowly.

### Endpoint requirements

* **Use an `https://` URL on port 443.** The host must be publicly routable and
  present a certificate from a public certificate authority. Cursor refuses
  private, loopback, and carrier-grade NAT addresses.
* **Redirects and tunnels don't work.** Cursor doesn't follow redirects and
  treats one as a failed check. Reverse-tunnel hosts aren't accepted.
* **Keep secrets out of the URL.** The URL can't carry credentials, a query
  string, or a fragment, because admins see it in plain text. Put credentials
  in custom headers, which are stored encrypted. URLs are limited to 2,048
  characters.
* **Answer every request with a verdict.** Return HTTP 200 and a JSON verdict,
  including for Test Connection. See [Verdicts](#verdicts).

### Custom headers

* **You can add up to 16 headers.** Names use letters, digits, and hyphens,
  without underscores, up to 128 characters. Values are printable ASCII, up to
  8,192 characters.
* **Values are write-only.** After you save, the page shows header names only.
  Changing any header means entering every value again.
* **A new URL clears saved values.** Header values never go to an endpoint they
  weren't saved for. After you change the URL, re-enter them in **Edit**. Until
  you do, requests go out without them.
* **Cursor owns some headers.** You can't add `Host`, `Cookie`, `User-Agent`,
  `Accept-Encoding`, connection headers such as `Transfer-Encoding`,
  client-address headers such as `X-Real-IP`, or any name starting with
  `Content-`, `Proxy-`, `X-Forwarded-`, `Webhook-`, or `X-Cursor-`.

### Signing secret

Every request carries [Standard Webhooks](https://www.standardwebhooks.com)
headers so your server can reject anything Cursor didn't send:

| Header | Value |
| --- | --- |
| `webhook-id` | The frame's `request_id` |
| `webhook-timestamp` | Unix time in seconds |
| `webhook-signature` | `v1,` then the base64 HMAC-SHA256 of `{webhook-id}.{webhook-timestamp}.{raw body}`, keyed with the base64-decoded part of the secret after `whsec_` |

Each request carries exactly one signature. To rotate the secret, click
**Rotate Secret** under **Request Signing**. The new secret is shown once, and
Cursor starts signing with it within about a minute, so keep accepting the
previous secret until then. Rotating counts as a settings change for the
[circuit breaker](#circuit-breaker).

### Test Connection

Test Connection sends a signed `prompt` frame with `source.application` set to
`config-test`, a fixed message that contains no user content, and no member,
session, or model. It signs with your saved secret and waits for your saved
verdict timeout. It uses the URL and headers in the form when you run it from
the endpoint dialog, and the saved ones when you run it from the page.

| Result | Meaning |
| --- | --- |
| Allow or deny | Your server returned a verdict. Resolve a deny before you enforce |
| URL rejected | The URL doesn't meet the endpoint requirements |
| Private or internal IP | The host isn't a publicly routable address |
| Timeout | No verdict arrived within the verdict timeout |
| Transport error | DNS, connection, or TLS failure |
| Non-200 status | Your server answered with a status other than 200, including a redirect |
| Unparseable response | The body wasn't a JSON verdict, was compressed, or was larger than 64 KiB |
| Signing secret required | Save the configuration first. Saving generates the secret |

## Modes

**Enforce Verdicts** turns sending on and off. While it's off, Cursor sends
nothing and keeps your settings. While it's on, **Mode** decides what happens
when a check can't finish:

| Mode | On a deny | When the check fails |
| --- | --- | --- |
| **Shadow Mode** (default) | Lets the request through | Lets the request through |
| **Allow the Request** | Blocks the request | Lets the request through uninspected (fails open) |
| **Block the Request** | Blocks the request | Blocks the request (fails closed) |

In Allow and Block modes the model request waits for the verdict. In Shadow
mode Cursor sends the same frames at the same moments, but in the background:
nothing waits, members see nothing, and denials and failures are recorded in
the audit log. Under heavy load, Cursor can skip a Shadow check, and a skipped
check writes no audit row.

A check fails when your server times out, answers with a status other than 200,
returns a body that isn't a JSON verdict or is larger than 64 KiB, returns an
`action` other than `allow` or `deny`, or can't be reached. A frame larger than
64 MiB also counts as a failure.

Once Cursor has your settings, Block mode blocks every check that can't finish,
including when the cause is on Cursor's side. If Cursor can't load your team's
inference hook settings at all, it can't tell which mode you chose, so the
request proceeds and the audit log records it as failed open with reason
`config_unavailable`.

### Verdict timeout

**Verdict Timeout (ms)** accepts 1 to 10,000 ms and defaults to 5,000. It
covers the whole exchange: connection, TLS handshake, request, and response. If
the connection fails, Cursor retries once within the same timeout, with the
same `webhook-id` and signature, so you can deduplicate on `webhook-id`. Cursor
never retries after your server responds. Its own processing adds up to about
half a second on top of the timeout.

### Rollout

**Requests Inspected (%)** sends only a share of covered requests to your
endpoint while you bring it up. The choice is sticky, so all the requests
behind one turn, subagents included, are either inspected or skipped. Requests
outside the share proceed uninspected even in Block mode, and 0% turns
inspection off.

### Circuit breaker

Sustained failures your server is responsible for, such as timeouts, error
statuses, TLS errors, and malformed verdicts, trip the circuit breaker. DNS and
connection errors, URLs Cursor refuses, and frames over 64 MiB count as
failures but never trip it.

* **While tripped, Cursor stops sending.** Your mode applies to every covered
  request: Block mode blocks them all, and Allow and Shadow let them through
  uninspected. The audit log records one
  `inference_hooks_circuit_breaker_tripped` event per trip and no per-request
  events while tripped.
* **Recovery is automatic.** Starting 10 minutes after the trip, Cursor
  periodically sends your server the Test Connection request. An allow or a
  deny resets the breaker.
* **Any settings change stops automatic recovery.** That includes rotating the
  secret. Once your endpoint is fixed, click **Reset**, or turn
  **Enforce Verdicts** off and on again.

### Cursor pause

Cursor can pause inference hooks for a team, or for everyone, in an emergency.
While paused, Cursor sends no frames, covered requests proceed, and the audit
log records most of them as failed open with reason `kill_switch`. Test
Connection shows "Inference hooks are temporarily paused by Cursor."

## What members see

When your server denies a request, the Grok Bot desktop and mobile apps show a
block notice to the member who sent the blocked message, in their own
conversation with the Bot. On mobile, the notice sits above the message box. It
shows:

* The title **Blocked by your organization's policy**.
* Your server's `deny_reason`, followed by your **Blocked Message**.
* Guidance with an **Edit** button and a **Reset** button. **Edit** takes the
  blocked message back out of the conversation and puts its text in the message
  box, unless the member already has a draft there, so they can send something
  different. **Reset** clears the conversation. The mobile app and newer
  versions of the desktop app ask the member to confirm first. When Cursor
  can't roll the conversation back to the point before the blocked message,
  only **Reset** appears.

**Blocked Message** accepts up to 500 characters and defaults to "Your
organization's security policy blocked this request." Turn it off to show only
your server's `deny_reason`. Use it to tell members what to do next, such as
who to contact.

After a reset, the Bot no longer sees earlier messages in that conversation,
and it stops the background helpers it was running for it. Other work it
started, such as cloud agents and background commands, keeps going and can
report back. Its memory, files, routines, and settings are kept. Edit rolls the
conversation back to the point before the blocked message. Neither one undoes
actions the Bot already took, such as files it wrote.

If the conversation is blocked again right after a reset, the notice has no
buttons. It explains that what's blocked may be in the Bot's memory or files,
and asks the member to remove it there or ask an admin for help.

When a check fails in Block mode, the desktop app shows
**Your organization's policy check is unavailable** and "Your organization
requires a policy check before the model responds, and the check didn't
complete. Try again later, or contact your admin if this keeps happening." The
mobile app shows "Your organization's policy check is unavailable. Try again
later, or contact your admin if this keeps happening." Your Blocked Message
isn't shown, and there's no Edit or Reset.

Other places show less:

* **Shared Bots notify only the sender.** In a shared Bot, the notice and its
  buttons go only to the teammate who sent the blocked message, in their own
  chat with the Bot, and Edit or Reset changes only that chat. The Bot's owner
  isn't shown the deny reason or your Blocked Message. Rooms and group chats
  get no Edit or Reset buttons.
* **Slack replies in the conversation.** The Bot answers "Your organization's
  policy blocked this conversation, so I can't reply," and in a one-to-one DM
  it quotes the deny reason and your Blocked Message, which channel threads and
  group DMs never show. The reply offers **Remove blocked message**, which
  works like Edit, and **Reset**, which asks for confirmation first, or only
  **Reset** when Cursor can't roll the conversation back. Anyone who can use
  the Bot and has linked their Cursor account can click them. A removed message
  stays visible in Slack, but the Bot no longer sees it. A repeat block right
  after a reset gets no buttons, and a failed check in Block mode gets the
  Bot's generic error reply instead of a policy notice.
* **Elsewhere, the mobile app shows a plain failure.** In group chats and
  conversations that aren't the member's own, it shows "Bot failed to respond"
  with "Blocked by your organization's policy. Send a different message, or
  contact your admin if this keeps happening," without the deny reason, your
  Blocked Message, or buttons.
* **Other Cursor apps show only the title.**
* **Older desktop versions show no buttons.** Depending on the version, the
  notice shows the deny reason and your Blocked Message with the guidance
  "Send a different message, or start a new chat if this keeps happening," or
  only "Blocked by your organization's policy. Send a different message, or
  contact your admin if this keeps happening."
* **Background helpers stop without a notice.** When a helper Grok Bot started
  is blocked, the Bot learns your organization's policy stopped it, without the
  deny reason.
* **Routines stop and record the block.** The run history in the Cursor
  dashboard shows **Blocked by your organization's policy**, or
  **Your organization's policy check is unavailable** for a failed check in
  Block mode, with a fixed explanation and no deny reason. The Grok Bot app's
  routine list shows only that the run failed.
* **Email, Linear, and other connected channels get no reply.**

A blocked message stays in the conversation until someone takes it back or
resets the conversation. Until then, Grok Bot sends it with every later
request, so your server judges it again each time. A policy that scans the
whole transcript keeps denying that conversation. A policy that judges the
newest user message lets it continue once the member sends something
different.

Members see nothing when a request is allowed or when you're in Shadow mode.
Shadow mode sends their conversations to your endpoint too, so tell members
your organization checks Grok Bot requests before you turn on
**Enforce Verdicts**.

## Coverage

**Covered:** the model requests behind your team members' Grok Bot
conversations. That includes every step of a turn, subagents, the summaries
Grok Bot writes of long conversations, and routines. A shared Bot or room
follows its team's inference hook. A personal Bot follows the team its owner has
selected. Each request gets its own frame with the conversation so far.

**Not covered:**

* **Model responses aren't checked.** See [How it works](#how-it-works).
* **Parts of a request that aren't conversation stay out.** System prompts,
  tool definitions, and the model's hidden reasoning never go to your endpoint,
  and Cursor leaves out most of the text it adds for the model, such as
  reminders and timestamps.
* **Ancillary model calls aren't sent.** These calls support a conversation
  rather than continue it, such as writing chat titles, Auto Review, and saving
  memories.
* **Other Cursor features aren't covered.** That includes Cloud Agents, agents
  in the editor, the CLI, the Agent SDK, Tab, embeddings, and local models.
* **Actions aren't checked as they run.** Tool execution, connected-app
  actions, and network traffic from a member's Grok Bot computer reach your
  endpoint only when their output returns to the model as a tool result in a
  later frame. Use the [network policy](/grok-bot/security#network-policy) and
  [Auto Review](/grok-bot/security#approvals-and-auto-review) to control
  actions.

## Request format

Cursor sends each frame as an HTTPS `POST` with a compact JSON body. Header
names are lowercase.

| Header | Value |
| --- | --- |
| `content-type` | `application/json` |
| `user-agent` | `cursor-inference-hooks/1` |
| `accept-encoding` | `identity` |
| `webhook-id`, `webhook-timestamp`, `webhook-signature` | See [Signing secret](#signing-secret) |
| Your custom headers | As saved |

Standard headers such as `host` and `content-length` come with every request
too.

```json
{
  "type": "prompt",
  "request_id": "req_6b1f0c2e-4d7a-4f1e-9a53-2c8d7e41b9a0",
  "tenant_id": "team_4mQvT8yLcN2pR6",
  "actor": {
    "type": "user",
    "id": "user_8hJw3KzP5sXq1V7nB2cF9mD4tR",
    "email_address": null
  },
  "source": { "application": "grok-bot" },
  "session_id": "3f2c9a71-58e4-4b0d-9c6a-0d1e7b25a4f8",
  "model": "<Cursor model identifier>",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Check the Q3 renewals sheet for accounts at risk and draft a note to the account team."
        },
        {
          "type": "attachment",
          "file_name": null,
          "media_type": "image/png",
          "size_bytes": 184320,
          "text": null
        }
      ]
    }
  ],
  "metadata": {}
}
```

### Frame fields

| Field | Value |
| --- | --- |
| `type` | Always `prompt` |
| `request_id` | A unique ID for the request. It matches `webhook-id` and the audit log's `request_id` |
| `tenant_id` | An opaque ID for your team |
| `actor.type` | Always `user` |
| `actor.id` | An opaque ID for the member who sent the message, or for a team service account. Null for Slack senders who haven't linked a Cursor account |
| `actor.email_address` | Always null |
| `source.application` | `grok-bot`, or `config-test` for Test Connection and circuit-breaker recovery checks |
| `session_id` | An opaque ID for the Bot, shared across its chats and members, so it doesn't identify one conversation |
| `model` | A Cursor model identifier. Use it for reporting, not allowlisting |
| `messages` | The conversation so far. See [Messages](#messages) |
| `metadata` | Always empty |

### Messages

* **Roles are `user` and `assistant`.** Tool results sit under `user`.
* **Blocks are `text`, `tool_use`, `tool_result`, and `attachment`.** A
  `tool_use` block names the tool and holds its `input`, and the matching
  `tool_result` holds the output. Context Grok Bot gives the model, such as
  rules, shared memory, and the connected apps it can use, usually arrives in
  an `attachment` block's `text`. An image is an `attachment` with its media
  type and size, but not its bytes or URL.
* **Every frame holds the whole conversation so far.** Frames aren't deltas,
  so each one carries the earlier messages again. In a long conversation, a
  summary Grok Bot writes takes the place of older messages.
* **Replies to members are tool calls.** Grok Bot sends what members read
  through a tool, so its replies appear in `tool_use` input, not in assistant
  `text`.
* **Cursor never adds secret values.** Context can name and describe the
  secrets a Bot can use, but never includes their values.

### Write policies for these frames

* **Verify the signature.** Don't rely on the User-Agent or source IP. If the
  Inference Hooks page lists **Source IP Ranges** under **Request Signing**,
  you can allowlist them as well.
* **Treat IDs as opaque strings.** Don't parse `tenant_id` or `actor.id`. Map
  members by `actor.id`, since frames carry no email.
* **Treat `source.application` as an open set.** Cursor adds values as
  coverage grows. It's advisory, not a security control.
* **Scan every block type, not only `text`.** Context usually arrives in
  attachment `text`, and replies to members and connected-app calls arrive in
  `tool_use` input.
* **Don't rely on `tool_result.is_error`.** It's `false` for most failed tool
  calls too.

### Verdicts

Answer with HTTP 200 and a JSON object:

```json
{
  "action": "deny",
  "deny_reason": "This message contains a customer account number. Remove it and try again.",
  "reference_id": "policy-7f3c21"
}
```

* **`action`** is `allow` or `deny`. Anything else is a failed check.
* **`deny_reason`** is shown in the block notice to the member who sent the
  message. Cursor truncates it to 500 characters.
* **`reference_id`** is your identifier for the decision, recorded in the
  Cursor audit log. Up to 50 characters from `A-Z`, `a-z`, `0-9`, and `.`,
  `_`, `:`, `/`, `-`. A malformed value is dropped and the deny still applies.
* **Unknown fields are ignored.** Cursor reads at most 64 KiB, uncompressed,
  and ignores cookies.

Answer `config-test` frames from Test Connection and circuit-breaker recovery
with a verdict too, and keep them out of your reports on member traffic.

## Audit log

Inference hook activity appears in your team's
[audit log](https://cursor.com/docs/enterprise/compliance-and-monitoring#audit-logs).
Payloads carry identifiers and codes, never prompt content, the deny reason,
the signing secret, or header values. An allowed request writes no event.

| `event_type` | When it fires | Fields |
| --- | --- | --- |
| `inference_hooks_config_updated` | An admin saves settings or resets the circuit breaker, or automatic recovery resets it | `action` (`update`, `reset_circuit_breaker`, `circuit_breaker_recovered`), `changed_fields`, `enforce_verdicts`, `mode`, `endpoint_host`, `verdict_timeout_ms`, `rollout_percent`, `enabled_surfaces`, `config_version` |
| `inference_hooks_signing_secret_generated` | The first save that sets an endpoint generates the signing secret, or an admin rotates it | `action` (`generate_signing_secret`, `rotate_signing_secret`), `changed_fields` (always empty), `enforce_verdicts`, `mode`, `endpoint_host`, `verdict_timeout_ms`, `rollout_percent`, `enabled_surfaces`, `config_version` |
| `inference_hooks_request_denied` | Your server denied a request | `request_id`, `reference_id`, `source_application`, `session_id`, `model`, `actor_id`, `mode`, `enforced` (`false` in Shadow mode) |
| `inference_hooks_request_failed_open` | A request proceeded without a verdict: a failed check in Allow or Shadow mode, a Cursor pause, or settings Cursor couldn't load | `request_id`, `reason`, `source_application`, `session_id`, `model`, `actor_id`, `mode`, `status_code` (`0` when no response arrived) |
| `inference_hooks_request_failed_closed` | A check failed in Block mode, so the request was blocked | `request_id`, `reason`, `source_application`, `session_id`, `model`, `actor_id`, `mode`, `status_code` (`0` when no response arrived) |
| `inference_hooks_circuit_breaker_tripped` | Sustained failures tripped the circuit breaker | `config_version`, `mode`, `failure_count`, `window_seconds`, `last_failure_kind` |

On `inference_hooks_signing_secret_generated`, the settings fields show the
state after the change. A rotation bumps `config_version`. A first secret
shares it with the `inference_hooks_config_updated` event from the same save.

Cursor records request failures in every mode, as failed open in Allow and
Shadow and failed closed in Block, and it records automatic circuit-breaker
recovery. `reason` on the failed-open and failed-closed events is a failure
(`timeout`, `non_200_status`, `unparseable_response`, `oversized_response`,
`invalid_action`, `transport_error`, `tls_error`, `endpoint_rejected`,
`frame_too_large`), a Cursor-side cause (`endpoint_not_allowlisted`,
`config_unavailable`), or, for failed open only, a pause (`kill_switch`). Build
SIEM rules on these event names and `reason` values.

The `request_id` on denied and failed events matches the frame's `request_id`
and `webhook-id`, so you can join your vendor's records to the audit log.

The Inference Hooks page also shows endpoint health: status, verdict latency,
failures per minute, block rate over 24 hours, and recent errors with their
type and status code. Its figures don't cover all traffic, so they can be lower
than your vendor's counts.

## Privacy and Privacy Mode

* **Cursor doesn't keep what it sends to your hook.** Cursor sends each frame
  to your endpoint over HTTPS and discards it once the verdict arrives. Frame
  content isn't written to Cursor's databases, logs, metrics, or traces.
* **Your endpoint, your retention.** The endpoint belongs to your organization
  or your security vendor. What it stores, where, and for how long depends on
  your configuration and your agreement with that vendor. Cursor doesn't
  control that data.
* **Privacy Mode is unchanged.** The model request itself is handled exactly as
  it is without a hook, under your team's Privacy Mode setting, and the hook
  adds no copy of it. Inference hooks run for every covered member regardless
  of Privacy Mode, because your admins direct Cursor to send these requests to
  your own endpoint.
* **Frame fields identify people only by opaque IDs.** `actor.email_address` is
  always null.

Cursor keeps only what it needs to run the feature and show you what happened:

* **Your settings, with secrets encrypted.** Header values and the signing
  secret are stored encrypted.
* **Audit log events with identifiers and codes only.** They include your
  server's `reference_id`, as listed in [Audit log](#audit-log).
* **Health figures without content.** They hold counts, latencies, and recent
  error types and status codes.
* **The block notice, encrypted with the blocked turn.** Your server's
  `deny_reason` and your Blocked Message are stored, encrypted, with Grok Bot's
  record of the blocked turn.

## Troubleshooting

### Why don't I see Inference Hooks on the Grok Bot page?

The page appears for team admins on Enterprise teams, and it shows the team
selected in the dashboard. Check that the right team is selected. If the page
says "Inference hooks aren't available yet," contact your account manager.

### Why is my endpoint URL rejected?

Check the [endpoint requirements](#endpoint-requirements). The usual causes are
a port other than 443, a query string or credentials in the URL, a tunnel host,
or a host that resolves to a private address.

### Why does Test Connection say a signing secret is required?

Cursor generates the secret on the first save that sets an endpoint. Save the
endpoint, copy the secret into your vendor's console, then test again.

### Why does my server reject Cursor's requests?

Most rejections are a signature or credential mismatch. Paste the current
signing secret into your server, including the `whsec_` prefix if your verifier
expects it, and check that it decodes the secret as standard base64. Confirm
your API key header is saved. If you changed the endpoint URL, re-enter the
header values. After a rotation, Cursor switches to the new secret within about
a minute.

### Why does Test Connection return a deny?

Your server's policy denies Cursor's synthetic test prompt. In Allow or Block
mode, a policy like that blocks members too. Adjust the policy or its default
action before you turn on enforcement.

### Why are requests timing out?

Your server took longer than the verdict timeout. Check verdict latency in the
health panel and your vendor's reports. Lighter scan profiles answer faster.
You can raise **Verdict Timeout (ms)** up to 10,000.

### Why isn't my endpoint receiving requests?

Check that an endpoint is saved, **Enforce Verdicts** is on, **Coverage**
includes Grok Bot, **Requests Inspected (%)** is above 0, and the circuit
breaker isn't tripped. Only Grok Bot conversations of your team's members are
covered. If Test Connection reports that inference hooks are paused, Cursor has
paused them.

### Why do members see that the policy check is unavailable?

You're in Block mode and the check failed, or the circuit breaker tripped.
Check **Recent Errors** on the Inference Hooks page. To keep members working
while you fix the endpoint, switch to **Allow the Request**.

### The circuit breaker tripped. How do I recover?

Fix the endpoint, run Test Connection, then click **Reset**. Automatic recovery
stops after any settings change, so don't wait for it if you edited anything
after the trip.

### Why is every message in a conversation blocked after one block?

The blocked message stays in the conversation and goes to your server with
every later request, so a policy that scans the whole transcript denies each of
them. Choose **Edit** on the block notice in the desktop or mobile app, or
**Remove blocked message** on the Bot's reply in Slack, to take the message
back and send something different. **Reset** clears the conversation instead.
If the conversation is blocked again right after a reset, what your policy
matches is likely in the Bot's memory or files. Remove it there. A policy that
judges the newest user message lets a conversation continue once the member
sends something different.

### Why don't inference hook events appear in the audit log filter?

The event types appear in the filter only while inference hooks are enabled for
your team. Events that were recorded still show in the log.

## Related pages

* [Grok Bot security](/grok-bot/security)
* [Grok Bot for teams and enterprises](/grok-bot/teams-and-enterprises)
* [Compliance and Monitoring](https://cursor.com/docs/enterprise/compliance-and-monitoring)
* [Privacy and Data Governance](https://cursor.com/docs/enterprise/privacy-and-data-governance)
