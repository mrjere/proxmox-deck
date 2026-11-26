# Proxmox Deck for Stream Deck +

A free, view-only dashboard for [Proxmox VE](https://www.proxmox.com) on the Elgato Stream Deck +.
Keep an eye on your host, containers and VMs, storage and backups from the dials, keys and touch
strip, and press any of them to jump straight to it in the Proxmox web UI.

It uses Proxmox's built-in API with a read-only token, so there is nothing to install on the
server, and the plugin can't change anything on it.

## Features

- **Four dial controls** for host stats, containers and VMs, storage, and recent tasks and
  backups, each with a live readout on the touch strip
- **Host stat key** that shows any of nine host metrics, from CPU and RAM to IO delay and uptime,
  with a 3-minute graph
- **Container / VM key** with a status dot and CPU and RAM bars for one guest
- **Backups at a glance**: set the Tasks dial to Backups to see whether last night's backup worked
- **Press to open, hold to refresh**, the same on every control
- **View-only by design**: the plugin can only read, and its token has no permission to change
  anything
- **Certificate pinning**, so it works with Proxmox's self-signed certificate without turning
  security checks off
- **One-time setup**: the connection details are entered once and shared by every control
- **Light on your server**: one shared poll, however many controls are on the deck, and no
  polling at all while none are on screen

## Requirements

- A Stream Deck +. The two key controls also work on other Stream Deck models.
- Stream Deck app 7.1 or newer, on Windows 10+ or macOS 12+
- A Proxmox VE server, and shell access as root to create a read-only API token. The plugin shows
  one node at a time, which suits a single home server.

## Installation

1. Download `com.jere.proxmox-deck.streamDeckPlugin` from the
   [latest release](../../releases/latest).
2. Double-click the file. The Stream Deck app installs it and adds a **Proxmox Deck** category to
   the actions list.

The [changelog](CHANGELOG.md) lists what's new in each version.

## Setup

1. On the Proxmox host's shell, create a user and role that can only look, never change anything,
   and give the user an API token:

   ```
   pveum role add StreamDeck -privs "Sys.Audit VM.Audit Datastore.Audit"
   pveum user add streamdeck@pve --comment "Stream Deck"
   pveum acl modify / -user streamdeck@pve -role StreamDeck
   pveum user token add streamdeck@pve deck --privsep 0
   ```

   The last command prints a `full-tokenid` and a `value`. Keep them handy, because Proxmox only
   shows the value once.
2. Drag any Proxmox Deck control onto your deck.
3. In its settings, open **Connection (shared by all Proxmox keys)**. Enter the **Host** (for
   example `192.168.1.10`), then paste the `full-tokenid` into **Token ID** and the `value` into
   **Secret**.
4. In the Proxmox web UI, go to your node → **System → Certificates**. Copy the **Fingerprint** of
   `pve-ssl.pem` into **Fingerprint**.
5. Press **Test connection**. You should see something like *Connected: 1 node, 7 guests*.

You only do this once. Every other Proxmox Deck control you add uses the same details.

**Set up with v0.1?** That version could start and stop guests. Take the power permission away
from the existing role:

```
pveum role modify StreamDeck -privs "Sys.Audit VM.Audit Datastore.Audit"
```

## Controls

Every control works the same way:

- **Press**: open what it's showing in the Proxmox web UI
- **Hold (half a second)**: refresh now. Keys show a tick, and dials show **✓ Refreshed** on the
  strip.
- **Tap or hold the touch strip**: refresh now

### Dials

| Control | Shows | Turn |
|---|---|---|
| **Host dial** | One host metric with a graph | Change metric (it remembers your choice) |
| **Guest carousel** | Status, CPU and RAM for one container or VM | Next / previous guest |
| **Storage carousel** | One storage (local, LVM, ZFS, NAS shares): % used, size and type | Next / previous storage |
| **Tasks & backups** | Recent tasks, newest first, with a 24-hour summary | Older / newer task |

### Keys

**Host stat** shows one host metric with a 3-minute graph.

**Container / VM** shows a status dot and CPU and RAM bars for one guest. The dot is green when
the guest is running, grey when it's stopped, and amber for anything else, such as paused.

### Per-control settings

| Control | Setting |
|---|---|
| Host stat, Host dial | **Show**: CPU, RAM, disk (root), IO delay, swap, load average, network in, network out or uptime |
| Container / VM | **Guest**: which container or VM |
| Guest carousel | **Include**: all containers and VMs, or running only |
| Tasks & backups | **Show**: all recent tasks, backups only, or failures and warnings only |

The shared **Connection** settings also have **Node** (Automatic uses the first node) and
**Refresh**, how often to poll, from 2 to 60 seconds (default 5).

### Colours

Colours only change when something is worth a look, because a tile that's always amber soon gets
ignored.

| Reading | Amber from | Red from |
|---|---|---|
| CPU, RAM, disk, swap and load | 70% | 90% |
| IO delay | 10% | 25% |
| Storage | 80% | 90% |

## Keeping your server safe

- **View-only, twice over.** Starting and stopping guests belongs in the web UI, where it takes a
  deliberate click and a confirmation, not on a key a child can reach. This is enforced in two
  places ("defence in depth"): the plugin's HTTP code can only send GET requests, and the token's
  role has no permission to change anything. Tests check both.
- **A read-only token.** This is the *principle of least privilege*: the token can read stats and
  nothing else. It can't start, stop, delete or reconfigure anything, and it can't log in to the
  web UI. If it ever leaked, there would be nothing to abuse.
- **Certificate pinning.** Proxmox uses a self-signed certificate, so normal HTTPS checks fail.
  **Skip certificate check** works, but anyone who can intercept your traffic could then capture
  the token. Pinning tells the plugin to trust exactly one certificate: yours. The plugin checks
  the fingerprint *before* it sends the token, and an automated test makes sure it stays that way.
- **Secrets stay local.** The connection details are kept in Stream Deck's global settings, which
  stay on your computer and aren't included when you export a profile.

If you later install a trusted certificate (for example from Let's Encrypt, using Proxmox's
built-in ACME support), you can clear the fingerprint and the plugin will check the certificate
normally. If Proxmox ever makes a new certificate, paste in its new fingerprint.

## Troubleshooting

**A key or the touch strip says Set up, Offline or an error.**
Set up means the connection details are missing. Offline only appears after two failed polls in a
row, and until then the plugin keeps showing the last good numbers. The other messages say what
went wrong:

- **Connection refused**, **Host not found**, **Host unreachable** or **Timed out**: check the
  host address, and that this computer can reach Proxmox on port 8006.
- **Token rejected**: check the Token ID and Secret.
- **Token lacks permission**: run the `pveum role modify` command from [Setup](#setup).
- **Untrusted certificate** or **Certificate fingerprint doesn't match**: copy the fingerprint
  again. Proxmox may have made a new certificate.
- **Certificate is for a different host name**: connect using the name on the certificate, or pin
  its fingerprint.

**Pressing a control opens the Proxmox dashboard, not the item.**
Links use the web UI's address format to jump to an item's page. If a future version of Proxmox
changes that format, links fall back to the dashboard.

**Only one node shows up.**
The plugin shows one node at a time. Choose which under **Node** in the Connection settings.

**Something else.**
The plugin writes logs to the `logs` folder inside the plugin's folder. Lines starting
`Poll failed` say what went wrong, for example `Timed out` or `Token rejected`.

- Windows: `%appdata%\Elgato\StreamDeck\Plugins\com.jere.proxmox-deck.sdPlugin\logs`
- macOS: `~/Library/Application Support/com.elgato.StreamDeck/Plugins/com.jere.proxmox-deck.sdPlugin/logs`

Your API token is never written to the logs. Please attach the latest log file if you open an
issue.

## Building from source

You need Node.js 24 or newer and the Stream Deck app 7.1 or newer. The Elgato CLI comes with the
project's dependencies, so there's nothing else to install. Clone or download this repository,
then from its folder:

```
npm install                                         # project dependencies, including the Elgato CLI
npm test                                            # run the tests (no server or deck needed)
npm run typecheck                                   # check the TypeScript types
npm run build                                       # build the plugin into the .sdPlugin folder
npx streamdeck link com.jere.proxmox-deck.sdPlugin  # install your build in the Stream Deck app
npm run watch                                       # rebuild on every save
npx streamdeck restart com.jere.proxmox-deck        # load the new build after a rebuild
npx streamdeck dev                                  # settings-page debugger on http://localhost:23654
npm run pack                                        # make dist/com.jere.proxmox-deck.streamDeckPlugin
```

Uninstall the released version before running `streamdeck link`, because both use the same ID.

### Project structure

```
src/
  settings.ts        The shared settings and their checks (turns a host into https://host:8006).
  proxmox/           Talks to Proxmox. No Stream Deck code, so it can be tested on its own.
    http.ts          HTTPS requests, the token header, certificate pinning and friendly errors.
    client.ts        Typed, read-only wrappers for the 5 API endpoints used.
    service.ts       One shared poller for every control, plus history for the graphs.
    format.ts        Pure helpers: percentages, bytes, rates, uptime, colours.
  render/
    key-images.ts    Draws the keys as SVG, so they're sharp at any size.
    metrics.ts       One place that decides how each metric is shown.
  actions/           One file per control, plus live-action.ts (what they share) and press.ts
                     (tells a short press from a hold).
  plugin.ts          Registers the controls and answers the settings pages.
com.jere.proxmox-deck.sdPlugin/
  manifest.json      The controls, their icons and what each gesture does.
  layouts/           Touch strip layouts (200 x 100 px per dial).
  imgs/              Icons for the keys, dials and touch strip.
  ui/                Settings pages. pi.js talks to Stream Deck's WebSocket directly.
test/                Tests against a fake Proxmox server and a fake Stream Deck, plus the
                     settings pages in jsdom.
```

### How it works

- **One poll for everything.** Eight tiles still means one set of API calls every few seconds.
  Polling stops entirely when no Proxmox control is on screen, for example inside a closed folder.
- **No overlapping requests.** If Proxmox is slow, the next poll waits for the current one rather
  than piling up.
- **Fetch only what's on screen.** Storage comes free with the regular poll. Tasks need an extra
  call, so they're only fetched while a Tasks dial is visible, and at most every 30 seconds.
- **Feedback for every action.** A button that seems to do nothing gets pressed again, or stops
  being trusted. So hold-to-refresh always shows a tick or a strip message.
- **Quiet logs.** Logging is set to `info`, not `trace`, because trace logs every message,
  including the token.

## Contributing

Bug reports, ideas and pull requests are welcome. By contributing, you agree that your changes are
released under the same licence as the rest of the project.

## Licence

Proxmox Deck is free, and meant to stay that way. It is released under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md). In plain words:

- **You can** use it, copy it, change it and share it for free, for any noncommercial purpose:
  at home, for a hobby, or in a school, charity or other noncommercial organisation.
- **You can't** sell it, charge for changed versions of it, or use it to make money.
- If you share it or a changed version, include the licence and the copyright notice.

This is a summary, and the licence text is what counts. Because it doesn't allow commercial use,
the project is "source-available" rather than "open source" by the Open Source Initiative's
definition.

## Credits

This is an independent project. It is not affiliated with or endorsed by Proxmox Server Solutions
GmbH or Elgato. Proxmox and Stream Deck are trademarks of their respective owners.
