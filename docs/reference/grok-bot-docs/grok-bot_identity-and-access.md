#### Manage and protect

# Configure identity and access

This guide is for admins running Okta or Microsoft Entra ID as their identity
provider (IdP). It covers giving people outside your engineering organization
access to Grok Bot through your Cursor team, and letting members sign in to
IdP-provisioned apps from the Bot's computer. For the broader security model,
see [Grok Bot security](/grok-bot/security).

Grok Bot uses your Cursor account, so there is no separate Grok Bot app in Okta
or Entra ID. Everything in this guide happens on the Cursor app you already
have. Cursor single sign-on is SAML 2.0 and works with Okta, Microsoft Entra,
Google Workspace, and OneLogin; this guide details the two where device-trust
policies most often need attention.

## What you will change

You will make two changes, and they do different jobs:

* [Assign the Cursor app](#assign-the-cursor-app) so users outside your
  engineering organization can access Grok Bot through your Cursor team.
* [Add an authentication rule](#allow-sign-in-to-idp-apps-from-the-computer) so
  users can sign in to IdP-provisioned apps from the Bot's computer, which runs
  Linux and does not run device-trust agents.

Only the first change controls Grok Bot sign-in. The second never blocks it, and
it does not apply to connected-app sign-in, because connecting an app does not
go through the computer.

## Before you start

Grok Bot access requires the user to be a member of your Cursor team. Members
sign in with their Cursor account, so your existing
[Cursor SSO](https://cursor.com/docs/account/teams/sso) applies. With
auto-provisioning on, a user joins the team at first sign-in; otherwise,
provision the user, then have them sign in to Cursor for a seat or invite them
from the [Cursor dashboard](https://cursor.com/dashboard).

**SCIM is Enterprise only.** If you use
[SCIM](https://cursor.com/docs/account/teams/scim), provisioning is SCIM 2.0,
and deprovisioning is automatic: removing the user in your identity provider
removes them from Cursor.

## Assign the Cursor app

A user can sign in only if they have a Cursor account, and they get one through
assignment to your existing Cursor SSO app, plus the SCIM app if you use SCIM.
If Cursor is assigned only to engineering, everyone else fails with
**User is not assigned to this application**, or their invite never completes.
Do not create a second Grok Bot application; widen assignment on the Cursor app
you already have.

### Assign the app in Okta

1. Go to **Admin Console → Applications → Applications** and open your existing
   Cursor app.
2. Open **Assignments** and select **Assign → Assign to Groups**. To assign
   individuals instead, select **Assign to People**.
3. Add every group that should get Grok Bot, not only engineering.
4. If you use SCIM, assign the same groups to the Cursor SCIM app and push them.
   Users appear in Cursor only after they are assigned to the SCIM app.
5. Confirm each group is also assigned to the SAML app. SCIM assignment without
   SSO assignment still blocks first sign-in.

If you use org-level identity in Cursor, map the directory group to the Grok Bot
team after it syncs; see
[Organizations](https://cursor.com/docs/enterprise/organizations). Use separate
groups for app assignment and Group Push.

### Assign the app in Microsoft Entra ID

1. Go to **Microsoft Entra admin center → Enterprise applications** and open
   your existing Cursor enterprise app.
2. Open **Users and groups** and select **Add user/group**.
3. Add every group that should get Grok Bot, not only engineering.
4. If you use SCIM, assign the same groups to the Cursor provisioning app. Turn
   provisioning on and scope it to assigned users and groups.
5. Confirm the assignment grants SSO rather than report-only access.

Group-based assignment requires Entra ID P1 or P2, and nested groups are not
included. Users must be explicitly assigned, unassigning blocks SSO sign-in, and
with SCIM it also removes them from Cursor.

For either provider, the assignment works when:

* A user outside the original engineering assignment can open Grok Bot and
  complete Cursor SSO without **User is not assigned to this application**.
* With auto-provisioning on, that user appears on the Cursor team after first
  sign-in, without a manual invite.
* With auto-provisioning off, that user is on the team after they sign in to
  Cursor for a seat, or after you invite them from the dashboard.

## Allow sign-in to IdP apps from the computer

Inside the hosted computer, members sign in to applications through your own
identity provider in the browser, so your session policies govern those
sessions. The computer runs Linux and is not enrolled in mobile device
management (MDM), and device-trust agents like Okta FastPass do not run on it.
Any rule that requires FastPass, a registered or managed device, a compliant
device, or a phishing-resistant factor only FastPass can satisfy fails in the
computer browser.

Do not turn FastPass or device compliance off for the whole company. Add a
higher-priority rule scoped to this unmanaged Linux session. This change covers
only the IdP-provisioned apps the Bot opens in the computer browser; it is not
required for Grok Bot sign-in or for connected-app sign-in.

These sign-in methods work in the computer browser:

* Password plus a second factor that works in a remote browser, such as Okta
  Verify push or an authenticator app.
* Passkeys stored in a password manager on the computer, installed with
  [Team Setup Scripts](/grok-bot/teams-and-enterprises#team-setup-scripts). Team
  Setup Scripts is Enterprise only.

> Requiring managed devices for Grok Bot sign-in itself still works. Grok Bot
> uses your Cursor SSO, so a device-aware sign-in policy in your identity
> provider applies to it. That policy gates sign-in on the member's device, not
> the hosted computer.

### Add the rule in Okta

In Okta Identity Engine, the computer matches the **Other Desktop** device
platform; there is no Linux checkbox. Repeat these steps for each
IdP-provisioned app the Bot opens in the computer browser.

1. Go to **Admin Console → Security → Authentication Policies** and open the
   policy attached to the app. To find the policy, open **Applications**, then
   the app, then **Sign On**.
2. Add a rule above the FastPass, managed-device, and deny catch-all rules. Name
   it so you can find it later, for example **Grok Bot computer (Linux)**.
3. In the IF conditions, scope the rule to a group. The Cursor-assigned group
   works if you do not want the rule company-wide.
4. Set **Device platform** to **Other Desktop** and **Device state** to **Any**.
   Do not require **Registered**, **Managed**, or a device assurance policy that
   depends on FastPass.
5. In the THEN conditions, set access to
   **Allowed after successful authentication** with
   **Password + Another factor**. Do not require phishing-resistant or
   hardware-protection factors.
6. Save the rule and confirm it sits above the unmanaged-device deny catch-all.

If several apps share one FastPass-on-managed-devices policy, add the Linux rule
to the shared policy and scope it by group, or give those apps their own policy.
On Classic Engine, allow **Other Desktop** without requiring
**Device Trust = Trusted**.

### Add the policy in Microsoft Entra ID

Entra ID has no FastPass. The grants that block the computer browser are a
compliant device, a hybrid joined device, a phishing-resistant authentication
strength that only a platform or managed passkey can meet, and an approved
client app or app protection policy.

1. Go to
   **Microsoft Entra admin center → Protection → Conditional Access → Policies**.
2. Find every policy that applies those grants to the IdP apps the Bot needs.
3. Leave those policies on. Add a higher-priority policy for Grok Bot users on
   Linux, or exclude them from the blocking policies.
4. In the new policy, set the users to the Cursor-assigned group and target the
   IdP apps they must open on the computer. Select **All resources** only if you
   accept that scope.
5. Under **Device platforms**, include **Linux** and exclude **Windows** and
   **macOS**.
6. Set the grant to **Require multifactor authentication** only.
7. Start the policy in report-only mode, then turn it on.
8. On existing compliant-device policies, exclude the group or exclude Linux.

For phishing resistance without a managed device, use an authentication
strength a synced passkey can satisfy, and test sign-in from the computer before
enforcing it.

For either provider, the change works when a user can sign in to
IdP-provisioned apps from the Bot's computer without a FastPass or
device-compliance error, connected-app sign-in works as before, and laptop sign-ins are
unchanged.

Revocation stays with you either way: revoking the user in your identity
provider ends their in-computer application sessions, and an organization admin
can [terminate the member's computer](/grok-bot/security#identity-and-sign-ins)
at any time.

## Limitations

* Okta FastPass does not run on Linux, so the Bot's computer cannot satisfy
  FastPass or managed-device rules.
* The computer is not enrolled in MDM by default.
* Group-based assignment in Entra ID requires P1 or P2 and does not include
  nested groups.

## FAQ

### Do I need a separate Grok Bot app in Okta or Entra ID?

No. Grok Bot sign-in uses the Cursor account, so your existing Cursor app
controls access. Widen assignment on that app instead of creating a new one.

### Does the device-trust change affect connected-app sign-in?

No. Connecting an app does not go through the computer, so authentication
rules for the computer browser do not apply to it.

### Will these changes weaken sign-in on employee laptops?

No. Scope the new rule or policy to the Linux platform and the Cursor-assigned
group, and laptop sign-ins keep your existing requirements.

### If I unassign a user from the Cursor app, do they lose access?

Yes, they can no longer sign in through SSO. With SCIM, unassigning also removes
them from Cursor automatically; without SCIM, remove them from the team in the
dashboard.

## Related pages

* [Grok Bot security](/grok-bot/security)
* [Grok Bot for teams and enterprises](/grok-bot/teams-and-enterprises)
* [SSO](https://cursor.com/docs/account/teams/sso)
* [SCIM](https://cursor.com/docs/account/teams/scim)
* [Organizations](https://cursor.com/docs/enterprise/organizations)
