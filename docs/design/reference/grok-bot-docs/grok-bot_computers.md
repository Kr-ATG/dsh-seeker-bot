#### Manage and protect

# Manage Grok Bot computers

Each member of your team gets one hosted computer where every Bot they run does
its work. **Manage Member Computers and Data**, under **Security & Compliance**
on the [Grok Bot page of the Cursor dashboard](https://cursor.com/dashboard/bot),
lets admins recreate or terminate computers across many members at once, or
[delete all of a member's Grok Bot data](#delete-all-grok-bot-data).
**Terminate Inactive Computers**, under **Bot Computers**, turns on
[automatic termination](#terminate-inactive-computers-automatically) for members
whose Bots go 30 days without a message. For the rest of the admin controls, see
[Grok Bot for teams and enterprises](/grok-bot/teams-and-enterprises).

**Manage Member Computers and Data is Enterprise only**. Organization admins
and Enterprise team admins can use it. Members never see this control. Team
admins can also
[restart the team's computers after a settings change](#restart-after-a-settings-change).

## Recreate or terminate

Both actions keep the member's durable disk, so their synced Bots, files, and
logins come back on the next computer. Both remove apps and packages members
installed themselves. Anything your Team Setup Scripts install comes back on
the new computer.

| Action | What happens | When to use it |
| --- | --- | --- |
| **Recreate** | Builds a replacement computer on the latest image and runs [Team Setup Scripts](/grok-bot/private-networks). The current computer stays available until the replacement is ready, then Grok Bot switches over. A Bot that is mid-turn pauses at a safe point and resumes on the new computer. If it cannot pause in time, that member's recreate is not started and shows as failed. | Roll out a new image or an updated Team Setup manifest to many members at once. [Network policy](/grok-bot/security#network-policy) changes reach computers without a recreate. |
| **Terminate** | Deletes the member's computer, running or hibernated. Running work stops. The computer does not restart on its own; the member's next message starts a fresh one on the same durable disk. | End a member's current work, or clear a computer that is stuck. Terminating does not remove access; see the [FAQ](#faq). |

## Delete all Grok Bot data

**Delete All Grok Bot Data** permanently deletes a member's Bots,
conversations, memory, routines, and computer across every team they belong to.
That includes shared Bots that teammates use, connected apps, email inboxes,
and files. Their Cursor account stays, and they stay on the team and start
fresh the next time they use Grok Bot.

* **At most 100 members** per operation.
* **It can't be undone.** Each operation is recorded in the
  [Audit Log](https://cursor.com/dashboard/audit-log).

## Run an operation

### Open Manage Member Computers and Data

Go to [Grok Bot in the Cursor dashboard](https://cursor.com/dashboard/bot), find
**Manage Member Computers and Data** under **Security & Compliance**, and select
**Manage**.

### Select members

Search by name or email, then check the members you want. **Select all** picks
everyone in the current results.

### Choose an action

Open **Manage selected** and pick **Recreate VMs** or **Terminate VMs**. A
confirmation screen restates the action and the number of members it affects.
The same menu also offers **Delete VMs and Data**, which removes the computer
and its durable data, and
[Delete All Grok Bot Data](#delete-all-grok-bot-data). Use either only when you
want the member to start from empty. Both delete actions ask you to type
`DELETE` to confirm.

### Confirm

Select **Recreate VMs** or **Terminate VMs** to start. Members without a
computer are skipped.

### Watch the results

A progress card shows queued, running, complete, skipped, and failed counts,
and each member's row shows its status. When the operation finishes, select
**Done** to clear the results and start another.

## How an operation runs

* **It runs on Cursor's side.** Closing the dialog or the browser does not stop
  it. Reopen **Manage** in the same browser to pick the progress back up.
* **Large operations take a while.** Members are processed in batches, and each
  recreate waits for the replacement computer to be ready before it counts as
  complete.
* **One operation per team at a time.** The action buttons stay disabled until
  you select **Done** on the finished results. The limit covers every admin: a
  start made while another operation for the team is still running shows
  **Not Started** and changes nothing. Select **Done**, wait for the running
  operation to finish, then start again.
* **Retry Start never duplicates work.** Use it when the dashboard cannot
  confirm the operation started.
* **A refused start says why.** A start that cannot run, for example because
  none of the selected members are still on the team, shows **Not Started**
  with the reason and changes nothing.

## Run operations through the API

To roll out across many teams from a script, start the same operations with the
Organization API. Organization admins can recreate, terminate, or delete
members' computers, or delete all of their Grok Bot data. You send a team, a
list of members, and an action, then poll the operation for its counts and, for
operations of up to 1,000 members, a result for each member.

The API and the dashboard share the limit of one operation per team. An
operation started from either place blocks the other until it finishes.

The API needs an Organization API key with the `admin:*` scope. For the
endpoints, request fields, and error codes, see
[Grok Bot computers](https://cursor.com/docs/account/organizations/organization-admin-api#grok-bot-computers)
in the Organization API reference.

## Skipped and failed members

A finished operation lists a result for every member you selected.

| Result | Meaning | What to do |
| --- | --- | --- |
| **Skipped**, No VM | The member had no running or hibernated computer. | Nothing. |
| **Skipped**, Action could not be completed | The member left the team or has never signed in, or their account changed while the operation was queued. | Nothing. |
| **Failed**, Another recreation is in progress | The member's computer is already being recreated, by an update or another admin. | Wait for it to finish, then run again for this member. |
| **Failed**, VM scan incomplete | Cursor could not confirm the state of the member's computer, so it made no change. | Run the operation again in a few minutes. |
| **Failed**, Another deletion is in progress | This member's Grok Bot data is already being deleted. | Wait for it to finish. |
| **Failed**, Grok Bot data could not be deleted | The deletion did not finish. | Run the operation again. If it fails twice, [contact support](https://cursor.com/help/grok-bot/get-help). |
| **Failed**, Action could not be completed | The recreate or terminate did not finish. For a recreate, a Bot on the member's computer may have been unable to pause in time, and the member keeps their current computer. | Run the operation again for the affected members, once their Bots are idle if you can. If it fails twice, [contact support](https://cursor.com/help/grok-bot/get-help) with the member's email and the time of the operation. |
| **Failed**, Recreation status unavailable | Cursor could not tell whether a recreate was already running on the member's computer, so it made no change. | Run the operation again in a few minutes. |
| **Failed**, Another computer operation is in progress | Another operation was using the member's computer during **Delete VMs and Data**. | Wait for it to finish, then run again for this member. |
| **Failed**, Computer operation lock unavailable | Cursor could not reserve the member's computer for **Delete VMs and Data**, so it made no change. | Run the operation again. |
| **Failed**, Data in an older format can't be deleted yet | The member's stored data is in an older format, so **Delete VMs and Data** deleted nothing. | [Contact support](https://cursor.com/help/grok-bot/get-help) with the member's email. |
| **Failed**, Durable data could not be deleted | **Delete VMs and Data** removed the computer but not its stored data. | Run **Delete VMs and Data** again for this member. If it fails twice, [contact support](https://cursor.com/help/grok-bot/get-help). |

## Restart after a settings change

After some changes to team settings, the Grok Bot page shows **Restart VMs to
apply changed settings** at the top. Select **Restart all VMs**, then
**Recreate VMs**, to recreate the computer of every member of the team with the
current team settings. The restart runs like any other recreate operation, with
the same progress card and results, and the notice clears once it starts.

Team admins on an Enterprise team can run this restart, not only organization
admins. It only recreates; **Terminate VMs** and **Delete VMs and Data** are
under **Manage Member Computers and Data**.

## Terminate inactive computers automatically

A hibernated computer stays around until someone terminates it, even when the
member has moved on or stopped using Grok Bot. **Terminate Inactive
Computers**, under **Bot Computers** on the same dashboard page, does that
cleanup for you. When nobody has sent a message to any of a member's Bots for
30 days, Cursor terminates their computer the next time it is asleep. Messages
count from the app or Slack, whether the member or a teammate sends them.
Routines and other work a Bot starts on its own don't count, so a Bot that
keeps running routines doesn't keep its computer around. Sending a message
restarts the count.

The setting is off by default. Turning it on opens a confirmation. Two things
to know before you select **Turn On**:

* **Members already past 30 days are included.** There is no grace period.
  Cursor checks hibernated computers on a rolling schedule, so termination
  lands in the days after the 30-day mark rather than at the exact moment.
* **Members lose nothing and do nothing.** An automatic terminate works like a
  manual one. The durable disk stays, and the member's next message starts a
  fresh computer with their Bots, files, and logins in place. Apps and packages
  they installed themselves are removed, and Team Setup Scripts run again.

Turning the setting off stops further terminations. One computer spans every
team a member belongs to, so the setting applies to a member's computer if any
of their Enterprise teams has it on.

## What members see

During a recreate, the desktop app shows **Updating Grok Bot's Computer** until
the switch completes. Bots that were working pause at a safe point and continue
on the new computer. Sign-in sessions inside the computer can drop when it is
recreated, so members sign in to company tools again under your identity
provider's policies.

After a terminate, manual or automatic, the member's next message starts a
fresh computer on their durable disk. The reconnect can take a few minutes.
Bots, files, and logins that had synced come back; a turn that was running is
lost.

## FAQ

### Can I recreate a member's computer from a different team?

Yes. Select the member from any team they belong to. One computer serves every
team the member is in, so recreating or terminating it from one team affects
the same computer everywhere.

### Does terminating stop a member from using Grok Bot?

No. Terminating a computer, by hand or automatically, ends the member's current
work. Their next message starts a fresh computer on the same durable disk, with
their Bots, files, and logins. To remove access, remove the member from the
team or turn off their access with **Manage Group Access**, and revoke their
sessions in your identity provider. See
[Enable Grok Bot](/grok-bot/teams-and-enterprises#enable-grok-bot).

### Can automatic termination interrupt a Bot that is still working?

No. Cursor only terminates a computer that is asleep. A computer that is awake,
because a Bot is working or the member is using Grok Bot, is never terminated by
this setting, even when the member's Bots have gone 30 days without a message.

## Related pages

* [Grok Bot for teams and enterprises](/grok-bot/teams-and-enterprises)
* [Grok Bot security](/grok-bot/security)
* [Connect to private networks](/grok-bot/private-networks)
* [Update, recover, or reset the computer](/grok-bot/computer-and-apps#update-recover-or-reset-the-computer)
* [Grok Bot computer](https://cursor.com/help/grok-bot/computer-recovery)
