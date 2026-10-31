#### Work with Grok Bot

# Files and results

Attach source material to a request and ask the Bot to return work in a form you
can inspect, edit, and hand off.

## Attach files

Use the attachment control or drag files into the composer. You can also paste
images and links.

Common supported inputs include:

* Images, audio, and video
* PDF and plain-text documents
* Word, Excel, and PowerPoint files
* CSV, JSON, YAML, and source-code files
* HTML and email files
* Jupyter notebooks

In the desktop app, you can attach:

| Limit | Value |
| --- | --- |
| Attachments per message | 20 |
| Images | 25 MB each, 200 MB total per message |
| Documents, audio, and other files | 250 MB each |
| Video | 1 GB each |

If a file is over its limit, the composer says it is too large and leaves it
out; send the rest in another message. Large, encrypted, damaged, or unusual
files may not be readable; export an unusual format as PDF, CSV, plain text, or
an image.

On iPhone, you can also share a photo, file, link, or text from another app
into Grok Bot. Use the system share sheet, choose **Grok Bot**, pick a chat,
and choose **Attach**. The item is added to that conversation's composer. On
Android, the share sheet currently accepts text. See
[Grok Bot for Mobile](/grok-bot/mobile).

Tell the Bot what each attachment is and how it should use it:

> The PDF is the signed policy. The spreadsheet is this month's transactions.
> Reconcile the spreadsheet against the policy, cite the relevant policy
> section for every exception, and return a new spreadsheet plus a short
> summary. Do not modify the originals.

## Share a link

