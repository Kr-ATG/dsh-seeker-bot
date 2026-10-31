#### Manage and protect

# Connect to private networks

Grok Bot computers run in Cursor's cloud and reach the internet through
[shared static egress IP addresses](/grok-bot/security#static-egress-ips).
If the systems your Bots need live on a private network, route traffic through a
member's desktop or install your organization's networking client on every team
computer through **Team Setup Scripts**.

> **Team Setup Scripts is Enterprise only.** It does not appear on other plans.
> **Network Controls is also Enterprise only.** That
> [network policy](/grok-bot/security#network-policy) is a separate layer that
> still applies; private network reach does not replace your destination
> allowlist.

## What you can do

* Route one member's traffic through their desktop, so destinations see that
  device's IP address. Sites that resolve to a private or VPN address stay
  blocked unless they have been allowed for your organization.
* Install your networking client on every team computer automatically, from one
  admin-managed manifest, with no per-computer setup.
* Let Bots reach services on your private network without exposing those
  services to the internet or adding shared egress IPs to your allowlists.
* Keep control on your side: your network, your access rules, and your identity
  provider. You can revoke a computer from your own admin console at any time.

## Choose a connection method

| Method | Use it when |
| --- | --- |
| Route traffic through a desktop | One member needs public sites to see their device's IP address, such as a site that allowlists office IPs |
| Install a networking client with Team Setup | Your Enterprise team needs a consistent connection on every hosted computer |

### Route through a member's desktop

In the Grok Bot desktop app, open **Settings → Computer** and, under **Your computer**,
turn on **Route traffic through this computer**. The route uses the current device's
network and IP address. It stops when the setting is turned off or an Enterprise
admin disables **Allow Local Egress Routing**.

The route does not open your private network to the Bot. Sites that resolve to
a private or VPN address are blocked unless they have been allowed for your
organization, and the setting shows how many sites were blocked this session.
To reach private services,
[install a networking client with Team Setup](#install-a-networking-client-with-team-setup).

Each member controls their own desktop route. Enterprise admins can remove this
option for the whole team from
[Grok Bot in the Cursor dashboard](https://cursor.com/dashboard/bot). See
[Route traffic through your desktop](/grok-bot/settings-and-notifications#route-traffic-through-your-desktop).

### Install a networking client with Team Setup

This is a pattern you run, not a Cursor-managed network mode. Cursor provides
the hook: Team Setup Scripts runs your install scripts on every team computer. You own
the rest: installing the client, configuring it, authenticating computers,
maintaining access rules, and keeping up with your vendor's changes. Cursor
installs nothing by default, does not operate or monitor your network client, and
the dashboard shows no client status. Your vendor's documentation is the source
of truth for installing and configuring their software; this page covers the
Cursor side.

## Before you start

* You are a team admin on the Enterprise plan. **Team Setup Scripts is
  Enterprise only** and does not appear on other plans.
* Your networking client runs on Debian-based Linux and can be installed and
  started from a shell script. Team computers run Linux, and scripts run as the
  computer user with `sudo` available.
* Your network has a way in for that client: a gateway, exit node, or tunnel
  connector inside the VPC or intranet you want to reach, per your vendor's
  architecture.
* You have decided how computers will authenticate to your network. Keep
  credentials out of setup scripts; if a script needs one, store it as a
  [Team Secret](/grok-bot/teams-and-enterprises#team-secrets).

## How Team Setup runs your scripts

**Team Setup Scripts** lives under **Bot Computers** on the **Grok Bot** page of
the [Cursor dashboard](https://cursor.com/dashboard/bot): manifests of install
scripts that run on every team computer. Each manifest holds one or more script
entries, and each entry has an **ID**, a **Setup Script**, and an optional
**Check Script**. To run a manifest on one cohort's computers only, add it under
the group's Grok Bot tab instead; see
[Group settings](/grok-bot/teams-and-enterprises#group-settings). Group
manifests follow the same rules as the ones below.

* Scripts run as the computer user on every team computer; use `sudo` for
  privileged installs.
* They run when a computer starts, and on a periodic refresh, roughly daily,
  while it runs.
* If a Check Script is present and exits 0, the Setup Script is skipped; use it
  to avoid reinstalling on every pass. After a setup runs, the check runs again
  to verify it succeeded.
* Entries run one at a time, in order. Each script has a 30-minute timeout. A
  failed script does not block the computer; it is retried on a later refresh.
* Scripts read your team's
  [Team Secrets](/grok-bot/teams-and-enterprises#team-secrets) as environment
  variables, so a credential a script needs never appears in the manifest.
  Secrets are present only while the script runs, and script output is redacted
  before it is logged. A computer whose setup comes from more than one team
  receives no secrets.

## Create the manifest

1. Go to [Grok Bot in the Cursor dashboard](https://cursor.com/dashboard/bot)
   and find **Team Setup Scripts** under **Bot Computers**.
2. Next to **Manifests**, select **+** to create a **New Manifest**, then enter
   a **Manifest ID**, for example `private-network`.
3. In the script entry, set the **ID** (for example `install-network-client`)
   and write the **Setup Script**: install your client following your
   provider's Linux install documentation, then start it and connect it to your
   network the way your configuration prescribes.
4. Optionally add a **Check Script** (for example `command -v <your-client>`),
   so computers that already have the client skip the install.
5. Select **Save**.

If you prefer editing JSON, toggle from **Form** to **JSON** at the top of the
editor. The manifest has this structure:

```json
{
  "manifestId": "private-network",
  "entries": [
    {
      "id": "install-network-client",
      "setup": "#!/usr/bin/env bash\nset -euo pipefail\n# 1) Install your networking client per your provider's Linux install docs\n# 2) Start the client and connect it to your network per your configuration",
      "check": "command -v <your-client>"
    }
  ]
}
```

> Do not paste secret values into scripts. Setup scripts run as the computer
> user on every team computer, and manifests are plain text applied to your
> whole fleet. If a script needs an auth key, token, or other credential, store
> it as a [Team Secret](/grok-bot/teams-and-enterprises#team-secrets) and read
> it from the environment, for example `"$MY_AUTH_KEY"`. Where your vendor
> supports it, prefer having members authenticate interactively in the
> computer's browser, where your identity provider's policies apply.

## Set up your networking client

Whatever tool you use, the last mile is the same: each computer authenticates to
your network, you confirm the connection in your vendor's console, and you
verify by asking a Bot to reach an internal hostname it could not reach before.
Interactive login happens in the computer's browser, the same way members
already [sign in to company tools there](/grok-bot/identity-and-access). Start
with one or two pilot computers before rolling out team-wide.

### Tailscale

Run Tailscale on each computer and route through an
[exit node](https://tailscale.com/docs/features/exit-nodes) inside your network.
This is the configuration the pattern has been exercised with. Tailscale also
offers [subnet routers](https://tailscale.com/docs/features/subnet-routers) for
exposing specific private ranges; validate that arrangement on a pilot computer
before relying on it.

**Before you start:** you operate a tailnet with an exit node inside the VPC or
intranet you want to reach.

**Team Setup manifest:**

* **Setup Script:** install Tailscale for Linux following
  [Tailscale's install documentation](https://tailscale.com/docs/install/linux),
  then bring the computer onto your tailnet per your configuration.
* **Check Script:** `command -v tailscale`.

**Connect and verify:**

1. Authenticate each computer. Tailscale prints a login URL that opens in the
   computer's browser, where your identity provider's policies apply. If you
   would rather join computers without a member signing in, store a reusable,
   tagged [auth key](https://tailscale.com/docs/concepts/auth-keys) as a
   [Team Secret](/grok-bot/teams-and-enterprises#team-secrets) and pass it from
   the environment, for example `tailscale up --auth-key "$TS_AUTHKEY"`. Every
   team computer then joins under the same key and tags rather than under the
   member's identity, so scope the key's ACLs accordingly. Never paste the key
   into the script itself.
2. Confirm the computer appears in your Tailscale admin console and is allowed
   to use the exit node.
3. Ask a Bot to reach an internal hostname.

**If it does not work:**

* The client installed but nobody authenticated. With browser login, the step
  is manual; with an auth key, check that the Team Secret exists, that its name
  matches what the script reads, and that the key has not expired. Check the
  machine list in your Tailscale admin console.
* Your team's network policy is allowlist-only and blocks Tailscale's
  coordination servers or relays. Allow the endpoints from Tailscale's docs.
  Running computers apply the change within about a minute. Sleeping computers
  apply it when they next wake.
* The exit node is not advertised or approved in your tailnet. Check route
  settings in the admin console.
* The computer was recreated, for example after an image update or reset, and
  the session did not survive. Authenticate again.

### Cloudflare Tunnel

The same Team Setup mechanics work for
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/):
a `cloudflared` connector inside your network publishes private services through
Cloudflare's edge, protected by Cloudflare Access, and the computer reaches them
by hostname. This arrangement has not been exercised on team computers the way
the Tailscale one has, so validate it on a pilot computer before rolling out.

**Before you start:** you run a Cloudflare Tunnel connector inside your private
network, with the services you need routed through it, and you have chosen your
Cloudflare Access policy. Identity-based policies fit this pattern well, since
members sign in through the browser. Access service tokens are secrets; if you
use them, store them as
[Team Secrets](/grok-bot/teams-and-enterprises#team-secrets) rather than in
setup scripts.

**Team Setup manifest:**

* **Setup Script:** install `cloudflared` following
  [Cloudflare's downloads documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/).
  Only the client goes on the computer; the connector stays in your network.
* **Check Script:** `command -v cloudflared`.

**Connect and verify:**

1. Private HTTP services: reach them at the hostname you routed through the
   tunnel. Cloudflare Access enforces your policy; with identity-based policies,
   the member signs in through the computer's browser.
2. Private TCP services, such as databases or SSH: run `cloudflared access tcp`
   on the computer to open a local listener and point the tool at it.
   Cloudflare's docs cover the flow. A Bot can start the listener in its shell
   when it needs the service.
3. Ask a Bot to reach the private hostname or service.

**If it does not work:**

* The connector inside your network is down. Check tunnel health in your
  Cloudflare dashboard; this fails on your side, not the computer's.
* Cloudflare Access denies the request. Check your Access logs and confirm the
  member has authenticated.
* Your team's network policy is allowlist-only and blocks the tunnel hostname or
  Cloudflare's endpoints. Allow them. Running computers apply the change within
  about a minute. Sleeping computers apply it when they next wake.
* A service token was embedded in the setup script. Do not do this; manifests are
  plain text. Use identity-based Access, or store the token as a Team Secret and
  have the script read it from the environment.
* A `cloudflared access tcp` listener is not running when the Bot needs it.
  Listeners do not persist across sessions; start one when needed.

To choose between them: Tailscale gives the computer network-level reach and,
with an exit node, egress from your network. Cloudflare Tunnel publishes
specific services through Cloudflare's edge behind Access: per-service rather
than whole-network, and the egress addresses that other services see do not
change.

Other clients that install and run on Debian-based Linux follow the same Team
Setup steps; validate yours on a pilot computer before rolling out.

## Roll out to existing computers

* New computers apply manifests when they start.
* Running computers pick up manifest changes on a periodic refresh, roughly
  daily.
* To apply a manifest change immediately, recreate the computer or have the
  member reset it from the desktop app. On Enterprise, admins can recreate or
  terminate a member's computer from the dashboard. The durable disk is kept,
  and the next computer applies current manifests when it starts.
* Image updates recreate computers automatically, and your scripts re-apply.
  Sign-in sessions, including your network client's login, may need to be
  re-established after a computer is recreated.

## Work with the network policy

The Grok Bot [network policy](/grok-bot/security#network-policy) is a separate
layer that controls which destinations team computers may reach.
If your team uses **Team allowlist only**, add the destinations your networking
client needs, such as coordination servers, relays, and gateways, from your
vendor's documentation. Running computers apply policy changes within about a
minute. Sleeping computers apply them when they next wake. You do not need to
recreate the computer.

## Limitations

* This is a pattern you operate, not a Cursor-managed network mode. Cursor
  does not install, operate, or monitor your networking client, and support for
  the client itself comes from your vendor.
* Regular internet traffic still egresses through Cursor's shared static IP
  ranges unless you route it through your own network. Dedicated per-customer
  egress IPs are not available.
* There is no fleet view of script results today. Verify a pilot computer before
  rolling out team-wide.
* This is not the Cloud Agents setup. The Cloud Agents docs have their own
  [Tailscale](https://cursor.com/docs/cloud-agent/setup#running-tailscale) and
  [Cloudflare Tunnel](https://cursor.com/docs/cloud-agent/setup#running-cloudflare-tunnel)
  recipes for a different product surface; Grok Bot computers are configured
  through Team Setup as described here. If Grok Bot delegates work to Cloud
  Agents, those agents run under Cloud Agent network settings, not your
  computer's network client.

## FAQ

### Can I put an auth key or credential in the setup script?

Not in the script text. Manifests are plain text, and the dashboard warns
against pasting secrets into them. Store the credential as a
[Team Secret](/grok-bot/teams-and-enterprises#team-secrets) on the Grok Bot page
and have the script read it as an environment variable. Team Secrets are
Enterprise only. Where your vendor supports it, interactive browser login is
still the simplest option, since your identity provider's policies apply to it.

### Which networking tools can I use?

Any client your team can install and run on Debian-based Linux from a shell
script. Tailscale and Cloudflare Tunnel are the worked examples on this page.
Validate your client on a pilot computer first.

### Do existing computers get a new manifest?

Yes. Running computers refresh manifests periodically, roughly daily. To apply
a manifest change immediately, recreate the computer or have the member reset
it from the desktop app.

### Does this change the IP addresses my services see?

For traffic routed through your network, yes. Traffic to your private network
arrives from inside your network, via your exit node, gateway, or tunnel
connector. Everything else continues to egress from Cursor's shared static
ranges.

### We use a strict network allowlist. Will our client work?

Only if you allow its endpoints. Add the destinations your client requires to
your team allowlist. Running computers apply the change within about a minute.
Sleeping computers apply it when they next wake.

### Is this the same as the Tailscale and Cloudflare Tunnel sections in the Cloud Agents docs?

No. Those recipes are specific to Cloud Agent VMs; Tailscale there requires
userspace networking and proxy variables. Grok Bot computers use Team Setup and
your own gateway or connector, as described on this page.

### Which plans include Team Setup Scripts?

**Team Setup Scripts is Enterprise only.** Team admins manage manifests. If you do not
see it on the Grok Bot page of the dashboard, you are not on Enterprise, or you
need your account team to enable Grok Bot for the organization.

### What happens if the setup script fails on some computers?

The computer still starts. Failed entries are retried on a later refresh. Keep
scripts re-runnable and use a Check Script so healthy computers skip the
install.

## Related pages

* [Grok Bot for teams and enterprises](/grok-bot/teams-and-enterprises)
* [Grok Bot security](/grok-bot/security)
* [Configure identity and access](/grok-bot/identity-and-access)
* [Configure TLS-inspecting proxies](/grok-bot/proxies), for the path from
  member devices to Cursor
* [Cloud Agents: Running Tailscale](https://cursor.com/docs/cloud-agent/setup#running-tailscale)
  and [Running Cloudflare Tunnel](https://cursor.com/docs/cloud-agent/setup#running-cloudflare-tunnel)
