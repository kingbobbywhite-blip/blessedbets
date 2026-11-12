# Switchboard

Talk to every Claude Code session you run from one place: a browser, your phone, or
your voice on a walk with a Flic button in your pocket.

```
   phone app / browser / Flic button / CLI
                    │  https + websocket (token)
                    ▼
   ┌─────────────────────────────────────────┐
   │ Hub (Node)                               │
   │  REST + WebSocket, tmux control, voice,  │──── Postgres: every message, every
   │  app updates, push notifications         │     transcript, the task backlog
   └─────────────────────────────────────────┘
        ▲ websocket          │ tmux new-session / send-keys / capture-pane
        │                    ▼
   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
   │ Claude Code │   │ Claude Code │   │ Claude Code │   one tmux session each
   │ "boss"      │   │ "api"       │   │ "research"  │   (sb-boss, sb-api, ...)
   │  └ channel  │   │  └ channel  │   │  └ channel  │   MCP server inside each session
   └─────────────┘   └─────────────┘   └─────────────┘
```

What it does:

- **One session runs the others.** The orchestrator ("boss") has tools to start Claude Code
  sessions in tmux, give them work, read their screens, press keys, interrupt, restart and
  stop them. You talk to boss; boss delegates.
- **A web UI** (phone-friendly, installable to the home screen) to talk to boss or any
  session, see who is working or waiting, peek at and type into any terminal, approve tool
  use, search history and manage the backlog.
- **Claude Code channels**, so what you type or say is *pushed* into the session the moment
  you send it: the session does not poll or call a tool to check. Replies come back through a
  `reply` tool. Tool-approval prompts are relayed to your phone and your answer goes back.
- **Postgres**, keeping every message between you and the sessions and between sessions,
  plus each session's own transcript (including what you typed straight into a terminal).
  Sessions search it with `search_history` when they have forgotten something.
- **A task backlog** by project, status and priority, kept by the sessions and by you.
- **A phone app** for iPhone and Android that **updates itself**: your sessions publish new
  versions to the hub and every phone pulls them in on its own, with no app store involved.
- **Replies spoken aloud**, and **push to talk** from a **Flic button**, so you can go for a
  walk and talk to the same system you used to juggle in ten terminal windows.
- **Phone actions**: sessions can speak, notify, vibrate, open links and apps, read your
  location, battery, clipboard or calendar (only what you allow), add calendar events, and
  draft texts and emails for you to send.

---

## Start here: where all this runs

**On your own computer**: the one you run Claude Code on, and one you can leave switched on
while you are out (a desktop, or a laptop left open and plugged in). Switchboard and every
Claude Code session run there. Your phone only connects to it.

Not on your phone, and not in a Claude Code cloud session on claude.ai: those are temporary
machines that are deleted when you are done, and they cannot keep your sessions running or see
your files.

**Every command below is typed into a terminal on that computer**, one grey box at a time,
pressing Return after each:

- **Mac:** the **Terminal** app. Press ⌘-Space, type `Terminal`, press Return.
- **Windows:** Switchboard needs tmux, which only exists on Mac and Linux, so on Windows it
  runs inside **WSL** (Linux built into Windows). After step 1 your terminal is the **Ubuntu**
  app in the Start menu, and Claude Code has to be installed in there as well.
- **Linux:** any terminal.

You can close the terminal window afterwards: Switchboard and your sessions keep running in
the background (in tmux) until you restart the computer.

### 1. Install the tools (once)

**Mac.** Install Homebrew. It asks for your Mac password, and when it finishes it prints
"Next steps" with two or three commands: run those too.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Then Node, tmux and git:

```bash
brew install node tmux git
```

**Windows.** Right-click the Start button, choose **Terminal (Admin)**, and run:

```powershell
wsl --install
```

Restart the PC, open **Ubuntu** from the Start menu, and choose a username and password. From
now on, type everything into that Ubuntu window:

