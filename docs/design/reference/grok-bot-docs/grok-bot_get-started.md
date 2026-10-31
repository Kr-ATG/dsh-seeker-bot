#### Start

# Get Started

This guide takes you from install to your first finished task. You'll set up the
desktop app, create a Bot with a clear job, and review its work.

## Before you begin

You need an eligible plan: Premium, Super, or Ultra on The X Subscription, for
an individual or a team seat. On a legacy Cursor plan, every paid individual
plan and Cursor Teams include Grok Bot. You can also link an individual
SuperGrok, SuperGrok Plus, SuperGrok Heavy, or X Premium+ subscription, or sign
in with a seat on a self-serve Grok Business plan. See
[Grok Bot on The X Subscription](/x-subscription/grok-bot) and
[Plans and billing](https://cursor.com/help/grok-bot/plans).

Grok Bot needs cloud data storage, so accounts on Privacy Mode (Legacy) are
prompted to switch to Privacy Mode before starting.

## 1. Install the desktop app

Get the installer from the Grok Bot page of the
[Cursor dashboard](https://cursor.com/dashboard/bot): the **Download Grok Bot**
setup row installs the desktop app or copies a link you can share. If you don't
have dashboard access, ask your admin for the download link. You can also
download the app from [x.ai/bot](https://x.ai/bot). The app runs on macOS
(Apple silicon and Intel), Windows (x64 and Arm64), and Linux (x64 and Arm64)
and checks for updates automatically. On a phone, install Grok Bot from the App
Store or Google Play; see
[Use Grok Bot on your phone](#use-grok-bot-on-your-phone).

## 2. Sign in

Choose **Sign in** on the welcome screen and finish authentication in your
browser. Grok Bot uses your Cursor account, and there is no separate Grok Bot
login. If your organization uses single sign-on, sign in through your normal
company flow; your existing Cursor SSO configuration applies.

If your access comes from a seat on a self-serve Grok Business plan, choose
**Sign in with Grok** in the browser and use the Grok account that holds the
seat. If your access comes from a SuperGrok or X Premium+ subscription, link it
when the app asks. On iPhone and Android, the access screen offers **Link Grok
Account** and then **Finished Linking? Refresh My Status**; on desktop,
**Settings → Usage & Billing** offers **Get Access with Grok**. For sign-in
problems, see [Sign-in does not complete](/grok-bot/troubleshooting#sign-in-does-not-complete).

## 3. Meet your first Bot

After you sign in, click through a short intro. Grok Bot then sets up your first
Bot, named **Grok Bot**, and opens a chat with it.

To add more Bots, choose the **+** button in the sidebar, then **Create a Bot**,
name the Bot, and choose **Create**. On a Cursor team, share a Bot to let
teammates chat with it, and choose **Browse shared Bots** under **+** to find
Bots shared with you; see [Shared Bots](/grok-bot/shared-bots).

Give each Bot one primary job in its first message and ask it to remember how
it should work. To rename it, click its name at the top of the chat to open its
details. A focused Bot builds more useful context than one catch-all helper.
For example:

> Your job is product performance. Investigate product-performance questions
> with our observability tools. Preserve links and screenshots, separate
> evidence from hypotheses, and lead with the highest-impact issue. Never
> change production settings. Remember this for future work.

## 4. Give it a first task

Type in the composer, or dictate with **Start voice input** (`Cmd/Ctrl+D` on
desktop; **Start dictation** on iPhone and Android). You can also choose
**Start voice chat** for a live conversation.

A strong request states the outcome, the sources that matter, the constraints,
the deliverable, and where the Bot should stop for you. For a five-minute first
result, attach a document and try:

> Summarize this document in five bullets. List every date, decision, and open
> question in a separate section, and cite the section for each item. Don't
> change the source file.

## 5. Sign in to the tools it needs

When the Bot reaches an app that requires authentication, it uses a login saved
in [Vault](/grok-bot/vault) or a connected password manager, or asks you for it
with a [Secure Form](/grok-bot/vault#secure-forms). The Bot never sees the
password, and the signed-in session persists on your computer for future tasks.
For single sign-on, a passkey, or another step a form can't handle, it hands you
the computer: click **Open computer**, finish that step, and return control. For
supported services, you can also
[connect an app](/grok-bot/computer-and-apps#connect-an-app) instead.

## 6. Review the result and make it stick

Ask for revisions, and name lasting preferences explicitly, like a report
format you want reused. When the process is stable, save it as a
[skill or routine](/grok-bot/skills-routines-and-automations).

Before you let a Bot change external systems, read
[Approvals and Auto Review](/grok-bot/security#approvals-and-auto-review). It
covers approval prompts, the review model behind them, and how to keep
credentials out of chat.

## Use Grok Bot on your phone

The iPhone app (iOS 18 or later) and the Android app (Android 9 or later)
connect to the same Bots, conversations, routines, and cloud computer as
desktop. Install Grok Bot from the App Store or Google Play and sign in with the
same Cursor account; access from your plan or SuperGrok link carries over
without a second purchase. From your phone you can message Bots, watch and take
over the computer, approve actions, and pause or resume routines.

Some flows stay on desktop: teaching a workflow by demonstration, testing
routines, and updating the computer. See [Grok Bot on mobile](/grok-bot/mobile)
for setup details and for subscribing from the mobile app if your account
doesn't include access.

## If something doesn't work

Most setup problems clear after you fully quit and reopen the app. For
symptom-by-symptom help with computers, routines, connected apps, and startup,
see [Troubleshooting](/grok-bot/troubleshooting), or
[contact support](/grok-bot/troubleshooting#before-contacting-support).

## Related pages

* [Work with Grok Bot](/grok-bot/bots)
* [Grok Bot use cases](/grok-bot/use-cases)
* [Deploy Grok Bot to your organization](/grok-bot/deployment)
* [Plans and billing](https://cursor.com/help/grok-bot/plans)
