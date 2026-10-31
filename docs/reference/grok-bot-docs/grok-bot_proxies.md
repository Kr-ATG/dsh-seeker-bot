#### Manage and protect

# Configure TLS-inspecting proxies

The Grok Bot desktop app connects from each member's device to two places:
Cursor's API at `*.cursor.sh` for chat, sign-in, and approvals, and the
member's hosted computer at a nested `*.*.cursorvm.com` hostname for computer
setup, screen, and shell. Secure web gateways that inspect TLS often let the
first through and break the second. The desktop app then hangs or errors during
computer setup; in some setups chat keeps working while the computer never
connects. Zscaler is the most common example, and this page uses it for
specifics; the same steps apply to any gateway that re-signs TLS or buffers
responses. This page is for the IT team that runs your gateway. The shared
domain list and streaming tests live on
[Enterprise network configuration](https://cursor.com/docs/enterprise/network-configuration);
this page covers what Grok Bot adds.

This page is about the path from a member's device to Cursor. It does not
change where the hosted computer itself may connect; that is the
[network policy](/grok-bot/security#network-policy). Reaching services on your
private network from the computer is covered in
[Connect to private networks](/grok-bot/private-networks).

## Symptoms

* **Computer setup hangs or fails.** The app never finishes connecting to the
  computer. Chat may keep working, since it can reach `api2.cursor.sh`, or
  stall along with it; either way, the computer link needs `cursorvm.com`.
* **It works on a hotspot or a personal device** and fails on the corporate
  network or with the gateway client running.
* **It works in the office and fails at home.** The exceptions were applied to
  the office location only. See
  [apply to every profile](#apply-to-every-profile-including-off-network).
* **Sign-in or chat stall too.** TLS inspection or response buffering is still
  active on `cursor.sh`.

## Allow these domain patterns

Allow all of these on the gateway and in any DNS filtering. Prefer the
wildcards over enumerating hostnames; computer hostnames are generated per
computer.

| Pattern | Used for |
| --- | --- |
| `*.cursor.sh` | Chat, sign-in, approvals, and the rest of the Cursor API |
| `*.cursor-cdn.com` | Static assets |
| `*.cursorapi.com` | Extension marketplace and related APIs |
| `*.cursorvm.com` | The hosted computer and its control plane |
| `*.*.cursorvm.com` | The same, one level deeper. Required. |
| `cursor.com`, `downloads.cursor.com` | Installing and updating the desktop app |

Add both `cursorvm.com` patterns. Computer hostnames have two labels below
`cursorvm.com`, in the form `<computer>.<cluster>.cursorvm.com`, and a
single-level wildcard matches only one. A gateway configured with
`*.cursorvm.com` alone looks correct and still leaves the computer unreachable.
This is the usual cause of computer setup failing on a network where
`cursor.sh` is already allowed.

## Exempt the same domains from TLS inspection and buffering

Allowing the traffic is not enough. On every domain above:

* **Bypass TLS (SSL) inspection.** When the gateway re-signs the connection
  with its own certificate, the computer setup handshake fails even though the
  hostname is allowed. Cursor's connections are already encrypted end to end.
* **Turn off response buffering.** Chat and the computer link stream. A gateway
  that holds responses until they complete leaves the app waiting on output
  that never arrives.

If your policy requires inspecting all traffic, the gateway must meet the
requirements under
[SSL inspection and DLP](https://cursor.com/docs/enterprise/network-configuration#ssl-inspection-and-dlp):
HTTP/2 or Cursor's HTTP/1.1 fallback, Server-Sent Events passthrough without
buffering, and long-lived connections without forced timeouts.

## Apply to every profile, including off-network

Zscaler Client Connector keeps running when a device leaves the office, and it
applies an off-network profile of its own. Exceptions added to the office
location or to a single policy do not follow the device home. Apply the allow
rules, the TLS inspection exemption, and any DNS exception to every location,
profile, and policy group that Grok Bot members fall under, including roaming
and off-network. Other gateways with separate on- and off-network policies need
the same treatment.

The tell: Grok Bot works from the office and fails from home on the same
laptop, with the gateway client still running.

## Verify from a member's device

Run these on a member's device with the gateway client running, after IT has
applied the changes.

### Check who issues the certificate

```bash
curl -v https://api2.cursor.sh |& grep -C1 issuer:
```

The issuer should be **Amazon RSA**. If it names Zscaler or your gateway
vendor, TLS inspection is still active on `cursor.sh` for this device's
profile.

### Check that computer hostnames resolve

```bash
nslookup test.us9.cursorvm.com
```

You should get addresses back. If the lookup fails, try
`nslookup test.us9.cursorvm.com 1.1.1.1`. If the public resolver answers and
your default one does not, the block is the device's DNS or gateway profile,
and the nested `*.*.cursorvm.com` exception is missing there.

### Test streaming

Run the HTTP/1.1 and HTTP/2 streaming tests under
[Testing proxy connectivity](https://cursor.com/docs/enterprise/network-configuration#testing-proxy-connectivity).
Output should arrive line by line, not all at once.

### Retry in the app

Open the Grok Bot desktop app on the same device and connect to the computer.
If it still fails, repeat the checks from that device; a passing hotspot and a
failing corporate network confirms the network is the cause.

## Scope

Three controls are easy to confuse:

| You want to | Use |
| --- | --- |
| Let member devices reach Cursor and their hosted computer through your gateway | This page |
| Limit which destinations the hosted computer may reach | [Network policy](/grok-bot/security#network-policy), Enterprise only |
| Route hosted computer traffic through a member device | [Route traffic through your desktop](/grok-bot/settings-and-notifications#route-traffic-through-your-desktop) |
| Install a networking client on every hosted computer | [Team Setup Scripts](/grok-bot/private-networks#install-a-networking-client-with-team-setup), Enterprise only |

By default, the hosted computer's own traffic leaves from Cursor's
[shared static egress IPs](/grok-bot/security#static-egress-ips) and does not
pass through the gateway on member devices. When a member enables **Route
traffic through this computer**, routed traffic uses that device's network and is
subject to its gateway policy.

## FAQ

### We allowlisted \*.cursorvm.com. Why does computer setup still fail?

Two usual reasons. The nested `*.*.cursorvm.com` pattern is missing, so the
computer's hostname does not match. Or the domain is allowed but still
TLS-inspected, so the gateway's certificate breaks the setup handshake. Add the
nested pattern, exempt both patterns from inspection, then run the
[checks](#verify-from-a-members-device).

### We allowed cursor.sh. Why does that not cover the computer?

They use different hostnames. Chat, sign-in, and approvals go to
`api2.cursor.sh`, which most gateways already allow. The computer link goes to
a nested `cursorvm.com` hostname that needs its own allow rule and inspection
exemption. That is also why chat can keep working on some networks while the
computer never connects.

### It works in the office but not from home. What is different?

The gateway client is still running at home, with an off-network profile that
did not get the exceptions. Apply them to the roaming and off-network profiles
too.

### Our policy requires TLS inspection on all traffic.

Then the gateway has to pass streaming through untouched. The requirements are
under
[SSL inspection and DLP](https://cursor.com/docs/enterprise/network-configuration#ssl-inspection-and-dlp).
Exempting Cursor's domains is the reliable path; Cursor's connections are
encrypted end to end already.

### Does this list also cover the Cursor editor?

Yes. It is the same list as
[Enterprise network configuration](https://cursor.com/docs/enterprise/network-configuration#ip-allowlisting).
The editor's chat and Tab features work without the `cursorvm.com` patterns,
which is why a gateway that is fine for the editor can still break Grok Bot.

## Related pages

* [Enterprise network configuration](https://cursor.com/docs/enterprise/network-configuration)
* [Grok Bot for teams and enterprises](/grok-bot/teams-and-enterprises)
* [Grok Bot security](/grok-bot/security)
* [Connect to private networks](/grok-bot/private-networks)
* [Network, proxy, and remote connections](https://cursor.com/help/troubleshooting/network)

Need help with your gateway configuration? Contact your Cursor account team for
deployment assistance and priority support.