```bash
sudo apt update && sudo apt install -y tmux git curl
```

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
```

Close Ubuntu, open it again, then:

```bash
nvm install 22
```

**Both.** In that same terminal, install Claude Code by following its
[quickstart](https://code.claude.com/docs/en/quickstart), then run `claude` once and log in.
`claude --version` must say 2.1.80 or newer.

Claude Code channels are a research preview. On a claude.ai **Team or Enterprise** plan an
Owner must turn them on first (Organization settings → Claude Code → Channels). Pro and Max
plans need nothing.

### 2. Get this repository onto that computer

If it is not on that computer yet:

```bash
cd ~ && git clone https://github.com/kingbobbywhite-blip/blessedbets.git
```

If it is (you already run BlessedBets from it), update it instead:

```bash
cd ~/blessedbets && git pull origin main
```

These commands assume the folder is `~/blessedbets`, where `git clone` puts it. If yours is
somewhere else, use that path in every command below.

### 3. Install Switchboard

```bash
cd ~/blessedbets/switchboard && npm install && npm link
```

`npm link` makes the `switchboard` command work from any folder. Check everything is in place:

```bash
switchboard doctor
```

### 4. Let your phone reach it from anywhere

Switchboard only answers on your own computer. [Tailscale](https://tailscale.com) (free) is
a private network between your own devices, so your phone reaches it on Wi-Fi or cellular
without anything being opened to the internet.

1. Install Tailscale on your phone (App Store or Play Store) and sign in.
2. Install it on the computer, open it, and sign in with the **same account**. It should say
   Connected.
   - **Mac:** download it from [tailscale.com/download/mac](https://tailscale.com/download/mac).
   - **Windows:** install it inside Ubuntu, where Switchboard runs:

     ```bash
     curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
     ```

     and allow yourself to change its settings without sudo:

     ```bash
     sudo tailscale set --operator=$USER
     ```

3. Give Switchboard its private https address and save it:

   ```bash
   switchboard tailscale
   ```

   It finds Tailscale even when Terminal says `command not found: tailscale` (the Mac app keeps
   its command inside the app), and writes the address into `switchboard/.env` for you. If it
   asks you to enable HTTPS for your tailnet, open the link it shows, turn it on, and run it
   again.

### 5. Start it

```bash
switchboard up
```

This starts the hub in a tmux session (`sb-hub`) and the orchestrator session (`sb-boss`,
working in `switchboard/orchestrator`, whose `CLAUDE.md` tells it how to run things). The
first time, Claude Code asks you to confirm "development channels" (custom channels are not
on Anthropic's allowlist during the preview) and to trust the folder; the hub answers both
for sessions it starts. Set `SWITCHBOARD_AUTO_ACCEPT_DIALOGS=0` to answer them yourself.

It ends by printing a link. Open it in a browser on the computer to see Switchboard.

To watch boss's own terminal, run `switchboard attach boss`; to leave it running, press
Ctrl-b, then d.

### 6. Open it on your phone

```bash
switchboard pair
```

prints two QR codes in the terminal. Point your phone's **camera** at the second one
("Browser"): it opens Switchboard in the phone's browser, already signed in. Then Share →
**Add to Home Screen** so it opens like an app. That is enough to chat, approve tool use, read
the backlog and talk by voice with the screen on.

The first QR code is for the Switchboard phone app ([below](#the-phone-app)), which is what
keeps listening with the phone locked in your pocket.

Postgres is built in: with no `DATABASE_URL`, the hub runs a real Postgres from the
`embedded-postgres` package, keeping its data in `~/.switchboard/postgres`. To use your own,
set `DATABASE_URL` in `switchboard/.env` (`docker compose up -d` in `switchboard/` starts one).

## Using it

**From a browser:** the session list shows everyone and what they are doing. Open one to
chat; **Screen** shows its real terminal and lets you press keys or type, for prompts a session
cannot relay. Approvals appear as a banner. **Backlog** is the task board, **Search** is the
history, **Walk** is voice mode.

**From the terminal:**

```bash
switchboard ls
switchboard send boss "what is everyone working on?"
switchboard spawn api --cwd ~/code/blessedbets --prompt "Run the tests and fix what fails"
switchboard screen api
switchboard attach boss        # the real terminal; detach with Ctrl-b d
switchboard tasks
switchboard task add "Fix the odds cache" --project blessedbets --priority P0
switchboard search "timezone bug"
switchboard down               # stops the hub; sessions keep running
```

**Sessions you start by hand** can join too:

```bash
switchboard install-mcp
claude --dangerously-load-development-channels server:switchboard
```

They name themselves after their tmux session or folder (`SWITCHBOARD_SESSION=name` to choose).

## The phone app

`mobile/` is an Expo (React Native) app for iPhone and Android. You build and install it once,
from the same terminal on the same computer; after that it keeps itself up to date.
[`mobile/README.md`](mobile/README.md) walks through it. In short, for Android:

```bash
switchboard app setup
```

```bash
cd ~/blessedbets/switchboard/mobile && npm install && npx eas-cli build --platform android --profile preview
```

The build runs on Expo's servers (free account) and ends with a link: open it on the phone to
install. iPhone builds need a paid Apple Developer account, or a Mac with Xcode. Then open the
app and scan the first code from `switchboard pair`.

It has the same sessions, chat, terminal peek, backlog, search and approvals as the web UI,
and three things a web page cannot do:

- **Walk mode** keeps it running in your pocket with the screen off: replies are read aloud,
  your Flic button starts and stops recording, and a headset (or a Flic set up as a media
  button) play/pause toggles talking too.
- **Phone actions** for sessions: calendar, location, battery, clipboard, notifications,
  opening apps, drafting texts and emails. Reading location, clipboard and calendar is off
  until you switch it on in the app's Settings.
- **Lock-screen replies and approvals** from notifications (push needs an EAS project; see the
  app README).

### It updates itself

The hub speaks the [Expo Updates protocol](https://docs.expo.dev/technical-specs/expo-updates-1/),
so the app fetches new versions of its JavaScript from **your** hub:

```bash
switchboard app publish --message "Bigger talk button"
```

bundles `mobile/` for iOS and Android, stores it on the hub, and tells connected phones; each
downloads it and restarts into it as soon as you are not mid-sentence. Phones that were off
pick it up the next time they open. The orchestrator does this itself when you ask it to change
the app. A broken update rolls back (`switchboard app rollback`), and the app falls back to the
last version that started.

Changes that need new native code (a new native module, a permission, an Expo SDK upgrade)
cannot travel over the air. Bump `RUNTIME_VERSION` in `mobile/app.config.ts` and build again.
On Android the hub can hand out the new build too: `switchboard app native app.apk --version
1.1.0`, and the app offers to install it.

## Push to talk with a Flic button

The simplest way needs only the Flic app on your phone. For each gesture, add an **Internet
Request** action (GET) with the links from `switchboard flic` (also in the web UI under
Settings → Flic):

| Gesture | Link | Does |
| --- | --- | --- |
| Click | `/api/ptt/toggle?token=…` | start talking; click again to send |
| Double click | `/api/ptt/cancel?token=…` | throw the recording away, stop reading aloud |
| Hold | `/api/ptt/start?token=…` | start talking |

The press travels phone → hub → back to whichever device has walk mode on (the app, or a
browser with Walk open), which records. Keep walk mode on and Tailscale connected.

With a **Flic Hub**, `flic/hub-sdk-ptt.js` gives real hold-to-talk: recording while the button
is down, sent on release.

**What you can say:** anything goes to the session you are talking to (boss by default).
"Switch to api" changes who you talk to. "api, run the tests" sends one message to api.
"Approve" or "deny" right after an approval is read out answers it.

Speech becomes text on the phone (Apple's or Google's recognizer) unless the hub has a
transcription service: set `OPENAI_API_KEY`, `GROQ_API_KEY`, or `STT_BASE_URL` for any
OpenAI-compatible server, including one running on your own machine.

## Keep it running

`switchboard up` survives closing the terminal (everything lives in tmux) but not a reboot.
To start the hub at login, on macOS save this as
`~/Library/LaunchAgents/dev.switchboard.hub.plist` (put your Mac username in the path, and use
the output of `which node` for the first one), then
`launchctl load ~/Library/LaunchAgents/dev.switchboard.hub.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.switchboard.hub</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/YOUR-NAME/blessedbets/switchboard/src/hub/main.ts</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/switchboard-hub.log</string>
  <key>StandardErrorPath</key><string>/tmp/switchboard-hub.log</string>
