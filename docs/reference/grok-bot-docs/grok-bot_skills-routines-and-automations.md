#### Work with Grok Bot

# Skills and routines

Turn a successful task into a repeatable process. Grok Bot uses two building
blocks:

* A **skill** is a reusable set of instructions for how to do a task.
* A **routine** tells one Bot when to run a workflow: on a schedule, or when
  something happens, such as a Slack message, a GitHub, Linear, Sentry, or
  PagerDuty event, an email, or a webhook call.

Start with a one-time task. Make it reliable, save the method as a skill, and
only then automate it.

## Save a skill

A skill captures steps, decision rules, expected output, and safety boundaries.
Skills are available across your Bots, although a Bot may need the relevant
app or login to use one.

Ask:

> Save the process we just used as a skill called “Weekly account health.”
> Include the source systems, risk definitions, output format, and the rule that
> customer contact always requires approval.

A useful skill states:

1. When to use it
2. Required inputs and access
3. The sequence of work
4. How to validate the result
5. What to return
6. What requires approval

Use **Connect apps** in the sidebar to discover and install supported apps and
packaged skills. To use a skill, ask the Bot for it by name; use `@` for Bots,
groups, routines, and apps.

Private skills are one library shared by all your Bots. If the Bot can't find a
private skill, open **Connect apps** in the sidebar, select the connected count
next to the title, and enable it for the current Bot under **Private skills**.

### Share a skill with your team

If you belong to a team, you can publish a private skill so your teammates can
use it. On desktop, open **Connect apps**, select the connected count next to
the title, and open the skill. Choose **Publish** in its header. If you belong
to more than one team, choose the team under **Publish to**.

A skill needs a description before you can publish it, because teammates and
their Bots use the description to decide when it applies. After you publish,
the button reads **Published**. Its menu offers **Sync** to push your later edits
to the team's copy, **Copy link**, and **Unpublish**.

If publishing is refused, the message says why: you need to join a team first,
or your team admin has turned off publishing for members, in which case ask an
admin to publish the skill. Skills that came with the app or with a Bot's
template can't be published.

## Teach a workflow by demonstration

When **Teach a task** is available, you can demonstrate a browser workflow
instead of describing every step.

1. Open a one-to-one Bot conversation and its computer view.
2. Choose **Teach a task**.
3. Describe the result you are about to demonstrate.
4. Perform the workflow once.
5. Stop the recording and review the skill the Bot creates.
6. Test it on a safe example before scheduling it.

Teaching records visible computer interaction for up to ten minutes. It does
not record microphone audio. Avoid exposing secrets during the demonstration;
use the secure handoff flow for credentials.

The learned skill is a draft. Add decision rules, failure handling, and
approval boundaries that may not be obvious from one example.

Teach-by-demonstration may be enabled gradually. If the control is not visible,
ask the Bot to create a skill from written instructions and the completed task.

## Create a routine

Ask the Bot that should own the recurring job:

> Every weekday at 8:00 AM, run the Daily customer-risk skill against the
> current account list. Post a linked watch list in this conversation. Do not
> contact customers. If the source data is unavailable, report the failure
> instead of using old data.

Confirm:

* The owning Bot
* The schedule and time zone
* The input source
* The expected result
* The approval boundary
* What should happen when a source is missing

The Bot creates the routine, and it appears in the Bot's routines. Routines run
in the cloud while your laptop is closed.

On the phone, you can also open the Bot's profile and tap **Add routine** under
**Routines**. Grok Bot starts a message that begins “Set up a routine to”;
finish the sentence and send it.

### Schedules and time zones

Schedules use the time zone in **Settings**, under **Bot**, labeled
**Timezone**. **Auto-detect** follows this computer. Pick a zone when the
routine should follow a different one, such as the office where the work
belongs.

Ask for a schedule in plain words, like “every weekday at 8:00 AM” or “every 2
hours.” Then open the routine and check **When to run**, which shows the saved
schedule in words. If it doesn't match what you meant, choose **Edit** and tell
the Bot what to fix.

A new routine waits for its next scheduled time; it doesn't run when it's
created. If you set up “every day at 8:00 AM” at 8:05, the first run is
tomorrow at 8:00 AM. To try it right away, use **Test**.

## Trigger work from an event

