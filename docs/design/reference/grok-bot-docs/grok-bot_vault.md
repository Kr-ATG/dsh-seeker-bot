#### Work with Grok Bot

# Vault and secure sign-in

Keep passwords, cards, API keys, and other credentials out of chat and ordinary
files. Save logins, cards, and contact info in **Vault** so your Bots can sign
in and check out for you, and use the secure secret card for API keys. After
you save a secret, Grok Bot does not show the value again; a blank field later
is not proof the secret was deleted.

## What Vault holds

Vault keeps your logins, cards, and contact info so your Bots can sign in to
websites and check out for you without seeing the secret values. Open it from
**Settings → Vault** in the desktop app or on your phone, where you can add,
edit, or remove anything. Vault needs Grok Bot 0.75.2 or later.

* **Logins:** a website, a username or email, and a password. A Bot uses a
  saved login to sign in on that website.
* **Cards:** the number, expiry, security code, name on card, and billing
  address.
* **Contact info:** names, addresses, phone numbers, and emails for shipping and
  billing.

A Bot never sees a saved password, card number, or security code. It can see
your contact info and which logins you saved, so it can pick the right entry
and type contact details for you.

Vault covers your whole account: everything you save is available to every Bot
on your account, and you can't limit an item to one Bot. Vault isn't supported
on [shared Bots](/grok-bot/shared-bots); add keys to a shared Bot under
**Secrets** instead. See [API keys and other
secrets](#api-keys-and-other-secrets).

## Add, import, and change items

1. Open **Settings → Vault** and choose **New item**.
2. Pick **Login**, **Card**, or **Contact info**.
3. Fill in the details and save.
   * For a login, enter the **Website**, **Username or email**, and
     **Password**, then choose **Save login**.
   * For a card, choose **Scan with camera** or **Upload a photo** to fill it
     from the card, or type it in. Then choose **Save card**.
   * For contact info, enter the name, address, phone, and email, then choose
     **Save contact info**.

Under **Hints**, tell your Bots when to use an entry, such as “Use for work
purchases.” A Bot follows the hint when it chooses between entries.

You can also save from a chat. When a Bot asks for a login, card, or address
with a [Secure Form](#secure-forms), check **Securely save to Bot's vault** to
keep it for next time; if you leave it unchecked, the value is kept only for
that chat and expires on its own. When you attach a photo of a card, Grok Bot
offers **Save to Vault** so your Bot can pay with it later.

To move logins from another password manager on desktop:

1. Export your passwords as a CSV file from 1Password, Chrome or Edge, Safari or
   Apple Passwords, Firefox, Bitwarden, or LastPass.
2. In **Settings → Vault**, choose **New item**, then **Import from CSV…**.
3. Select **Choose CSV file** and pick the export. The file is read on your
   computer and never uploaded, and it must be under 5 MB.
4. Review the list. Items already in your vault are skipped. Rows with an
   error, such as a missing password or a website that isn't https, aren't
   imported.
5. Choose the import button, which shows how many items are ready.

LastPass exports bring cards along too. The export holds your passwords
unencrypted, so delete it once the import finishes.

To change or delete an item, select it in **Settings → Vault** and edit it, or
choose **Remove**. After you remove a login, Grok Bot can no longer sign in to
that site with it; after you remove a card, Grok Bot can no longer pay with it.
To change a card's number, remove the card and add it again. On the phone,
saved cards can't be edited yet.

A Bot can change contact info, and an entry's nickname and hints, when you ask.
Passwords, usernames, websites, card numbers, and security codes change only in
**Settings → Vault**, and logins and cards are removed only there.

## How a Bot uses Vault

To sign in, a Bot uses a login saved in Vault first, then a connected password
manager such as
[1Password](/grok-bot/computer-and-apps#connect-1password), then asks you
with a Secure Form. Values from Vault and from a Secure Form are filled into the
page without the Bot seeing them. When a site emails a one-time code, the Bot
can read it from a connected Gmail or Outlook account or from
[its own inbox](/grok-bot/computer-and-apps#give-your-bots-an-email-address).

* **New accounts:** if you let a Bot choose the password when it signs up for a
  site, Vault generates the password and saves the login, and the Bot never
  sees it.
* **Checkout:** saved cards fill in at checkout, and contact info fills in
  shipping and billing details. See [Pay for things](#pay-for-things).
* **Details you share in chat:** when you give a Bot a name, address, phone
  number, or email, it saves it as contact info once the task is done and tells
  you what it saved. Tell it if you don't want something kept.

The Bot hands you the computer when a form can't do the step, such as single
sign-on, a passkey, a CAPTCHA it couldn't get past, an approval on another
device, a QR code, or a bank card verification. Choose **Take over** on the
request, or open the computer and choose **Take control**, complete only that
step, then choose **I'm done** and tell the Bot to continue. The signed-in
session stays on the computer for future tasks and is shared across your Bots.

## Secure Forms

When a page needs something only you should provide, the Bot shows a **Secure
Form** in the chat, one form per step. The form names the site it fills, such
as “Never shown to your Bot. Filled directly to example.com.” Your answers go
straight into the page and are never shown to the Bot.

If a form for a login, card, or contact info has **Securely save to Bot's
vault**, check it to keep the value in Vault. Leave it unchecked to use the
value only for that chat. A form without that checkbox saves straight to Vault.

A filled form says **Filled into the page. Secret values were never shown to
your Bot.** If it says **Could not fill into the page**, the page may have moved
before the form could fill it; the values still weren't shown to the Bot. Submit
a new form if the Bot asks again.

## API keys and other secrets

For an API key or another secret that isn't a login or card, use the **secure
secret card** when a Bot asks for one. The field is masked. Choose **Save
securely**, and the card then says **Saved** and **Saved securely and kept
private**. The value isn't written into the chat or shown to the Bot.

On a [shared Bot](/grok-bot/shared-bots) you own or manage, you can also add a
secret from the Bot's details. Open **Secrets**, choose **Add secret**, enter an
environment variable name, a short description, and the value, then choose
**Save secret**. The description is visible to the Bot; the value is not.
Secrets on a shared Bot are used in every teammate's chat, so only add keys
you're happy for everyone who can chat with the Bot to use.

A credential your company's setup scripts need, such as a license key for a
tool installed on every team computer, is stored by a team admin as a [Team
Secret](/grok-bot/teams-and-enterprises#team-secrets) on the Enterprise
dashboard instead. Those never reach your Bots directly.

Never paste a password, one-time code, or API key into ordinary chat, a Shell
command, or a file on the computer, and don't type secrets into a demonstration
when you use [Teach a
task](/grok-bot/skills-routines-and-automations#teach-a-workflow-by-demonstration).

### Why you can't see a saved value

Saved values are write-only:

* In **Settings → Vault**, saved passwords stay hidden, and cards show only
  their last four digits.
* The secure secret card does not show the value after **Saved**. The footer
  says **Stored securely, never shown to your Bot**.
* On a shared Bot, **Secrets** lists the name and description only. It never
  shows the value again, including in Shell.
* To change a value there, choose **Replace**, paste the new value, and choose
  **Replace value**. You can't read the old value back.

If a save fails, the form says **The secret was not saved. Try again.** If a
shared Bot's **Secrets** list says **Something went wrong. Try again.**, choose
**Try Again**. **No secrets yet** means that Bot has no saved names, not that a
value is hidden.

### Did an update delete my secrets?

**Recover**, **Reset**, and computer updates remove installed apps and packages,
so a secret you typed into a file, a shell profile, or an installed tool on the
computer can disappear with them. That is separate from secrets you saved with
the secure card, under **Secrets**, or in Vault. See [Update, recover, or reset
the computer](/grok-bot/computer-and-apps#update-recover-or-reset-the-computer).

Shell not printing a secret does not mean it was wiped. On a shared Bot, if the
name is still listed under **Secrets**, the value is still stored. If a shared
Bot's secret name is gone and you did not choose **Remove**:

1. Fully quit Grok Bot and reopen it. On Mac, choose **Quit** from the menu bar,
   not just close the window.
2. Open the same Bot on another device signed into the same Cursor account.
3. If the list says **Something went wrong. Try again.**, choose **Try Again**
   before you add anything.

If the name is still missing on every device, add it again; don't put it in a
file to keep a copy on the computer. If names keep disappearing, [contact
support](/grok-bot/troubleshooting) with your account email and a screenshot of
**Secrets**, but never the secret value.

## Pay for things

A card saved in Vault fills in at checkout without asking you each time, and no
setting requires your approval for each use. If you want to approve every
payment yourself, don't save the card:

* When a Bot asks for a card with a Secure Form at checkout, leave **Securely
  save to Bot's vault** unchecked. The card is used only in that chat. A form
  without that checkbox saves straight to Vault, so don't submit it.
* If you already saved a card, open **Settings → Vault**, select it, and choose
  **Remove**.

**Settings → Vault** also lists **Payment accounts**, wallets you can connect,
such as Link or X Money, and **Default payment method**, which Grok Bot pays
with first.

With a Link account connected, a Bot can ask you to approve a one-time card for
a single purchase. The request shows the merchant, the items, and the total.
Choose the **Pay** button, which shows the amount, to approve; choose **Pay
another way** to skip the card, or **Deny**. After you approve, finish
authorizing on the Link page that opens. Nothing is charged if you decline or
the request expires. If the card says your Link account isn't connected,
reconnect Link, then ask the Bot again.

## Related pages

* [Use the computer and apps](/grok-bot/computer-and-apps)
* [Shared Bots](/grok-bot/shared-bots)
* [Approvals, security, and privacy](/grok-bot/approvals-security-and-privacy)
* [Store secrets securely](https://cursor.com/help/grok-bot/secrets)
