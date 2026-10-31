#### Manage and protect

# Grok Bot for teams and enterprises

Grok Bot gives each person on your team standing Bots for everyday work:
research, operations, documents, browsing, and automations. This page is for
team and organization admins rolling Grok Bot out. Security reviewers should
start with [Grok Bot security](/grok-bot/security) and the
[Grok Bot security FAQ](/grok-bot/security-faq). Members who want the approval
model should start there too.

## Availability

| Plan | Access |
| --- | --- |
| Individuals | Included with every paid Cursor plan, through an individual SuperGrok link, or with a seat on a self-serve Grok Business plan |
| Teams | Included; every member has access, and usage follows the seat's allowance |
| Enterprise | Enable Grok Bot for your team from [your dashboard](https://cursor.com/dashboard/bot) |

That table is product access, not the admin control list. Grok Bot is included
on Teams. Several settings are Enterprise only and do not appear for
self-serve Teams. [Admin controls](#admin-controls) marks each one.

[Plans and billing](https://cursor.com/help/grok-bot/plans) is the canonical
plan and usage matrix.

## Enabling Grok Bot for your team

On the Teams plan, Grok Bot is enabled by default, and every member has access
without any admin action. It stays off for teams on
[Privacy Mode (Legacy)](#before-you-roll-out) or on a
[legacy request-based plan](https://cursor.com/docs/models-and-pricing#legacy-request-based-pricing).
There is no switch to turn it off.

On the Enterprise plan, an admin turns it on from
[Grok Bot in the Cursor dashboard](https://cursor.com/dashboard/bot). Once
enabled, you can give access to all team members or limit it to specific
[groups](https://cursor.com/dashboard/members?subtab=groups) with
**Manage Group Access**. Turning Grok Bot off blocks every member without
deleting their computers.

Admins on either plan can bring members in with **Invite Team** on the Grok Bot
page. Existing Cursor users on your team get an email with a download link. New
users get an invitation to your Cursor team, by email or invite link, that also
points them to Grok Bot. Teams that manage membership through SCIM see only the
existing-users option.

To install the desktop app on managed devices yourself and plan updates, see
[Deploy Grok Bot to your organization](/grok-bot/deployment).

## Before you roll out

* Move off Privacy Mode (Legacy). That setting blocks Grok Bot entirely, and
  you are prompted to change it before enabling. Check the privacy setting in
  Team Settings.
* Plan for shared egress addresses. If your company restricts services by
  source IP, see [static egress IPs](/grok-bot/security#static-egress-ips).
* Clear your gateway. If member devices sit behind Zscaler or another
  TLS-inspecting proxy, allow Cursor's domains, including the nested
  `*.*.cursorvm.com` pattern, and exempt them from inspection before members
  connect. See
  [Configure TLS-inspecting proxies](/grok-bot/proxies).
* Decide how members sign in to company tools from the computer. See
  [identity and sign-ins](/grok-bot/security#identity-and-sign-ins).
* Review the policies Grok Bot inherits: Team Rules and the connector policy on
  every plan, plus team Auto-review rules and the MCP allowlist on Enterprise.

## Architecture

### How Grok Bot is built

Grok Bot is a computer-use agent that operates applications, browsers, and
development environments. It runs in Cursor's cloud, and each user's work
executes on a dedicated cloud computer. The desktop and mobile apps are thin
clients for chat, review, and approvals.

The security model rests on four principles:

* Per-user isolation. Each user's work runs in a dedicated Firecracker microVM,
  a micro virtual machine with hardware-level separation from other users.
* No access by default. A Bot can use only the accounts and connected apps the
  user or team grants it.
* Human approval gates. Sensitive actions require user approval, evaluated by
  an independent review model called Auto Review.
* Administrative control. Team admins can set Team Rules, Cloud Agent
  delegation, template sharing, and the local execution ceiling. Network
  Controls, Team Setup Scripts, Team Secrets, Allow Local Egress Routing, Allow
  Sudo on Bot Computers, Action Recording, Enforce Auto-review, Auto-review
  rules, and the organization-wide enable switch are Enterprise only.

The pieces fit together like this:

1. Local machine. Chat, review, and approvals happen on the member's device.
   Work runs in the hosted computer. Optional
   [local execution](/grok-bot/security#local-execution) requires per-command
   approval by default and can be turned off.
2. Environment. One persistent Firecracker microVM per user. Every Bot that
   user runs shares that computer. Admins manage Grok Bot from the Grok Bot
   page of the [Cursor dashboard](https://cursor.com/dashboard/bot). Team
   Rules, Cloud Agent delegation, public template sharing, and Execution on
   Local Computer are available to team admins. Enterprise only on that page:
   the organization-wide enable switch, Network Controls, Team Setup Scripts,
   Team Secrets, Allow Local Egress Routing, Allow Sudo on Bot Computers,
   Action Recording, Enforce Auto-review, Auto-review rules, and computer
   management. Members never see this page.
3. The Bot. Shell, browser, and computer use inside the hosted computer. A Bot
   has no access by default and acts only with accounts the member signs it
   into. It fills logins and cards from the member's Vault, a connected
   password manager, or a Secure Form without seeing the values, and hands
   steps such as single sign-on and passkeys to the member.
4. Connected apps. Your team's Cursor MCP (Model Context Protocol) policy
   applies in full, allowing or blocking each connector. OAuth tokens stay on
   Cursor's connector backend, and Bots invoke tools without receiving them.
5. Cloud Agents. Grok Bot can delegate coding tasks to separate computers under
   your existing [Cloud Agent](https://cursor.com/docs/cloud-agent) controls.
   Admins can disable spawning.
6. Models and data. Grok Bot manages model selection. With Privacy Mode enabled,
   customer data is not used for training; Cursor enforces this on its servers,
   and when the setting cannot be verified, the system defaults to not training.

### How users are isolated

Each user gets a dedicated computer with hardware-level separation, and one
user cannot reach another user's computer. Every computer is a Firecracker
microVM with its own kernel, memory, and virtual devices.

Within one user, the boundary is different: all of that user's Bots share one
computer, and Bots isolate personalities and workspaces, not compute. Treat a
login or file on the computer as available to every Bot that user runs, sign
the browser out of accounts a Bot no longer needs, and remove sensitive
temporary files when work completes. When a workload needs its own computer and
credential set, give it its own Cursor user.

[Shared Bots](/grok-bot/shared-bots) are the exception to one Bot per user. A
Bot is either personal or shared: a member shares a cloud-hosted Bot with
everyone on the team, or only with certain people and groups, and those members
can chat with it. Each member's chat is private, including from the owner and
the Bot's Managers. In a member's own chat or Slack DM, the Bot usually works
on that member's computer, uses that member's connected accounts after asking,
and uses that member's Grok Bot usage. In Slack channels, threads, group DMs,
and group chats, a shared Bot uses one computer of its own. Secrets, apps, and
files the owner or a Manager adds to a shared Bot are available in every
teammate's chat.

## Admin controls

Most Grok Bot settings sit on the Grok Bot page of the
[Cursor dashboard](https://cursor.com/dashboard/bot), which only admins see. A
few live in Team Settings, your Team Marketplace, or your identity provider.
Several controls are available only on the
[Enterprise plan](https://cursor.com/docs/enterprise); the rest are available
on Teams and Enterprise. Enterprise teams can also widen several of these
controls for one cohort from a group's Grok Bot tab; see
[Group settings](#group-settings).

### Access and identity

Who can use Grok Bot, and how members are provisioned.

#### Enable Grok Bot

The organization-wide switch on the Grok Bot page, with **Manage Group Access**
beside it. Turning it on opens a setup modal that covers privacy mode, billing,
and model availability, offers to turn on Cloud Agents when they are off, and
asks you to accept the Grok Bot Terms. Turning it off blocks every member
without deleting their computers. See
[Enabling Grok Bot for your team](#enabling-grok-bot-for-your-team).

Available on the Enterprise plan.

#### SCIM

SCIM 2.0 provisioning and deprovisioning through your identity provider.
Members sign in to Grok Bot with their Cursor account, so your existing
[SCIM](https://cursor.com/docs/account/teams/scim) and SSO setup carries over.
For Okta and Entra ID steps, including app assignment and sign-in rules for the
computer browser, see
[Configure identity and access](/grok-bot/identity-and-access).

Available on the Enterprise plan.

#### Team icon

The image Grok Bot shows for your whole team, such as when a member shares a
Bot with everyone. Admins upload, change, or remove it from the
**Team Profile** section of Team Settings. Use a PNG, JPEG, or WebP up to 2 MB.

### Agent capabilities

What Bots may do on behalf of members. Each control applies to every member's
Bots.

#### Cloud Agents

Allows or blocks Bots delegating coding tasks to Cursor
[Cloud Agents](https://cursor.com/docs/cloud-agent). The switch is on the Grok
Bot page, applies to the whole team, and is on by default. Delegated work runs
on separate computers under your existing Cloud Agent controls. Turn it off
when your team does not need delegation.

#### Public template sharing

Controls whether members can publish Bot templates outside your team. Off keeps
sharing team-only, and Cursor enforces the policy on its servers, including for
templates that are already public. Enterprise teams start with public sharing
off; other teams start with it allowed. For what a shared template contains,
see [Share a Bot](/grok-bot/bots#share-a-bot).

#### Manage Shared Bots

Controls who can use each [shared Bot](/grok-bot/shared-bots) and adds shared
Bots to members' sidebars automatically. Open **Manage Shared Bots** under
**Shared Bots** on the Grok Bot page. The **Access** column shows who can use
each shared Bot, such as the whole team, certain people or groups, or only its
owner. Click it to change who has access. In a Bot's **Auto-add** column, pick
**All team** or one or more groups, or clear it. Auto-add only applies to
groups that have access. Members who get a Bot this way cannot hide it from
their sidebar. Admins can also delete a shared Bot here. Deleting it removes it
for everyone on the team, removes its Slack app, and cannot be undone. Groups
are managed on the Members & Groups page.

#### Page sharing

Controls how members can share [Pages](/grok-bot/files-and-results#pages)
inside your team. Find **Page sharing** under **Sharing** on the Grok Bot page
and pick **Anyone on the team**, **Specific teammates**, or **Off**.
**Anyone on the team** is the default. Pages already shared stay shared when you
tighten it. The control appears as Pages reach your team.

#### Agent Email

Lets members claim a `mail.grokbot.com` address that their Bots can read and
send mail from. The switch is under **Bot Capabilities** on the Grok Bot page
and is off by default; members get no email tools until it is on. When a member
asks for an email in chat, it sends once Auto-review allows it or the member
approves it. Email the Bot writes on its own, including from routines, waits as
a draft until the member presses **Send**. Newsletters and first-contact emails
include an unsubscribe link, and incoming mail acts only through routines the
member sets up. Turning it off removes the Bots' email tools and stops email
routines; existing addresses keep receiving mail. See
[Give your Bot an email address](https://cursor.com/help/grok-bot/agent-email).

#### Connector policy

Grok Bot inherits your team's Cursor connector policy. There is no separate
Grok Bot connector list, and members find permitted connectors under **Connect
apps** in Grok Bot. Set which servers members can use from your Team
Marketplace on the dashboard's
[Plugins & MCPs page](https://cursor.com/dashboard/plugins), not on the Grok
Bot page. The MCP allowlist is Enterprise only; see
[MCP server trust management](https://cursor.com/docs/enterprise/model-and-integration-management#mcp-server-trust-management).
Any permitted connector is available to every Bot a member runs, and a blocked
one shows as **Disabled by team admin**. Pushing connectors to members, whether
mandatory or default-on, is not available. If your team uses an allowlist
network policy and wants remote MCP servers held to the same list, turn on
**Apply to MCP servers** under **Network**; it is off by default. See
[MCP servers and the network policy](/grok-bot/security#mcp-servers-and-the-network-policy).

#### Execution on Local Computer

Caps what Bots may do on a member's own machine through the desktop app: open
files and run tasks. Pick **Always allow**, **Ask every time**, or **Never
allow** on the Grok Bot page. **Always allow**, the default, leaves the choice
to each member, whose own setting defaults to asking before every task. **Ask
every time** makes every local task ask for approval, and **Never allow** turns
local execution off for the whole team. A member's own setting still applies
when it is stricter than the team's. Pick **Never allow** unless Bots have a
specific reason to work on member machines. See
[local execution](/grok-bot/security#local-execution).

#### Allow Local Egress Routing

Let members route Grok Bot's web traffic through their own computer. Off
disables the option in Grok Bot. The switch is under **Bot Computers** on the
Grok Bot page and is on by default. Turning it off stops active routes within
five minutes. Turning it back on restores each member's previous choice. See
[Route traffic through your desktop](/grok-bot/settings-and-notifications#route-traffic-through-your-desktop).

Available on the Enterprise plan.

### Rules and approvals

Guidance Bots follow, and the review layers that stop actions and model
requests.

#### Team Rules

Rules that every member's Bots follow. Add them from the Grok Bot page and
scope each rule to Cursor, Grok Bot, or both. Rules applied to Grok Bot are
always required, so members cannot turn them off. Keep them short and few,
like "never move company data to personal accounts." Rules guide a Bot; for
approval behavior, use [Auto-review rules](#auto-review-rules). For guidance
that belongs to one cohort, add Group Rules under
[Group settings](#group-settings).

#### Enforce Auto-review

Prevents members from turning Auto-review off. The switch is on the Grok Bot
page and is off by default. When it is on, Bots always check risky actions
before running them and ask for approval when needed. This includes shared
Bots in chats where nobody can answer an approval, which otherwise run without
Auto-review. Turn it on before you rely on team Auto-review rules. A group can
lift the lock for its own members with **Don't enforce for this group**; see
[Group settings](#group-settings).

Available on the Enterprise plan.

#### Auto-review rules

Team-wide **Ask first** and **Allow automatically** rules that apply to every
member's Bots on top of their own rules. Add them with **Configure Rules** on
the Grok Bot page; changes save automatically. Members see the team rules under
**Settings → General → Auto-review** but cannot edit or delete them, and **Ask
first** wins when rules conflict. Turning enforcement off stops applying the
team rules. See
[approvals and Auto Review](/grok-bot/security#approvals-and-auto-review).

Available on the Enterprise plan.

#### Inference Hooks

Sends each Grok Bot model request, signed, to an AI security server your
organization runs or uses through a security vendor. Your server allows or
denies the request before the model runs. Open
[Inference Hooks](https://cursor.com/dashboard/bot/inference-hooks) from
**Security & Compliance** on the Grok Bot page. New configurations start in
Shadow mode, which records denials in the audit log without blocking members.
Inference hooks are in beta and available to all Enterprise teams. See
[Grok Bot inference hooks](/grok-bot/inference-hooks).

Available on the Enterprise plan.

### Computers and network

How team computers are set up, what they can reach, and how you recreate or
terminate them.

#### Network Controls

Restricts which destinations team computers can reach. Find it under
**Network** on the Grok Bot page as **Grok Bot Network Access**. Pick
**Allow All Network Access**, **Defaults + Team Allowlist**, or
**Team Allowlist Only**, and list domains and IP ranges for the allowlist
modes. Directory groups can carry their own policy, and a lock makes the team
policy apply to everyone. Teams without a policy default to allow-all. See
[network policy](/grok-bot/security#network-policy) for the modes and how a
new policy reaches running computers.

In an allowlist mode, the **Apply to MCP servers** switch appears below the
destination list. It is off by default. When it is on, every connected app,
including built-in connectors such as GitHub, X, and Origin, must match an
allowed destination by the hosts it sends requests to, and a Bot's connection
to one that does not match is refused. Command servers are unaffected. See
[MCP servers and the network policy](/grok-bot/security#mcp-servers-and-the-network-policy)
for the hosts each built-in connector needs.

Available on the Enterprise plan.

#### Team Setup Scripts

Manifests of install scripts that run on every team computer, so the same
tooling is present everywhere. Find **Team Setup Scripts** under **Bot
Computers** on the Grok Bot page. Keep secret values out of setup scripts; when
a script needs a credential, store it as a [Team Secret](#team-secrets) and
read it from the environment. Members do not see these scripts in the app. For
how manifests run, and to install a networking client that reaches private
services, see [Connect to private networks](/grok-bot/private-networks). To
run extra scripts on one cohort's computers only, add them under
[Group settings](#group-settings).

Available on the Enterprise plan.

#### Team Secrets

Team-wide values that Team Setup scripts read as environment variables, so a
script can hold a license key, auth key, or service token without the value
appearing in the manifest. Add them under **Team Secrets** on the Grok Bot
page: each secret is an environment variable name and a value. Cursor stores
the value encrypted, and the dashboard never shows it again after you save it.
Team admins, including unpaid admins, can add, replace, or delete them.

How they reach the computer:

* Every Setup Script and Check Script in your Team Setup manifests, and in
  group [Setup Scripts](#group-settings), runs with the team's secrets in its
  environment. Reference a secret by name, for example `"$MY_LICENSE_KEY"`.
* Secrets exist only in the script's process environment. Once the script
  finishes, the value is gone unless the script wrote it somewhere, so store
  nothing on the computer that you do not want every Bot that member runs to
  reach.
* Script output is checked for secret values before it is logged, and matches
  are redacted.
* A computer receives secrets only when its Team Setup comes from exactly one
  team. A member whose computer applies setup from two or more teams gets no
  secrets from any of them, since scripts from different teams share one
  computer user.
* Changes, including rotated values, take effect the next time the scripts
  run: when a computer starts, on the periodic refresh, or when you recreate
  it. See
  [Roll out to existing computers](/grok-bot/private-networks#roll-out-to-existing-computers).

Limits: up to 100 secrets per team, up to 32 KB per value, and up to 96 KB in
total. Names must be valid environment variable names, and names the computer
runtime reserves, such as `PATH`, `HOME`, and anything starting with `SAND_`
or `LD_`, are rejected when you save. Team Secrets are for scripts you control.
They do not make a value available to Bots directly, and they are separate from
the [secrets members store on a Bot](/grok-bot/vault). They are not available
through the Admin API.

Available on the Enterprise plan.

#### Allow Sudo on Bot Computers

Lets Bots run commands as root on their own computer. The switch is under
**Bot Computers** on the Grok Bot page and is on by default. Existing computers
pick up a change after they restart.

Available on the Enterprise plan.

#### Manage Member Computers and Data

Lets admins recreate, terminate, or permanently delete the computers of many
members at once, or delete all of their Grok Bot data, with a result for each
member. Find it under **Security & Compliance** on the Grok Bot page.
**Recreate** moves members to the latest image and Team Setup Scripts while
keeping their Bots, files, and logins. **Terminate** ends the member's current
work and keeps the durable disk; the member's next session starts a fresh
computer on it. **Delete** removes the computer and its stored files, and the
member's next session starts an empty computer.
**Terminate Inactive Computers**, under **Bot Computers**, does the terminate
for you when a member's Bots go 30 days without a message. It is off by
default. None of these remove access: to do that, remove the member from the
team or turn off Grok Bot for their group, and revoke their sessions in your
identity provider. See [Manage Grok Bot computers](/grok-bot/computers).

Available on the Enterprise plan.

### Logging and audit

What gets recorded, and where it goes.

#### Action Recording

Records what a Bot did: every tool call and how it ended, the decision that
allowed or refused it (Auto-review, a hook, or the member), connector (MCP)
tool calls, shell commands, browser navigations, computer use sessions, file
transfers, messages the Bot sent, routine runs, guardrail interventions, skills
it read, and work it handed to subagents or cloud agents. Events are metadata,
sanitized before they are stored or exported. Shell commands are
secret-scrubbed; browser navigations keep each page as `scheme://host/path`
with the title but strip query strings and credentials; computer use sessions
record action and screenshot counts and the session duration, without the
screenshots, clicks, or typed text; every other event carries ids, outcomes,
and durations, never tool arguments, file paths, or message content. The
switch is on the Grok Bot page and is off by default. Recorded events do not
appear on the Audit Log page. To receive them in your own collector, configure
[OpenTelemetry Export](https://cursor.com/docs/enterprise/opentelemetry-export),
which delivers each event tagged `cursor.surface=grok_bot`; the
[Wire Reference](https://cursor.com/docs/enterprise/opentelemetry-export/wire#shared-grok_bot-attributes)
lists every event and attribute. Retention details are on
[logging and audit](/grok-bot/security#logging-and-audit).

Available on the Enterprise plan.

#### Audit logs

Admin, security, and authentication events, plus Grok Bot control-plane
events: Bot creation, member access changes, Team Setup manifests, MCP
authentication, Slack account links, and routines. Each row names the
application that acted, so you can filter the log to Grok Bot. View them on the
[Audit Log page](https://cursor.com/dashboard/audit-log) or stream them to
your SIEM; see
[audit logs](https://cursor.com/docs/enterprise/compliance-and-monitoring#audit-logs).
For the actions Bots took, use [Action Recording](#action-recording).

Available on the Enterprise plan.

#### OpenTelemetry Export

Streams Cursor usage metrics and logs, including recorded Grok Bot actions, to
a collector you run. It is the customer path for Action Recording events.
Configure it under **Team Settings → OpenTelemetry Export**. Endpoint
requirements and the event schema are on
[OpenTelemetry Export](https://cursor.com/docs/enterprise/opentelemetry-export).

Available on the Enterprise plan.

### Group settings

The controls above set the team-wide baseline. To widen that baseline for one
cohort, open a group your team owns from
[Members > Groups](https://cursor.com/dashboard/members?subtab=groups) and use
its **Grok Bot** tab. Except for network policy, group settings only widen: a
group can grant its members more than the team allows, never less, and a
member in several groups gets the most permissive result. This is the same
rule as
[group model access](https://cursor.com/docs/enterprise/model-and-integration-management#how-team-and-group-model-access-combine).
A group control left at the team's value changes nothing, so tighten controls
on the Grok Bot page and widen them per group.

The tab has four sections:

* **Bot Capabilities.** Allow [Cloud Agents](#cloud-agents),
  [Agent Email](#agent-email), or
  [Allow Local Egress Routing](#allow-local-egress-routing), or raise the
  [Execution on Local Computer](#execution-on-local-computer) ceiling, for
  group members when the team has them off or stricter. For Auto-review,
  **Don't enforce for this group** lifts the team's
  [Enforce Auto-review](#enforce-auto-review) lock so group members can turn
  Auto-review off, and group Auto-review rules combine with the team's
  [Auto-review rules](#auto-review-rules), with **Ask first** winning when
  rules conflict.
* **Network.** The group's own network policy, as described under
  [Network Controls](#network-controls). It replaces the team policy for group
  members, whether looser or tighter, and a member of several groups gets the
  most restrictive one. A locked team policy applies to everyone.
  **Apply to MCP servers** is set on the team's Grok Bot page only; a group
  inherits it and cannot turn it off.
* **Group Rules.** Rules for the group's Bots, combined with
  [Team Rules](#team-rules). Members cannot turn them off.
* **Setup Scripts.** Manifests that run on group members' computers alongside
  [Team Setup Scripts](#team-setup-scripts). They use the same structure and
  run the same way, the same no-secrets rule applies, and they read the same
  [Team Secrets](#team-secrets) as the team's manifests; there are no
  group-level secrets. See
  [how Team Setup runs your scripts](/grok-bot/private-networks#how-team-setup-runs-your-scripts).

Group settings apply to groups your team owns, whether you manage membership by
hand or sync it through
[SCIM](https://cursor.com/docs/account/teams/scim#directory-groups). They are
separate from
[Organization Groups](https://cursor.com/docs/enterprise/organization-groups).
To control who can use Grok Bot at all, use **Manage Group Access** on the Grok
Bot page instead; see
[Enabling Grok Bot for your team](#enabling-grok-bot-for-your-team).

Available on the Enterprise plan.

## Admin API

Enable Grok Bot and manage capabilities, Enforce Auto-Review, group access,
network policy, team rules, and setup scripts through the
[Admin API](https://cursor.com/docs/account/teams/admin-api#grok-bot).
[Team Secrets](#team-secrets) are managed from the dashboard only.

To recreate, terminate, or delete members' computers, or delete all of their
Grok Bot data, from a script, use the
[Organization API](https://cursor.com/docs/account/organizations/organization-admin-api#grok-bot-computers).
It takes an Organization API key with the `admin:*` scope, because one computer
serves every team a member belongs to.

## Security

The security model, network policy, approvals and Auto Review, identity,
logging, data handling, and certifications live on
[Grok Bot security](/grok-bot/security). Common review questions are on
[Grok Bot security FAQ](/grok-bot/security-faq). To have your own AI security
server check each model request, see
[Grok Bot inference hooks](/grok-bot/inference-hooks).

## Recommended configuration

For security-sensitive deployments, this is the recommended baseline.

For administrators:

1. Configure Network Controls. Enterprise only. Teams without a policy default
   to allow-all. Self-serve Teams cannot set this. If you pick an allowlist
   mode and want it to cover connected apps too, add the hosts your connectors
   use (for example `api.github.com`, `api.x.com`, `api.origin.cursor.com`) to
   the list, then turn on **Apply to MCP servers**; it is off until you do. See
   [Grok Bot security](/grok-bot/security#network-policy).
2. Audit connector policy in Teams Marketplace before enabling Grok Bot. Any
   permitted connector is available to every Bot a member runs.
3. Turn on Enforce Auto-review before you rely on team rules. Enterprise only.
   Members can add stricter personal rules on top, and **Ask first** wins when
   rules conflict.
4. Set Execution on Local Computer to **Never allow** unless Bots need to act
   on member machines. The default leaves the choice to each member.
5. Disable Cloud Agent spawning if you do not need delegation.
6. Keep public template sharing off unless members should publish Bot
   templates outside the team.
7. Add team Auto-review rules. Enterprise only. Cover actions that should
   always ask first or can proceed automatically. Production deployments,
   external email, payments, and accepting legal terms are good **Ask first**
   examples. Keep automatic rules narrow.
8. Gate sign-in to managed devices through your identity provider. Grok Bot
   sign-in uses your SSO, so a device-aware sign-in policy applies to it. This
   gates sign-in, not the hosted computer itself.

For members:

1. Never paste credentials into chat. The masked secret request is the
   supported path.
2. Prefer **Allow once** over **Always allow** for actions that touch accounts,
   money, or shared resources.
3. Sign the Bot's browser into accounts sized to the task, and sign it out of
   accounts it no longer needs. Use scoped service accounts where the source
   system supports them.
4. Start new roles with read-only tasks and draft outputs, and keep sending,
   publishing, purchasing, deletion, and production changes behind approval.
5. Review connected apps and active routines regularly, and pause a routine
   when its source system changes.

## FAQ

### Can I turn Grok Bot on or off for my team?

The organization-wide **Enable Grok Bot** switch is Enterprise only. It lives
on the Grok Bot page of the Cursor dashboard. Self-serve Teams do not get this
switch. Disabling blocks members without deleting their computers.

### Can I manage Grok Bot through the Admin API?

Yes. Use the
[Admin API](https://cursor.com/docs/account/teams/admin-api#grok-bot).

### Can I set a Grok Bot spend cap?

A separate Grok Bot spend cap is not available today. Account-level on-demand
controls apply, and the per-product split is on the dashboard usage page.

### Why does a member see an app as Disabled by team admin?

Your team's connector policy blocks that server. Enable it in **Teams
Marketplace**, add its server URL to your MCP allowlist if you use one, and
have the member restart the app. If a permitted app still fails for regular
members with a vendor-side permission error, check the provider's
requirements; some vendors restrict their MCP endpoints to their own
administrators. See
[Connect apps](/grok-bot/computer-and-apps#connect-an-app).

### How do members request access?

Members can send a request from the app. On a pooled Enterprise team whose
admin has not finished setup, members see a team-setup message instead. The
next step is for an admin to use the Enterprise only enable switch. Self-serve
Teams do not use that switch.

### Can I see what kind of work my team does with Grok Bot?

Yes, on all Enterprise teams. The Conversation Insights page of the Analytics
dashboard has a **Grok Bot** source that groups Bot conversations by Type of
Work and Level of Automation. See
[Grok Bot Conversation Insights](https://cursor.com/docs/account/teams/analytics#grok-bot-conversation-insights).

Isolation, egress, approvals, logging, and data-handling questions are on
[Grok Bot security FAQ](/grok-bot/security-faq).

## Related pages

* [Deploy Grok Bot to your organization](/grok-bot/deployment)
* [Grok Bot security](/grok-bot/security)
* [Grok Bot security FAQ](/grok-bot/security-faq)
* [Grok Bot inference hooks](/grok-bot/inference-hooks)
* [Configure identity and access](/grok-bot/identity-and-access)
* [Connect to private networks](/grok-bot/private-networks)
* [Configure TLS-inspecting proxies](/grok-bot/proxies)
* [Manage Grok Bot computers](/grok-bot/computers)
* [Create and manage Bots](/grok-bot/bots)
* [Admin API](https://cursor.com/docs/account/teams/admin-api#grok-bot)
* [Grok Bot Conversation Insights](https://cursor.com/docs/account/teams/analytics#grok-bot-conversation-insights)
* [Plans and billing](https://cursor.com/help/grok-bot/plans)
* [Privacy and Data Governance](https://cursor.com/docs/enterprise/privacy-and-data-governance)

Contact your Cursor account team about Enterprise plan enablement, egress
ranges, residency commitments, and security review support.
