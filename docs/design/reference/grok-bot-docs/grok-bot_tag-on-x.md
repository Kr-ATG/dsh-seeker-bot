#### Work with Grok Bot

# Tag @bot on X

Tag [@bot](https://x.com/bot) in a post or reply on X to hand that post to your
Grok Bot as a task. For example, reply to a thread with:

> @bot summarize this thread and send the key points to my Slack

@bot answers on X with a short reply confirming that your Grok Bot has the
request, and your main Bot starts working on its cloud computer. The work and
its results stay in that Bot's conversation in the Grok Bot app; @bot posts only
the confirmation on X.

Your Bot receives your post, the post you replied to, and any post either of
them quotes, including still photos. The first time a request goes through, X
sends you a notification that tagged requests start work automatically and use
your Grok Bot usage.

## Before you start

You need:

* A Grok account with your X account connected. On grok.com, open
  **Settings → Account** and choose **Connect** next to **𝕏 Account**.
* Grok Bot access on that same Grok account. Download the app from
  [x.ai/bot](https://x.ai/bot); if your access comes from a SuperGrok
  subscription, link it as described in
  [Get started](/grok-bot/get-started#2-sign-in).
* At least one Bot of your own. Bots that someone shares with you can't take
  tagged requests.
* An X account based in a region where tagging is available.

The X for Grok Bot plugin is optional. It lets your Bot search posts, read
timelines, check mentions, and use trends and bookmarks, and @bot forwards
requests with or without it. For X's own explanation of @bot, see
[About @bot](https://help.x.com/en/using-x/about-bot) in the X Help Center.

## Where tagging is available

Tagging @bot works for X accounts based in most countries. It is not yet
available for accounts based in Australia, the United Kingdom, the European
Union, Iceland, Liechtenstein, or Norway.

@bot goes by the country X has on record for your account, so your current
location and any VPN have no effect. If X lists only a broader region for your
account, such as "South Asia," or no country at all, tagging is not available
yet either. In all of these cases @bot does not reply.

## What @bot's reply means

| @bot replies | What it means | What to do |
| --- | --- | --- |
| A short line saying it sent your request to your Grok Bot | Your main Bot has the task. | Open Grok Bot to follow the work and review the result. |
| "Sign up for Grok Bot: https://x.ai/bot" | No Grok account is connected to the X account you posted from. | Connect your X account on grok.com, set up Grok Bot, and tag @bot again. |
| "Grok Bot isn't set up yet. Open https://x.ai/bot" | Your accounts are connected, but you don't have a Bot of your own yet. | Open Grok Bot, create a Bot, and tag @bot again. |

## When @bot stays quiet

If @bot doesn't reply, your Bot didn't get the request. Common causes:

* Your X account is in a region where
  [tagging isn't available yet](#where-tagging-is-available).
* You replied in a thread that already includes @bot, but didn't tag @bot
  yourself.
* The post also tags @grok.
* The post, the post it replies to, or a quoted post has a video or GIF.
* The post doesn't pass internal moderation.
* Grok Bot isn't linked to your Grok account, or your weekly usage is used up.