</dict></plist>
```

On Linux or WSL, a systemd user unit (`~/.config/systemd/user/switchboard.service`; replace
`NODE` with the output of `which node`), then `systemctl --user enable --now switchboard`:

```ini
[Service]
ExecStart=NODE %h/blessedbets/switchboard/src/hub/main.ts
Restart=always
[Install]
WantedBy=default.target
```

Then `switchboard up` only has to start the orchestrator.

## How the pieces fit

| Piece | Where | What |
| --- | --- | --- |
| Hub | `src/hub/` | Fastify server: REST, WebSocket, tmux control, voice, app updates. Run with `switchboard up` or `npm start`. |
| Channel | `src/channel/main.ts` | The MCP server inside every session. Declares `claude/channel` and `claude/channel/permission`, keeps a socket to the hub, pushes messages in as `notifications/claude/channel`, and gives the session its tools. |
| Hooks | `src/hook.ts` | Claude Code hooks (start, prompt, stop, notification, end) that report status and let the hub copy the session's transcript into Postgres. |
| Web UI | `web/` | Preact without a build step. Edits show on the next reload. |
| Phone app | `mobile/` | Expo SDK 58. |
| Orchestrator brief | `orchestrator/CLAUDE.md` | How boss runs things. |
| CLI | `src/cli.ts` | `switchboard …` |

**Sessions** are tmux sessions named `sb-<name>`, each running:

```
claude --mcp-config ~/.switchboard/sessions/<name>.mcp.json \
       --settings ~/.switchboard/claude-settings.json \
       --dangerously-load-development-channels server:switchboard \
       --name <name> --append-system-prompt "<who you are, how to answer>"
