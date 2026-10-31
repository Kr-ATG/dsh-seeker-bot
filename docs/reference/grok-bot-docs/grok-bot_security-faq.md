#### Manage and protect

# Grok Bot security FAQ

These are the questions security reviews ask most often. The controls behind
each answer are on [Grok Bot security](/grok-bot/security). Dashboard settings
and rollout steps are on
[Grok Bot for teams and enterprises](/grok-bot/teams-and-enterprises).

## Isolation and access

### How are users isolated from each other?

Each user gets a dedicated Firecracker microVM with its own kernel, memory, and
virtual devices. One user cannot reach another user's computer. Within one
user, every Bot shares that computer. Treat a login or file on the computer as
available to every Bot that user runs. When a workload needs its own computer
and credential set, give it its own Cursor user. A teammate's
[shared Bot](/grok-bot/shared-bots) usually works on a user's computer during
that user's own chat with it.

### What can a Bot access?

Only accounts and connected apps the member or team grants. A Bot has no
identity of its own and cannot hold more access than the signed-in member.
Connector tokens stay on Cursor's backend. Logins and cards saved in Vault, and
values entered in a Secure Form, are filled without the model seeing them.
Steps a form cannot handle, such as single sign-on or a passkey, are handed to
the member. See
[identity and sign-ins](/grok-bot/security#identity-and-sign-ins).

### If we block an app, can a Bot still reach that service in the browser?

Yes. Blocking an app does not block that service's website. The connector
policy and the [network policy](/grok-bot/security#network-policy) are separate
layers. Closing the website path takes **Network Controls**, which is
Enterprise only.

### Can admins push connectors to members?

No. The connector policy allows or blocks servers. Provisioning connectors to
members, whether mandatory or default-on, is not available.

## Network and egress

### Can we restrict which destinations computers can reach?

**Network Controls is Enterprise only.** Admins set a Grok Bot network policy
from that panel on the Grok Bot page of the dashboard. Self-serve Teams do not
see it and cannot set a destination allowlist. Teams without a policy default
to allow-all. See [network policy](/grok-bot/security#network-policy).

### Do admin controls apply per group, or only org-wide?

Directory-group scope is part of **Network Controls**, which is Enterprise
only. Groups can set their own policy, and a lock makes the team policy
effective for everyone. The organization-wide enable switch is also Enterprise
only and applies to the whole organization. Cloud Agents, Team Rules, and
public template sharing apply to the whole team on Teams and Enterprise.
Enforce Auto-review and Auto-review rules are Enterprise only and also apply
to the whole team. Allow Local Egress Routing is Enterprise only and applies to
the whole team. On Enterprise, a group's Grok Bot tab can widen Cloud Agents,
agent email, local execution, local egress, Auto-review, rules, and setup
scripts for that group's members, never tighten them. See
[Group settings](/grok-bot/teams-and-enterprises#group-settings).

### Why do some websites block Bots?

Some services flag datacenter IP addresses. The egress ranges are shared static
ranges, available from your account team; allowlist them on your own services
where appropriate.

### Are dedicated egress IPs available?

No. Computers use shared static egress IP addresses. Dedicated per-customer
IPs are not available. Current ranges are available from your account team.

### Can traffic run through our own network?

Yes. A member can route a Grok Bot computer's web traffic through their
desktop, using its network and IP address. On that route, sites that resolve to
a private or VPN address are blocked unless they have been allowed for your
organization. Enterprise teams can also install a networking client on every
hosted computer through **Team Setup Scripts**. See
[Connect to private networks](/grok-bot/private-networks).

### Grok Bot hangs at computer setup from our network. Why?

A TLS-inspecting gateway such as Zscaler is letting `api2.cursor.sh` through
and blocking or inspecting the computer's nested `cursorvm.com` hostname. Chat
may or may not keep working; the computer link fails either way. Allow
`*.cursorvm.com` and `*.*.cursorvm.com`, exempt them from inspection, and apply
the change to off-network profiles too. See
[Configure TLS-inspecting proxies](/grok-bot/proxies).

## Approvals, logging, and data

### What does Auto Review check?

With enforcement on, Auto Review evaluates shell commands, app calls,
computer use, automation writes, and delegation such as Cloud Agent and
subagent launches. It can let an action proceed, require approval, or deny it.
On Enterprise, team admins can enforce Auto-review from the Grok Bot page and
add team Auto-review rules that every member inherits. Members can add stricter
personal rules on top, and **Ask first** wins when rules conflict. If an admin
turns enforcement off, members go back to their own rules only. It does not
review every side effect, such as memory writes and most settings changes.

### Can our own security tooling check what Grok Bot sends to models?

Yes, with inference hooks, an Enterprise beta. Cursor sends each Grok Bot model
request, signed, to an AI security server your organization runs or uses
through a security vendor, and your server allows or denies it before the model
runs. Hooks check model inputs, not actions as they run. Team admins on any
Enterprise team can set them up from the dashboard. See
[Grok Bot inference hooks](/grok-bot/inference-hooks).

### Can I see what Bots did on behalf of my team?

Spend and usage are on the dashboard usage page, broken down by product.
**Audit logs are Enterprise only.** They cover admin, security, and
authentication events, plus Grok Bot control-plane events like Bot creation,
access changes, Team Setup, and routines, filterable by application, and can
stream to your SIEM. **Action Recording is Enterprise only** and is a separate
setting, off by default. When enabled, it records Bot actions internally.
**OpenTelemetry Export is Enterprise only.** Configure it to receive those
events in your own collector, tagged `cursor.surface=grok_bot`. They do not
appear on the Audit Log page.

### Can I restrict which models Grok Bot uses?

No. The team model allowlist does not govern Grok Bot. It uses SpaceXSI
first-party models and may use third-party models from providers on the
[sub-processor list](https://trust.cursor.com/subprocessors) regardless of that
setting. Teams with a model allowlist see this acknowledgement when they enable
Grok Bot. Grok Bot manages model selection, and there is no customer-facing
model picker. If your contract restricts subprocessors, contact your account
team. See
[Which AI models power Grok Bot?](https://cursor.com/help/grok-bot/models).

### Where do Grok Bot computers run?

In the United States. Grok Bot is also covered by Cursor's
[US-only data residency](https://cursor.com/docs/enterprise/privacy-and-data-governance#us-data-residency)
program, which keeps inference, data processing, and storage in the US for
enrolled customers. Contact your account team to enroll. See
[data residency](/grok-bot/security#data-residency).

### Can we run Grok Bot on-premises or from our own image?

No. Grok Bot runs only on Cursor-hosted cloud computers. On-premises
deployment, deployment inside your own perimeter, and bring-your-own-image
deployment are not supported today.

### Can we install our own security tooling on team computers?

**Team Setup Scripts** is Enterprise only. Those admins can install their own
tooling on every team computer. Grok Bot does not ship a built-in
customer-facing EDR feed.

### Why do members have to sign in to company tools again?

Sign-in sessions inside the computer can drop when the computer is recreated,
for example after an image update or when an admin recreates it. Sessions ride
your identity provider, so your session policies also apply.

### What happens to data when an admin terminates a computer?

Computer management is Enterprise only. Organization admins and Enterprise team
admins can terminate a member's computer. The durable disk is kept, and the
member's next session starts a fresh computer on that disk. Terminating a
computer is separate from the Enterprise-only enable switch.

### What certifications apply to Grok Bot?

Anysphere holds ISO/IEC 27001 and ISO/IEC 42001 certifications, issued by
Schellman, and Grok Bot is included in the current ISO scope. Certificates and
reports are available at [trust.cursor.com](https://trust.cursor.com).

## Related pages

* [Grok Bot security](/grok-bot/security)
* [Grok Bot for teams and enterprises](/grok-bot/teams-and-enterprises)
* [Grok Bot inference hooks](/grok-bot/inference-hooks)
* [Configure identity and access](/grok-bot/identity-and-access)
* [Connect to private networks](/grok-bot/private-networks)
* [Privacy and Data Governance](https://cursor.com/docs/enterprise/privacy-and-data-governance)
