#### Help

# Frequently asked questions

## How is Grok Bot different from an AI assistant?

Bots can use a persistent cloud computer, connected tools, websites, and
files to complete work—not only answer questions. They can continue in the
background, keep role-specific context, and coordinate with other Bots.

## Is Grok Bot the same as the Grok app?

No. Grok (the chat app from SpaceXSI) and Grok Bot are two different apps. A
paywall or a **Weekly SuperGrok Limit** in the Grok app is not about Grok Bot.
Grok Bot signs in with your Cursor account. See
[Sign in](/grok-bot/get-started#2-sign-in).

## Where do I talk to Grok Bot?

Use the Grok Bot desktop app on macOS, Windows, or Linux, or the companion app
on iOS or Android. The same Bots and conversations sync across your signed-in
devices. You can also chat with your Bots in
[X Chat](/grok-bot/chat-and-collaboration#chat-in-x-chat),
[tag @bot on X](/grok-bot/tag-on-x) to hand a post to your Bot, and talk to a
[shared Bot in Slack](/grok-bot/shared-bots#how-do-i-add-a-shared-bot-to-slack).

## Does Grok Bot keep working when my laptop is closed?

Yes. Bot work runs on the cloud computer. Closing the app, laptop, or phone
does not stop a background turn or routine.

## Does the Bot use my own computer?

Bots work on their own cloud computer. A Bot runs a command on your desktop
only if you allow it. The setting is under
**Settings → Computer → Your computer**, labeled
**Execution on this computer**. If no desktop is listed there yet, the same
page shows **Execution on Local Computer**. By default it asks you each time.
See [Run commands on your desktop](/grok-bot/settings-and-notifications#run-commands-on-your-desktop).

## Do my Bots share one computer?

Yes. Every Bot on your account uses one persistent cloud computer. They share
its files, browser sessions, and logins so they can hand work off.

The computer is assigned per user, not per Bot. Do not use separate Bots as a
security boundary.

## Can several Bots work at the same time?

Yes. Bots can reason, use connectors, work with files, and coordinate in
parallel. Each Bot gets its own screen on the shared computer. One Bot can run
one computer-use task on its screen at a time.

## What does a Bot remember?

A Bot can retain stable preferences, role context, and summaries of prior work.
Its conversations and learned role are separate from other Bots, but a few
facts about you, such as your name and time zone, are shared by all your Bots.
Shared files, browser sessions, group messages, and direct handoffs can also
move context between them. To check what a Bot remembers, ask it: "What do you
remember about me?" See
[What a Bot remembers](/grok-bot/bots#what-a-bot-remembers).

For important decisions, ask the Bot to check the current source rather than
relying on memory.

## Can Grok Bot use any website?

Grok Bot can use many browser-based tools, including services without a
dedicated connector. A site may still block automation, require a new login,
present a CAPTCHA, or require human confirmation. The Bot should hand those
steps to you rather than bypassing them.

Some sites block traffic from cloud computers. When that happens, the Bot hands
you the step, and you can sign in yourself on the Bot's computer. You can also
turn on **Route traffic through this computer** in **Settings → Computer**,
under **Your computer**, so sites see your own connection. If a site times out
or shows a connection error instead, see
[A website times out or won't connect](/grok-bot/troubleshooting#a-website-times-out-or-wont-connect).

Use a connector when one is available for a more structured and reliable
integration.

## What actions require my approval?

The answer depends on the tool, the risk of the action, and—when enforcement is
enabled—your Auto-review rules. Sensitive or consequential actions can stop for
approval. Bots sign in with logins from [Vault](/grok-bot/vault), a connected
password manager, or a Secure Form without seeing the values; single sign-on,
passkeys, CAPTCHAs, and similar human-only steps use a computer takeover.

Tell each Bot its standing boundaries and ask it to remember them, and add
narrow **Ask first**
rules for actions such as sending, publishing, deleting, purchasing, or
changing production systems.

Approvals from work that started without you, like a routine or a message from
another Bot, expire after about 30 minutes. Approvals in a chat you are in wait
for you. See
[An approval expired or is blocked](/grok-bot/troubleshooting#an-approval-expired-or-is-blocked).

## Can I pick the model?

No. Grok Bot picks the model for each task, and there is no model picker. For
each task, it uses the backend model most likely to deliver the best outcome.
That can be a first-party SpaceXSI model or a third-party model from a provider
on the [sub-processor list](https://trust.cursor.com/subprocessors), and the
choice can differ from one request to the next. Users cannot be routed to or
away from a particular model.

Grok Bot does not show the underlying model for a request. Your usage and
spending views record this activity as Grok Bot usage, not by provider or model
name. Routing a task to Opus 5.5 doesn't change what it costs you per token;
how fast you use your usage depends on the kind of work you give Grok Bot and
how much effort each task takes.

Your team's Cursor
[model allowlist or blocklist](https://cursor.com/docs/enterprise/model-and-integration-management#model-access-control)
does not apply to Grok Bot. Teams with a model allowlist see this notice when
they [enable Grok Bot](/grok-bot/teams-and-enterprises#enabling-grok-bot-for-your-team).
Only providers on the sub-processor list can process your data, and the set of
models changes over time. See
[Models and data](/grok-bot/security#models-and-data) and
[Which AI models power Grok Bot?](https://cursor.com/help/grok-bot/models).

## How does Grok Bot handle data and privacy?

Grok Bot uses Cursor authentication and account data settings. Training opt-out
follows the applicable Cursor account and privacy settings.

Grok Bot requires cloud data storage, so Legacy Privacy Mode is not supported.
All of your Bots can access the same cloud computer assigned to your account. See
[Approvals, security, and privacy](/grok-bot/approvals-security-and-privacy) for the
full boundary and links to current Cursor security information.

## Do I need a separate Grok Bot subscription?

No. Grok Bot comes with **Premium**, **Super**, and **Ultra** on The X
Subscription, and with legacy **Cursor Pro**, **Pro+**, **Ultra**, and
self-serve **Teams**. On a legacy Cursor account you can also link an
individual **SuperGrok**, **SuperGrok Plus**, **SuperGrok Heavy**, or
**X Premium+** account, or sign in with a Grok account that has an assigned
seat on a self-serve **Grok Business** plan. On Enterprise, ask your account
team.

## How much does Grok Bot cost?

Availability and billing depend on the account and plan. On The X Subscription,
where new customers start, Grok Bot is included on Premium, Super, and Ultra,
for individuals and team seats; Plus and Free don't include it. There, Grok Bot
draws from the same weekly usage pool as Cursor and the Grok apps, and prepaid
credit covers usage past the pool. Super and Ultra include larger weekly pools
than Premium. Check usage under **Usage** at
[grok.com/dashboard](https://grok.com/dashboard).

On a legacy Cursor plan, Grok Bot is included with every paid individual plan
and with Cursor Teams, and you can link an individual SuperGrok, SuperGrok Plus,
SuperGrok Heavy, or X Premium+ subscription. **Pro** includes weekly usage,
**Pro+** generous weekly usage, and **Ultra** the highest weekly usage. When the
**Weekly usage limit** runs out, extra usage continues as **On-demand usage**
if on-demand is enabled, billed through Cursor. Grok Bot usage is metered on
your Cursor account, not on Grok or X, and macOS and iOS share the same usage.

See [Grok Bot on The X Subscription](/x-subscription/grok-bot) and
[Plans and billing](https://cursor.com/help/grok-bot/plans). Enterprise
customers should contact their Cursor account team.

## Which Grok plans can I link?

Individual **SuperGrok**, **SuperGrok Plus**, **SuperGrok Heavy**, and
**X Premium+**. **SuperGrok Lite** and **Grok Enterprise** cannot link. If you
have a seat on a self-serve **Grok Business** plan, you don't link from the
plan screen. Sign out, then sign back in with **Sign in with Grok** using the
Grok account that holds the seat. On The X Subscription there's nothing to
link: Grok Bot draws from your plan's shared weekly pool. See
[Link SuperGrok for Grok Bot](https://cursor.com/help/grok-bot/supergrok).

## I don't see Link Grok Account.

**Link Grok Account** is on the **Get Started with Grok Bot** page at
[cursor.com/bot/onboarding](https://cursor.com/bot/onboarding), and on the
phone's paywall screen. If you already have access, open
**Settings → Usage & Billing** and look under **Manage Plan** for
**Get Access with Grok**. It appears only when linking would raise your usage.

## I linked SuperGrok to the wrong Cursor account. Can I unlink it?

No. A link is permanent, and you cannot move it yourself.
[Contact support](/grok-bot/troubleshooting#before-contacting-support) with the
account that got the link and the account that should have it. Linking is a
usage grant, not a Cursor plan, so it doesn't change or cancel the Cursor plan
on either account.

## Do a Cursor plan and SuperGrok add together?

No. On a legacy Cursor account, Grok Bot uses whichever one grants more weekly
usage. Legacy **Pro**, **SuperGrok**, and **X Premium+** are the same tier,
**Pro+** matches **SuperGrok Plus**, and **Ultra** matches **SuperGrok Heavy**.
A Grok Business seat works the same way as a SuperGrok link. For more usage,
move to a higher tier or turn on on-demand usage. Both subscriptions keep
billing on their own; buying one does not cancel the other.

If you upgrade SuperGrok after linking, allow up to 24 hours for the
**Weekly usage limit** to move to the new tier. You do not need to link again.

## Why doesn't my SuperGrok limit match my Grok Bot usage?

They are two separate meters for two products. Grok Bot usage lives on your
Cursor account. See it in Grok Bot under **Settings → Usage & Billing**, not in
the Grok app.

## How do I stop charges after my weekly usage runs out?

On The X Subscription, leave Auto Top-up off or set a monthly additional usage
limit under **Additional usage credits** at
[grok.com/dashboard/billing](https://grok.com/dashboard/billing). On a legacy
Cursor plan, turn off on-demand or set a cap: in Grok Bot, open
**Settings → Usage & Billing → On-demand monthly limit**, or on the web go to
[cursor.com/dashboard](https://cursor.com/dashboard) and set **Monthly Limit**
under **Spending**. The cap does not stop a Bot in the middle of a run, so a
running task can go a little past it. If on-demand is off, Grok Bot stops when
weekly usage runs out and resumes when weekly usage resets.

## Is there a free trial?

Some accounts can try Grok Bot before they pay: when the access screen offers
**Start Trial**, choose it. The trial is a usage credit, and a 7-day window also
applies. It never turns into a paid plan. The credit is drawn down by how much
work your agents do, measured by agent steps and tokens rather than the number
of messages you send, so start small, scope tasks tightly, and check your usage
on the plan screen before running large or long jobs. One big task can use all
of it, and used credit is not restored.

**Cancel Trial** appears on free-plan accounts. There is no charge to cancel.
On a free plan, you can end it early with **Cancel Trial** in
**Settings → Usage & Billing** on desktop or **Settings → Usage** on iPhone
and Android. That removes any remaining trial credit, and you can't start the trial
again. On a paid plan or Teams seat, the trial ends on its own.

An App Store free trial started in the iOS app is different: Apple runs it, and
it turns into a paid Apple subscription unless you cancel first. See
[Manage or cancel a phone subscription](/grok-bot/mobile#manage-or-cancel-a-phone-subscription).

## How do refunds work for Grok Bot?

Grok Bot does not have a separate subscription, so it does not have a separate
refund path. On The X Subscription, refunds follow
[Invoices and refunds](/x-subscription/invoices-and-refunds), and prepaid
credit you've already spent isn't refundable. On a legacy Cursor plan,
subscription refunds follow Cursor's
[Refunds](https://cursor.com/help/account-and-billing/refunds) policy;
on-demand usage Grok Bot has already consumed and mid-cycle downgrades with
usage are not refundable. Apple or Google handles refunds for store purchases.
SuperGrok and X Premium+ are billed by SpaceXSI or X, not Cursor; see the
[Grok FAQ](/grok/faq#can-i-get-a-refund-for-my-grok-or-supergrok-subscription)
for SuperGrok, and contact X for X Premium+.

## Is Grok Bot available to teams and enterprises?

Yes. On a self-serve Cursor Teams plan, every member gets Grok Bot on their
Cursor account, without a Premium seat or an admin request, and on legacy Teams
plans on-demand usage is enabled by default. On a team on The X Subscription,
every paid seat (Premium, Super, or Ultra) includes it. On Cursor Enterprise,
an admin enables Grok Bot for the team; contact your Cursor account team.
Request-based Teams plans and Enterprise seats do not take a personal SuperGrok
link. See
[Grok Bot for teams and enterprises](/grok-bot/teams-and-enterprises).

## Can I change the email on my account?

No. The email on a Cursor account cannot change. To use a different email, make
a new account. See
[Change your email address](https://cursor.com/help/account-and-billing/change-email).

## Can I dictate or talk to a Bot?

Yes. On desktop, press `Cmd/Ctrl+D` or choose **Start voice input** to dictate
into the composer. On iPhone and Android, dictate with **Start dictation**.
**Start voice chat** starts a live conversation on desktop, iPhone, and
Android. Bots can also send a **voice memo** you can play in the transcript.

## What keyboard shortcuts does the desktop app have?

See [Keyboard shortcuts](/grok-bot/chat-and-collaboration#keyboard-shortcuts).
Dictate uses `Cmd/Ctrl+D`. Settings uses `Cmd/Ctrl+,`. **Start voice chat** is
a button and has no keybinding.

## Can I change the app language?

Yes. On desktop, open **Settings**, go to **General**, and choose a
**Language** under **Appearance**. **Follow System** uses your computer's
language, and desktop has 37 languages. On iPhone and Android, open
**Settings** and choose **Language**; **System** uses your phone's language,
and the phone app has 12 languages.

The language changes the app's menus and messages. New Bots write to you in
that language unless you write to them in another one. Voice chat has its own
**Language** setting.

## Can I use more than one account?

On desktop, open the account menu and choose **Switch account** or
**Add account**. Settings lists the same accounts; inactive rows include
**Remove**. On iPhone and Android, open **Settings** and, under
**Switch Account**, choose an account to switch to it or choose
**Add Account**. Swipe an inactive account to remove it.

## Which platforms are supported?

* macOS on Apple silicon and Intel
* Windows on x64 and Arm64
* Linux on x64 and Arm64, as a `.deb` package, an `.rpm` package, or an
  AppImage
* iPhone on iOS 18 or later
* Android 9 or later

The iOS app also runs on iPad with iPadOS 18 or later. Get the desktop app from
the Grok Bot page at [cursor.com/dashboard/bot](https://cursor.com/dashboard/bot).

## What is the difference between a skill and a routine?

A **skill** describes how to perform a task. A **routine** assigns a workflow to
one Bot and tells it when to run—on a schedule or, where supported, after an
event.

Test the skill on a real one-time task before turning it into a routine.

## Can I show a Bot how I do a task?

When **Teach a task** is available, record one browser workflow from the
computer view. The Bot turns the demonstration into a draft skill that you can
review and test. The rollout may be gradual, and the recording is limited to
ten minutes.

## Can I share a Bot with someone else?

Yes. Open the Bot's details, choose **Share**, then **Create a copy**. When the
Bot posts the template, choose **Publish**, then **Copy link**. Anyone with the
link can preview it on [x.ai](https://x.ai) and add a copy to their account.
They do not get your computer, logins, or conversation history. If your team
limits template sharing, the app doesn't offer **Create a copy**.

The link exposes the Bot's configuration. Strip secrets and anything
confidential before you share. Adding a shared Bot accepts the
[third-party bot terms](https://x.ai/legal/bot-sharing-terms). See
[Share a Bot](/grok-bot/bots#share-a-bot).

To give the team one Bot they all talk to, rather than a copy each person
customizes, publish a [shared Bot](/grok-bot/shared-bots).

## What happens if I delete a Bot?

Deletion removes the Bot's active profile, conversation, and routines from Grok
Bot. Because Bots share a computer, files and logins on that computer may
remain. Backend retention follows the applicable Cursor terms. Hide the Bot
instead if you may need its work later.

## How do I delete my Grok Bot account?

Grok Bot uses your Cursor account, so deleting it deletes the Cursor account.
Deletion is self-serve and permanent. Signing out of Grok Bot or uninstalling
the app leaves the account in place, and there is no way to delete Grok Bot
without deleting your Cursor account.

* **On iPhone or Android:** tap your account avatar to open **Settings**, tap
  your account, then tap **Delete Account** and confirm. In the browser page
  that opens, sign in, type **Delete**, and confirm again.
* **On desktop or the web:** cancel your subscription first if it is active.
  Then go to [cursor.com/dashboard](https://cursor.com/dashboard), open
  **Settings**, find **Delete Account** in **More**, choose **Delete**, and
  confirm. Desktop Grok Bot can sign you out, but it doesn't delete the
  account.

Deletion removes your Cursor account and Grok Bot access; Grok Bot agents,
chats, computers, and connected apps; and Cursor chat history and settings.
All data is removed within 30 days. Files on your own computer stay there. An
App Store or Google Play subscription, a linked SuperGrok subscription, and a
linked X Premium+ subscription are separate: cancel each with Apple, Google,
Grok, or X if you no longer want it.

On cursor.com, **Delete Account** appears for personal accounts. If you are on
a Cursor Teams or Enterprise seat, ask a team admin or
[contact support](/grok-bot/troubleshooting#before-contacting-support).
