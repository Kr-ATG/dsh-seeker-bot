#### Manage and protect

# Settings and notifications

Grok Bot settings cover app-wide and desktop-local behavior. Each Bot's name,
picture, and label live in its conversation details.

## Open Grok Bot settings

Open the account menu and choose **Settings**, or press `Cmd/Ctrl+,`. For
other desktop shortcuts, including Bot settings (`Cmd/Ctrl+Shift+,`) and
conversation details, see
[Keyboard shortcuts](/grok-bot/chat-and-collaboration#keyboard-shortcuts).

The **Grok Bot settings** dialog has **General**, **Computer**, **Vault**,
**Usage & Billing**, and **Updates** panes. Sections depend on your account and
rollout, so some options described below may not appear.

## General

### Account

Sign in or out of the Cursor account used by Grok Bot. The account menu also
has **Get Grok Bot for mobile**, which opens the App Store listing, and
**Support → About** shows the installed Grok Bot version.

When more than one account is saved on the desktop, the account menu includes
**Switch account**. Choose **Add account** to save another. Settings lists
the same accounts; inactive rows include **Remove**.

### Appearance

Choose **Follow System**, **Light**, or **Dark**.

**Accent** colors your 1:1 Bot messages and cards with each Bot's color
(**Bot color**, the default) or keeps them **Black**.

Use **Language** to choose **Follow System** or one of more than 20 app
languages, including English, Spanish, French, German, Japanese, Korean,
Simplified Chinese, and Traditional Chinese. On iPhone and Android the
follow-device option is labeled **System**, and the list is shorter. See
[Grok Bot for Mobile](/grok-bot/mobile).

**Check Spelling While Typing** underlines misspelled words as you type. It's
on by default.

### System

* **Microphone** picks the microphone Grok Bot listens to when you talk to it:
  **System Default** or a specific device.
* **Use hardware acceleration** lets your graphics card draw the app. Turn it
  off if the window flickers or stays blank, then choose **Restart Now**. It's
  on by default on macOS and Windows and off on Linux.

### Bot

Configure shared and local Bot behavior:

* **Timezone**, which routines use for schedules
* Your Auto-review switch and **Custom Rules**

Grok Bot manages model selection, so there is no model picker.

### Import

**Import Memory to Grok Bot** brings your preferences and context over from
another AI assistant. Choose **Start Import**, copy the prompt into a chat with
your other assistant, paste its answer into the second box, and choose
**Add to Memory**. Grok Bot sends the import to your primary Bot and opens that
chat. See [What a Bot remembers](/grok-bot/bots#what-a-bot-remembers).

### Auto-review

Manage your personal Auto-review rules, plus any team rules your admin
requires.

Auto-review rules shape which actions stop for your approval. When your
admin enforces Auto-review for the team, the same table also shows locked team
rules with `Required by your admin. You can't edit or delete this rule.` You
can add your own rules on top, but they only make behavior stricter; **Ask
first** wins when rules conflict. If your admin turns enforcement off, the
locked team rules go away and your own rules apply, unless your team shares
Auto-review instructions from the Cursor dashboard; then those apply to your
Bots instead of your own rules, and the section says so. Your personal rules
are saved to your account, so the same rules apply on every desktop and on
iPhone. Read [Approvals and Auto Review](/grok-bot/security#approvals-and-auto-review)
before changing them.

## Computer

**Computer** has two sections. **Your computer** holds settings for the
desktops signed in to your account. **Bot's computer** holds the update and
reset controls for the cloud computer your Bots share; see
[Update or reset Bot's computer](#update-or-reset-bots-computer).

**Manage devices** lists the computers and phones where you use Grok Bot. You
can rename any of them there, change another computer's execution setting, or
remove another computer while it's offline. Phones can't be removed.

### Run commands on your desktop

**Execution on this computer** controls whether Bots can run commands on a
desktop. Each listed desktop under **Your computer** has its own setting. Until
a desktop is listed, the page shows **Execution on Local Computer** instead.
Per-command approval is the default, and the setting applies to that desktop
alone. Read [Approvals and Auto Review](/grok-bot/security#approvals-and-auto-review)
before changing it. For what local execution can reach, see
[Control access to your local computer](/grok-bot/approvals-security-and-privacy#control-access-to-your-local-computer).

### Route traffic through your desktop

Under **Your computer**, turn on **Route traffic through this computer** to
send your Grok Bot computer's web traffic through the current desktop. The route
applies to new connections, and destinations see your desktop's IP address.
Sites that resolve to a private or VPN address are blocked unless your
organization has allowed them, and the setting shows how many it blocked this
session. Only one of your computers routes at a time; if another one is
routing, send a message from this computer to route through it instead. If the
setting asks you to **Update Bot's computer**, do that first.

The setting applies to one desktop. If your Enterprise admin turns off **Allow
Local Egress Routing**, the toggle turns off and locks. The setting reads
`Your team admin has turned off local traffic routing. Grok Bot's computer routes traffic through the cloud.`
and the switch shows `Disabled by your admin. You can't turn this on.` Any
active route stops within five minutes. Your choice is preserved and takes
effect again if the admin re-allows local egress.

For private network options and their tradeoffs, see
[Connect to private networks](/grok-bot/private-networks).

### Update or reset Bot's computer

Under **Bot's computer**, **Update Bot's Computer** moves Grok Bot's computer
to the latest version. A software update only refreshes Grok Bot's software and
keeps installed apps. A computer update rebuilds the computer, keeping files
and logins but removing installed apps and packages. The text under **Update
Bot's Computer** says which kind is waiting.

**Reset Bot's Computer** is a last resort. It rebuilds the computer from your
last saved data, the same as **Recover computer**; if the computer can't be
reached to save first, very recent changes don't come back.

See
[Update, recover, or reset the computer](/grok-bot/computer-and-apps#update-recover-or-reset-the-computer)
for the least destructive recovery order.

## Vault

**Vault** holds the logins, cards, and contact info your Bots use to sign in and
check out without seeing the secret values. Use **New item** to add one, select
an item to edit or remove it, and import logins from another password manager
with **New item → Import**. See [Vault and secure sign-in](/grok-bot/vault).

## Connected apps

Apps aren't in settings. Open **Connect apps** in the sidebar to find apps and
packaged skills. Select the connected count next to the title to manage
installed apps and private skills. An installed app may still need browser
authentication, and individual app tools can be enabled or disabled. On the
Teams plan and the Enterprise plan, an admin may restrict which apps members can
use. See [Connect an app](/grok-bot/computer-and-apps#connect-an-app).

## Usage and billing

**Usage & Billing** shows weekly included usage and on-demand usage for eligible
accounts, and the account menu can show **Weekly usage** at a glance. If neither
surface appears, review usage from the Cursor account page or contact your
organization's admin.

For how plans, weekly usage, and on-demand spend work, see
[Plans and billing](https://cursor.com/help/grok-bot/plans).

## Team Setup Scripts

**Team Setup Scripts** is Enterprise only. Admins manage these scripts on the
Grok Bot page of the Cursor dashboard, and they run on every member's computer.
Members don't see them in settings. See
[Team Setup Scripts](/grok-bot/teams-and-enterprises#team-setup-scripts).

## Updates

**Settings → Updates** handles updates to the desktop app. **Grok Bot Updates**
shows the installed version; use **Check for Updates** and **Restart to
Update** to install a new one. To update or reset Grok Bot's computer, see
[Update or reset Bot's computer](#update-or-reset-bots-computer).

**Automatic Updates**, in the same pane, is on by default. When it's on, a
downloaded update installs and the app restarts while you're away: your screen
is locked or the screensaver is on, the computer has been idle for at least 10
minutes, and Grok Bot isn't busy. Turn it off to install only when you choose
**Restart to Update**. Linux `.deb` and `.rpm` installs update through the
system package manager and don't show the switch.

## Per-Bot settings

Click the Bot's name at the top of the chat (**View conversation details**) to
open its details. Click the name or the label to edit it, and click the Bot's
picture to change its avatar. These belong to that Bot alone. Personal Bots
don't have a description; to change what a Bot does, tell it in chat. See
[Edit a Bot](/grok-bot/bots#edit-a-bot).

**Execution on this computer** is set per desktop, and your personal
Auto-review rules are saved to your account.

## Understand attention states

The sidebar distinguishes:

* **Needs attention** for a question, approval, or handoff
* **Unread activity** for a new result
* Working or typing status

Opening a conversation marks its current activity as read. Use the Bot menu to
mark a conversation read or unread manually.

## Control notifications

Turn on **Notifications** for a Bot to get a system or mobile notification when
that Bot finishes or is waiting for you. On the phone, the switch is
in the Bot's profile. On desktop, ask the Bot to turn its notifications on or
off. Group chats do not have the same per-Bot notification switch.

While you use the desktop app on macOS or Windows, notifications from Bots you
own go to the desktop instead of your phone. The app counts as in use while it
is open and signed in, the screen is unlocked, you have used the computer
recently, and your system settings let Grok Bot show banners or alerts. A focused window stays quiet only for the Bot on screen; other Bots
still show a desktop notification. Finished replies skip your phone. When a Bot
needs your input, your phone is notified about 3 minutes later unless you open
that Bot, turn off its **Notifications**, or hide it from your sidebar first.

At other times, and always on Linux, notifications are suppressed while Grok
Bot is focused, and your phone is notified as usual. The sidebar and dock badge
still show unread activity.

The iPhone and Android apps also ask for notification permission during first
run. Both device permission and the Bot's notification setting must allow the
notification. On iPhone, push delivery is rolling out gradually.

## Handle in-app errors

Errors appear above the composer under **Notifications**. You can dismiss one
notice or clear the list. Some notices include **Copy request ID** for support;
copy and share the complete ID with
[support](/grok-bot/troubleshooting#before-contacting-support).

Clearing a notice removes the notification, not the underlying external action
or Bot history.

## Related pages

* [Keyboard shortcuts](/grok-bot/chat-and-collaboration#keyboard-shortcuts)
* [Use the computer and apps](/grok-bot/computer-and-apps)
* [Approvals, security, and privacy](/grok-bot/approvals-security-and-privacy)
* [Grok Bot for teams and enterprises](/grok-bot/teams-and-enterprises)
* [Grok Bot security](/grok-bot/security)
* [Plans and billing](https://cursor.com/help/grok-bot/plans)
* [Delete your Grok Bot account](https://cursor.com/help/grok-bot/delete-account)
* [Remove access and working data](/grok-bot/approvals-security-and-privacy#remove-access-and-working-data)
