# Deskat

A desktop companion for macOS: animated characters (two cats, Grace and Linux, and two people,
Nati and Roei) that live at the bottom of your screen, made from real photos turned into
transparent video clips.

It is also a small assistant:

- **Chat** with any character in a speech bubble, in that character's own style (`⌃⌥D` from anywhere)
- **Reminders, to-dos and notes** by just asking in the chat ("remind me in 20 min to call mom")
- **Google Calendar** meeting reminders with a live countdown and a Join button, plus "What's next today?"
- **Gmail alerts** for important mail, with one-click Summarize
- **Morning brief** the first time you're at the Mac each day
- **Clipboard actions**: summarize, translate, fix grammar, make polite
- **Focus mode**: stays quiet during meetings and calls, and hides from screen sharing

## Run it

Requires macOS and Node.js 20+.

```bash
cd app
npm install
npm run dev
```

Click the 🐾 in the menu bar → **Settings…** to pick a character and set things up.

## Connect your own accounts

Nothing is shared between installs: every person uses their own accounts, and all keys and
tokens are stored encrypted on their own Mac (Electron `safeStorage` / Keychain), never in this repo.

- **Claude (chat)**: create an API key at [console.anthropic.com](https://console.anthropic.com/settings/keys),
  add a few dollars of credit, and paste the key in Settings → Assistant. Usage is billed to your
  own key; on the default Haiku model a normal day of chatting costs well under a cent.
- **Google Calendar & Gmail** (optional, read-only): create your own free OAuth client
  (Settings → Google shows the 3 steps: a Google Cloud project with the Calendar and Gmail APIs
  enabled, yourself as a test user, and a *Desktop app* client), then **Load client JSON…** →
  **Connect**. While the Google app is in "Testing" mode, Google asks you to reconnect about once a week.

## Project layout

- `app/`: the Electron + React + TypeScript app (`src/main` = windows, calendar, mail, chat;
  `src/renderer` = character player, speech bubble, settings)
- `grace/`, `linux/`, `nati/`, `roei/`: one folder per character: `cat.json` (clips, actions,
  personality), `final/*.webm` (transparent clips), `master.jpg` and `poses/` (source stills)
- `tools/`: the background-removal pipeline that turned the generated videos into transparent clips
