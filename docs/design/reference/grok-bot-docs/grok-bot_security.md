#### Manage and protect

# Grok Bot security

Use these controls and deployment details to decide whether Grok Bot is allowed
in, and to limit what Bots can access, change, and retain. Rollout steps and
the dashboard settings list live on
[Grok Bot for teams and enterprises](/grok-bot/teams-and-enterprises). Common
review questions are on [Grok Bot security FAQ](/grok-bot/security-faq).

> **Enterprise only** on the Grok Bot dashboard: the organization-wide enable
> switch, **Network Controls**, **Team Setup Scripts**,
> [**Team Secrets**](/grok-bot/teams-and-enterprises#team-secrets),
> **Action Recording**, **Allow Local Egress Routing**,
> **Allow Sudo on Bot Computers**, **Enforce Auto-review** with its team rules,
> **Inference Hooks**, and computer management for organization admins. Audit
> logs, OpenTelemetry Export, the MCP allowlist, and SCIM are also Enterprise
> only. Self-serve Teams do not see those settings. The full list is on
> [admin controls](/grok-bot/teams-and-enterprises#admin-controls).

## Architecture

The Grok Bot desktop and mobile apps send each request to Cursor's servers.
From there, work runs on the member's hosted computer, prompts go to model
providers, and tool calls reach third-party services through connected apps.

A control sits on each of those paths. Each one links to its section on this
page.

## Network policy

**Network Controls is Enterprise only.** Admins set a Grok Bot network policy
under **Network** on the [Grok Bot page](https://cursor.com/dashboard/bot) of
the Cursor dashboard, in **Grok Bot Network Access**. It controls which
destinations team computers can reach. Self-serve Teams do not see this panel
and cannot set a destination allowlist. Teams without a policy default to
allow-all.

| Mode | Effect |
| --- | --- |
| **Allow All Network Access** | All destinations. Teams without a policy get this. |
| **Defaults + Team Allowlist** | Cursor's default destinations plus your list |
| **Team Allowlist Only** | Only your list, plus the destinations a computer needs to function |

* **Destinations** cover web domains as well as IP ranges with ports for raw
  connections, with no cap on the number of entries.
* **Directory groups. Enterprise only, inside Network Controls.** Groups can
  set their own network policy, which replaces the team's for their members,
  and a lock makes the team policy effective for everyone.
* **The policy is separate from Cloud Agent network settings.** Running
  computers apply changes automatically within about a minute. Sleeping
  computers apply changes when they next wake. You do not need to recreate the
  computer.
* **Restricting egress limits where data can be sent.** To check what reaches
  the model against your own data loss prevention policy, use
  [inference hooks](#inference-hooks).

Blocking an app does not block that service's website. The connector policy
and the network policy are separate layers, and closing both paths takes both
controls.

### MCP servers and the network policy

The network policy governs where team computers send traffic. Connected apps
(MCP servers) are different: Bots reach remote MCP servers from Cursor's
servers, so an allowlist mode does not cover them on its own. To hold them to
the same list, turn on **Apply to MCP servers**. The switch sits below
**Allowed destinations** (Allowed Destinations on the older settings page) and
above **Lock for all groups** (Lock for All Groups) in
**Grok Bot Network Access**, and it appears only while
**Default, plus the allowlist** (Defaults + Team Allowlist) or
**Allowlist only** (Team Allowlist Only) is selected.

* **Off, the default for every team.** Bots can connect to any MCP server your
  connector policy permits, whatever the network policy says.
* **On.** A remote MCP server must also match an entry in
  **Allowed destinations**. A server that does not match is refused when a Bot
  tries to use it, and the member sees which destination to ask an admin to
  add. Command servers that run on the computer are unaffected; the network
  policy already applies to them.

Turn the switch on before you rely on it: an allowlist mode by itself does not
restrict MCP servers. The switch is a team setting. Directory groups inherit it
and cannot turn it off, and a locked team policy includes it. Saving it does
not restart computers; it applies to the next MCP connection. It is separate
from the settings under **MCP Configuration** in Team Settings, which govern
Cursor in the editor; changing one does not change the other.

**Built-in connectors are checked too.** The switch covers every connected app
a Bot uses, including the ones Cursor operates for you under **Connect apps**,
such as GitHub, X, Origin, Google Workspace, and Microsoft 365. A connected app
is checked by the hosts it sends requests to, not by the name in the connector
list, so add those hosts to **Allowed destinations** before you turn the switch
on. A connector whose hosts are not all allowed is refused the next time a Bot
uses it, with the message
`MCP server "<host>" refused: it is not on your team's Grok Bot network allowlist (Grok Bot settings > Network > Allowed destinations). A team admin can add it.`

| Connected app | Hosts to allow |
| --- | --- |
| GitHub | `api.github.com` |
| X | `api.x.com` |
| Origin | `api.origin.cursor.com` |
| Gmail | `gmail.googleapis.com`; also `gmailmcp.googleapis.com` if the connector was added at Google's hosted address |
| Google Calendar | `www.googleapis.com`; also `calendarmcp.googleapis.com` if added at Google's hosted address |
| Google Drive | `www.googleapis.com`, `sheets.googleapis.com`; also `drivemcp.googleapis.com` if added at Google's hosted address |
| Google Docs | `docs.googleapis.com` |
| Google Sheets | `sheets.googleapis.com` |
| Google Slides | `slides.googleapis.com`, `slidesmcp.googleapis.com` |
| Google Ads | `googleads.googleapis.com` |
| Outlook, Outlook Calendar, OneDrive, Microsoft Teams | `graph.microsoft.com` |
| Stripe Link | `api.link.com` |
| Tailscale | `api.tailscale.com`, `login.tailscale.com` |
| QuickBooks Online | `ah-api.merge.dev`, `quickbooks.api.intuit.com` (`sandbox-quickbooks.api.intuit.com` for a sandbox company), `oauth.platform.intuit.com`, `developer.api.intuit.com` |
| Workday | `ah-api.merge.dev`, plus the sign-in and REST API hosts of your Workday tenant as entered in the connector's settings |
| WhatsApp Business | `ah-api.merge.dev`, `graph.facebook.com` |
| Zoho CRM, Zoho Books | `ah-api.merge.dev`, plus your Zoho data center's accounts host and API host, for example `accounts.zoho.com` and `www.zohoapis.com` for the United States (`.eu`, `.in`, `.com.au`, `.jp`, `.sa`, `.uk`, `.ae`, `.sg`, or `accounts.zohocloud.ca` and `www.zohoapis.ca` for Canada) |
| Zoho Desk | `ah-api.merge.dev`, plus your data center's accounts host and its Desk host, for example `accounts.zoho.com` and `desk.zoho.com` |

Other connectors in the Team Marketplace are checked by the host in their
server address, which is shown on the dashboard's
[Plugins & MCPs page](https://cursor.com/dashboard/plugins); allow that host.

## Static egress IPs

Hosted computers reach the internet through shared static egress IP addresses
by default. The ranges are shared across Grok Bot customers, and dedicated
per-customer IPs are not available, so treat the ranges as identifying Grok Bot
traffic rather than your team alone. Current ranges are available from your
account team, and the product control is the destination allowlist rather than
a source IP editor.

If member devices sit behind Zscaler or another TLS-inspecting gateway, allow
Cursor's domains and exempt them from inspection on every profile, including
off-network. See [Configure TLS-inspecting proxies](/grok-bot/proxies).

Members can route traffic through their desktop to use its IP address; sites
that resolve to a private or VPN address stay blocked on that route unless they
have been allowed for your organization. **Team Setup Scripts** is Enterprise
only. Those teams can also install their own networking client on every team
computer. Both paths are separate from the shared egress ranges. See
[Connect to private networks](/grok-bot/private-networks).

## Approvals and Auto Review

Approvals keep consequential actions under the member's control. The strongest
boundary is the one in the request itself, so have members state what a Bot
may change and where it must stop:

> Reconcile the campaign data and draft a recommended budget change. Do not
> change the campaign or message the agency. Ask for approval after showing the
> current value, proposed value, and expected impact.

When an action needs approval, the conversation shows the proposed operation
and its inputs. **Allow once** lets the Bot continue with that action,
**Always allow** can save a matching rule, and **Deny** stops the action; the
Bot does not try it again until the member sends another message. The controls
are the same on iPhone. An approval controls the proposed action, not work
already completed, and nobody should approve an action whose target or effect
they cannot identify.

Auto Review is the review layer behind those prompts: an independent review
model that evaluates risky Bot actions before they run, covering shell
commands, app calls, computer use, automation writes (changes to routines
and event triggers), and delegation such as Cloud Agent and subagent launches.
It can let an action proceed, require approval, or deny it.

* **Team admins can enforce Auto-review. Enterprise only.** The switch lives
  on the Grok Bot page of the Cursor dashboard. When it is on, members cannot
  turn Auto-review off, unless a group they belong to lifts the lock with
  **Don't enforce for this group**; see
  [Group settings](/grok-bot/teams-and-enterprises#group-settings).
* **Admins can add team Auto-review rules. Enterprise only.** These live on
  the Grok Bot page too. They apply to every member's Bots, show up as locked
  rows in the member settings table, and save automatically when an admin
  adds, edits, or deletes a rule. If admins turn enforcement off, the team
  rules stop applying and members go back to their own rules only.
* **Members can add personal rules** under **Settings → General →
  Auto-review**, in **Custom Rules**. **Ask first** rules always stop matching
  actions, and **Allow automatically** rules let matching actions proceed only
  when the reviewer finds no other reason to stop. Members can add personal
  rules on top of team rules, but they only make behavior stricter;
  **Ask first** wins when rules conflict. Keep rules narrow and tied to a known
  action, like "ask first before sending any external email" or "allow
  automatically when running `git status` in `/workspace/reports`". Avoid broad
  rules like "allow everything in the browser". Personal rules are saved to the
  member's account, so they apply from every desktop and the mobile app.
* **It does not review every side effect.** Memory writes and most settings
  changes are examples. Treat it as a complement to explicit boundaries and
  least privilege, working alongside controls that do not depend on a model's
  judgment: per-action approvals, the network policy, and per-user isolation.

## Inference hooks

Inference hooks send each Grok Bot model request, signed, to an AI security
server your organization runs or uses through a security vendor. Your server
allows or denies the request before the model runs, so your own policy checks
prompts and the content Grok Bot gathers, such as web pages and app results.
New configurations start in Shadow mode, which records denials in the audit
log without blocking anything.

Inference hooks check model inputs, not actions as they run. Keep the network
policy and Auto Review in place to control what Bots do. Setup, modes, the
request format, and audit events are on
[Grok Bot inference hooks](/grok-bot/inference-hooks).

Inference hooks are in beta and available to all Enterprise teams.

## Identity and sign-ins

Members sign in to Grok Bot with their Cursor account, so your existing Cursor
SSO configuration applies. SAML 2.0 single sign-on works with Okta, Microsoft
Entra, Google Workspace, and OneLogin, and SSO can be required for all members
(which blocks password login). **SCIM is Enterprise only:** SCIM 2.0
provisioning and deprovisioning. For step-by-step Okta and Entra ID
configuration, including app assignment and sign-in rules for the computer
browser, see [Configure identity and access](/grok-bot/identity-and-access).

Inside the hosted computer, members sign in to applications through your own
identity provider in the browser, comparable to enrolling a new laptop. Your
session policies govern those sessions, and revoking the user in your identity
provider ends them.

A Bot has no identity or credentials of its own:

* **Bots act as the signed-in member.** A Bot can never hold more access than
  the person it belongs to, every action stays attributable to a named member,
  and there is no separate machine identity outside your identity provider to
  provision, rotate, or audit. Team-managed connectors are the one exception:
  they may use team or service-account credentials.
* **Connector tokens stay on Cursor's backend.** Bots invoke tools without
  receiving OAuth tokens, and tokens are never stored on the computer.
* **Credentials stay out of the model.** To sign in, the Bot uses a login the
  member saved in Vault, a connected password manager, or a value the member
  enters in a Secure Form. These values are filled into the page by reference:
  the model never receives a saved password, card number, or security code, or
  what the member types in a Secure Form. The Bot can see which logins are
  saved and the member's saved contact info. For single sign-on, passkeys, and
  other steps a form cannot handle, the Bot hands the computer to the member.
  For an API key or other secret, a secure secret card masks the value and
  keeps it out of the transcript and away from the model. A card saved in Vault
  fills at checkout without a separate approval each time, so members who want
  to approve each payment should not save the card. Vault is not available on
  shared Bots. Passwords and one-time codes never belong in ordinary chat. See
  [Store secrets securely](/grok-bot/vault).

To end a member's current work, an organization admin terminates the member's
computer from the dashboard; see [Manage Grok Bot computers](/grok-bot/computers).
That control is Enterprise only. It stops running Bots, keeps the durable disk,
and the member's next session starts a fresh computer. It does not remove
access. To remove access, remove the member from the team or turn off Grok Bot
for their group, and revoke their sessions in your identity provider.
Application sessions persist only on the member's computer.

When a project or login should no longer be available, members clean up
directly: pause or delete related routines, sign out of websites on the
computer, remove connected apps and revoke their authorization in the source
service, and remove sensitive files from `/workspace`. Deleting a Bot does not
remove computer files or browser sessions.

## Logging and audit

Audit Logs and Action Recording use separate pipelines. Audit Logs cover
administrative and security events, including Grok Bot control-plane actions.
Action Recording captures Bot actions, and OpenTelemetry Export sends those
events to your collector when configured, tagged `cursor.surface=grok_bot`.

* **Audit logs. Enterprise only.** They cover admin, security, and
  authentication events, plus Grok Bot control-plane events: Bot creation,
  member access changes, Team Setup manifests, MCP authentication, Slack
  account links, and routines. Filter them by application in the dashboard, or
  stream them to your SIEM. Self-serve Teams do not get this log.
* **Action Recording. Enterprise only.** It is a setting on the Grok Bot page,
  off by default. When a team enables it, Cursor records Bot actions, including
  scrubbed shell commands, in an internal store with a 90-day retention. Action
  Recording events do not appear on the Audit Log page. To receive the
  sanitized events in your own collector, configure
  [OpenTelemetry Export](https://cursor.com/docs/enterprise/opentelemetry-export),
  which is also Enterprise only. Privacy Mode (Legacy) forces recording off.

## Endpoint tooling

Grok Bot does not ship a built-in customer-facing telemetry or EDR feed. The
computers are Cursor-operated infrastructure that Cursor monitors for
operational health and abuse, and that telemetry deliberately excludes customer
data. **Team Setup Scripts** is Enterprise only. Those admins can install their
own tooling on every team computer.

## Data retention and deletion

Each member's computer keeps local files, browser sessions, and anything saved
in the browser on a durable disk across sessions. Connector tokens are never
stored on the computer.

* **Idle computers hibernate automatically.** Hibernation is not deletion.
* **Image updates preserve files.** Computers on a stale system image are
  recreated on the fresh image with member files preserved.
* **Member resets keep saved data.** Members can reset their own computer
  from the desktop app. Like Recover, Reset rebuilds the computer from the
  last saved data, and very recent changes can be lost if the computer cannot
  be reached to save them. See
  [Grok Bot computer](/grok-bot/computer-and-apps#update-recover-or-reset-the-computer).
* **Deletion follows the DPA.** Under the
  [Data Processing Agreement](https://cursor.com/terms/dpa), data is deleted or
  returned within 30 days of written direction after the service ends.
* **Backups run daily.** Cursor's production control plane is covered by daily
  encrypted backups, replicated to a separate recovery facility.

A per-organization retention policy and customer-managed point-in-time restore
of an individual computer are not available.

## Data residency

Grok Bot computers run in the United States. Grok Bot is also covered by
Cursor's US-only data residency program. When it is enabled, inference, data
processing, and storage for Grok Bot stay in the US. Contact your account team
to enroll. See
[US data residency](https://cursor.com/docs/enterprise/privacy-and-data-governance#us-data-residency)
for supported models, exclusions, and pricing.

## Models and data

Grok Bot manages model selection. There is no customer-facing model picker, and
the serving mix can change over time with no fixed vendor set guaranteed. Each
request goes to a first-party SpaceXSI model or a third-party model from a
provider on the [sub-processor list](https://trust.cursor.com/subprocessors).
Usage and spending views record this activity as Grok Bot usage rather than by
model. See
[Which AI models power Grok Bot?](https://cursor.com/help/grok-bot/models).

* **The team model allowlist does not govern Grok Bot.** Grok Bot uses
  SpaceXSI first-party models and may use third-party models regardless of your
  [model access control](https://cursor.com/docs/enterprise/model-and-integration-management#model-access-control)
  settings. Teams with a model allowlist see this acknowledgement when they
  enable Grok Bot. If your contract restricts subprocessors, contact your
  account team.
* **Privacy Mode applies.** While a member is on your team, the team's privacy
  mode governs them, and with Privacy Mode enabled, customer data is not used
  for training.
* **Zero Data Retention follows Cursor's existing provider agreements.** Model
  providers do not keep prompts or outputs, and Grok Bot adds no separate
  control. Providers may run abuse and safety classifiers, and flagged data
  may be stored for investigation.

## Local execution

Bots can act on a member's own machine through the desktop app: run commands,
read files, and move files between the cloud computer and the local machine.
This is separate from work in the hosted computer, with its own control, and
it is distinct from Auto Review, which governs work inside the hosted computer.

Per-command approval is the default, and the approval card shows the exact
command. Members choose the policy under
**Settings → Computer → Your computer**, in **Execution on this computer**
(**Execution on Local Computer** until the desktop is listed): **Ask every
time**, **Always allow**, or **Never allow**. Recommend **Never allow** unless
a Bot has a specific reason to work on local files. Admins can cap the policy
for the whole team with
[Execution on Local Computer](/grok-bot/teams-and-enterprises#execution-on-local-computer)
on the Grok Bot page; a member's own setting still applies when it is stricter.

## Hosting

Grok Bot runs only on Cursor-hosted cloud computers. On-premises deployment,
deployment inside your own perimeter, and bring-your-own-image deployment are
not supported today. Hosted computers use shared static egress by default.
Members can route traffic through their desktop, and Enterprise teams can
install a networking client with **Team Setup Scripts**. See
[Connect to private networks](/grok-bot/private-networks).

## Prompt injection

Content a Bot reads from the outside world, like web pages, app results, and
command output, can try to steer it. Grok Bot layers defenses: Auto Review
checks Bot actions against the member's request when enforcement is on, and
beneath it sit controls that do not depend on any model's judgment, including
the network policy, per-action approvals, and per-user isolation. Outside
content is marked as untrusted data when presented to the model. With
[inference hooks](#inference-hooks), your own security server can also screen
that content before the next model call. These controls reduce, but do not
eliminate, risk from malicious content, which is another reason to keep
consequential actions behind approval.

## Certifications

Anysphere, the company behind Cursor, holds ISO/IEC 27001 and ISO/IEC 42001
certifications, issued by Schellman, and Grok Bot is included in the current
ISO scope. ISO/IEC 27001 certifies the information security management system,
the security program of the whole organization. ISO/IEC 42001 certifies the AI
management system, how Cursor governs the AI it builds and operates.
Certificates and reports are available at
[trust.cursor.com](https://trust.cursor.com).

## Related pages

* [Grok Bot security FAQ](/grok-bot/security-faq)
* [Grok Bot for teams and enterprises](/grok-bot/teams-and-enterprises)
* [Grok Bot inference hooks](/grok-bot/inference-hooks)
* [Configure identity and access](/grok-bot/identity-and-access)
* [Connect to private networks](/grok-bot/private-networks)
* [Configure TLS-inspecting proxies](/grok-bot/proxies)
* [Privacy and Data Governance](https://cursor.com/docs/enterprise/privacy-and-data-governance)

Contact your Cursor account team about egress ranges, residency commitments,
and security review support.
