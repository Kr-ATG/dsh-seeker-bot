#### Start

# Use Cases

The best Bot roles own a repeatable outcome, not a loose category of questions.
Start each role with read-and-prepare work, review the result, and only then add
approved actions or a [routine](/grok-bot/skills-routines-and-automations).

Every starter prompt below ends at a review point on purpose. Keep sending,
publishing, purchasing, and production changes behind
[approval](/grok-bot/security#approvals-and-auto-review).

## Sales outbound

Owns account research, contact prioritization, and review-ready outreach.
Connect your CRM, product-intent sources, and email.

> Research the 25 accounts in this CRM view. Score them against our ideal
> customer profile and recent intent, identify up to three relevant contacts
> per account, and draft email and LinkedIn outreach in the style examples
> attached. Skip anyone already in an active sequence. Return a review list;
> do not send or enroll anyone.

Once the output is reliable, schedule a nightly research routine that stops at
the review list.

## Talent scout

Owns sourcing, candidate research, and outreach drafts. Connect your applicant
tracking system, approved sourcing tools, email, and calendar.

> For this role description, find 20 candidates who meet the must-have
> criteria. Exclude anyone already in our ATS, explain the evidence for each
> match, and draft personalized outreach in my voice. Do not contact anyone.

Keep external outreach behind approval, and have the Bot respect candidate
privacy and each source's terms.

## Paid media

Owns campaign monitoring and budget recommendations. Connect your advertising
platforms, analytics, budget spreadsheet, and Slack.

> Pull current spend and performance by campaign. Compare it with the monthly
> budget and target customer acquisition cost, then recommend reallocations
> with the supporting numbers. Draft a Slack update for the growth team. Do not
> change budgets or send the message.

Keep campaign changes behind approval even after the analysis becomes a
routine.

## Expense manager

Owns weekly expense reconciliation and missing-information follow-up. Connect
your expense system, email, and finance spreadsheets.

> Build this week's expense summary from the expense system and the attached
> policy. Match receipts from the finance inbox, flag missing categories or
> policy exceptions, and draft one follow-up per owner. Return the summary and
> drafts; do not send messages or change reimbursements.

Ask for a policy citation on every exception and totals that reconcile back to
the source.

## Product performance

Owns targeted performance investigations with evidence. Connect observability,
analytics, and incident tooling.

> Investigate the checkout latency increase since yesterday's release. Review
> dashboards and traces, identify the highest-confidence hotspot, and return a
> short write-up with screenshots and direct links. Separate facts from
> hypotheses. Do not change alerts or production settings.

Use a routine for a recurring health report, not for unsupervised production
changes.

## Bug reproduction

Owns turning reports into reliable reproduction packs. Connect your issue
tracker and a staging environment.

> Read this bug report and reproduce it in staging with a fresh test account.
> Return exact steps, expected and actual behavior, screenshots, browser and OS
> details, and a minimal test case if possible. Do not use production customer
> data.

Provide test credentials through a
[secure handoff](/grok-bot/computer-and-apps#take-over-for-a-sensitive-step),
not chat.

## Account health

Owns risk and expansion signals across a customer portfolio. Connect your CRM,
product usage, support, and billing sources.

> Review the accounts in this portfolio. Combine recent usage, support
> escalations, renewal timing, and stakeholder activity into a ranked watch
> list. For each account, include the evidence, why it matters, and a suggested
> next step. Do not contact customers or edit the CRM.

Define risk thresholds in the Bot's description so the weekly result stays
consistent.

## Chief of staff

Owns a source-linked digest of what changed and what needs your attention.
Connect Slack, email, calendar, and your planning documents.

> Review activity since yesterday across my approved channels, inbox, calendar,
> and meeting notes. Return only items that map to the priorities in this
> document. For each item, include the source, why it matters, the proposed next
> step, and whether I owe a decision. Do not send messages or change meetings.

Mark what was useful and what was noise, then schedule the digest for a time you
can review it.

## Turn a role into a durable Bot

1. Put the job, source systems, output format, and standing boundaries in the
   [Bot's description](/grok-bot/bots#edit-a-bot).
2. Run one real task with a safe scope.
3. Correct the result until it's reviewable without you.
4. Save the working process as a
   [skill](/grok-bot/skills-routines-and-automations#save-a-skill), and test it
   on a second input.
5. Create a
   [routine](/grok-bot/skills-routines-and-automations#create-a-routine) only
   after retries and failure cases are defined.
6. Keep consequential external actions behind approval.

## Related pages

* [Get started with Grok Bot](/grok-bot/get-started)
* [Work with Grok Bot](/grok-bot/bots)
* [Grok Bot for Teams and Enterprise](/grok-bot/teams-and-enterprises)
