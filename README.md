# WhatsApp MCP for Claude

[![CI](https://github.com/Akram-Atassi/claude-whatsapp-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Akram-Atassi/claude-whatsapp-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Akram-Atassi/claude-whatsapp-mcp?sort=semver)](https://github.com/Akram-Atassi/claude-whatsapp-mcp/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An MCP server that links your **personal WhatsApp account** to Claude Desktop, the same way WhatsApp Web does (you scan a QR code once). Claude can then read your chats, search your history, send messages and files, broadcast to a list of people, and create and run groups and communities.

Everything runs locally on your computer. Messages live in `data/store.json` next to the server and are never sent anywhere except between your machine and WhatsApp.

22 tools, built with Baileys 6.7.24 and the MCP TypeScript SDK.

## What Claude can do with it

### Reading

| Tool | What it does |
|---|---|
| `whatsapp_status` | Is WhatsApp connected? Which number? How many chats/messages are stored? |
| `get_login_qr` | Returns the pairing QR as a scannable image in chat |
| `list_chats` | Recent chats, unread counts, last message. Filters: name, unread only, groups, archived |
| `search_contacts` | Find people/groups by name or phone number |
| `get_messages` | Read a chat's messages (page back in time with `before`) |
| `search_messages` | Full-text search across every chat |
| `download_media` | Save an attachment to disk (images are also shown to Claude inline) |
| `mark_as_read` | Send read receipts / clear the unread badge |

### Sending

| Tool | What it does |
|---|---|
| `send_message` | Send a text (optionally as a reply to a specific message) |
| `send_file` | Send an image, video, audio, voice note, or document from a local path |
| `broadcast_message` | Send the same text to many chats as individual messages. Dry run by default |
| `broadcast_status` | Progress and per-recipient results of a running broadcast; can cancel it |

### Groups

| Tool | What it does |
|---|---|
| `get_group_info` | Group description and participant list |
| `refresh_groups` | Re-fetch all groups you belong to |
| `create_group` | New group with an initial member list, optional description, optional community |
| `manage_group_participants` | Add, remove, promote or demote members |
| `update_group` | Rename, set description, control who can post / edit info / add members / join |
| `group_invite_link` | Get the join link, or revoke it and issue a fresh one |
| `leave_group` | Leave a group or community (requires `confirm=true`) |

### Communities

| Tool | What it does |
|---|---|
| `create_community` | New community, optionally linking existing groups into it immediately |
| `list_communities` | Every community you're in, with the groups inside each |
| `link_group_to_community` | Move existing groups into a community as subgroups, or remove them |

Anywhere a tool takes a `chat` / `to` / `group`, you can pass a contact name ("Alex"), a group name ("Tennis Squad"), a phone number with country code ("+1 202 555 0101"), or a raw jid (`12025550101@s.whatsapp.net`, `1234567890@g.us`). If a name is ambiguous the tool lists the candidates instead of guessing.

## Requirements

- Node.js 20 or newer
- Claude Desktop
- A phone with WhatsApp

## Install

Two ways. Both end with a `dist/index.js` for Claude Desktop to run.

### Option A — download a release (no build)

Grab `index.js` and `login.js` from the [latest release](https://github.com/Akram-Atassi/claude-whatsapp-mcp/releases/latest) and drop them into a `dist/` folder wherever you want the server to live. They are dependency-free bundles; Node runs them as-is.

Each release is built by GitHub Actions from the tagged source and carries signed build provenance, so you can confirm the bundle really came from this repo rather than someone's laptop:

```bash
gh attestation verify index.js --repo Akram-Atassi/claude-whatsapp-mcp
```

`SHA256SUMS.txt` is attached to every release too.

### Option B — build from source

```bash
git clone https://github.com/Akram-Atassi/claude-whatsapp-mcp.git
cd claude-whatsapp-mcp
npm install      # .npmrc already sets legacy-peer-deps
npm run build    # esbuild -> dist/index.js + dist/login.js
```

`dist/` is deliberately not committed — a minified bundle can't be audited, and this server holds your WhatsApp session keys. The build compiles every dependency in, so the server then runs on nothing but Node, with no `node_modules` at runtime.

## Setup

### 1. Claude Desktop config

`%APPDATA%\Claude\claude_desktop_config.json` contains:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["C:\\path\\to\\claude-whatsapp-mcp\\dist\\index.js"],
      "env": { "WHATSAPP_MCP_DATA_DIR": "C:\\Users\\you\\.local\\whatsapp-mcp-data" }
    }
  }
}
```

`WHATSAPP_MCP_DATA_DIR` deliberately points **outside** the project folder. `data/auth/` holds your WhatsApp session keys and `store.json` is rewritten every few seconds, so if the code lives in a synced folder (OneDrive, Dropbox, iCloud) keeping the data elsewhere avoids sync conflicts and keeps your session keys off the cloud. If you don't need that, drop the `env` block and the server uses `data/` next to itself.

If `node` turns out not to be on Claude Desktop's PATH, change `command` to the full path, e.g. `"C:\\Program Files\\nodejs\\node.exe"`.

### 2. Restart Claude Desktop

Quit it completely (right-click the tray icon → Quit) and reopen. **You must do this after every rebuild** — Claude Desktop loads `dist/index.js` once at startup, so a new bundle does nothing until it restarts. The tools icon should then list 22 WhatsApp tools.

### 3. Link your phone

Ask Claude: *"Show me the WhatsApp login QR."* Then on your phone: **WhatsApp → Settings → Linked devices → Link a device**, and scan it. The code expires in about 20 seconds — ask again for a fresh one.

After scanning, WhatsApp pushes your history once. Give it a minute, then ask *"what's my WhatsApp status?"* — it should report `state: connected` with a chat count.

You only do this once. The session is saved in `data/auth/` and reused on every start.

Terminal alternative: `npm run login` in the project folder shows the same QR in the terminal. Close it before starting Claude Desktop — only one process can hold the WhatsApp session at a time.

## Using it

Reading and one-to-one sending:

- "Show me my unread WhatsApp chats."
- "What did Sam send me last week?"
- "Summarize the last 50 messages in the Tennis Squad group."
- "Reply to Alex: I'll be there at 6."
- "Send the PDF at C:\Users\you\Downloads\poster.pdf to the Book Club group."

Broadcast:

- "Broadcast to the book club — Sam, Alex, Jordan, Riley: reminder that the meeting moved to Thursday 7pm."

Claude runs a dry run first and shows you exactly who would receive it. Nothing goes out until you approve and it calls again with `confirm=true`.

Groups and communities:

- "Create a group called 'Weekend Trip' with Sam, Alex and Jordan, and make it announcement-only."
- "Add +1 202 555 0101 to the Book Club group and make them an admin."
- "Get me the invite link for the Tennis Squad, and revoke the old one."
- "Create a community called 'Neighborhood' and put the Book Club and Garden Crew groups in it."
- "What communities am I in, and which groups are in each?"

## Broadcast, and why it is careful

WhatsApp's real Broadcast Lists can only be created in the phone app, and this kind of client can't make one. `broadcast_message` does what a Broadcast List actually does under the hood: it sends each person a separate normal message from you. Recipients don't see each other and replies come back as ordinary 1:1 chats.

The guardrails exist because bulk sending is the single fastest way to get a personal WhatsApp number banned:

- **Dry run by default.** The first call resolves every recipient, shows the roster and the message, and sends nothing.
- **Explicit confirmation.** Actual sending needs `confirm=true`, which Claude should only pass after you've seen the list.
- **50-recipient cap** per call.
- **Paced sending**, 3–8 seconds apart with jitter, one message at a time — never a burst.
- **Runs in the background.** 50 recipients takes several minutes, longer than an MCP call should stay open, so the tool returns a job id and `broadcast_status` reports progress and lets you cancel mid-run.
- **Unresolvable names abort the batch** unless you pass `skip_unresolved=true`, so a typo can't silently drop someone.

Use it for people who expect to hear from you. Don't use it for cold outreach.

## Communities

A WhatsApp community is an umbrella over several groups, plus an announcement channel every member sees. People are never added to a community directly — they join by being in one of its groups. So the flow is:

1. `create_community` (optionally passing `link_groups` to pull existing groups in immediately)
2. `create_group(..., community: "My Community")` for new subgroups, or `link_group_to_community` for existing ones
3. `manage_group_participants` to add people to the individual groups

You must be an admin of both the community and a group to link them. Baileys 6.7.24 has no linking helper, so `link_group_to_community` sends the raw `w:g2` iq node that WhatsApp Web uses (see `linkSubgroups` in `src/actions.ts`).

## How it works

```
Claude Desktop  ──stdio (MCP)──►  dist/index.js  ──WebSocket──►  WhatsApp servers  ◄──►  your phone
                                       │
                                       ▼
                               data/store.json   (chats, contacts, messages)
                               data/auth/        (session keys — treat like a password)
                               data/media/       (downloaded attachments)
