# Switchboard for iPhone and Android

An Expo (React Native, SDK 58) app: sessions, chat, terminal peek, backlog, search,
approvals, walk mode with spoken replies and push to talk, phone actions for your sessions,
and over-the-air updates from your own hub.

You build and install it **once**. After that, `switchboard app publish` (which the
orchestrator runs itself when you ask it to change the app) updates every paired phone over
the air.

## 1. Set the hub address

The app downloads its updates from the hub address it was built with. Edit the
`SWITCHBOARD_PUBLIC_URL` lines in `eas.json` (for EAS builds), or export it before a local
build:

```bash
export SWITCHBOARD_PUBLIC_URL=https://your-mac.tail1234.ts.net
```

Optionally choose your own app identifiers with `SWITCHBOARD_IOS_BUNDLE_ID` and
`SWITCHBOARD_ANDROID_PACKAGE` (default `dev.switchboard.app`).

## 2. Build it

```bash
cd switchboard/mobile
npm install
```

**Android, easiest:** a cloud build with EAS gives you an `.apk` link to open on the phone.

```bash
npm install -g eas-cli
eas login
eas build --platform android --profile preview
```

**iPhone with EAS** needs a paid Apple Developer account. Register the phone, then build:

```bash
eas device:create
eas build --platform ios --profile preview
```

**On your own machine** (Xcode for iPhone, which works with a free Apple ID for 7-day installs;
Android Studio for Android), with the phone plugged in:

```bash
npx expo run:ios --device --configuration Release
npx expo run:android --variant release
```

Plain Expo Go will not do: the app uses native modules (background audio, speech
recognition), so it needs its own build.

## 3. Pair

Open the app and scan the code from `switchboard pair` (or the web UI's Settings). It checks
the hub answers before saving the address and token (in the phone's secure storage).

## Walk mode

Turn it on before the phone goes in your pocket. It plays a silent track with lock-screen
controls, which is what keeps an app (and its connection to the hub) alive with the screen
off on both iOS and Android, and it:

- reads replies aloud as they arrive (and shows them as notifications),
- starts and stops recording when your Flic button is pressed (see the main README),
- treats a headset's or media-mode Flic's play/pause as push to talk,
- reads out approvals; say "approve" or "deny".

Recording goes to the hub for transcription if it has a speech service set up, otherwise the
phone's own recognizer turns it into text.

## Updates

- **JavaScript changes** (almost everything): `switchboard app publish`. The app checks on
  launch, when it comes to the foreground, and the moment the hub announces an update; it
  restarts into the new version when you are not talking. Settings → App updates shows which
  version is running and can check by hand.
- **Native changes** (a new native module, a new permission, an Expo SDK upgrade): bump
  `RUNTIME_VERSION` in `app.config.ts` and build again. Phones only take updates made for their
  runtime, so an update that needs new native code never reaches a build that lacks it. On
  Android the hub can distribute the new build: `switchboard app native path/to/app.apk
  --version 1.1.0`; the app offers to download and install it (allow "install unknown apps"
  for Switchboard when Android asks).

## Push notifications (optional)

Without them, the app still notifies you while it is running (walk mode keeps it running).
To be notified when it is closed, give the build an EAS project and push credentials:

```bash
eas init                     # prints the project id
export EAS_PROJECT_ID=...    # or add it to the env of each eas.json profile
eas credentials              # Android: upload an FCM key; iOS: EAS creates the APNs key
```

then rebuild. The app registers its push token with the hub, and the hub sends a push when a
session writes to you and the phone is not connected. Notifications have **Reply** (type an
answer from the lock screen) and **Allow / Deny** for approvals.

## What sessions can do on the phone

The `phone` tool in every session: `speak`, `stop_speaking`, `notify`, `vibrate`, `open_url`
(web links and app deep links), `get_location`, `get_battery`, `get_device_info`,
`clipboard_get`, `clipboard_set`, `calendar_list`, `calendar_create`, `compose_sms`,
`compose_email`. Location, clipboard reading and the calendar stay off until you switch them
on in Settings. Texts and emails open as drafts for you to send.

## Checks

```bash
npx tsc --noEmit
npx expo export --platform ios --platform android   # what `switchboard app publish` builds
```
