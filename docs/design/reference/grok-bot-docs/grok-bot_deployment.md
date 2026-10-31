#### Manage and protect

# Deploy Grok Bot to your organization

Your IT team installs the Grok Bot desktop app on member devices with the tools
it already uses for other software: download a versioned installer, push it,
and decide when devices move to a new release. Dashboard controls for turning
Grok Bot on and scoping access are on
[Grok Bot for teams and enterprises](/grok-bot/teams-and-enterprises), and
deploying the Cursor editor is covered in
[Deployment patterns](https://cursor.com/docs/enterprise/deployment-patterns).

## What you deploy

| Component | Runs on | Updated by |
| --- | --- | --- |
| Desktop app | macOS (Apple silicon and Intel), Windows (x64 and Arm64), Linux (x64 and Arm64) | The app, or your package manager for Linux `.deb` and `.rpm` installs |
| iPhone app | iOS 18 or later | The App Store |
| Android app | Android 9 or later | Google Play |
| Hosted computer | The cloud, one per member | Automatically, in the background |

The apps are clients for chat, review, and approvals. Bots do their work on the
member's hosted computer. Your device management tool reaches the apps on
member devices and stops there: the hosted computer runs Linux in the cloud and
isn't enrolled in MDM. To put your own tooling on hosted computers, Enterprise
teams use
[Team Setup Scripts](/grok-bot/private-networks#install-a-networking-client-with-team-setup).

## Get the installers

* The **Download Grok Bot** row on the
  [Grok Bot page](https://cursor.com/dashboard/bot) of the dashboard installs
  the app or copies a link you can share with members.
* The [download page](https://cursor.com/download/bot) lists the current
  installer for every platform and format.
* For scripted packaging, read the current release from the
  [release feed](#read-the-current-release-from-the-feed) and download the file
  it names.

| Platform | Architectures | Formats |
| --- | --- | --- |
| macOS | Apple silicon, Intel | `.dmg` |
| Windows | x64, Arm64 | Setup `.exe` |
| Linux | x64, Arm64 | `.deb`, `.rpm`, AppImage |

### Read the current release from the feed

Each platform has a JSON feed at
`https://api2.cursor.sh/updates/api/download/stable/{platform}/sand`:

| `{platform}` | Installer |
| --- | --- |
| `darwin-arm64` | macOS, Apple silicon |
| `darwin-x64` | macOS, Intel |
| `win32-x64-user` | Windows x64 |
| `win32-arm64-user` | Windows Arm64 |
| `linux-x64` | Linux x64 |
| `linux-arm64` | Linux Arm64 |

```bash
curl -s https://api2.cursor.sh/updates/api/download/stable/darwin-arm64/sand
```

The fields you need:

| Field | Value |
| --- | --- |
| `version` | The current release |
| `commitSha` | The build the release comes from. Linux download URLs include it. |
| `downloadUrl` | The installer: `.dmg` on macOS, Setup `.exe` on Windows, AppImage on Linux |
| `debUrl`, `rpmUrl` | Linux only. The `.deb` and `.rpm` packages. |

The response can carry other fields; installing the desktop app doesn't need
them.

### Build a versioned URL

macOS and Windows installers keep a versioned URL for each release. Replace
`{version}` with the release you want:

```text
# macOS, Apple silicon
https://downloads.cursor.com/grokbot/stable/darwin-arm64/{version}/Grok_Bot_{version}.dmg

# macOS, Intel
https://downloads.cursor.com/grokbot/stable/darwin-x64/{version}/Grok_Bot_{version}_x64.dmg

# Windows x64
https://downloads.cursor.com/grokbot/stable/win32-x64/{version}/Grok_Bot_{version}_Setup.exe

# Windows Arm64
https://downloads.cursor.com/grokbot/stable/win32-arm64/{version}/Grok_Bot_{version}_Setup.exe
```

Linux packages sit under the release's `commitSha`, in
`https://downloads.cursor.com/grokbot/stable/{commitSha}/linux/x64/` or
`.../linux/arm64/`. Copy the exact file URLs from `downloadUrl`, `debUrl`, and
`rpmUrl` in the Linux feed.

## Push the desktop app with your device management tool

* On macOS, deploy the `.dmg` with the Mac management tool you run today, such
  as Jamf Pro, Kandji, or Microsoft Intune.
* On Windows, deploy the Setup `.exe` with Intune, Configuration Manager, or
  another software distribution tool, and install silently with
  `Grok_Bot_{version}_Setup.exe /S`. The installer installs per user, into the
  member's profile under `%LOCALAPPDATA%\Programs`, so deploy it in user
  context, not as SYSTEM. Test the install on a pilot device before you push
  it.
* On Linux, install the `.deb` or `.rpm` with your configuration management
  tool, such as Ansible, Puppet, or Chef. Prefer these packages for managed
  fleets: package installs update through your package manager on your
  schedule. See [Linux package updates](#linux-package-updates).
* On iPhone, members install Grok Bot from the
  [App Store](https://apps.apple.com/app/id6794501026) on iOS 18 or later.
* On Android, members install Grok Bot from
  [Google Play](https://play.google.com/store/apps/details?id=ai.x.grok.bot) on
  Android 9 or later. To push it to managed devices, approve it in managed
  Google Play from Intune or another Android device management tool.

Members sign in with their Cursor account through your normal SSO flow; Grok
Bot has no separate login.
To assign the Cursor app in Okta or Entra ID, see
[Assign the Cursor app](/grok-bot/identity-and-access#assign-the-cursor-app).

## Choose a version

Pin the version you tested. Download that release's installer, keep it in your
own software repository or MDM package store, and deploy from your copy so
every new device gets the same build. How long older installers stay available
for download isn't published, and a pinned build works only until it loses
support; see [How desktop updates work](#how-desktop-updates-work).

Linux package URLs include the release's `commitSha`, so record the full URL
along with the version.

To check what a device runs, open the account menu in the app, choose
**Support**, then **About**. The dialog shows **Version**, and **Copy version
info** copies the version, release track, and operating system.

### How desktop updates work

| Install | How updates arrive |
| --- | --- |
| macOS `.dmg`, Windows Setup `.exe`, Linux AppImage | The app checks for updates automatically and offers each new version to the member. **Restart to Update**, in the [Updates](/grok-bot/settings-and-notifications#updates) section of settings, installs it. With **Automatic Updates** on, the default, the app also installs a downloaded update while the member is away. |
| Linux `.deb` or `.rpm` | The app doesn't install updates. New versions arrive through your package manager. |

For macOS, Windows, and AppImage installs, no device policy, installer option,
or dashboard setting turns off desktop app updates. Members can turn off
**Automatic Updates** so updates wait for **Restart to Update**, but the app
still checks for and offers new versions. Pinning decides which version you
install; the app still offers newer ones afterward.

Old builds stop working. When a build loses support, the app covers its whole
window with **Update required** until the member updates. A build loses support
when it falls below the minimum supported version, or when it passes a maximum
age and a newer release is available. This applies to every install, including
Linux `.deb` and `.rpm` packages. Both limits are set remotely and aren't
published, so plan a regular cadence for moving devices to the current release.

### Linux package updates

Installing the `.deb` adds a signed apt repository at
`/etc/apt/sources.list.d/grok-bot.sources`, and installing the `.rpm` adds a
signed repository at `/etc/yum.repos.d/grok-bot.repo`. Devices then pick up new
Grok Bot versions whenever they run package upgrades.

To control when Linux devices move, either:

* Hold the package with your package manager, such as
  `apt-mark hold grok-bot`, and release it when you're ready to upgrade.
* Turn the repository off: set `Enabled: no` in `grok-bot.sources`, or
  `enabled=0` in `grok-bot.repo`. The package rewrites these files on every
  install and upgrade and keeps your choice. Then ship new versions yourself
  from package files you've tested.

Either way, upgrade before the installed version loses support. A held package
still gets the **Update required** screen.

On a `.deb` or `.rpm` install, the **Update required** screen shows the command
to run, with **Copy command**:

* `.deb`: `sudo apt update && sudo apt install --only-upgrade grok-bot`
* `.rpm`: `sudo dnf upgrade --refresh grok-bot`

When the repository doesn't have the new version yet, for example because you
turned it off, the screen tells the member to download and install the latest
package instead and links to it. After either step, the member restarts
Grok Bot.

## Update the hosted computers

The hosted computer's image is maintained for you, so there is no image for you
to pin or supply. A computer moves to a newer image in one of three ways:

| Trigger | What happens | Who starts it |
| --- | --- | --- |
| New image | Idle computers are recreated on the new image in the background, gradually and without a fixed schedule. Until then, a computer stays on its current image. Member files carry over, and Team Setup runs again. | Automatic, in the background |
| **Update Bot's Computer** | Rebuilds the member's computer on the latest image. Scheduling it for a later time isn't available to every account yet. | The member, from **Settings → Computer** in the desktop app, under **Bot's computer** |
| **Recreate VMs** | Rebuilds the selected members' computers on the latest image and Team Setup Scripts. | Admins on Enterprise, from [Manage Member Computers and Data](/grok-bot/computers) |

Running computers pick up Team Setup manifest changes roughly once a day; to
apply a change sooner, recreate the computers. On Enterprise,
[audit logs](/grok-bot/teams-and-enterprises#audit-logs) record computer
updates, resets, recreates, and terminations as `grok_bot_vm` events, and
operations across many members as `grok_bot_vm_bulk`.

## Open the network path

Devices download installers and desktop updates from `cursor.com` and
`downloads.cursor.com`, and the app reaches its API and the member's hosted
computer on the domains in
[Allow these domain patterns](/grok-bot/proxies#allow-these-domain-patterns).
Allow all of them, including the nested `*.*.cursorvm.com` pattern, and exempt
them from TLS inspection before you push the app.

## Rollout checklist

1. Move off Privacy Mode (Legacy), which blocks Grok Bot entirely. See
   [Before you roll out](/grok-bot/teams-and-enterprises#before-you-roll-out).
2. Clear your network: allow the Grok Bot domains on your gateway and exempt
   them from TLS inspection. See
   [Configure TLS-inspecting proxies](/grok-bot/proxies).
3. Assign the Cursor app in your identity provider, since Grok Bot sign-in uses
   your SSO. See
   [Assign the Cursor app](/grok-bot/identity-and-access#assign-the-cursor-app).
4. Turn on Grok Bot and choose who gets it. On Enterprise, an admin turns Grok
   Bot on from the dashboard and scopes it with **Manage Group Access**; on
   Teams, every member already has access. See
   [Enabling Grok Bot for your team](/grok-bot/teams-and-enterprises#enabling-grok-bot-for-your-team).
5. Apply the recommended configuration: set the admin controls in
   [Recommended configuration](/grok-bot/teams-and-enterprises#recommended-configuration)
   before members start.
6. Pilot the installer: install your chosen version on a few devices for each
   platform, sign in, and confirm the app connects to the hosted computer.
7. Push to your fleet: deploy the tested installer to every device whose owner
   has access.
8. Plan updates: pick a cadence for moving devices to new releases. For Linux, decide whether
   devices upgrade from the Grok Bot repository or from packages you ship.

## FAQ

### Can I turn off automatic updates for the desktop app?

On macOS, Windows, and AppImage installs, no. The app checks for updates and
offers them to members. Each member can turn off **Automatic Updates** so an
update installs only when they choose **Restart to Update**, but there's no
admin control. Linux `.deb` and `.rpm` installs don't update themselves, so you
control them with your package manager. See
[How desktop updates work](#how-desktop-updates-work).

### Is there an MSI or PKG installer?

The published installers are a `.dmg` for macOS, a Setup `.exe` for Windows,
and a `.deb`, `.rpm`, or AppImage for Linux. Wrap the `.dmg` or `.exe` in your
management tool's package format if it requires one.

### Does my device management tool reach the hosted computer?

No. The hosted computer runs Linux in the cloud and isn't enrolled in MDM.
Enterprise teams install their own tooling on it with
[Team Setup Scripts](/grok-bot/private-networks). If your identity provider requires a
managed device, see
[Allow sign-in to IdP apps from the computer](/grok-bot/identity-and-access#allow-sign-in-to-idp-apps-from-the-computer).

### Can I pin the hosted computer's image?

No. The image is maintained for you, and computers move to new images in the
background. Enterprise admins can recreate computers at a time they choose
from [Manage Member Computers and Data](/grok-bot/computers).

### Can members install Grok Bot without IT?

Yes, unless your device policies block it. Members can download the app from
the dashboard link an admin shares or from the
[download page](https://cursor.com/download/bot). Access still depends on your
plan and, on Enterprise, on **Manage Group Access**.

## Related pages

* [Grok Bot for teams and enterprises](/grok-bot/teams-and-enterprises)
* [Configure identity and access](/grok-bot/identity-and-access)
* [Configure TLS-inspecting proxies](/grok-bot/proxies)
* [Manage Grok Bot computers](/grok-bot/computers)
* [Settings and notifications](/grok-bot/settings-and-notifications#updates)
* [Deployment patterns](https://cursor.com/docs/enterprise/deployment-patterns)

Contact your account team about Enterprise enablement, deployment planning, and
security review support.
