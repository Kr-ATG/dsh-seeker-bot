#### Work with Grok Bot

# Use the computer and apps

Your Bots work from a persistent cloud computer with a browser, command line,
and filesystem. Work continues while your laptop is closed, and files,
sign-ins, and browser sessions persist between tasks.

## One computer, shared by all your Bots

Every Bot on your account uses the same computer:

* Browser cookies and signed-in sessions are shared
* Files are visible to every Bot
* Command-line credentials are shared
* One Bot can continue from work another Bot saved

The computer is assigned to your user account, not an individual Bot. Do not
place a credential or file on it if another Bot on your account should not be
able to use it.

Each Bot gets its own screen on the shared computer. Several Bots can therefore
use browser and desktop tools in parallel, although one Bot can run only one
computer-use task on its screen at a time. The screens are separate work
surfaces, not separate security boundaries.

Between users, isolation is strict: each user's computer is dedicated and
hardware-isolated. See
[How users are isolated](/grok-bot/teams-and-enterprises#how-users-are-isolated).

## Watch computer work

Click the computer preview in the right-hand panel of a conversation to open
the computer and watch clicks, typing, navigation, and current status.

You can leave the preview while work continues. Closing the Grok Bot app or
your laptop does not stop cloud work.

## Take over for a sensitive step

To sign in, a Bot uses a login saved in [Vault](/grok-bot/vault) first, then a
connected password manager such as [1Password](#connect-1password), then asks
you with a Secure Form. Values from Vault and the Secure Form are filled into
the page without the Bot seeing them. When a site emails a one-time code, the
Bot can read it from a connected Gmail or Outlook account or from [its own
inbox](#give-your-bots-an-email-address). At checkout, it can use a card saved
in Vault, a card you enter in a Secure Form, or a connected wallet such as Link
or X Money; see [Pay for things](/grok-bot/vault#pay-for-things).

The Bot hands you the computer when a form can't do the step:

* Single sign-on or a passkey
* A CAPTCHA it couldn't get past
* An approval on another device or a QR code
* A bank card verification
* A site that explicitly requires a human

Open the computer, take control, complete only the blocked step, and tell the
Bot to continue. Never paste passwords or one-time codes into ordinary chat. For
an API key or other secret, enter it in the secure secret card when the Bot
asks: the field is masked, and the value isn't written into the chat or shown to
the Bot. See [API keys and other
secrets](/grok-bot/vault#api-keys-and-other-secrets).

## Sign in once

Browser sessions persist so you usually do not need to sign in for each task.
Because the browser is shared, signing in for one Bot makes the session
available to your other Bots.

Some websites expire sessions, enforce short timeouts, or request verification
again. Ask the Bot to pause and notify you rather than attempting to work around
the check.

## Connect an app

Apps give a Bot a structured way to work with services like Gmail, Notion, and
Slack, and are more reliable than clicking through a website when one exists.
Use the browser for services without an app or for visual workflows an app does
not expose. App connections belong to the same account you used to sign in to
Grok Bot.

1. Open **Connect apps** from the sidebar, or follow an in-chat **Connect**
   card. In the mobile app, tap your avatar on the top left and choose
   **Connect apps**.
2. Browse or search for the app, then add it.
3. When Grok Bot asks you to **Authorize** or **Authenticate**, finish the
   provider login in your browser.
4. If sign-in doesn't finish, choose **Reconnect** on the app, or **Reopen** on
   the in-chat card, to bring the sign-in page back.
5. Confirm the app appears under **Installed**.

In chat, type `@` to attach the app to the task.

**Added** means the app is installed, not that you are signed in. If the Bot
says an app is missing, open the app and choose **Authenticate** (**Authorize**
on the phone) if it shows **Needs auth** or **Disconnected**.

You can also ask a Bot to do this for you, for example “Add the Linear app.”
The Bot searches the catalog, installs the app on your account, and shows a
**Connect** card when the app needs you to sign in. The app's tools are ready
from your next message. A Bot can also add an MCP server that isn't in the
catalog, by URL or by a command that runs on its computer; a server started by a
command is available to your other Bots too. Adding a server on a private
network, or one that uses a private certificate authority, asks for your
approval first.

When a Bot removes an app for you, everything the app added goes with it and
you are signed out, so reinstalling it means signing in again. Apps your team
requires can't be removed.

* **Apps are account-wide.** A connected app is available to every Bot you run.
  A teammate's [shared Bot](/grok-bot/shared-bots) asks before it uses your
  accounts.
* **App logins stay off the computer.** OAuth tokens are held on Cursor's
  connector backend, and the Bot invokes tools without receiving them.
* **Team policy applies.** An app blocked by your team's
  [connector policy](/grok-bot/teams-and-enterprises#connector-policy) shows
  **Disabled by team admin**; ask your admin to enable it. Blocking an app
  doesn't block that service's website. Closing that second path takes
  **Network Controls**, which is Enterprise only. See [Network
  policy](/grok-bot/security#network-policy).

The **Email** app is different: it gives your Bots [their own email
address](#give-your-bots-an-email-address) instead of connecting an account you
already have.

### What a connected app can do

An app uses the account you authorize. It can do only what that account can
already do in that service. It cannot raise your access, and it cannot change
sharing.

* **Google Calendar:** the Bot can read calendars you can see, create and
  update events, check free time, and respond to invitations on calendars you
  can edit. It cannot change Google Meet settings, such as the waiting room or
  host controls, and it cannot add a Zoom link, because Google's Zoom add-on
  isn't available to the app. Put the Zoom link in the event location or
  description yourself, or create the event in Calendar and ask the Bot to
  update the other fields.
* **Google Sheets:** the Bot can read and edit cells in spreadsheets the
  connected Google account can edit. A file shared as Viewer stays view-only.
  Finding and opening files uses the **Google Drive** app, which can search and
  read files that account can open.
* **Slack:** the app posts as the Slack user you connected, not as a separate
  bot that has to be invited. It can post only in channels that user can post
  in. To use another Slack workspace, connect that workspace. This is separate
  from a Slack message that [starts a
  routine](/grok-bot/skills-routines-and-automations#trigger-work-from-an-event).
* **Gmail:** the app can search and read mail, draft and send, and apply labels
  on the connected mailbox. Gmail connects one mailbox at a time; to use a
  different one, disconnect the current mailbox and authorize the other.
  Disconnect Gmail if a Bot should not use that mailbox. Some other apps, like
  Notion, can connect a second account.
* **X:** the X plugin needs X API credits on your X developer account.

### If Google says an admin needs to review Grok

A company Google account can stop the connection before Gmail, Calendar, Drive,
Docs, Sheets, or Slides finishes signing in. Grok Bot signs in to Google as
**Grok**, not Cursor. This is separate from the Cursor **Disabled by team
admin** control.

If the Google page says **Your admin needs to review Grok**, Grok is not
approved for that Workspace yet. Request access if that button is there, and
wait for the admin to approve Grok before you try **Authorize** again. An IT
admin approves **Grok** in the Google Admin console:

1. Open **Security**, then **Access and data control**, then **API controls**.
2. Open **App access control**, then **Manage third-party app access**.
3. Add the app named **Grok**. If name search does not find it, use the client
   ID from the blocked page or the admin review email.
4. Set Grok to **Trusted** for the people who use Grok Bot.

That approval covers the Google apps those people connect. It does not turn an
app back on in Cursor.

If the page says **Access blocked**, Google refused the sign-in. A personal
Gmail account does not need a company admin; a company account often hits this
when Grok is not on the allowlist, or when the admin has blocked third-party
apps. Ask the Google admin to trust **Grok** with the steps above. Changing
browsers or connecting the app again does not clear a Google admin block. If the
page still says access is blocked, [contact support](/grok-bot/troubleshooting)
with the Google account email and a screenshot of the blocked page.

### Connect 1Password

1Password lets your Bots sign in to websites on their computer with logins from
your 1Password account. You approve each login in 1Password, and 1Password fills
it in; your Bots never see the values. The new 1Password integration is rolling
out gradually. It works with personal and Family 1Password accounts and needs
1Password 8.12.42 or later.

1. Choose **Connect apps** and open **1Password**, under **Password Managers**.
2. On your computer, choose **Connect 1Password**.
3. Your browser opens. Sign in to 1Password there and approve Grok Bot. Grok Bot
   updates when you're done.

On the phone, open 1Password from the **Password Managers** shelf in **Connect
apps**, or search for it, then approve the connection in 1Password. If your phone
says **1Password can only be set up on a Mac**, the new integration hasn't
reached your account yet; set it up from Grok Bot on your computer instead. To
stop using 1Password, open it in **Connect apps** and choose **Disconnect**.

When a login isn't saved in Vault, the Bot sends a card in the chat that names
the website:

1. Choose **Review in 1Password**. The 1Password app opens, or 1Password opens
   in your browser if the app isn't installed on that computer.
2. In 1Password, choose the exact logins to share and approve the request.
3. 1Password fills the login in the Bot's browser.

A login you share stays available in later chats. If 1Password stops allowing
it, the Bot asks again. 1Password does not fill payment cards, and your Bots
still ask you to help with steps it can't fill, such as a passkey, single
sign-on, or a CAPTCHA.

1Password only offers logins from your own Personal vault, called Private on
Family accounts, not from shared vaults. Move or duplicate the login into that
vault, then ask the Bot to try again. If no approval prompt shows up at all,
update the 1Password app to 8.12.42 or later.

The new integration no longer uses a service account, so if you used 1Password
with Grok Bot before, connect it again. Logins in the vault you shared with the
old integration aren't available until you move them to your Personal or
Private vault; the 1Password page in **Connect apps** tells you how many. On a
Mac, you can choose **Move to Private** instead and approve in 1Password if it
asks. The old vault stays in 1Password.

| Message | What to do |
| --- | --- |
| **1Password didn't finish connecting** | Start connecting again. On the phone, if you already have a 1Password account, choose **I already have 1Password** and sign in with it. |
| **This 1Password account is already connected to another Grok Bot account** | Disconnect 1Password from the other Grok Bot account first, or connect a different 1Password account. |
| **Reconnect required** | 1Password no longer accepts the connection. Choose **Reconnect**. |
| **Sign in to the 1Password account you connected to Grok Bot, then try again** | Sign in to the account you connected, then ask the Bot to try again. |
| **Access requests aren't turned on for your 1Password account** | Ask your 1Password administrator to turn on access requests. |
| **This request already ended in 1Password** | Ask the Bot to try again. It sends a new request. |
| **1Password could not be opened** | Open the 1Password app yourself to review the request. |
| A message that asks you to revoke Grok Bot's access under **Integrations** in 1Password | Revoke Grok Bot's access under **Integrations** in 1Password, then connect 1Password again. |

### Known app issues

* **Zoom error 4700:** Zoom authorization from the Grok Bot desktop app
  currently fails with error 4700 (Invalid redirect). There is no workaround
  yet, and no change on your end resolves it.
* **SharePoint AADSTS50011:** when a Cursor team admin connects SharePoint from
  the dashboard **Integrations** page with **Application-level permissions**,
  Microsoft shows a redirect URI mismatch before the consent prompt. Nothing in
  your tenant causes this. Connect with **Delegated permissions** instead:
  choose **Connect team** (or **Reconnect**) on the SharePoint card, pick
  **Delegated permissions**, enter your Microsoft tenant ID, and sign in with
  Microsoft. Most work or school tenants need a Microsoft admin to consent once
  to Sites.Read.All. Each member then signs in with their own Microsoft account
  the first time a Bot uses SharePoint and sees only the sites their account
  can already open. If members see “This team does not have the SharePoint
  integration”, the admin needs to finish the Delegated sign-in.

For more setup help, see [Connect
apps](https://cursor.com/help/grok-bot/connect-apps).

## Give your Bots an email address

You can claim one email address at `mail.grokbot.com`, such as
`yourname@mail.grokbot.com`, for your Bots to use. Your Bots can then receive,
read, search, and send email from it. With an address, a Bot can:

* Sign up for services with its own address, and pick up the verification code
  or link with your OK
* Collect receipts, newsletters, and reports, and summarize them for you
* Draft email for you, such as a digest or an update, and draft replies
* Forward an email from its inbox with the original formatting, images, and
  attachments, which needs Grok Bot 0.75.2 or later
* Run a routine when email arrives, optionally only from specific senders

To claim an address, ask a Bot, for example “Get yourself an email address.” It
asks what name you want, checks that the name is free, and shows an approval
card; nothing is claimed until you approve. You can also open **Connect apps**,
choose **Email**, type a name in **Choose a name** under **Email address**, and
choose **Create address**. On iPhone and Android, open **Settings → Connect apps
→ Email**. After you claim it, the app shows your address with a button to copy
it.

Names use lowercase letters, digits, dots, hyphens, and underscores, start and
end with a letter or digit, and are at most 64 characters. Reserved words such
as support, admin, billing, security, help, info, team, cursor, grok, and xai
aren't allowed.

Your address also takes plus aliases. Mail to `yourname+receipts@mail.grokbot.com`
lands in the same inbox as `yourname@mail.grokbot.com`, so you can give each
service its own alias without claiming another address. A Bot can send from an
alias too, and a routine that watches an alias runs only for mail sent to that
alias, while a routine on the plain address runs for all of it. An alias is a
label, not a lock: anyone can write to it, so keep a sender filter on a routine
that should act only for certain senders.

* **One address, for good.** You get one address, and you can't rename or
  delete it. Addresses are never reissued, even after the account that claimed
  one is deleted.
* **Yours, not one Bot's.** All your Bots can use the address in your own chats
  and routines. It isn't used in Slack threads or in chats where someone else is
  talking to the Bot, and a [shared Bot](/grok-bot/shared-bots) doesn't have a
  team address.
* **Reading mail.** Anyone can send mail to the address. Mail that fails the
  spam or virus scan is kept without its body or attachments, and it never
  starts a routine. There's no inbox view and no new-mail notifications, so ask
  a Bot, for example “What arrived in your inbox today?” Mail that arrived in
  the last minute may not show up in a search yet. Each incoming message can
  include up to 10 attachments, up to 10 MB each and 25 MB in total; attachments
  beyond those limits are skipped.
* **Acting on mail.** New mail doesn't start a chat or wake a Bot on its own. To
  act on it, set up a
  [routine](/grok-bot/skills-routines-and-automations#trigger-work-from-an-event)
  that watches for mail from anyone, from specific addresses, or from a whole
  domain such as `*@example.com`. By default, the routine only runs for mail
  from senders that pass standard email authentication checks, and routines
  can't filter by subject.
* **Sending mail.** When you ask a Bot in chat to send an email, it goes out
  once [Auto Review](/grok-bot/approvals-security-and-privacy#configure-auto-review)
  allows it; if Auto Review needs you, you see an approval card first. Email
  from a routine, or from any other turn you didn't start with that request,
  waits as a draft until you press **Send**, and there's no option for
  unattended sending. If you've also connected Gmail or Outlook, the Bot asks
  which account to send from when either could work.
* **Safety.** A Bot treats email from other people as information, not
  instructions. Each message it reads is marked as from you or from someone
  else, and instructions inside an email never count as your permission to send
  or act.

Sending limits:

* Up to 50 recipients per email, across To, Cc, and Bcc
* Up to 10 attachments, up to 10 MB each and 25 MB in total; executable files
  can't be attached
* Newsletters and first-contact emails go to one recipient per message and
  include a one-click unsubscribe link
* If a message bounces, or someone unsubscribes or marks it as spam, the Bot
  stops emailing that address and tells you who it skipped
* There are also limits on how many new people a Bot can email, to protect the
  address from being flagged as spam

If you delete your Grok Bot account, your mail and attachments are deleted, and
the address is retired.

On a Cursor team, agent email is off by default; an admin turns on [Agent
Email](/grok-bot/teams-and-enterprises#agent-email) before members can claim an
address. If an admin turns it off later, Bots lose their email tools and email
routines stop running, but mail sent to existing addresses is still received and
kept, and members keep their addresses.

| What you see | What to do |
| --- | --- |
| **Agent email is not enabled for this account.** | Agent email isn't available on your account yet. |
| **Your team admin has turned off Grok Bot agent email, so this account cannot claim or use an agent email address.** | Ask your team admin to turn on **Agent Email**. |
| **That address is taken, and addresses are never reissued, so retrying it cannot succeed. Choose a different name.** | Choose a different name. |
| A message about allowed characters, length, or a reserved word | Pick a name that follows the name rules above. |
| **You can have one agent email address.** | You already have an address. Ask your Bot what it is, or open the **Email** app. |
| **Couldn't create your email address. Try again.** (phone) | Check the name rules, or try on desktop, which shows the exact reason. |
| **Too many email addresses checked in the last minute.** | Wait a minute, then try again. |

## Search and read X

Bots can search and read what's public on X without you connecting an X
account. Ask a Bot to search posts, open a post from its link, read an
account's posts and mentions, see who quoted or reposted a post, count recent
posts on a topic, or check trends and news.

This access is read-only and doesn't sign in as you. For your DMs, bookmarks,
home timeline, or who liked your posts, add the X plugin from **Connect apps**
and sign in with X.

## Work with files

The computer has a shared workspace at `/workspace`. Keep durable project files
there in clear project folders.

Files, browser state, and supported sign-ins survive normal computer updates
and recovery. Treat temporary directories, manually installed packages, and
uncommitted application state as replaceable. Copy important results into the
shared workspace or attach them to the conversation.

Conversation history is stored outside the computer, so deleting files inside
it, including `rm -rf`, does not delete chats. Grok Bot keeps a durable copy of
synced computer data, and reopening the computer restores from that copy, so
synced files usually come back. Project folders such as `node_modules` or a
Python virtual environment are not saved; reinstall them after a computer
update, **Recover**, or **Reset**. Files that exist only on your Mac or Windows
machine are not covered, so keep your own backups for those.

When the computer is almost full, your Bot tells you once in chat, names the
biggest files or folders with their sizes, and offers to delete them. Nothing is
deleted unless you say yes. Low disk space is not data loss, and cleanup applies
only to computer files, not to chats.

## Update, recover, or reset the computer

Open computer controls from **Settings → Computer**, under **Bot's computer**.
You can also get **Recover** from the reconnect screen when the app offers it.
The app and the computer update separately.

| Action | What it does | What it keeps | What it removes |
| --- | --- | --- | --- |
| **Update** | Moves the computer to the latest version. Some updates only refresh Grok Bot's software; others replace the whole computer, and you may be able to schedule those for later. The text under **Update Bot's Computer** says which kind is waiting. | Software update: everything, including installed apps. Computer update: Bots, files, and logins. | Software update: nothing. Computer update: installed apps and packages. |
| **Recover** | Saves what it can, then builds a new computer on the latest version from your saved data. Running work is interrupted. | Bots, files, and logins that were saved | Installed apps and packages, and very recent changes if the computer could not be reached to save them |
| **Reset** | Builds a new computer on the latest version from your last saved data. Running work is interrupted. | Bots, files, and logins that were saved | Installed apps and packages, and very recent changes if the computer could not be reached to save them |

Conversations are stored outside the computer, so they survive even a reset.
If Bots recently disappeared, or saving failed, [contact
support](/grok-bot/troubleshooting) before you use **Recover** or **Reset**.

When the computer is unreachable, work from the least destructive option first:

1. Wait, then choose **Retry** if the computer says **Reconnecting** or
   **Couldn't Reach Grok Bot's Computer**, or reopen the conversation. Bots,
   files, and logins are safe while it reconnects. Do not **Reset** during this.
2. Fully quit Grok Bot and reopen it, and check for an app update. On Mac,
   choose **Quit** from the menu bar, not just close the window.
3. Use **Update Bot's Computer** in **Settings → Computer** if an update is
   offered.
4. Choose **Recover computer** (the confirmation dialog calls it **Recover Grok
   Bot's Computer**) if it still cannot reconnect, or if an update looks stuck
   and **Recover computer** is shown. On a slow update, **Keep waiting** is the
   safe default.
5. Use **Reset Bot's Computer** only after those steps.

Do not start a second Update or Reset while one is already running; repeated
resets can interrupt a restore that is still finishing. **Reconnecting** and
**Recover** usually take a few minutes, and you can choose **Continue in
Background**. An **Update** can also take a few minutes; if it says **Update
still running**, keep waiting. If **Recover** or **Reset** fails, use **Retry
Recovery** or **Retry Reset** once, then stop and [contact
support](/grok-bot/troubleshooting).

If the computer's files aren't backed up yet, **Update** says they aren't ready
and nothing changes; wait a moment and try again rather than resetting. If
Settings says **An agent couldn't pause in time, so the computer was not
updated**, let that Bot finish, then choose **Update** again.

A Bot cannot finish a turn while the computer says **Reconnecting** or
**Couldn't Reach Grok Bot's Computer**. Fix the connection with the steps above,
then send the message again. See [Troubleshooting](/grok-bot/troubleshooting)
for missing chats and when to contact support.

## Your local computer is separate

The Grok Bot cloud computer is separate from the Mac or Windows computer in
front of you. A Bot only runs commands on your local computer when that
capability is enabled and you approve it under your local-computer policy:
per-command approval with **Ask every time** by default, or **Always allow** or
**Never allow**. That policy is separate from the approvals that govern work on
the cloud computer.

Review local-computer permissions in
[Approvals, security, and privacy](/grok-bot/approvals-security-and-privacy#control-access-to-your-local-computer).