```

- **Baileys 6.7.24** implements the WhatsApp Web multi-device protocol in pure JavaScript; no browser or Puppeteer.
- `dist/index.js` and `dist/login.js` are esbuild bundles with every dependency compiled in, so the server runs with nothing but Node — no `node_modules` at runtime.
- WhatsApp only pushes chat history **once**, right after linking, so the server keeps its own store on disk. It keeps the last 2,000 messages per chat.
- The server connects in the background as soon as Claude Desktop starts it, and reconnects with exponential backoff (3s doubling to a 5-minute cap) if the connection drops.
- Every send waits on `whatsapp.ensureReady()`, which gives a mid-reconnect socket up to 15 seconds to come back and otherwise fails with a readable reason. Without it a dropped connection made sends hang until the MCP client gave up.
- **Claude Desktop starts this server twice** — two child processes of the same `claude.exe`, a couple of seconds apart, from a single config entry. Two Baileys clients on one credential set make WhatsApp drop the link with `Stream Errored (conflict)`, costing a QR re-scan and a full history re-sync. So the instances elect one owner: whichever wins the lock at `connection.lock` in the data dir opens the WhatsApp socket and listens on a loopback port; the others register the same tools but forward every call there. Both surfaces keep working, one Baileys client exists. The lock carries a heartbeat, so if the owner dies another instance takes over within about ten seconds.
- Nothing is written to stdout except MCP JSON-RPC; all logging goes to stderr, so the protocol stream stays clean.
- Your phone does **not** need to stay online after linking (multi-device), but it must reconnect every 14 days or WhatsApp unlinks the device.

## Rebuilding

After changing anything under `src/`:

```bash
npm run typecheck
npm run build
```

Then **quit and reopen Claude Desktop**, or it keeps running the old bundle.

If `npm run build` fails with `Could not resolve "any-base"`, `parse-bmfont-ascii`, or `Unexpected end of file` in `@protobufjs`, `node_modules` is partially corrupt. Delete the whole `node_modules` folder and `npm install` again — repairing in place doesn't work.

If a rebuild misbehaves, keep a copy of the working `dist/index.js` before overwriting it — or just re-download the last good bundle from [Releases](https://github.com/Akram-Atassi/claude-whatsapp-mcp/releases).

## Troubleshooting

**`state: waiting_for_qr_scan`** — the device isn't linked. Ask Claude for the login QR and scan it.

**`state: logged_out`** — you removed the device from your phone. Delete the `data/auth` folder and link again.

**`state: disconnected`, `last error: Stream Errored (conflict)`** — two processes are holding the same WhatsApp session. Close WhatsApp Web in your browser and any `npm run login` window. It usually recovers on its own within a minute or two; check `whatsapp_status` again before doing anything drastic.

Two copies of *this server* no longer cause it — the lock described above prevents that. If a conflict does appear, count the server processes before re-scanning anything, because re-linking while two clients are running just gets you unlinked again:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*whatsapp-mcp*' } |
  Select-Object ProcessId, ParentProcessId, CreationDate | Format-Table
```

