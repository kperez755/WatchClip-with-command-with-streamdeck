# WatchKlyp

A `!watch` chat command and Stream Deck button that pull the most recent
Twitch clip posted in your chat straight into a Streamlabs OBS browser
source — instantly, no clicking required. Everything runs locally on your
own PC, so there's no third-party bot dashboard (Nightbot, StreamElements,
etc.) that can go down on you.

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Clip cycling](#clip-cycling)
- [Staying up to date](#staying-up-to-date)
- [Notes](#notes)
- [Troubleshooting](#troubleshooting)

## Features

- **`!watch` chat command** — grabs whichever Twitch clip link was most
  recently posted in chat, by anyone, and plays it instantly
- **Stream Deck integration** — dedicated buttons for Watch Clip, Stop, and
  Pause/Resume; no plugin required
- **Chrome-less playback** — clips play with no Twitch UI or branding, via
  the official clip-download API, falling back automatically to Twitch's
  embed player if that's ever unavailable
- **Mod-only trigger** — only a moderator or the broadcaster can fire
  `!watch` from chat, so random viewers can't hijack the screen
- **Clip cycling** — auto-plays through your own clip library back-to-back,
  meant to pair with a dedicated OBS scene
- **Zero setup for testers** — authorizes through one shared Twitch
  application; no dev account, app registration, or `.env` editing required
- **Self-hosted auth** — no third-party token generator; authorization
  happens entirely on your own machine and nothing outside your control can
  break it
- **Update check** — notices when a newer version has shipped and offers to
  apply it with one click; nothing happens without you approving it

## How it works

A small local server watches your chat for Twitch clip links
(`clips.twitch.tv/...` or `twitch.tv/channel/clip/...`) and remembers the
most recent one. Either trigger — the `!watch` chat command, or a Stream
Deck button hitting a local URL — looks up that clip and pushes it over a
WebSocket to a browser-source page, which swaps it in immediately.

## Quick start

### 1. Install and run

Requires [Node.js](https://nodejs.org) (v18+).

- Easiest: double-click **`start.bat`**. It installs dependencies the first
  time, then starts the server and opens your browser to it automatically.
  Leave the window open while you stream (or see [Run at Windows
  startup](#notes) below).
- Or from a terminal: `npm install` then `npm start`.

### 2. Connect your channel

Your browser opens automatically to a one-time setup page — enter your
Twitch channel login name (all lowercase, the part after twitch.tv/ in your
channel URL) and click **Continue**. This is stored locally in
`config.json`, not `.env`, and you can change it later from the status page.

### 3. Authorize with Twitch

After saving your channel, you'll land on the status page — click
**Authorize with Twitch**. The server needs permission to read/send chat as
your account (or a bot account, see below), plus permission to fetch clip
video files for chrome-less playback.

1. You'll land on a page with a **Continue on Twitch** link and a short
   code. Click it (or open it on your phone — it works from any device).
2. Log in with the account that should post as the bot (your own account is
   fine — it only speaks when `!watch` is used), and approve the request.
3. That's it — no code to type, nothing to copy. The WatchKlyp tab notices
   automatically and takes you to the status page once you've approved it on
   Twitch. The chat bot connects from there, including on future restarts
   (it saves a token locally in `token.json`).

Want a separate bot account instead of your own? Just log into that account
before approving the request.

> **Already authorized before, or want a clean slate?** Visit
> `/auth/twitch` any time to re-authorize. You can also manage or fully
> revoke access from twitch.tv/settings/connections; the status page links
> there directly, and checks live with Twitch rather than just trusting the
> local token file.

> **Running your own Twitch app instead of the shared one?** Set
> `TWITCH_CLIENT_ID` in `.env` — it must be registered as a **Public**
> client type (this app uses the device code flow and has no secret). Not
> something most people need to touch.

### 4. Add the browser source in Streamlabs OBS

1. In Streamlabs OBS, add a new **Browser Source**.
2. URL: `http://localhost:3939/browser-source.html`
3. Set width/height to match your scene (e.g. 1920x1080, or a smaller box
   wherever you want the clip to appear).
4. Leave "Shutdown source when not visible" **unchecked** — otherwise the
   page disconnects from the server while hidden and misses triggers.

It's fully transparent and blank until triggered, and goes back to blank
automatically once the clip finishes playing — no manual refresh needed, and
nothing sits on screen when idle. If Streamlabs ever seems to show a stale
clip, right-click the source and choose **Refresh** to force it to reload.

### 5. Set up Stream Deck buttons

No plugin needed — Stream Deck's built-in **Website** action can fire a
silent background request. Set up as many of these as you want, each on its
own button:

1. In the Stream Deck app, drag the **Website** action (under System) onto a
   button.
2. URL: one of the four below.
3. Check **"Run in Background"** — this is the key setting; it fires the
   request without popping open a browser window.
4. Give it a matching icon and title.

| Button | URL | What it does |
|---|---|---|
| Watch Clip | `http://localhost:3939/api/latest-clip` | Same as typing `!watch` in chat |
| Stop | `http://localhost:3939/api/stop` | Immediately hides whatever's playing (also stops clip cycling) |
| Pause/Resume | `http://localhost:3939/api/pause` | Toggles playback — only works during chrome-less playback; does nothing during the plain iframe embed, since Twitch doesn't expose any external control over it |
| Create Clip | `http://localhost:3939/api/clip/create` | Clips your own live stream right now, same as Twitch's own clip button — only works while you're live, and needs one re-authorization if you set WatchKlyp up before this feature existed. Posts "Clip created: ... link" in chat once it's ready |

All of these URLs are also listed on the status page (`http://localhost:3939/status`) with one-click copy buttons.

Only a mod or the broadcaster can trigger `!watch` from chat — anyone can
still paste a clip link (that's how "latest posted" gets set), but random
viewers can't pull it up on stream themselves. The Stream Deck button and
`/api/latest-clip` aren't affected by this, since you're the one pressing it.

## Clip cycling

A separate mode that auto-plays through this channel's own clip library,
back-to-back, meant to run only while a specific OBS/Streamlabs scene is up
(a "Be Right Back" or intermission scene, for example) — no manual
triggering needed once it's going.

Since every clip it cycles through belongs to the account that authorized
WatchKlyp, it always uses chrome-less `<video>` playback (the two-tier
fallback described in [Notes](#notes) doesn't come into play here), and the
browser source advances to the next clip the instant a clip's video actually
finishes — a real `ended` event, not a guessed timer — so transitions are
seamless. That's specifically what the plain Twitch iframe player can't do:
it has no way to signal exactly when a clip finished, so cycling through it
would mean guessing at timing between clips.

| Endpoint | What it does |
|---|---|
| `http://localhost:3939/api/cycle/start` | Fetches ~20 of the channel's own clips (shuffled) and starts cycling |
| `http://localhost:3939/api/cycle/stop` | Stops cycling and clears the browser source |

There's no automatic OBS scene-state detection — that would need Streamlabs'
websocket API, a bigger feature for later if it's wanted. The practical way
to tie this to a scene today is a **Stream Deck multi-action**: one button
that both switches to that scene and hits `/api/cycle/start` (Website
action, "Run in Background"), and another that switches away and hits
`/api/cycle/stop`. The plain **Stop** button also stops cycling, so it works
as a universal kill switch if something looks wrong.

## Staying up to date

If you set this up with `git clone` (rather than downloading a zip), the
status page checks GitHub once, a few seconds after the server starts, for a
newer commit on `main` (not on a timer — restart the app for a fresh check).
When one's found, a banner appears with **Update now** and **Not now**:

- **Update now** runs `git pull` + `npm install`, then restarts itself
  automatically — the page reloads on its own once it's back up. It only
  ever fast-forwards (never merges or overwrites anything), so if you've
  hand-edited files locally it'll fail safely and show the error instead of
  touching anything.
- **Not now** doesn't make the notice go away — it just shrinks down to a
  small **Out of date** line at the top of the page that stays there (with
  its own **Update** button) until you actually update.

Downloaded as a zip instead of cloned with git? This section just doesn't
appear — grab the latest zip from GitHub manually when you want to update.

## Notes

- **What counts as "latest"**: whichever Twitch clip link was most recently
  posted in your chat since the bot started, from any channel, by any
  viewer (or you). It is not your own channel's most recent clip — to test
  it, paste any clip link in chat first (an old clip works fine; "latest
  posted" means most recently pasted, not most recently created).
- **No clip posted yet**: if nobody's shared a clip link since the bot
  started, `!watch` replies with a short message in chat instead of doing
  nothing silently.
- **Chrome-less playback, two tiers**: Twitch's official clip-download API
  only works for clips from a channel you're authorized to manage (your
  own), so for clips from other streamers WatchKlyp tries an unofficial
  thumbnail-derived video URL instead — a long-used community trick, not a
  supported Twitch API. It usually works, but isn't guaranteed and could
  stop working without warning if Twitch changes how clip files are stored.
  If it ever doesn't play, the browser source automatically falls back to
  Twitch's regular embed player — you'll just see Twitch's UI on that
  particular clip.
- **Cooldown**: triggers are rate-limited to once per 3 seconds to avoid
  chat spam. Starting a manual `!watch`/Stream Deck trigger automatically
  stops clip cycling if it was running, so the two don't fight over the
  browser source.
- **Multiple browser sources**: every open browser-source page updates
  together, since the server broadcasts to all of them.
- **Launch at Windows startup (optional)**: on the status page, there's an
  **Enable** button under **Startup** that registers WatchKlyp to launch
  automatically (minimized) whenever you log into Windows — no manual
  shortcut needed. Click **Disable** there any time to turn it back off.
  Windows-only; the toggle doesn't appear on other platforms.
- **One port, no certs**: everything — browser source, Stream Deck
  endpoints, setup, and authorization — runs on plain http on `3939`. There's
  no separate HTTPS listener or self-signed cert to click through, since
  Twitch's device code flow doesn't use a redirect URL at all.

## Troubleshooting

- **Browser didn't open automatically** — just open
  `http://localhost:3939` yourself; the server's running fine either way.
- **Chat bot never says anything / stays "not authorized"** — visit
  `http://localhost:3939/status` to check authorization state, then
  authorize from there.
- **Browser source stays blank after pressing the button** — check the
  terminal window running the server for errors, or check that a clip link
  has actually been posted in chat since the bot started.
- **Stream Deck button does nothing** — make sure "Run in Background" is
  checked, and that the server is running (the URL only works while
  `start.bat` / `node server.js` is active).
- **`!watch` does nothing when a viewer types it** — that's expected, it's
  mod/broadcaster-only. Check the terminal log, which logs an "Ignored
  !watch from ..." line for non-mods.
- **`/api/cycle/start` responds with "No clips found"** — the channel needs
  at least one existing clip; WatchKlyp pulls from clips that already exist,
  it doesn't create new ones.
