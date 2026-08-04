# WatchKlyp

A `!watch` chat command + Stream Deck button that pull the **most recent
Twitch clip link posted in your chat** (by anyone — not necessarily your own
channel's clips) straight into a Streamlabs OBS browser source — instantly,
no clicking required. Runs entirely on your own PC; no third-party bot
dashboard (Nightbot, StreamElements, etc.) involved, so nothing outside your
control can go down.

How it works: a small local server watches your chat for Twitch clip links
(`clips.twitch.tv/...` or `twitch.tv/channel/clip/...`) and remembers the
most recent one. Either trigger — chat message `!watch`, or a Stream Deck
button hitting a local URL — looks up that clip and pushes it over a
WebSocket to a browser-source page, which swaps it in immediately. Playback
is chrome-less (no Twitch controls/branding) via Twitch's official
clip-download API when available, falling back automatically to Twitch's
standard embed player if that ever doesn't cooperate.

## 1. Install & run

Requires [Node.js](https://nodejs.org) (v18+). No Twitch dev account, app
registration, or `.env` editing needed — everything authorizes through one
shared WatchKlyp Twitch application.

- Easiest: double-click **`start.bat`**. It installs dependencies the first
  time, then starts the server and opens your browser to it automatically.
  Leave the window open while you stream (or see "Run at startup" below).
- Or from a terminal: `npm install` then `npm start`.

## 2. Enter your channel name

Your browser opens automatically to a one-time setup page — enter your
Twitch channel login name (all lowercase, the part after twitch.tv/ in your
channel URL) and click **Save**. This is stored locally in `config.json`, not
`.env`. You can change it later from the `/status` page.

## 3. Authorize the chat bot (one-time)

After saving your channel, you'll land on the status page — click
**"click here to authorize"**. The server needs permission to read/send chat
as your account (or a bot account — see note below), plus permission to
fetch clip video files for chrome-less playback.

1. Log in with the account that should post as the bot (your own account is
   fine — it'll only speak when `!watch` is used).
2. You should land on an actual Twitch permissions screen listing the
   requested scopes — click **Authorize**. You'll then land on
   `https://localhost:3940/...` and your browser will show a "connection is
   not private" warning — that's expected, it's the self-signed cert for the
   local callback listener. Click **Advanced → Proceed to localhost**
   (Chrome) or equivalent, and you'll see "Authorized!". The chat bot
   connects automatically from then on, including on future restarts (it
   saves a token locally in `token.json`).

Want a separate bot account instead of your own? Just log into that account
in the browser before visiting the authorize link.

> **Already authorized before, or want a clean slate?** Visit
> `/auth/twitch` again any time to re-authorize (it always shows the
> permissions screen, even if you'd approved before). You can also manage or
> fully revoke access from https://www.twitch.tv/settings/connections — the
> `/status` page links there directly, and checks live with Twitch rather
> than just trusting the local token file.

> **Running your own Twitch app instead of the shared one?** Set
> `TWITCH_CLIENT_ID` in `.env` — it must be registered as a **Public** client
> type (Public apps use this PKCE flow and have no secret) with redirect URL
> `https://localhost:3940/auth/twitch/callback`. Not something most people
> need to touch.

## 4. Add the browser source in Streamlabs OBS

1. In Streamlabs OBS, add a new **Browser Source**.
2. URL: `http://localhost:3939/browser-source.html`
3. Set width/height to match your scene (e.g. 1920x1080, or a smaller box
   wherever you want the clip to appear).
4. Leave "Shutdown source when not visible" **unchecked** — otherwise the
   page disconnects from the server while hidden and misses triggers.

It's fully transparent/blank until triggered, and goes back to blank
automatically once the clip finishes playing — no manual refresh needed, and
nothing sits on screen when idle. If Streamlabs ever seems to be showing a
stale clip, right-click the source → **Refresh** to force it to reload.

## 5. Set up Stream Deck buttons

No plugin needed — Stream Deck's built-in **Website** action can fire a
silent background request. Set up as many of these as you want, each on its
own button:

1. In the Stream Deck app, drag the **Website** action (under System) onto a
   button.
2. URL: one of the three below.
3. Check **"Run in Background"** (this is the key setting — it fires the
   request without popping open a browser window).
4. Give it a matching icon/title.

| Button        | URL                                    | What it does |
|---------------|-----------------------------------------|--------------|
| Watch Clip | `http://localhost:3939/api/latest-clip` | Same as typing `!watch` in chat |
| Stop       | `http://localhost:3939/api/stop`        | Immediately hides whatever's playing (also stops clip cycling, see below) |
| Pause/Resume | `http://localhost:3939/api/pause`     | Toggles playback — **only works while a chrome-less clip is playing**; does nothing during the plain iframe embed, since Twitch doesn't expose any external control over it |

Only a mod or the broadcaster can trigger `!watch` from chat — anyone can
still paste a clip link (that's how "latest posted" gets set), but random
viewers can't pull it up on stream themselves. The Stream Deck button and
`/api/latest-clip` aren't affected by this (you're the one pressing it).

## 6. Clip cycling (auto-play through your own clips on a scene)

A separate mode that auto-plays through *this channel's own* clip library,
back-to-back, meant to run only while a specific OBS/Streamlabs scene is up
(e.g. a "Be Right Back" or intermission scene) — no manual triggering needed
once it's going.

Since every clip it cycles through belongs to the account that authorized
WatchKlyp, it can always use chrome-less `<video>` playback (the two-tier
fallback in the Notes section below doesn't come into play here), and the
browser source advances to the next clip the instant a clip's video actually
finishes — a real `ended` event, not a guessed timer — so transitions are
seamless. That's specifically what the plain Twitch iframe player can't do:
it has no way to tell us exactly when a clip finished, so cycling through it
would mean guessing at timing between clips.

| Endpoint | What it does |
|---|---|
| `http://localhost:3939/api/cycle/start` | Fetches ~20 of the channel's own clips (shuffled), starts cycling |
| `http://localhost:3939/api/cycle/stop`  | Stops cycling and clears the browser source |

There's no automatic OBS scene-state detection (that would need Streamlabs'
websocket API — a bigger feature, ask if you want it added later). The
practical way to tie this to a scene today is a **Stream Deck multi-action**:
one button that both switches to that scene *and* hits `/api/cycle/start`
(Website action, "Run in Background"), and another that switches away *and*
hits `/api/cycle/stop`. The plain **Stop** button above also stops cycling,
so it works as a universal kill switch if something looks wrong.

## Notes

- **What counts as "latest"**: whichever Twitch clip link was most recently
  posted in your chat since the bot started — from any channel, by any
  viewer (or you). It is *not* your own channel's most recent clip; to test
  it, paste any clip link in chat first (an old clip works fine — "latest
  posted" means most recently pasted, not most recently created).
- **No clip posted yet**: if nobody's shared a clip link since the bot
  started, `!watch` replies with a small warning in chat instead of doing
  nothing silently.
- **Chrome-less playback, two tiers**: Twitch's official clip-download API
  only works for clips from a channel you're authorized to manage (your own),
  so for clips from other streamers WatchKlyp tries an unofficial
  thumbnail-derived video URL instead — a long-used community trick, not a
  supported Twitch API. It usually works, but isn't guaranteed and could stop
  working without warning if Twitch changes how clip files are stored. If it
  ever doesn't play, the browser source automatically falls back to Twitch's
  regular embed player — you'll just see Twitch's UI on that particular clip.
- **Cooldown**: triggers are rate-limited to once per 3 seconds to avoid chat
  spam. Starting a manual `!watch`/Stream Deck trigger automatically stops
  clip cycling if it was running, so the two don't fight over the browser
  source.
- **Multiple browser sources**: every open browser-source page updates
  together, since the server broadcasts to all of them.
- **Run at Windows startup (optional)**: press `Win+R`, type `shell:startup`,
  and drop a shortcut to `start.bat` in that folder so it launches whenever
  you log in.
- **Two ports, on purpose**: `3939` (plain http) serves the browser source and
  Stream Deck endpoint — Streamlabs OBS's embedded browser won't accept a
  self-signed cert, so this stays on http. `3940` (https, self-signed) exists
  solely so Twitch will accept the OAuth redirect URL; you only ever touch it
  once, during the one-time authorize step.

## Troubleshooting

- **Browser didn't open automatically** — just open
  `http://localhost:3939` yourself; the server's running fine either way.
- **Chat bot never says anything / stays "not authorized"** — visit
  `http://localhost:3939/status` to check authorization state, then
  `/auth/twitch` to (re)authorize.
- **Browser source stays blank after pressing the button** — check the
  terminal window running the server for errors, or check that a clip link
  has actually been posted in chat since the bot started.
- **Stream Deck button does nothing** — make sure "Run in Background" is
  checked, and that the server is running (the URL only works while
  `start.bat` / `node server.js` is active).
- **`!watch` does nothing when a viewer types it** — that's expected, it's
  mod/broadcaster-only now. Check the terminal log, which logs an "Ignored
  !watch from ..." line for non-mods.
- **`/api/cycle/start` responds with "No clips found"** — the channel needs
  at least one existing clip; WatchKlyp pulls from clips that already exist,
  it doesn't create new ones.