More than one is expected and fine; only the lock holder connects. Check `connection.lock` in the data dir to see which pid owns it.

**Chats have no names / groups show as numbers** — history sync was incomplete. Ask Claude to run `refresh_groups`; contact names fill in as messages arrive.

**Claude Desktop doesn't show the tools** — check the config path and JSON syntax, and read the log: `%APPDATA%\Claude\logs\mcp-server-whatsapp.log`. A `'node' is not recognized` line there means you need the full path to `node.exe` in `command`.

**A participant comes back as `403`** — their privacy settings don't allow being added to groups directly. Send them the invite link from `group_invite_link` instead. `408` means they recently left and can't be re-added yet; `409` means they're already in.

**"You are not an admin"** — `update_group`, `group_invite_link`, `manage_group_participants` and `link_group_to_community` all require admin rights on the group (and on the community, for linking).

**Move the data folder** — change `WHATSAPP_MCP_DATA_DIR` in the config and move the existing folder to match:

```json
"whatsapp": {
  "command": "node",
  "args": ["C:\\path\\to\\claude-whatsapp-mcp\\dist\\index.js"],
  "env": { "WHATSAPP_MCP_DATA_DIR": "D:\\whatsapp-data" }
}
```

## Privacy and safety notes

- `data/auth/` contains the keys that let anyone act as your WhatsApp. Don't share or commit it (it is in `.gitignore`).
- This uses an unofficial client library. WhatsApp's terms don't allow automation on regular accounts; use it for your own personal assistant purposes, not bulk messaging, or you risk a ban. The broadcast guardrails reduce that risk — they don't remove it.
- A server that can read your messages *and* send them is exposed to prompt injection — a message someone sends you is untrusted text, not instructions. Confirm recipients before sending, and be especially careful asking Claude to act on the contents of a chat.
- `leave_group` and `link_group_to_community` change things other people see. `leave_group` needs an explicit `confirm=true`.
- Claude only sees what the tools return; it does not stream your messages anywhere on its own.

