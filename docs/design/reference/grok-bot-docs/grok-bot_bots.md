#### Work with Grok Bot

# Create and manage Bots

A Bot is a durable AI teammate with a name, a job, its own conversation, and
working context that develops over time.

## Give each Bot a clear job

Create a separate Bot when the work has a distinct:

* Goal or area of ownership
* Set of tools and sources
* Working style
* Approval boundary
* Recurring schedule

Jobs like **Talent Scout**, **Expense Manager**, and **Bug Reproduction** give a
Bot guidance and make its saved context reusable; a **General Helper** does
neither.

Describe the role in operational terms:

> Own the weekly account-health review. Pull product usage and support signals,
> flag evidence of churn or expansion, and produce a linked watch list for the
> customer-success team. Never contact a customer or change an account without
> approval.

## Create a Bot

1. Choose **New Bot** (the **+** button) at the top of the sidebar, or press
   `Cmd/Ctrl+N`. On a team, the **+** button opens a menu; choose **Create a
   Bot**.
2. In **Create New Bot**, type a name, pick a shape and color for its picture,
   and choose **Create**.
3. Grok Bot opens a chat with the new Bot.
4. In your first message, give the Bot its job, sources, and approval
   boundaries, and ask it to remember them. Send a real first task with a
   clear finish line; see [use cases](/grok-bot/use-cases) for starter prompts.
