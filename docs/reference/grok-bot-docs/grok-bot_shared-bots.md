#### Work with Grok Bot

# Shared Bots

A Bot is either personal or shared. Share a Bot with your Cursor team the way
you'd share a doc: with everyone on the team, or only with certain people and
groups. Sharing doesn't make a copy, and each person's chat with a shared Bot is
private.

Shared Bots always run in the cloud. A Bot that runs on your own computer can't
be shared.

## Who can use shared Bots?

Shared Bots are for members of a Cursor team who have Grok Bot. Choose **+** in
the sidebar to see **Create a Bot** and **Browse shared Bots**. If **Browse
shared Bots** isn't there, you aren't on a Cursor team, or your Grok Bot app
needs an update.

## How do I create a Bot for my team?

1. Choose **+** in the sidebar, then **Create a Bot**, and give it a name.
2. Tell the Bot what it should help the team with. A sentence is enough.
3. Follow its setup steps for apps, secrets, skills, and files. Only add keys
   and files you're happy for everyone you share it with to use.
4. Share it. See [How do I share a Bot with my
   team?](#how-do-i-share-a-bot-with-my-team)

You can also share a Bot you already have. Sharing doesn't duplicate it. Before
you share, check its apps, secrets, skills, and files, since they work in every
teammate's chat.

## How do I share a Bot with my team?

Click the Bot's name at the top of the chat and choose **Share**. In **Share
this Bot**:

* Under **Who has access**, choose your team to share the Bot with everyone on
  the team, or **People you invite** to share it only with the people and
  groups you add. Limiting it asks you to confirm with **Limit access**. The
  owner and Managers can always use the Bot.
* Choose **Add people or groups** to add someone. Under **Add as**, pick
  **Collaborator** to let them chat with the Bot, or **Manager** to let them
  also change how it works: its instructions, skills, memory, and apps.

To stop sharing, open **Share** again and remove access.

## How do teammates find a shared Bot?

* Choose **+** in the sidebar, then **Browse shared Bots**. The list shows Bots
  shared with you, and each one shows who made it. Choose **Add** to keep a Bot
  in your sidebar.
* On your phone, tap **+**, then **Browse shared Bots**.
* Open a link a teammate sent you, then choose **Start a chat**.

A shared Bot's link opens the same Bot for everyone. It's different from
[sharing a Bot template](/grok-bot/bots#share-a-bot), which gives each person
their own copy.

## Can the owner see my chats with a shared Bot?

No. Each person's chat with a shared Bot is private. The owner and Managers
can't read your chats, and you can't read the owner's or anyone else's.

The Bot can save things it learns for the whole team, and it tells you when it
does. It doesn't save anything about you personally for the team. What it
remembers about working with you stays between you and the Bot.

## Whose apps and secrets does a shared Bot use?

A shared Bot uses the apps and secrets its owner added. Those work the same for
everyone who chats with it.

In your own chat with a shared Bot, it can also use your apps. It asks before it
uses one of your personal accounts. The card says **Allow**, then the app name:

* **Allow once** lets it use that account this time.
* **Always allow** remembers your answer. Its menu has **Always allow for your
  messages to this Bot** and **Always allow for your messages to every Shared
  Bot**.
* **Skip** means it doesn't use that account this time.

In Slack channels, threads, and group chats, a shared Bot uses only its owner's
apps, and asks before it uses your accounts.

A connected account always acts as the person the Bot is answering. One
teammate's connection is never used for someone else.

To make every shared Bot ask again, open **Settings** > **General** > **Shared
Bots** and choose **Clear** next to **Clear connector preferences**.

## Which computer does a shared Bot use?

In your own chat with a teammate's shared Bot, the Bot usually works on your
Grok Bot computer. That means it can use the files there and the sites you're
signed in to there. Sometimes it uses a separate computer just for that
conversation, for example when your privacy mode is stricter than the owner's.

When you DM a shared Bot in Slack, it also works on your own computer. In Slack
channels, threads, group DMs, and group chats, a shared Bot uses one shared
computer of its own.

## Whose usage pays for a shared Bot chat?

A shared Bot reply uses the Grok Bot usage of the person it's answering. That's
true in your own chat, in Slack, and in group chats. Your own limits apply. The
owner's usage pays for the owner's own messages, and for Slack posts from apps
or workflows that aren't linked to a Cursor account. See [How much does Grok Bot
cost?](/grok-bot/faq#how-much-does-grok-bot-cost)

## How do approvals work on a shared Bot?

A shared Bot asks the person it's answering before risky actions.

* In your own chat with a shared Bot, you answer its approval cards.
* In a Slack thread, the Bot posts a **Review an action** card with **Allow
  once**, **Deny**, and **View details**. Only the person who asked can answer
  it.
* In a group chat, only the person whose message the Bot is answering can
  answer.

It also asks before it uses your personal accounts. See [Whose apps and secrets
does a shared Bot use?](#whose-apps-and-secrets-does-a-shared-bot-use) For the
rest of the approval model, see [Approvals, security, and
privacy](/grok-bot/approvals-security-and-privacy).

## How do I add a shared Bot to Slack?

The owner or a Manager adds it, after sharing:

1. Click the Bot's name at the top of the chat.
2. Find **Bring to your team's Slack** and choose **Connect**.
3. If it says **Awaiting admin approval**, a Slack workspace admin needs to
   approve the app.

Once it says **Connected**, teammates can message the Bot directly or mention it
in channels.

In a channel thread or a DM, the shared Bot acts for the teammate who mentioned
it. It can hand work to that person's own Bots, and their replies are posted
back into the same thread. A personal Bot doesn't hand work to other Bots from a
channel thread. See [Let Bots hand work
off](/grok-bot/chat-and-collaboration#let-bots-hand-work-off).

Bots record who asked for each message they post in Slack, so anyone in the
thread can ask the Bot who requested it. When a shared Bot's routine replies in a
Slack thread, the Bot follows that thread and answers later replies without an
@mention.

Each teammate needs to link their Slack account first. Open **Settings** >
**General** > **Shared Bots** and choose **Link**. If you message the Bot before
you link, it replies with steps to link your account.

## How do I edit or delete a shared Bot?

The owner and the Bot's Managers can change a shared Bot. Click the Bot's name
at the top of the chat to open its details, or choose the wrench at the top
right to open **Bot settings**:

* **Plugins** (the Bot's connected apps), **Secrets**, **Skills**, and
  **Files** hold what the Bot uses for everyone.
* Click the name to rename the Bot. Edit the description under **About**.
* **Share** controls who can use the Bot and who manages it.

The owner can also rename the Bot by right-clicking it in the sidebar and
choosing **Rename Bot**.

Only the owner can delete a shared Bot. Right-click the Bot in the sidebar and
choose **Delete**. This deletes the Bot for your whole team. Teammates lose it,
along with their chats and routines on it. It can't be undone.

## How do I remove a shared Bot from my sidebar?

Right-click the Bot and choose **Hide from sidebar**. To add it back, choose
**+** in the sidebar, then **Browse shared Bots**, and choose **Add** next to
it.

If your admin added the Bot to your sidebar for you, **Hide from sidebar** isn't
in its menu, and you can't remove it.

## Can I use shared Bots on my phone?

Yes. Shared Bots you've added appear in the [phone app](/grok-bot/mobile). To
find another, tap **+**, then **Browse shared Bots**. You can chat with shared
Bots and answer their **Allow** cards. A shared Bot can't be your [primary
Bot](/grok-bot/bots#your-primary-bot).

## Can I voice chat with a teammate's shared Bot?

Yes, on desktop. In your own chat with the Bot, choose **Start voice chat**. See
[Start a voice chat](/grok-bot/chat-and-collaboration#start-a-voice-chat).

## Can a shared Bot join a group chat?

Yes. You can add a Bot a teammate shared with you to your own group chat. It
can't share a group with Bots that run on your own computer. See [Start a group
chat](/grok-bot/chat-and-collaboration#start-a-group-chat).

## How do admins manage shared Bots?

On the Grok Bot page of the [Cursor dashboard](https://cursor.com/dashboard/bot),
open **Manage Shared Bots** under **Shared Bots**.

* **Access** shows who can use each shared Bot. Click it to change who can use
  the Bot.
* **Auto-add** puts the Bot in members' sidebars automatically. Pick **All
  team** or one or more groups. Those members can't hide it. Auto-add only
  applies to groups that have access.

See [Grok Bot for teams and
enterprises](/grok-bot/teams-and-enterprises#manage-shared-bots).

## Why can't I see or use a shared Bot?

| What you see | What it means |
| --- | --- |
| **Browse shared Bots** isn't under **+** | You aren't on a Cursor team, or your Grok Bot app needs an update. |
| **Shared Bots Not Available** | Your account doesn't have access to shared Bots. |
| **Bot Not Found** | The Bot may have been removed, or it isn't shared with you. |
| **No Access to This Bot** | The Bot is shared only with certain people. Ask its owner or a Manager for access. |
| A teammate's Bot isn't in **Browse shared Bots** | The owner hasn't shared it with you yet. |
| **Your usage limit has been reached** | Your Grok Bot usage ran out. Your chats with a teammate's shared Bot use your usage. See [How much does Grok Bot cost?](/grok-bot/faq#how-much-does-grok-bot-cost) |
| **This Bot's owner has reached their usage limit** | This reply was billed to the owner's account, and the owner's usage ran out. Ask the owner to check their plan. |
| **This conversation can't run on your computer because your privacy mode is stricter than the bot owner's.** | Your privacy mode setting is stricter than the owner's, so this chat can't use your computer. |
| In Slack, the Bot asks you to link a Cursor account | Link your Slack account under **Settings** > **General** > **Shared Bots**, using the Cursor account on the Bot's team. |

If none of these match, [contact support](/grok-bot/troubleshooting) with the
Bot's name, the exact message, and your Grok Bot version.

## Related pages

* [Create and manage Bots](/grok-bot/bots)
* [Message and collaborate](/grok-bot/chat-and-collaboration)
* [Use the computer and apps](/grok-bot/computer-and-apps)
* [Vault and secure sign-in](/grok-bot/vault)
* [Approvals, security, and privacy](/grok-bot/approvals-security-and-privacy)
* [Grok Bot for teams and enterprises](/grok-bot/teams-and-enterprises)
* [Troubleshooting](/grok-bot/troubleshooting)