```

Messages for a session that is not connected are kept and pushed in, in order, when it
connects. Each message shows ✓ (stored), ✓✓ (pushed into the session) and **seen** (found in
the session's own transcript, so Claude really has it).

**The database** (`src/hub/schema.ts`): `sessions`, `messages` (full-text indexed),
`projects`, `tasks` and `task_events` (every change and comment), `permission_requests`,
`devices`, `transcript_entries`, `app_updates`, `native_builds`.

## Security

- Everything except the static web page, the health check and the app-update files needs the
  token (`~/.switchboard/token`, created on first run, readable only by you). Phones and
  browsers get it from the pairing code. `switchboard pair` codes carry it: keep them to
  yourself.
- The hub listens on 127.0.0.1 by default. Reach it through `tailscale serve`, which adds HTTPS
  and keeps it inside your tailnet. `SWITCHBOARD_HOST=0.0.0.0` exposes it on your network.
- A channel is a way to put text in front of Claude. Only holders of the token can send
  through this one, and every message is labelled with who sent it.
- Approving a tool from your phone is the same as approving it in the terminal. Approvals by
  voice only count right after an approval was read out.
- The app-update files are served without the token (they hold no secrets) so a phone can
  update before it is paired. `SWITCHBOARD_UPDATES_PUBLIC=0` requires the token for them too.
- The orchestrator is told never to place trades, move money or change financial account
  settings, and to confirm anything destructive or outward-facing.

## Troubleshooting

- **A session shows "channel not connected".** It is running but its channel has not reached
  the hub: `switchboard screen <name>`, then `/mcp` in its terminal shows why. A hub restart
  heals itself within seconds.
- **"needs attention" after starting a session.** Claude Code is showing a question the hub
  does not answer for you (for example a project's own `.mcp.json` asking for consent). Answer
  it from the web UI's **Screen**, or `switchboard attach <name>`.
- **Messages arrive but nothing happens.** Channels need Claude Code 2.1.80+, a claude.ai or
  Console login, and on Team/Enterprise plans the admin setting. The terminal shows
  `Channels (experimental)` under the banner when it is working.
- **Flic does nothing.** Walk mode must be open on the phone, and the phone must reach the hub:
  open the Flic link in the phone's browser; it should answer `{"ok":true,...}`.
- **No sound when the phone is locked (iPhone).** Start walk mode while the app is open; iOS
  only keeps an app's audio alive if it started in the foreground.

## Development

```bash
npm run typecheck
npm test                     # unit + integration: real Postgres, real channel server over MCP, tmux
cd mobile && npx tsc --noEmit
```

The integration tests start their own Postgres (or use `TEST_DATABASE_URL`), their own tmux
server, and a stand-in for `claude` (`test/fixtures/fake-claude.mjs`) that shows the same
startup dialogs and runs MCP servers the way Claude Code does. The real `claude` is never
called and no model is used.