## Project layout

```
src/
  index.ts     MCP server and the 22 tool definitions
  actions.ts   broadcast jobs, group management, community linking
  whatsapp.ts  Baileys connection, event ingestion, send/download, readiness
  store.ts     on-disk JSON store for chats, contacts, messages
  resolve.ts   name / phone / jid resolution and formatting
  login.ts     terminal QR login helper
  config.ts    data directory paths
  lock.ts      single-instance lock and the local handoff between copies
build.mjs      esbuild bundling into standalone dist/ files
.github/workflows/
  ci.yml       typecheck + build on every push and PR
  release.yml  builds, attests and publishes bundles on a v* tag
dist/          build output — dependency-free bundles (what Claude Desktop runs)

<data dir>/    WHATSAPP_MCP_DATA_DIR, outside the project folder
  auth/        session keys — treat like a password
  store.json   chats, contacts, messages
  media/       downloaded attachments
```

## Releasing

CI typechecks and builds on every push to `main`. To cut a release, tag a commit on `main`:

```bash
git tag v1.1.0
git push origin v1.1.0
```

`release.yml` then builds the bundles, generates provenance attestations, and publishes a GitHub Release with `index.js`, `login.js`, a zip and `SHA256SUMS.txt` attached. Release notes are generated from the commits since the previous tag.

## License

MIT. Not affiliated with or endorsed by WhatsApp or Meta.