5. To rename the Bot, add a label, or change its picture, click the Bot's name
   at the top of the chat to open its details. See [Change a Bot's name,
   picture, and label](#change-a-bots-name-picture-and-label).

Your existing Bots can also suggest or create a focused Bot when a job should
have a long-lived owner. Ask before creating several Bots if you want to keep
the roster small.

## Your primary Bot

Your primary Bot is your main point of contact. It checks in with you on its
own and coordinates work with your other Bots.

If you don't have a primary Bot, Grok Bot shows **Introducing your primary
Bot**. Choose **Create primary Bot** to add one, or choose **Choose an existing
Bot**, select one of your Bots, and choose **Confirm**.

To pick a different one later, right-click your primary Bot in the sidebar and
choose **Replace with different Bot**. On iPhone and Android, use **Replace
Primary Bot…** in the Bot's menu. A [shared Bot](/grok-bot/shared-bots) can't
be your primary Bot.

## Edit a Bot

When you discover a durable preference, boundary, or responsibility that should
shape future work, tell the Bot and ask it to remember. Use ordinary messages
for task-specific instructions:

* **Lasting rule:** “From now on, never send external messages without
  approval.”
* **Task:** “Draft follow-ups for these twelve accounts.”

The Bot keeps lasting rules in its memory. Personal Bots no longer have a
description or a **Bot settings** page; to change what a Bot does, tell it in
chat. A [shared Bot](/grok-bot/shared-bots) still has a description, which its
owner or a Manager edits under **About** in the Bot's details.

### Change a Bot's name, picture, and label

Each Bot has its own name, picture, and label. Only the Bot's owner can change
these; **Rename Bot** does not appear for a Bot you don't own.

To rename a Bot on desktop, right-click it in the sidebar and choose **Rename
Bot**, or double-click its name in the sidebar. Type the new name and press
Enter. If the sidebar is collapsed to icons, expand it first. You can also click
the Bot's name at the top of the chat to open its details, then click the name
to edit it. The label under the name works the same way; it shows **Add a
label** when the Bot doesn't have one.

To change the picture on desktop, open the Bot's details and click its picture,
then choose a tab:

* **Bot** changes the look of the Bot's character.
* **Generate** makes a picture from a short description. Describe the picture,
  choose **Generate**, then choose **Set avatar**.
* **Upload** uses your own image. Drag in an image or choose **Browse files**,
  adjust it, then choose **Set avatar**. The image must be smaller than 25 MB.

On the phone, tap the Bot's name at the top of the chat to open its profile and
tap **Edit**. Change the **Name** or the **Title** (the phone's name for the
label) and tap **Done**. To change the picture, tap the picture or **Avatar**
and choose **Shape**, **Generate**, or **Upload**. **Upload** offers **Choose
from Photos** or **Take Photo**, then lets you crop the image; images can be up
to 25 MB.

## Organize your roster

* **Pin** active Bots to keep them at the top of the sidebar.
* Group Bots by project, client, or business with sections: right-click a Bot
  and choose **Move to new section**, or **Move to** once you have sections.
  Sections sync between desktop and iOS.
* **Hide from sidebar** removes a Bot from the main list without deleting its
  work or pausing its routines. Hidden Bots stay active and keep their history.
* To restore a hidden Bot, open **Hidden Bots** at the bottom of the sidebar and
  choose **Show in sidebar** from the Bot's menu. On iPhone and Android, choose
  **Unhide** in the hidden Bots list; when every Bot is hidden, the home screen
  shows **Show Hidden Bots**.

On iPhone, **Duplicate** a Bot to reuse a role for a different scope, like one
account-health Bot per region. The copy carries the profile, settings, enabled
skills, routines, and avatar, but not conversation history, learned memory, or
attachments, so rename it and give it the new scope before assigning work.

## Share a Bot

Share a template when someone else should start from the same Bot.

1. Click the Bot's name at the top of the chat to open its details, choose
   **Share**, then choose **Create a copy**. The Bot builds a template and posts
   it in the chat.
2. Choose **Publish** on the template card, then **Copy link**.
3. Send the link. The recipient opens a preview on [x.ai](https://x.ai) and can
   choose **Add to Grok Bot**. They need the Grok Bot app to finish adding it.

On iPhone and Android, open the Bot's menu and choose **Share as Template**.

After you publish, the same **Share** menu offers **View template details**,
**Update template** to push your latest changes to the shared copy, and
**Delete Template** to turn off the link.

A new template link is public. If your team allows only team-only sharing or
has turned template sharing off, the app doesn't offer **Create a copy**, and
publishing a template shows `Your team doesn't allow public templates` or
`Template sharing is turned off`. Enterprise teams start with template sharing
limited to the team; an admin can change it under
[Public template sharing](/grok-bot/teams-and-enterprises#public-template-sharing).

A public link can be opened by anyone who has it and exposes the Bot's shared
configuration: its identity, description, skills, and routines. A team-only
link opens only for members of your team. Remove API keys, internal URLs,
customer data, and anything else you would not put in a public document before
you share.

Adding a shared template creates a copy on the recipient's account. They never
get your computer, logins, or conversation history. To give your team one Bot
to chat with instead of a copy each, [share the Bot
itself](/grok-bot/shared-bots).

Shared templates are created by other users, not by Grok Bot. Adding one
accepts the [third-party bot terms](https://x.ai/legal/bot-sharing-terms) shown
at that point.

On the Teams plan and the Enterprise plan, admins control whether members can
publish Bot templates publicly. See [Public template
sharing](/grok-bot/teams-and-enterprises#public-template-sharing).

## Add a Bot from a template

To browse Bot templates, open **Connect apps** in the sidebar and choose
**Bot templates**. The gallery opens on x.ai in your browser. Open a template
link and choose **Import Bot** to add your own copy of that Bot.

## Delete a Bot

To delete a Bot, right-click it in the sidebar and choose **Delete**. This
erases its profile, conversations, memory, routines, and attachments, including
the shared facts it saved for your other Bots. It can't be undone. Files and
sign-ins on the shared computer aren't isolated per Bot and can remain there;
clean them up separately. Backend retention follows the applicable Cursor terms.

If you may need the work later, or want to keep the Bot's memory, choose **Hide
from sidebar** instead.

## What a Bot remembers

A Bot retains stable preferences, important facts, and summaries from its work,
which lets it keep a role over time without replaying every prior message. It
saves lasting things, such as:

* How you like to work, and your preferences
* Rules you ask it to keep, like “Always ask before you send an email.”
* Facts about you, like your name and time zone
* A dated log of what it has worked on with you

Logins, cards, and contact info, like addresses and phone numbers, belong in
[Vault](/grok-bot/vault), not in memory.

### When a Bot saves something

A Bot decides on its own when something is worth keeping. It doesn't ask first.
It often mentions a save in its reply, but not every save shows up in the chat.
To make sure it keeps something, ask it to remember, for example: “Remember that
I'm out every Friday.”

### Across chats, Bots, and calls

What a Bot saves in one chat, it remembers in all your chats with it. Each Bot
has its own memory, but a few facts about you, such as your name and time zone,
are shared by all your Bots. When one Bot learns one of these, your other Bots
know it too.

In a [voice chat](/grok-bot/chat-and-collaboration#start-a-voice-chat), a Bot
can draw on your earlier calls and your recent chat with it. After you hang up,
you can ask it about the call in chat.

In a [group chat](/grok-bot/chat-and-collaboration#start-a-group-chat), your
Bot can use what you told it in your private chat. If something should stay out
of a group chat, tell your Bot. Each Bot in a group keeps its own memory; your
Bot's memory isn't shared with the other Bots there, but everyone in the group
can read what your Bot says.

### See, correct, or remove a memory

There is no memory screen for a personal Bot. Ask in chat instead:

* To see it: “What do you remember about me?”
* To correct it: “That's out of date. I moved to Denver.”
* To remove it: “Forget that I'm on the launch team.”

If a fact that all your Bots share is wrong, tell any of your Bots the right
version. To remove a shared fact completely, ask the Bot that saved it.

### What resets or deletes memory

| What you do          | What happens to memory            |
| -------------------- | --------------------------------- |
| Reset a conversation | Memory is kept.                   |
| Delete a Bot         | That Bot's memory is deleted.     |
| Delete your account  | All your Bots' memory is deleted. |

When a message is blocked, the notice can offer **Reset**. If you choose it, you
see **Reset this conversation?** The conversation history starts over, and the
Bot's memory, files, routines, and settings are kept.

### Who can see or change memory

A personal Bot's memory is yours, and only you can change it. A [shared
Bot](/grok-bot/shared-bots) can save things it learns for the whole team, and
it tells you when it does. It doesn't save anything about you personally for
the team; what it remembers about working with you stays between you and the
Bot. A teammate's shared Bot doesn't get the facts your own Bots share about
you.

### Import memory from another assistant

To bring over what another AI assistant knows about you, open Settings →
**General** and choose **Start Import** under **Import**. Copy the prompt into
a chat with your other assistant, paste its answer into the second box, and
choose **Add to Memory**. Grok Bot sends it to your
[primary Bot](#your-primary-bot) and opens that chat.

### Memory is not a source of truth

Memory is not a substitute for an authoritative source:

* Keep changing facts in the source system
* Ask the Bot to cite or reopen current data for consequential decisions
* Correct stale assumptions directly
* Back safety boundaries with approvals and
  [Auto-review rules](/grok-bot/security#approvals-and-auto-review) rather
  than memory alone

Bots have separate roles and conversations, but they share the computer. They
can pass context through direct messages, group chats, and shared files.

## Organize a team of Bots

Start with the smallest useful roster:

1. Give one Bot ownership of an end-to-end outcome.
2. Add another Bot only when the work has a stable specialist role.
3. Put Bots in a [group chat](/grok-bot/chat-and-collaboration) when the handoff itself
   needs to be visible.
4. Keep external actions behind a clear approval boundary.

For example, a Website Launch group might include a launch coordinator, a
content editor, and an analytics reviewer. The coordinator can assign work,
while the group preserves the handoffs in one conversation.