A routine can start when something happens instead of on a schedule: a Slack
message, a GitHub, Linear, Sentry, or PagerDuty event, an email to your
[Bot's own address](/grok-bot/computer-and-apps#give-your-bots-an-email-address),
or a webhook call. Cursor account integrations start these routines; they're
separate from the Slack or GitHub apps and may need their own connection. Ask
the Bot for the trigger you want; the routine's **When to run** shows it in
words, such as “When a Linear issue is created.” Only new activity counts:
events from before the trigger existed don't start a run.

Define a narrow matching rule and a clear response:

> When a message in `#customer-escalations` contains a support ticket link and
> the phrase “needs repro,” open the ticket, reproduce the issue in staging,
> and post a repro pack in this conversation. Never post back to Slack without
> approval.

Avoid broad listeners such as “every new message.” They create noise, consume
usage, and increase the chance of acting on irrelevant input.

### Slack triggers

A Slack trigger is part of a routine, not the Slack app. The app lets a Bot post
and read as the Slack user you connected; a trigger starts the routine when
something happens in Slack. Connect Slack on the Cursor account that owns the
Bot before you rely on it.

A routine can start when the Bot is mentioned, when a word or phrase is
mentioned, when you react to a message, or on any message. It can watch one
channel or all of Slack, and **When to run** shows the trigger in words, such
as a phrase and a channel. Keep the channel and phrase narrow: a trigger on any
message in a busy channel runs often and spends usage on messages that don't
need the Bot.

### Webhooks

Ask the Bot to add a webhook trigger to the routine, then open the routine on
desktop. The **Webhook** section shows three fields:

* **POST to** is the URL.
* **key** is the secret. Senders include it as `Authorization: Bearer <key>`.
* **header** is that full header, ready to copy.

Click a field to copy it. Send an HTTP POST to that URL with the header and,
optionally, a JSON body; the Bot receives the body with the routine
instruction. A `200` response means Grok Bot accepted the call and started a
run, not that the Bot has finished; check the Bot's chat for the result. Any
other response means a run didn't start, so confirm that the routine isn't
paused and that the request uses the current key.

## Test before enabling

If the routine shows **Test**, use it after creating or editing the routine:
open the routine on desktop and choose **Test**. The button says **Running…**
until the run finishes, and the result shows up in the Bot's chat. If the test
can't start, you see **Couldn't start a test run**, or a message that explains
why.

Some routines don't show **Test**; they still run on their schedule or trigger.
For those, ask the Bot to do the same work once in chat with a safe input before
you rely on the routine, then check the first scheduled run.

> A test run performs real work. It can navigate websites, change files, and
> call connected tools. Use safe inputs and keep write actions behind approval.

Review:

* Whether it selected current inputs
* Whether the output meets the required format
* Whether every action has a source or audit trail
* Whether it stopped at the intended approval point
* Whether failure states are explicit

## Manage routines

Create and change routines by asking the Bot in chat. To review them on
desktop, click the Bot's name at the top of the chat to open its details.
Routines are on the **Details** tab. Each row shows the routine's name and when
it runs, or **Paused**; use the switch on the row to pause or resume it. If the
Bot has no routines, you see **Ask in chat to set a routine**.

Open a routine to read its **Instruction** (what the Bot does on each run) and
**When to run** (the schedule and the events that start it). A routine that a
webhook call starts also shows **Webhook**. The buttons at the bottom are:

* **Pause** or **Resume**
* **Test**, when the routine offers it
* **Edit**, which starts a message to the Bot that begins “Edit your routine:”
  with the routine's name; add what should change and send it
* **Delete routine** (the trash icon), which asks you to confirm

You can also right-click a routine to **Pause** or **Resume** it, **Test** it,
**Edit** it in chat, or **Delete** it.

On the phone, open the Bot's profile and find **Routines**. Tap a routine to see
**Active**, **Schedule**, **Next run**, **Instruction**, and **Run history**.
Turn off **Active** to pause the routine, and swipe the routine's row to delete
it. **Run history** shows each recent run as **Running**, **Succeeded**, or
**Failed**, with the reason for a failed run; **No runs yet** means nothing has
started the routine yet.

A Bot can own up to 50 routines, and the app keeps the 20 most recent run
records for each routine. Routine schedules must be at least five minutes
apart. Deleting a routine stops its future runs and can't be undone. Deleting a
Bot also removes routines owned by that Bot.

### If a routine hasn't run

* The routine isn't **Paused**. On the phone, **Active** is on.
* **When to run** shows the schedule or trigger you expect, in the right time
  zone.
* A new schedule waits for its next time. Use **Test** to run it now.
* For Slack, the message is new, in the channel the trigger watches, and
  matches its phrase.
* For a webhook, the call returned `200` and used the current key.

### Rate limits

Routines have hourly limits: all of your routines together can run up to 300
times an hour, and each routine up to 200 times an hour. A run past either limit
fails with `Automation run rate limit exceeded`. If one routine keeps hitting
its limit, ask the Bot to narrow its trigger or widen its schedule.

Some runs can also fail with this error because of a limit all Grok Bot routines
share, even when your own routines run less than that. This is a known issue
that is being fixed. A run that fails with this error isn't retried
automatically, so rerun the routine yourself: use **Test** to run it now, or for
a webhook, send the call again.

### Routines and usage

Each run spends usage, so a routine that runs often spends more than one that
runs rarely. An hourly schedule, a short interval, or a Slack trigger on a busy
channel can use a week of usage in a day. If your **Weekly usage limit** is
running out faster than you expect, pause routines you don't need, then ask the
Bot to widen schedules and narrow Slack triggers before you raise a plan or an
on-demand limit. A routine that never runs doesn't spend usage; **Test** does,
because it performs the work. See [Plans and
billing](https://cursor.com/help/grok-bot/plans) for weekly usage and the
on-demand monthly limit.

To control unattended usage, Grok Bot may ask whether to keep routines running
after a long period away and pause them if there is no response. Review paused
routines when you return.

## Design routines for trust

* Automate preparation before execution.
* Have the Bot draft, reconcile, or recommend first.
* Require approval for sending, purchasing, deleting, publishing, or changing
  production systems.
* Include a no-data and stale-data policy.
* Make retries idempotent where possible.
* Tell the Bot where to report partial completion.
* Re-test after a website, app, or source format changes.

For more on schedules, Slack triggers, and webhooks, see
[Routines](https://cursor.com/help/grok-bot/routines). See [Settings and notifications](/grok-bot/settings-and-notifications) for time zone
and usage controls, and [Approvals, security, and
privacy](/grok-bot/approvals-security-and-privacy) for automation boundaries.