Paste a link when the Bot can access the page from its computer or a connected
app. If the page is private,
[sign in through the computer](/grok-bot/computer-and-apps#take-over-for-a-sensitive-step)
or connect the app.

Links in messages and results open in your system browser; hovering over a
link card shows a preview first. Always check the destination before entering
credentials or approving an external action.

## Move files to and from your apps

When you've connected Google Drive, OneDrive, SharePoint, Gmail, or Outlook, a
Bot can move files between its computer and those accounts without pasting
their contents into the chat:

* Save a file it made or downloaded to Google Drive, OneDrive, or SharePoint,
  or attach it to a Gmail or Outlook draft.
* Bring a Drive, OneDrive, or SharePoint file, or an email attachment, onto its
  computer to work on it. Google Docs, Sheets, Slides, and Drawings arrive as
  `.docx`, `.xlsx`, `.pptx`, and `.png` files.

Say where the file should go. Saving to Google Drive always creates a new file,
even when one with the same name exists. OneDrive and SharePoint refuse a name
that already exists unless you tell the Bot to overwrite it.

## Ask for a reviewable result

Specify the artifact and its acceptance criteria:

* A document with headings and source links
* A spreadsheet with defined columns and formulas
* A slide deck with speaker notes
* A folder containing screenshots and logs
* A draft message that has not been sent
* A short recommendation followed by the underlying evidence

For consequential work, ask the Bot to separate:

1. Facts found in source systems
2. Assumptions or inferences
3. Actions already completed
4. Actions waiting for approval
5. Unresolved questions

## Preview generated work

Files, images, links, and tool results appear as cards in the conversation.
Open a card to preview supported formats. You can then save the file, open the
source link, or continue the conversation with feedback.

Ask the Bot to revise the existing artifact instead of making disconnected
copies:

> Update the report you just created. Add source links to the first two claims
> and replace the final table with a CSV attachment.

## Create images and videos

The Bot can create pictures and short video clips. It creates them only when
you ask, from a description or from images you share in the conversation. It
sends each image and video it makes to the conversation, and you can find them
again in the Bot's [Library](#find-a-page-later). Images it creates still load
in the conversation while its computer is asleep.

### Ask for an image

Describe what you want, such as the subject, style, and mood, in your own
words. To build on pictures you already have, share them in the conversation and
say how to use them. The Bot uses them as references.

Images can be square, wide, or tall: 1:1, 4:3, 3:4, 16:9, or 9:16. Image
creation isn't used for charts, plots, or tables; for those, ask for a
[page](#pages).

### Ask for a video

Ask for a video, an animation, or a clip. The Bot can make one from:

* A description of the scene
* An image you share, which becomes the first frame
* Two images you share, one for the start and one for the end. Use the same
  image for both to make a loop.
* Up to 14 reference images that show how people, objects, clothing, or
  settings should look

You can also share up to 4 images that must appear at set moments in the clip.

* Clips run 1 to 15 seconds. The default is 6 seconds.
* Clips are 480p unless you ask for 720p.
* Aspect ratios are 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, and 2:3. A clip made from
  your image keeps that image's shape unless you ask for another.
* Images you share for a video must be JPEG, PNG, or WebP, and all the images
  for one clip can add up to about 35 MB.
* The Bot saves each clip as an MP4 file.

Videos look filmed. They suit a live scene, a still photo brought to life, or a
character from your reference images. They aren't made for motion graphics,
title cards, slideshows, product or app demos, charts, or anything that needs
exact text, timing, or brand assets. Creating a video can take a few minutes.

When the Bot hands work to a task, that task can create images and videos too,
and the Bot then sends them to the conversation.

### If the Bot didn't create what you asked for

* To show you what a real person, place, or product looks like, the Bot finds a
  real image instead of creating one.
* Some requests are blocked by content rules, and the Bot tells you when that
  happens. Naming trademarked characters, brands, or real people often causes a
  block. Describe the subject in your own words and try again.
* If image creation is busy, the Bot may ask you to try again in a moment.
* If the Bot says image or video generation isn't available for your account,
  creation is turned off for you. On a team, an admin's model settings or the
  team's privacy settings can cause this. Ask your admin.

### View, save, and copy images and videos

In the desktop app:

* Click an image, or a video's thumbnail, to open it full screen. Click an
  image there to zoom in. When there is more than one item, use the left and
  right arrow keys or the thumbnails to move between them. Click the download
  button at the top to save the item. Close the viewer with Escape, the close
  button, or a click outside the image.
* The video player has play and pause, a seek bar, and a speed menu with
  **2×**, **1.5×**, **1×**, and **0.5×**.
* Right-click an image and choose **Copy image** or **Save image…**, or
  right-click a video and choose **Save video…**.
* Hover over a message and click the three dots. Choose **Download**, or
  **Download all** when the message has several items. For an image, you can
  also choose **Copy**.

In the phone app:

* Tap an image to open it full screen. Open the viewer's menu and choose
  **Forward** to send it to another chat, **Share**, or **Save**.
* Touch and hold an image in the conversation for **Copy Image** and
  **Save to Photos**.
* Tap a video to play it in the conversation. Touch and hold it for
  **Save to Photos**.

## Pages

A page is something a Bot builds for you to read, such as a report, a memo, a
dashboard, a tracker, or an explainer. It can hold text, tables, charts, and
controls like filters and switches. A page lives in the Bot's Library, so you
can come back to it later and share it.

Pages is rolling out gradually, and it isn't available on Enterprise teams yet.
If you don't see pages, update Grok Bot to version 0.60.0 or later on your
computer and 1.14.0 or later on your phone.

To make a page, ask the Bot in chat. Say what the page is for and what should
be on it, for example:

> Make a page that compares the three quotes in this thread, with a table and a
> short recommendation.

> Build a dashboard of signups, trials, and conversions for the last 30 days.

> Create a launch tracker that organizes open tasks, owners, and statuses.

The Bot builds the page and posts it in the chat as a card with the page's
title and **Open**. You can also ask a Bot to create or update a page from a
[routine](/grok-bot/skills-routines-and-automations).

### Open a page

In the desktop app, click a page's card in the conversation to open it. The
page fills the window, and the chat stays open in a smaller panel beside it, so
you can keep talking to the Bot while you read.

When the Bot updates a page, the earlier card in the chat says **Updated
below**. Click it to open the latest version.

In the phone app, tap a page's card to open it. Tap the close button to go
back to the conversation.

### Change a page

Ask the Bot. While the page is open, type in the chat panel beside it, labeled
**Message about** and the page's title. The Bot edits the same page, so everyone
who can open it sees the change.

Filters, switches, and other controls on a page change what you see, not what
the page holds. Nothing you do on the page is saved. To change the page itself,
ask the Bot.

To rename a page you made, click its title at the top of the open page, type a
new name, and press Enter. Press Escape to keep the old name.

### Find a page later

In the desktop app, press `Cmd/Ctrl+K` and type a page's title to find it.

Each Bot also has a **Library**. Click the Bot's name at the top of the chat
(**View conversation details**) and open the **Library** tab. It lists the
pages, files, and apps the Bot has made and the images, videos, and links it
sent in your conversation, newest first under **Today**, **This week**, and
**Older**. Things you sent, including images you uploaded, and files a Cloud
Agent returned aren't listed. Each group shows five items at a time; click
**Show more** to see more. On the phone, tap the Bot's name at the top of the
chat to open its profile, then tap **Library**.

* Click a page to open it. Click an image or video to view it full screen, a
  file to preview it, or a link to open it in your browser.
* A page you've shared with your team or with anyone who has the link shows a
  mark on its row.
* Click **More actions** (the three dots) on a row and choose **Pin** to keep
  the item at the top of the Library under **Pinned**. Choose **Unpin** to
  take it off. A page's menu also has **Open**, and **Share…** for pages you
  own.

### Share a page

A new page is private to you until you share it. You can change who can view a
page you own.

* In the desktop app, open the page and click **Share** at the top, or choose
  **Share…** from the page's menu in the Library. Click the current setting
  and choose who can view the page.
* In the phone app, open the page, tap the share button, and choose an option
  under **Who can view**.

| Option | Who can open the page |
| --- | --- |
| **People you invite** | You and the teammates and groups you add. Each one gets **Viewer** access; open it and choose **Remove** to take someone off. On a personal account, this option is **Only you**. |
| Your team's name, or **Your team** | Everyone on your Cursor team. |
| **Anyone with the link** | Anyone, with no sign-in needed. |

Some teams also see an option for everyone in their organization. People who
open a team or invite link sign in with their Cursor account first. Everyone you
share with can read the page and use its controls; only the Bot can change it.
To share a page with fewer people, open **Share** again and choose a narrower
option, or change it from your
[dashboard](#see-pages-youve-shared).

When an option isn't available, the share menu says why:

| What you see | What it means |
| --- | --- |
| **Public sharing is off for Enterprise teams** | Your team is on the Enterprise plan. Share the page with your team or with people you invite instead. |
| **Pages in your personal space can't be team-shared** | The page belongs to your personal account, not a team. Keep it private, or share it with anyone who has the link. |
| **Couldn't update access** | The change didn't save. Try again. |
| **This page's access changed. Make your change again.** | Someone changed who can view the page while you had the menu open. Make your change again. |

To send the link, use **Copy link** at the bottom of the desktop share menu or
at the top of the phone's share screen. The desktop menu also has
**Open in browser**. In the phone app, once someone besides you can open the
page, the share screen also has **Share**, which opens your phone's share
sheet, and **Open in browser**.

A page you share with anyone who has the link opens at its own address on
`pages.grok.bot`, based on the page's title. Anyone with that address can open
the page without signing in, so share a page this way only when it holds
nothing private. The address stays the same when you rename the page, and you
can't choose a custom address yet. In the phone app, the address is under
**Address**; tap it to copy it. Public sharing is off on Enterprise teams; with
a personal account, or on a team that isn't on the Enterprise plan, you can
share a page with anyone who has the link.

If a change doesn't save, choose **Retry**.

### See pages you've shared

To see every page you've shared, open the
[Cursor dashboard](https://cursor.com/dashboard/shared-canvases) and find
**Grok Bot Pages**. Each row shows the **Page**, its **Visibility**, and the
**Date**. Click a row to open the page, or use **Visibility** to change who can
view it.

Click the three dots on a row for **Copy Link** or **Delete**. When you delete
a page, anyone with the link loses access.

## Results from Cloud Agents

A Bot can hand coding work to a
[Cloud Agent](/grok-bot/teams-and-enterprises#cloud-agents). When the Cloud
Agent finishes, the Bot copies the images, videos, and other files cited in the
Cloud Agent's final report to its computer and attaches them to its reply.
In the desktop app, the Cloud Agent's card in the conversation shows the same
files; open an image or video to view it full screen.

In the phone app, the Cloud Agent's card shows the same files once the run is
**Done**, **Error**, or **Expired**: images first, then videos, then other
files. Tap an image to view it full screen, a video to play it, or another
file to open your phone's share sheet. If a file doesn't load, tap **Retry**.
If the run opened a pull request and hasn't expired, **View PR** opens it.
**Open in Cursor** opens the run in the Cursor app or on the web.

## Preserve evidence

A strong result should be independently reviewable. Depending on the task, ask
for:

* Direct source links
* Screenshots with the relevant state visible
* Timestamps and time zones
* Input and output file names
* A concise action log
* An explicit list of anything the Bot could not verify

Do not rely on a screenshot alone for rapidly changing data. Keep a link or
export from the source system when possible.

## Shared computer files

Bots can read files other Bots save in `/workspace`. Use project folders and
descriptive names to make handoffs reliable.

The shared workspace is useful for intermediate material, but the conversation
should still contain the final result or a clear link to it. See
[Use the computer and apps](/grok-bot/computer-and-apps) for persistence and recovery
details.
