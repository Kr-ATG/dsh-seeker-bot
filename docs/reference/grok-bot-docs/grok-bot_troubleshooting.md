#### Help

# Troubleshooting

Start with the least destructive step. A Bot's cloud work can continue even
when the desktop or mobile app is disconnected. Most problems clear with a full
restart: fully quit Grok Bot (on Mac, choose **Quit** from the menu bar, not
just closing the window), reopen it, and try again before anything else.

## Sign-in does not complete

1. Keep Grok Bot open while authentication runs in your browser.
2. Confirm the browser shows a successful Cursor sign-in.
3. Return to the app manually if it does not regain focus.
4. Choose **Sign in** on the welcome screen again. If you are already in the
   app, use **Sign In with Cursor** from Settings.
5. Confirm that your account has Grok Bot access.

If your organization uses SSO, complete the organization login rather than
signing in with a different personal account. If your access comes from a seat
on a self-serve Grok Business plan, choose **Sign in with Grok** in the browser
and use the Grok account that holds the seat.

If you are stuck in a sign-in loop or see a persistent authentication error:

1. Update the desktop app to the latest version, then sign out and sign back
   in.
2. Clear browser cache and cookies for cursor.com and x.ai, then sign in again
   in a private or incognito window.
3. On desktop, also try signing in at [x.ai/bot](https://x.ai/bot) with the
   same Cursor account. If the phone loops, sign in on desktop first.
4. If the error started recently, wait 30 to 60 minutes and retry. Some
   authentication errors clear on their own as your session refreshes.

Reinstalling the app usually does not fix this. Some session and account-link
failures, including looped sign-in flows, and access blocks caused by a phone
verification failure can't be fixed from your side.
[Contact support](#before-contacting-support) with the exact error text, the
steps you already tried, and whether the problem started during SuperGrok or
X Premium+ linking; for a phone verification block, include a screenshot of
the access-blocked screen.

An error about Legacy Privacy Mode means the account is using a data mode that
does not permit Grok Bot's required storage. Update the Cursor account data
setting or contact your organization administrator.

## Is Grok Bot down?

Check [status.cursor.com](https://status.cursor.com) and look at the
**Grok Bot** row. The app doesn't show service status, so the status page is
the place to check. You can subscribe to updates there.

If the status page shows a Grok Bot incident, wait for it to be resolved, then
send your message again. Don't **Reset** the computer or reinstall the app.
Neither fixes a service problem, and **Reset** can lose very recent changes if
the computer can't be reached to save them.

If the status page shows no incident and the Bot says **Bot failed to respond**
or **Model provider is overloaded**, wait a moment and send the message again.
If the Bot still doesn't reply, fully quit and reopen Grok Bot. A Bot also can't finish a turn while the computer says **Reconnecting** or
**Couldn't Reach Grok Bot's Computer**; see
[The computer cannot be reached](#the-computer-cannot-be-reached). If the
computer is connected and the same prompt still fails,
[contact support](#before-contacting-support) with the error title, the
request ID, and a screenshot of the computer status.

## The computer is still setting up

First setup and a computer update can take several minutes. Keep the app open
while it shows progress, such as **Setting up your Grok Bot…** during first
setup or **Updating Grok Bot's Computer** during an update. On your phone, the
home screen shows **Starting your computer…**. A slow update may say
**Update still running** or **Taking longer than usual**; **Keep waiting** is
the safe choice unless the update looks stuck. An update can take a few
minutes when it is downloading a large image or transferring data.

If progress is still changing, wait. If it fails or stops changing, follow
[The computer cannot be reached](#the-computer-cannot-be-reached). Choose
**Recover** only if the update appears stuck and the app offers
**Recover computer**; if recovery is not available, keep waiting.

If the computer's files aren't backed up yet, **Update** says they aren't ready
and nothing changes. Wait a moment and try again; do not **Reset** to force it.
If it keeps saying the files aren't ready,
[contact support](#before-contacting-support).
If **Settings** says
**An agent couldn't pause in time, so the computer was not updated**, let that
Bot finish, then choose **Update** again.

## The computer cannot be reached

Your Bot profiles and saved conversations are not lost when the computer is
temporarily unreachable. Chats are stored separately from the computer, and
Bots, files, and logins are safe while it reconnects.

Recover in this order:

1. If the computer says **Reconnecting** or
   **Couldn't Reach Grok Bot's Computer**, wait, then choose **Retry**. Do not
   **Reset** during this.
2. Fully quit Grok Bot and reopen it.
3. If an update is offered, open **Settings → Computer** and choose
   **Update Bot's Computer**.
4. Choose **Recover computer** if it still cannot reconnect, or if an update
   looks stuck and **Recover computer** is shown (the confirmation dialog calls
   it **Recover Grok Bot's Computer**).
5. Use **Reset** only after those steps. On iPhone and Android,
   **Settings → Bot → Bot Computer** has **Reset Computer**; updating and
   recovering the computer require the desktop app.

**Reconnecting** and **Recover** usually take a few minutes; you can choose
**Continue in Background**. Do not start a second Update or Reset while one is
already running. Repeated resets can interrupt a restore that is still
finishing. If **Recover** or **Reset** fails, use **Retry Recovery** or
**Retry Reset** once, then stop and
[contact support](#before-contacting-support).

The text under **Update Bot's Computer** says which kind of update is waiting.
A software update keeps everything, including installed apps. A full computer
update keeps your Bots, files, and logins but removes installed apps and
packages, and you may be able to schedule it for later. **Recover computer**
saves what it can, then builds a new computer on the latest version from your
saved data: saved Bots, files, and logins stay, installed apps and packages are
removed, running work is interrupted, and very recent changes can be lost if
the computer couldn't be reached to save them. **Reset** builds a new computer
from your last saved data with the same losses. If Bots recently disappeared,
or saving failed, contact support before you use either one.

Project folders such as `node_modules` or a Python virtual environment are not
saved. Reinstall them after a computer update, **Recover**, or **Reset**.

## Chats or Bots look missing

They are usually not deleted. Chats are stored separately from the computer, so
a computer problem does not delete conversation history by itself. Check before
you do anything else:

1. Fully quit Grok Bot and reopen it.
2. Open the same account on another device, including the phone app. Bots and
   conversations are shared across devices signed in to that account.
3. In the sidebar, open **Hidden Bots** on desktop or **Show Hidden Bots** on
   the phone. **Hide from sidebar** removes a Bot from the list only; hidden
   Bots stay active and keep their history. To show one again, choose
   **Show in sidebar** on desktop or **Unhide** on the phone.
4. Confirm you are in the same Cursor account, not a different login.

Don't use **Recover** or **Reset** to look for them. If they are still missing
on every device after these checks,
[contact support](#before-contacting-support) with the Bot name and a
screenshot of the sidebar.

## Files are missing from the computer

Conversation history is stored outside the computer, so deleting files inside
it, including `rm -rf`, does not delete chats. Grok Bot keeps a durable copy of
synced computer data, and reopening the computer restores from that copy, so
synced files usually come back. If the computer is still empty after
**Recover**, stop making changes inside it and
[contact support](#before-contacting-support).

Files that exist only on your Mac or Windows machine are not covered. Keep your
own backups for those.

## The computer is low on disk space

This is about your Bots' cloud computer, not your laptop. When it's almost full,
your Bot tells you once in chat, names the biggest files or folders with their
sizes, and offers to delete them. Nothing is deleted unless you say yes, and
saying no leaves those files in place. Cleanup applies only to computer files,
not to chats. Low disk space is not data loss.

## A Bot appears stuck

* Check the status shown in the sidebar and conversation.
* Open the computer to see whether the Bot is waiting on a page.
* Look for a question, approval, login, CAPTCHA, or secret request.
* Send a short redirect if the current approach is wrong.
* Send a direct “Stop now” message if the work should end.

A computer-use task already active on that Bot's screen may need to finish or
be redirected before another one can start.

## Your usage limit is reached

If the Bot stopped replying and says you hit your usage limit, it isn't broken:
your weekly usage is used up. It resets each week. To keep going now, add
prepaid credit (The X Subscription), turn on on-demand usage (legacy Cursor
plans), or move to a bigger plan. If on-demand is on, the
**On-demand monthly limit** caps it; a Bot already working can finish past
that limit. See
[How much does Grok Bot cost?](/grok-bot/faq#how-much-does-grok-bot-cost) and
[Usage and billing](/grok-bot/settings-and-notifications#usage-and-billing).

## A website keeps asking for login

1. Take over the computer and sign in yourself.
2. Complete two-factor authentication or CAPTCHA.
3. Confirm the signed-in page has loaded before returning control.
4. Tell the Bot to continue from the current page.

Do not paste a password or verification code into ordinary chat. Some sites
expire sessions or require verification for each sensitive action; this cannot
always be avoided.

Fingerprint, Face ID, Windows Hello, and passkeys saved on your laptop or phone
don't work on the Bot's computer. For a work app that uses Okta or single
sign-on, choose **Take over** on the **Computer** card marked
**Action needed**, sign in with a method your company allows there, such as a
password with a code or a push approval on your phone, then choose
**I'm done**. On Mac and Windows, you can also use a hardware security key: in
**Settings → General**, under **Security Key**, turn on
**Use hardware security keys**.

## A website times out or won't connect

The Bot's computer reaches the internet through Cursor's shared network. Some
sites and services drop connections from it, even when the same address opens
on your own device. The Bot may report a timeout, a secure connection error, or
a page that never loads. **Update**, **Recover**, and **Reset** don't change
this, so skip them.

Two settings under **Settings → Computer → Your computer** send the work
through your own device instead:

* **Route traffic through this computer.** The Bot's browser uses your
  desktop's connection, so the site sees your network and IP address. It
  applies to new connections and works while the Grok Bot desktop app is open.
  If the row asks you to update the Bot's computer first, choose **Update**. If
  your team admin has turned off local routing, the switch is locked. See
  [Route traffic through your desktop](/grok-bot/settings-and-notifications#route-traffic-through-your-desktop).
* **Execution on this computer.** The Bot runs commands and scripts, including
  API calls, on your desktop instead of its cloud computer. Choose
  **Ask every time** or **Always allow**.

If neither fits, [contact support](#before-contacting-support) with the site
address and a screenshot of the error.

## A plugin will not install or authenticate

A Bot shows a connect card only when an app needs you to sign in. Don't wait for
one:

1. Open **Connect apps** from the sidebar, select the connected count next to
   the title, and confirm the plugin is listed as installed.
2. Open the app and choose **Authenticate** (**Authorize** on the phone).
3. Complete authorization with the intended account in the browser within
   about 10 minutes.
4. Return to Grok Bot and retry the task.

If a connect card says it is waiting for authorization, choose **Reopen** to
bring the sign-in page back. If it says authorization didn't finish or failed,
choose **Retry**. If the app's button changes to **Reconnect**, choose it.

**Added** means the app is installed, not that you are signed in. Check its
status in **Connect apps**:

* **Needs auth** or **Disconnected**: choose **Authenticate** and finish the
  sign-in.
* **Disabled by team admin**: ask your Cursor team admin to turn it on.
* **Connected**: send the Bot a new message and ask it to try the app again.

If it still doesn't work, or authentication was revoked in the source service,
choose **Remove**, add the app again, and sign in. Also check whether the
connector requires an organization-provided variable or administrator
configuration. If re-authorizing completes but the app still shows
disconnected, [contact support](#before-contacting-support) with the app name.

## The X plugin is connected, but private X requests fail

Public X is built in. Grok Bot can search posts, profiles, mentions, trends, and
news without connecting X and without X API credits. The X plugin is only for
account-private data: your DMs, bookmarks, home timeline, and who liked your
posts. It runs on your own X developer account, which needs X API credits.

1. Open [console.x.com](https://console.x.com) and sign in with the same X
   account you connected in Grok Bot.
2. Check your X API credit balance. If it shows $0.00, add prepaid credits
   there. You buy these from X.
3. Retry the request in Grok Bot. You don't need to reconnect the plugin.

Reconnecting the plugin and changing your Grok Bot or Cursor plan do not add X
API credits. Connecting X does not always apply starter X API credits yet, so
console.x.com can show $0.00 until you add credits.

## A secret value seems missing

A saved value is not shown again, including in Shell. On a shared Bot, if the
name is still listed under **Secrets**, it is still stored. See
[Vault](/grok-bot/vault).

## An attachment cannot be read

Check that:

* The file is within its limit: 25 MB for an image, 250 MB for a document,
  audio, or other file, and 1 GB for a video. Images also count toward 200 MB
  per message.
* No more than 20 files are attached to one message on desktop
* The file is not encrypted or password-protected
* The upload finished before sending
* The file type is supported

Try exporting an unusual format as PDF, CSV, plain text, or an image. Do not
remove document protection if the resulting file would violate your data
policy.

## A routine did not run

Open the routine and verify:

* It is enabled, not **Paused**
* **When to run** shows the schedule and time zone you expect
* The owning Bot still exists
* Required plugins remain authenticated
* The computer can reach the source system
* Usage or account access has not been paused

Inspect recent run history for a failure. If the routine shows **Test** in the
desktop app, use it only with safe input; a test run can perform real external
actions. Many routines don't show **Test**; for those, ask the Bot to do the
same work once in chat with a safe input.

For an event-triggered routine, confirm the source channel, repository, and
matching rule are still valid. If a routine isn't paused but hasn't run for 24
hours or more with no error shown,
[report a bug](https://cursor.com/help/troubleshooting/reporting-bugs) with the
Bot name and routine details.

## A run fails with an error

Copy the request ID from the message, then try the task again. If the same
prompt fails on a fresh run,
[report a bug](https://cursor.com/help/troubleshooting/reporting-bugs) and
include the error text and request ID.

## An approval expired or is blocked

An approval from a chat you are in waits for you. An approval from work that
started without you, like a routine, a trigger, or a message from another Bot,
expires after about 30 minutes. The card then shows **Expired**, and the action
doesn't run. To catch approvals in time, turn on **Notifications** for Bots that
run routines, choose **Always allow** for actions you trust, and ask the Bot to
try the task again after an approval expires.

If a card is no longer actionable, read the proposed target and arguments,
then:

1. Reject or cancel it if that control is available
2. Send the Bot a replacement instruction
3. Ask it to regenerate the action with the corrected scope

If an action keeps requiring approval, check **Custom Rules** under
**Settings → General → Bot** for a matching **Ask first** rule, including team rules your
admin requires. **Ask first** rules take precedence over **Allow
automatically** rules.

## Local computer work is refused

Cloud-computer work and local-computer work use different permissions. Open
**Settings → Computer → Your computer**, find **Execution on this computer**
for the desktop (**Execution on Local Computer** until the desktop is listed),
and review the policy.

Keep local access disabled unless the task specifically requires files or
commands on the computer in front of you.

A Bot may say "Local tools are turned off. The user has set local tool access
to Never." even though **Execution on this computer** is set to
**Always allow** or **Ask every time**. This is a known issue on Cursor's side.
Your setting is correct, and restarting or reinstalling Grok Bot, or changing
the setting, won't clear the error.

## A Bot can't use your phone's apps

Keep Grok Bot open on your phone while the Bot works, and ask from your own
chat with a Bot you own. On the phone, open **Settings → Connect apps** and
choose **iPhone** or **Android** next to **All**. If the app shows **Denied**,
choose **Open Settings** and turn it on. See
[Let a Bot use your phone's apps](/grok-bot/mobile#let-a-bot-use-your-phones-apps).

## @bot did not reply on X

Tagging @bot isn't available in every region yet, and @bot also stays quiet
when a post has a video, tags @grok as well, or doesn't pass internal
moderation. [Tag @bot on X](/grok-bot/tag-on-x#when-bot-stays-quiet) lists the
common causes and what each @bot reply means.

## The app hangs on launch

Fully quit and relaunch. On Mac, use **Quit** from the menu bar. If it hangs on
every launch, [contact support](#before-contacting-support) with your platform
and Grok Bot version.

## Grok Bot says Update required

Grok Bot requires an update when your version is more than 14 days old and a
newer version is out. It covers its window with **Update required** and says
your version is no longer supported. Choose **Update** and wait for the
download, then choose **Restart to update**. Your Bots keep running in the
cloud the whole time. If the download fails, choose **Try again** or
**Download the latest version** and install it yourself.

On Linux, the screen may show a command to run instead. Choose
**Copy command**, run it in a terminal, then restart Grok Bot:

* Debian or Ubuntu: `sudo apt update && sudo apt install --only-upgrade grok-bot`
* Fedora or other RPM systems: `sudo dnf upgrade --refresh grok-bot`

If the screen asks you to download and install the latest package, do that,
then restart Grok Bot.

On iPhone and Android, choose **Update Grok Bot** to get the new version from
the App Store or Google Play.

## Update Grok Bot

The Grok Bot app and Grok Bot's computer have separate updates.

* The desktop app checks for updates on its own. When one is ready, the account
  menu shows **New update available**. Choose **Install**, then
  **Restart to update**.
* To check yourself, open **Settings → Updates → Check for Updates**. If an
  update is ready, choose **Restart to Update**. With **Automatic Updates** on,
  the default, a downloaded update also installs while you're away.
* On a Linux `.deb` or `.rpm` install, **Check for Updates** only tells you a new
  version is out. Update with your package manager, for example
  `sudo apt update && sudo apt install --only-upgrade grok-bot` or
  `sudo dnf upgrade --refresh grok-bot`.
* Phone updates come from the App Store or Google Play.
* To rebuild the cloud computer, open **Settings → Computer** and choose
  **Update Bot's Computer**.

Updating the desktop app does not reset the cloud computer. Product changes are
listed on the [changelog](https://cursor.com/changelog).

If Grok Bot closed to update but is still on the old version, check the version
under **Support → About** in the account menu, fully quit and reopen Grok Bot,
then choose **Check for Updates** and **Restart to Update** again. If the
version still hasn't changed, download the latest version from
[cursor.com/dashboard/bot](https://cursor.com/dashboard/bot) and install it
over the current app. Your Bots and chats belong to your account, so they are
still there after you reinstall. On Linux, run the update command for your
system. If the old version keeps coming back,
[contact support](#before-contacting-support) with the version and your
platform.

## Before contacting support

To report a problem from the desktop app, open the account menu and choose
**Support → Send Feedback**. On a Mac, you can also choose
**Help → Send Feedback** in the menu bar. Make sure
**Include current conversation ID** is selected when the problem is in the open
conversation. In the phone app, open **Settings** and tap **Send Feedback**;
if the problem is with one Bot, choose it and keep **Include Bot ID** on.

For help from the support team, email [support@x.ai](mailto:support@x.ai)
from the email on your Grok Bot account. Billing and cancellation questions go
to the same address with a quick summary of the issue.

To find your version, open the account menu and choose **Support → About**,
then **Copy version info**, which copies the version, release track, and OS. To
copy a request ID, right-click the message and choose **Copy request ID**, or
hover the message, open **More message actions**, and choose
**Copy request ID**. If the menu doesn't offer it, that message has no request
ID; include the error text and a screenshot instead.

Collect:

* The email on your Grok Bot account
* Grok Bot version and platform: Mac, Windows, Linux, iOS, or Android
* What you were trying to do, and the Bot or routine name
* The exact error message or a screenshot of the error or plan screen
* The approximate time and time zone
* The full request ID or conversation ID if one is shown
* The troubleshooting steps you already tried, such as retry, app restart, or
  updating Grok Bot's computer

Do not include passwords, one-time codes, private keys, or secret values.
