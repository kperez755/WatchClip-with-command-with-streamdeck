/**
 * WatchKlyp — local server for a Twitch "!watch" chat command + Stream Deck
 * button that both pull the most recent Twitch clip *link shared in chat*
 * (by anyone, not necessarily your own channel's clips) into a Streamlabs
 * OBS browser source, instantly, with no external/third-party service involved.
 *
 * Pieces:
 *  - Express server serving public/browser-source.html (the OBS source)
 *  - WebSocket push: tells the open browser source to swap in a new clip
 *  - GET /api/latest-clip: fetch-and-broadcast trigger (hit by Stream Deck)
 *  - tmi.js chat bot: watches chat for clip links, and listens for "!watch"
 *    to trigger playback of whichever clip link was posted most recently
 *  - Self-contained Twitch OAuth flow (no third-party token generator needed)
 *
 * Auth model: every install authorizes through one shared Twitch application
 * (Public client type, Device Code Flow — no client secret exists or is
 * needed, and no redirect URL/HTTPS listener either). This means testers
 * never register their own Twitch dev app; they just run the server, enter
 * their channel name, click Authorize, and approve on twitch.tv in any
 * browser (even their phone). Channel name lives in config.json (set via the
 * in-app setup page), not .env.
 */

const path = require('path');
const fs = require('fs');

// When bundled into a standalone .exe (via pkg), __dirname points inside the
// read-only virtual snapshot. Writable/user-editable files (.env, token.json,
// the generated cert) need to live next to the actual exe on disk instead.
const EXE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;

// Mirror everything printed to the terminal into a plain text file too, so
// logs can be opened/shared without relying on copying from the console
// window (which can be unreliable, e.g. scrollback limits). Fresh file each
// time the server starts.
const LOG_PATH = path.join(EXE_DIR, 'watchklyp.log');
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'w' });
function stringifyArg(a) {
  return typeof a === 'string' ? a : (a && a.stack) || JSON.stringify(a);
}
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    try {
      logStream.write(`[${new Date().toISOString()}] ${level.toUpperCase()}: ${args.map(stringifyArg).join(' ')}\n`);
    } catch {}
  };
}
console.log(`[watchklyp] Logging to ${LOG_PATH}`);

require('dotenv').config({ path: path.join(EXE_DIR, '.env') }); // optional now — fine if the file doesn't exist
const { exec, execFile, spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const tmi = require('tmi.js');

// Shared WatchKlyp Twitch application (Public client — no secret). Every
// install uses this same Client ID; testers never need their own Twitch dev
// app. Overridable via .env for advanced use (e.g. running your own app).
const {
  TWITCH_CLIENT_ID = '4qgo5nr361rj7iagxghu4a8fbsgnkb',
  PORT = 3939,
} = process.env;

const TOKEN_PATH = path.join(EXE_DIR, 'token.json');
const CONFIG_PATH = path.join(EXE_DIR, 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();
// One-time migration for existing installs (like yours) that had
// TWITCH_CHANNEL set in .env under the old setup — carries it over to
// config.json so nothing breaks on upgrade, no re-entry needed.
if (!config.channel && process.env.TWITCH_CHANNEL) {
  config = { channel: process.env.TWITCH_CHANNEL.trim().toLowerCase() };
  saveConfig(config);
  console.log(`[watchklyp] Migrated TWITCH_CHANNEL from .env to config.json (${config.channel}).`);
}
// Mutable — set for the first time via the in-app setup page at "/" if this
// is a fresh install with no config.json yet.
let channelLogin = config.channel || null;

// Opens the user's default browser to a local URL, so the app is immediately
// visible on start instead of a bare terminal window. Best-effort — if it
// fails (unsupported platform, etc.) the server keeps running regardless.
function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.warn('[watchklyp] Could not auto-open browser:', err.message);
  });
}

// ---------------------------------------------------------------------------
// Auto-start on Windows login — flips a per-user registry value under
// HKCU\...\Run, so no admin rights are needed. Points at start.bat itself
// (launched minimized), which already handles first-run npm install, so
// autostart works identically to double-clicking it by hand. This is
// Windows-only; other platforms just report unsupported and the status page
// hides the toggle.
// ---------------------------------------------------------------------------
const AUTOSTART_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_VALUE_NAME = 'WatchKlyp';

function isAutoStartSupported() {
  return process.platform === 'win32';
}

function getAutoStartStatus() {
  return new Promise((resolve) => {
    if (!isAutoStartSupported()) return resolve(false);
    execFile('reg', ['query', AUTOSTART_REG_KEY, '/v', AUTOSTART_VALUE_NAME], (err) => {
      resolve(!err); // reg query exits non-zero if the value doesn't exist
    });
  });
}

function setAutoStart(enabled) {
  return new Promise((resolve, reject) => {
    if (!isAutoStartSupported()) {
      return reject(new Error('Auto-start is only supported on Windows.'));
    }
    if (!enabled) {
      execFile('reg', ['delete', AUTOSTART_REG_KEY, '/v', AUTOSTART_VALUE_NAME, '/f'], (err) => {
        // Exits non-zero if the value was already gone — that's fine, the
        // end state (not registered) is what we wanted either way.
        resolve();
      });
      return;
    }
    const startBatPath = path.join(EXE_DIR, 'start.bat');
    // Launched via `start ... /min` so login doesn't pop a visible console
    // window the way manually double-clicking start.bat does.
    const command = `cmd /c start "" /min "${startBatPath}"`;
    execFile(
      'reg',
      ['add', AUTOSTART_REG_KEY, '/v', AUTOSTART_VALUE_NAME, '/t', 'REG_SZ', '/d', command, '/f'],
      (err) => {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Every outbound call to Twitch below goes through this instead of bare
// fetch(). None of them had a timeout before, which meant a single slow or
// stalled response from Twitch (their clip-download endpoint is beta and can
// be flaky) would hang that request forever with no error and no recovery —
// exactly what caused clip playback to silently "freeze" and stop responding
// to further triggers. A hung promise never rejects on its own, so no amount
// of try/catch fixes it; only an explicit abort does.
// ---------------------------------------------------------------------------
const FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Live update check — compares the local git commit against GitHub's main
// branch, so a running install can notice when a new version has shipped.
// Only works when this is an actual git checkout (not a zip download); the
// status page hides the whole feature otherwise. Nothing here touches your
// files unless you click "Update now" — checking just reads state.
//
// Goes through `git fetch` + rev-parse rather than GitHub's REST API —
// same github.com the repo already talks to for every pull, no separate
// API host, no rate limit, and it pre-warms the fetch that "Update now"
// would need anyway.
// ---------------------------------------------------------------------------
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes

let updateState = {
  supported: false,
  checking: false,
  localSha: null,
  remoteSha: null,
  remoteMessage: null,
  updateAvailable: false,
  dismissedSha: null, // "not now" hides the banner until an even newer commit lands
  lastCheckedAt: null,
  lastError: null,
  applying: false,
};

function isGitCheckout() {
  try {
    return fs.existsSync(path.join(EXE_DIR, '.git'));
  } catch {
    return false;
  }
}

// Small shell-command helper (goes through cmd.exe on Windows, same as
// openBrowser above) — used for git/npm here since npm's Windows launcher
// is a .cmd shim that a shell-less spawn can't resolve directly.
function runShell(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd: EXE_DIR, timeout: 90000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr && stderr.trim()) || err.message));
      resolve(stdout);
    });
  });
}

async function checkForUpdates() {
  updateState.supported = isGitCheckout();
  if (!updateState.supported) return;
  updateState.checking = true;
  try {
    const localSha = (await runShell('git rev-parse HEAD')).trim();
    await runShell('git fetch origin main --quiet'); // read-only — updates origin/main, never touches the working tree
    const remoteSha = (await runShell('git rev-parse origin/main')).trim();
    const remoteMessage = (await runShell('git log -1 --format=%s origin/main')).trim().slice(0, 120);
    updateState.localSha = localSha;
    updateState.remoteSha = remoteSha;
    updateState.remoteMessage = remoteMessage;
    updateState.updateAvailable = !!(remoteSha && localSha !== remoteSha && remoteSha !== updateState.dismissedSha);
    updateState.lastCheckedAt = Date.now();
    updateState.lastError = null;
  } catch (err) {
    updateState.lastError = err.message;
    console.warn('[watchklyp] Update check failed:', err.message);
  } finally {
    updateState.checking = false;
  }
}

// Fast-forward only — never merges or overwrites local edits. If someone's
// hand-modified files in place, this fails loudly instead of clobbering
// anything, and the error surfaces straight to the status page.
async function applyUpdate() {
  if (!isGitCheckout()) {
    throw new Error("This isn't a git checkout, so it can't auto-update. Re-clone the repo with git to enable this.");
  }
  await runShell('git pull --ff-only');
  await runShell('npm install');
}

// Respawns a fresh, detached, windowless node process running the just-
// updated server.js, then exits this one — the new process picks up PORT
// once this one releases it (see the EADDRINUSE retry on startServer below,
// which is exactly what makes that handoff reliable instead of a race).
function scheduleSelfRestart() {
  console.log('[watchklyp] Restarting to apply update...');
  const child = spawn(process.execPath, [path.join(EXE_DIR, 'server.js')], {
    cwd: EXE_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  setTimeout(() => process.exit(0), 1200);
}

// ---------------------------------------------------------------------------
// Get Clips Download (official beta API) — gives us the raw clip video file
// so the browser source can play it with a plain, chrome-less <video> tag
// instead of Twitch's iframe player (no controls/branding, full JS control
// over show/hide). Requires the user token to carry channel:manage:clips.
// Falls back to the iframe embed automatically if this doesn't work.
// ---------------------------------------------------------------------------
async function getClipDownloadUrl(clipId, broadcasterId) {
  // editor_id must be the ID of the account that authorized WatchKlyp (you),
  // NOT the clip's channel owner — those only happen to match for clips from
  // your own channel, which is why that case worked and others 400'd.
  const token = await getValidToken();
  if (!token || !token.userId) return null;
  try {
    const params = new URLSearchParams({
      broadcaster_id: broadcasterId,
      editor_id: token.userId,
      clip_id: clipId,
    });
    const res = await fetchWithTimeout(`https://api.twitch.tv/helix/clips/downloads?${params}`, {
      headers: { 'Client-Id': TWITCH_CLIENT_ID, Authorization: `Bearer ${token.access_token}` },
    });
    if (!res.ok) {
      console.warn(`[watchklyp] Clip download API unavailable (${res.status}); falling back to embed.`);
      return null;
    }
    const data = await res.json();
    const entry = (data.data || [])[0];
    if (!entry) return null;

    // Field names per Twitch's Get Clips Download response:
    // landscape_download_url / portrait_download_url (signed, temporary URLs).
    return entry.landscape_download_url || entry.portrait_download_url || null;
  } catch (err) {
    console.warn('[watchklyp] Clip download fetch failed; falling back to embed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Unofficial fallback for clips from channels WatchKlyp isn't authorized to
// manage (the official API above only works for your own channel). Derives
// a direct video URL from the clip's thumbnail path — a long-used community
// trick, NOT a supported Twitch API. It can break without warning if Twitch
// changes how clip files are stored; the browser source already falls back
// to the regular embed automatically if this URL doesn't actually play.
// ---------------------------------------------------------------------------
function guessClipVideoUrl(clip) {
  if (!clip.thumbnail_url) return null;
  // Typical shape: https://clips-media-assets2.twitch.tv/SOMEPATH-preview-480x272.jpg
  // The actual video file lives at the same path with .mp4 instead.
  const match = clip.thumbnail_url.match(/^(.*)-preview-\d+x\d+\.jpg(?:\?.*)?$/i);
  if (!match) return null;
  return `${match[1]}.mp4`;
}

// ---------------------------------------------------------------------------
// Clip link detection — pulls the clip ID/slug out of a chat message so we
// can look up whichever clip was most recently *shared in chat* (by anyone),
// as opposed to the broadcaster's own most recent clip.
// Handles both URL shapes: clips.twitch.tv/SLUG and twitch.tv/channel/clip/SLUG
// ---------------------------------------------------------------------------
function extractClipSlug(message) {
  const clipPathMatch = message.match(/twitch\.tv\/[A-Za-z0-9_]+\/clip\/([A-Za-z0-9_-]+)/i);
  if (clipPathMatch) return clipPathMatch[1];
  const clipsSubdomainMatch = message.match(/clips\.twitch\.tv\/([A-Za-z0-9_-]+)/i);
  if (clipsSubdomainMatch) return clipsSubdomainMatch[1];
  return null;
}

// Tracks the most recent clip link posted in chat since the bot started.
let lastPostedClip = null; // { id, postedBy }

// Mod-only gate for the !watch trigger — anyone can still paste a clip link
// (that's how "latest posted" gets set), but only a mod or the broadcaster
// can actually pull it up on stream, so chat trolls/randoms can't hijack the
// screen mid-stream. tmi.js sets tags.mod for mods; the broadcaster doesn't
// get tags.mod=true from Twitch, so check their badge separately too.
function isModOrBroadcaster(tags) {
  if (tags.badges && tags.badges.broadcaster === '1') return true;
  return !!tags.mod;
}

// Look up a single clip by its ID/slug (much simpler than scanning a
// channel's clips — we already know exactly which one we want). Public
// clients have no client-credentials app token, so every Helix call just
// uses the signed-in user's own token instead — Twitch accepts a user token
// for these read-only endpoints just fine.
async function getClipById(clipId) {
  const token = await getValidToken();
  if (!token) return null;
  try {
    const res = await fetchWithTimeout(`https://api.twitch.tv/helix/clips?id=${encodeURIComponent(clipId)}`, {
      headers: { 'Client-Id': TWITCH_CLIENT_ID, Authorization: `Bearer ${token.access_token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.data || [])[0] || null;
  } catch (err) {
    console.warn('[watchklyp] Get Clips lookup failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Own-channel clip lookup — used by the clip-cycling feature below (a scene
// that auto-plays through the channel's own clip library). Separate from
// getClipById, which looks up one clip by ID from chat links.
// ---------------------------------------------------------------------------
let cachedBroadcasterId = null;

async function getOwnBroadcasterId() {
  if (cachedBroadcasterId) return cachedBroadcasterId;
  const token = await getValidToken();
  if (!token) return null;
  try {
    const res = await fetchWithTimeout(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(channelLogin)}`, {
      headers: { 'Client-Id': TWITCH_CLIENT_ID, Authorization: `Bearer ${token.access_token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    cachedBroadcasterId = (data.data || [])[0]?.id || null;
    return cachedBroadcasterId;
  } catch (err) {
    console.warn('[watchklyp] Get Users lookup failed:', err.message);
    return null;
  }
}

async function fetchOwnClips(limit = 20) {
  const broadcasterId = await getOwnBroadcasterId();
  if (!broadcasterId) return [];
  const token = await getValidToken();
  if (!token) return [];
  try {
    const params = new URLSearchParams({ broadcaster_id: broadcasterId, first: String(limit) });
    const res = await fetchWithTimeout(`https://api.twitch.tv/helix/clips?${params}`, {
      headers: { 'Client-Id': TWITCH_CLIENT_ID, Authorization: `Bearer ${token.access_token}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.data || [];
  } catch (err) {
    console.warn('[watchklyp] Fetch own clips failed:', err.message);
    return [];
  }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// WebSocket broadcast to the browser source page(s)
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

let lastTriggerAt = 0;
const TRIGGER_COOLDOWN_MS = 3000;

async function triggerLatestClip(source = 'unknown') {
  const now = Date.now();
  if (now - lastTriggerAt < TRIGGER_COOLDOWN_MS) {
    return { ok: false, cooldown: true, message: 'On cooldown, try again in a moment.' };
  }
  lastTriggerAt = now;
  stopCycling(); // a manual trigger takes over the browser source; don't let a cycling clip pop back up mid-way

  if (!lastPostedClip) {
    return { ok: false, message: 'No clip has been posted in chat yet.' };
  }

  try {
    const clip = await getClipById(lastPostedClip.id);
    if (!clip) {
      console.log(`[watchklyp] (${source}) Clip ${lastPostedClip.id} not found (deleted?).`);
      return { ok: false, message: 'That clip could not be found — it may have been deleted.' };
    }
    console.log(
      `[watchklyp] (${source}) Latest posted clip: "${clip.title}" clipped by ${clip.creator_name} ` +
      `from channel: ${clip.broadcaster_name} (${clip.broadcaster_id}), duration: ${clip.duration}s`
    );

    // Official chrome-less path only works for clips belonging to a channel that
    // has authorized this app (i.e. your own channel) — for clips from other
    // streamers this naturally 403s and falls back to the iframe embed.
    let videoUrl = await getClipDownloadUrl(clip.id, clip.broadcaster_id);
    let videoSource = videoUrl ? 'official' : null;
    if (!videoUrl) {
      videoUrl = guessClipVideoUrl(clip);
      if (videoUrl) videoSource = 'unofficial-guess';
    }
    console.log(`[watchklyp] Chrome-less video: ${videoUrl ? `yes (${videoSource})` : 'no (using iframe embed)'}`);

    broadcast({
      type: 'clip',
      id: clip.id,
      title: clip.title,
      creator: clip.creator_name,
      url: clip.url,
      videoUrl, // chrome-less playback when available (needs channel:manage:clips scope)
      embedUrl: `https://clips.twitch.tv/embed?clip=${clip.id}&parent=localhost&autoplay=true`, // fallback
      durationSeconds: clip.duration,
      createdAt: clip.created_at,
    });
    return { ok: true, clip };
  } catch (err) {
    console.error('[watchklyp] Error fetching latest clip:', err.message);
    return { ok: false, message: err.message };
  }
}

// ---------------------------------------------------------------------------
// Clip cycling — auto-plays through this channel's own clip library back to
// back, meant to be started/stopped alongside a specific OBS/Streamlabs
// scene (e.g. a "BRB"/intermission scene). Since these are always the
// configured channel's own clips, the official chrome-less video API works
// reliably every time — unlike the general !watch path, this doesn't need
// the unofficial fallback trick to get smooth, chrome-less playback.
//
// Transitions are driven by the browser source itself: it calls
// /api/cycle/next the instant a clip's <video> actually finishes (a real
// 'ended' event, frame-accurate) rather than the server guessing at timing
// with a countdown — which is exactly what made the plain Twitch iframe
// embed feel janky for back-to-back playback (no way to know when it
// actually finished, only guess-and-buffer). The server-side timer below is
// only a safety net for the rare case a specific clip falls back to the
// iframe embed instead.
// ---------------------------------------------------------------------------
const cycling = {
  active: false,
  clips: [],
  index: 0,
  generation: 0,
  safetyTimer: null,
};

function stopCycling() {
  cycling.active = false;
  cycling.generation += 1;
  clearTimeout(cycling.safetyTimer);
}

async function advanceCycle() {
  if (!cycling.active || cycling.clips.length === 0) return;
  clearTimeout(cycling.safetyTimer);

  const clip = cycling.clips[cycling.index];
  cycling.index = (cycling.index + 1) % cycling.clips.length;
  cycling.generation += 1;
  const myGeneration = cycling.generation;

  // Wrapped defensively so cycling can never permanently die mid-run — any
  // unexpected error here just means this one clip falls back to the iframe
  // embed instead of chrome-less video; the cycle itself keeps moving.
  let videoUrl = null;
  let videoSource = null;
  try {
    videoUrl = await getClipDownloadUrl(clip.id, clip.broadcaster_id);
    videoSource = videoUrl ? 'official' : null;
    if (!videoUrl) {
      videoUrl = guessClipVideoUrl(clip);
      if (videoUrl) videoSource = 'unofficial-guess';
    }
  } catch (err) {
    console.error('[watchklyp] (cycle) Error resolving video, falling back to embed:', err.message);
  }
  console.log(
    `[watchklyp] (cycle) "${clip.title}" (${clip.duration}s) — video: ${videoUrl ? videoSource : 'no, iframe fallback'}`
  );

  // Stopped, or superseded by another advance, while the fetch above was in
  // flight — drop this one instead of broadcasting a stale clip.
  if (!cycling.active || myGeneration !== cycling.generation) return;

  broadcast({
    type: 'clip',
    id: clip.id,
    title: clip.title,
    creator: clip.creator_name,
    url: clip.url,
    videoUrl,
    embedUrl: `https://clips.twitch.tv/embed?clip=${clip.id}&parent=localhost&autoplay=true`,
    durationSeconds: clip.duration,
    createdAt: clip.created_at,
    cycling: true,
  });

  cycling.safetyTimer = setTimeout(() => {
    if (cycling.active && myGeneration === cycling.generation) advanceCycle();
  }, (Number(clip.duration) || 30) * 1000 + 10000);
}

// ---------------------------------------------------------------------------
// Twitch OAuth (self-hosted — no third-party token site needed) for the
// chat-bot's user token (scopes: chat:read chat:edit)
// ---------------------------------------------------------------------------
function loadToken() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveToken(t) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(t, null, 2));
}

function clearToken() {
  try { fs.unlinkSync(TOKEN_PATH); } catch {}
}

// Ask Twitch directly whether a token is still valid (it won't be if the
// user revoked access from twitch.tv/settings/connections, even though our
// local token.json file still exists on disk). Also returns the scopes
// actually granted, since Twitch can silently keep old scopes on reuse.
async function validateToken(accessToken) {
  try {
    const res = await fetchWithTimeout('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${accessToken}` },
    });
    if (!res.ok) return { valid: false, scopes: [], userId: null };
    const data = await res.json();
    return { valid: true, scopes: data.scopes || [], userId: data.user_id || null };
  } catch {
    // Network hiccup — don't treat as revoked, just unknown; caller should
    // assume the cached token is still good rather than nuking it.
    return { valid: true, scopes: null, userId: null, unknown: true };
  }
}

// Loads token.json AND checks it's still actually valid with Twitch. If it's
// been revoked, clears the stale local file so state reflects reality.
//
// A single trigger (chat command or Stream Deck button) calls this from more
// than one place (e.g. getClipById + getClipDownloadUrl), which used to mean
// two full network round-trips to Twitch's /oauth2/validate per click before
// any actual clip data was fetched. That's cut down here with a short TTL
// cache — same access token seen again within the window skips the network
// call entirely. It self-invalidates on refresh/re-auth since a new token
// string won't match the cached one.
let tokenValidationCache = { token: null, result: null, checkedAt: 0 };
const TOKEN_VALIDATION_TTL_MS = 60_000;

async function getValidToken() {
  const token = loadToken();
  if (!token) return null;

  const now = Date.now();
  if (
    tokenValidationCache.token === token.access_token &&
    now - tokenValidationCache.checkedAt < TOKEN_VALIDATION_TTL_MS
  ) {
    return { ...token, ...tokenValidationCache.result };
  }

  const { valid, scopes, userId, unknown } = await validateToken(token.access_token);
  if (!valid) {
    console.warn('[watchklyp] Stored token was revoked/expired — clearing it. Re-authorize at /auth/twitch.');
    clearToken();
    tokenValidationCache = { token: null, result: null, checkedAt: 0 };
    return null;
  }

  const result = { scopes: unknown ? null : scopes, userId };
  tokenValidationCache = { token: token.access_token, result, checkedAt: now };
  return { ...token, ...result };
}

async function refreshUserToken(refreshToken) {
  // Public clients refresh without a secret too — just client_id + the
  // refresh token itself authenticates the request.
  const res = await fetchWithTimeout('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const token = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    obtained_at: Date.now(),
  };
  saveToken(token);
  return token;
}

// ---------------------------------------------------------------------------
// Device Code Flow — the auth flow Twitch actually supports for Public
// clients with no secret (their Authorization Code grant always requires a
// client_secret, confidential or not — confirmed against Twitch's own docs).
// No redirect URL or local HTTPS listener needed at all: we ask Twitch for a
// device_code + a short user_code, show the user a link to approve it on
// twitch.tv (in any browser, even their phone), and poll in the background
// until they do. Docs: https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow
// ---------------------------------------------------------------------------
const AUTH_SCOPES = 'chat:read chat:edit channel:manage:clips';

// Single in-flight auth attempt at a time — fine for a local single-user app.
// { device_code, user_code, verification_uri, expiresAt, interval, status, error }
let deviceAuth = null;

async function startDeviceAuth() {
  const form = new FormData();
  form.append('client_id', TWITCH_CLIENT_ID);
  form.append('scopes', AUTH_SCOPES);
  const res = await fetchWithTimeout('https://id.twitch.tv/oauth2/device', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.device_code) {
    throw new Error(data.message || `Failed to start device auth (${res.status})`);
  }
  deviceAuth = {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    expiresAt: Date.now() + (data.expires_in || 1800) * 1000,
    interval: Math.max(data.interval || 5, 2) * 1000,
    status: 'pending',
    error: null,
  };
  pollDeviceAuth(deviceAuth);
  return deviceAuth;
}

// Polls in the background — not tied to any single HTTP request, since the
// user might take anywhere from a few seconds to a couple minutes to
// actually click through on Twitch. The frontend checks in on progress via
// GET /auth/twitch/poll rather than holding a request open.
async function pollDeviceAuth(session) {
  if (deviceAuth !== session || session.status !== 'pending') return; // superseded or already resolved
  if (Date.now() > session.expiresAt) {
    session.status = 'expired';
    return;
  }
  try {
    const form = new FormData();
    form.append('client_id', TWITCH_CLIENT_ID);
    form.append('scopes', AUTH_SCOPES);
    form.append('device_code', session.device_code);
    form.append('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');
    const res = await fetchWithTimeout('https://id.twitch.tv/oauth2/token', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.access_token) {
      saveToken({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        obtained_at: Date.now(),
      });
      session.status = 'authorized';
      console.log('[watchklyp] Authorized via Twitch.');
      await startChatBot();
      return;
    }

    if (data.message === 'authorization_pending') {
      setTimeout(() => pollDeviceAuth(session), session.interval);
      return;
    }
    if (data.message === 'slow_down' || res.status === 429) {
      session.interval += 2000;
      setTimeout(() => pollDeviceAuth(session), session.interval);
      return;
    }
    if (data.message === 'invalid device code') {
      session.status = 'expired';
      return;
    }

    // Anything else unrecognized — surface it and stop rather than loop forever.
    session.status = 'error';
    session.error = data.message || `Unexpected response (${res.status})`;
    console.error('[watchklyp] Device auth error:', session.error);
  } catch (err) {
    // A single stalled/failed poll (including a timeout) shouldn't kill the
    // whole flow — the user may still be mid-approval on Twitch's side. Just
    // retry; the expiresAt check at the top of this function is what
    // eventually gives up if it really has gone stale.
    console.warn('[watchklyp] Device auth poll network error, retrying:', err.message);
    setTimeout(() => pollDeviceAuth(session), session.interval);
  }
}

// ---------------------------------------------------------------------------
// Chat bot (tmi.js) — connects once we have a user token, listens for !watch
// ---------------------------------------------------------------------------
let chatClient = null;

async function startChatBot() {
  if (!channelLogin) {
    console.log('[watchklyp] No channel configured yet. Visit the app to set one up.');
    return;
  }
  const token = await getValidToken();
  if (!token) {
    console.log('[watchklyp] No valid chat bot token. Visit /auth/twitch to authorize.');
    return;
  }
  if (chatClient) {
    try { await chatClient.disconnect(); } catch {}
    chatClient = null;
  }

  chatClient = new tmi.Client({
    options: { skipMembership: true },
    identity: { username: channelLogin, password: `oauth:${token.access_token}` },
    channels: [channelLogin],
  });

  chatClient.on('message', (channel, tags, message, self) => {
    if (self) return;

    const who = tags['display-name'] || tags.username;
    const slug = extractClipSlug(message);
    if (slug) {
      lastPostedClip = { id: slug, postedBy: who };
      console.log(`[watchklyp] Clip link posted by ${who}: ${slug}`);
    }

    if (message.trim().toLowerCase() === '!watch') {
      if (!isModOrBroadcaster(tags)) {
        console.log(`[watchklyp] Ignored !watch from ${who} (not a mod/broadcaster).`);
        return;
      }
      triggerLatestClip(`chat:${who}`).then((result) => {
        if (!result.ok && !result.cooldown) {
          chatClient.say(channel, `WatchKlyp: ${result.message}`).catch(() => {});
        }
      });
    }
  });

  chatClient.on('disconnected', async (reason) => {
    console.warn('[watchklyp] Chat bot disconnected:', reason);
    if (/login authentication failed/i.test(reason) && token.refresh_token) {
      try {
        await refreshUserToken(token.refresh_token);
        setTimeout(startChatBot, 1000);
      } catch (err) {
        console.error('[watchklyp] Token refresh failed, re-authorize at /auth/twitch:', err.message);
      }
    }
  });

  try {
    await chatClient.connect();
    console.log(`[watchklyp] Chat bot connected to #${channelLogin}, listening for !watch`);
  } catch (err) {
    console.error('[watchklyp] Chat bot failed to connect:', err.message);
    if (token.refresh_token) {
      try {
        await refreshUserToken(token.refresh_token);
        setTimeout(startChatBot, 1000);
      } catch (refreshErr) {
        console.error('[watchklyp] Re-authorize at /auth/twitch —', refreshErr.message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Page shell — plain white, flat purple accent, text wordmark. Used by every
// HTML page the app serves so setup/status/auth screens feel like one plain,
// ordinary utility page rather than a template.
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderPage(title, body) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — WatchKlyp</title>
<style>
  :root {
    --bg: #f6f6f7;
    --card: #ffffff;
    --card-2: #f6f6f7;
    --border: #e2e2e5;
    --text: #1a1a1e;
    --muted: #6b6b74;
    --accent: #6d28d9;
    --success-bg: #eaf7ee;
    --success-text: #1f7a3d;
    --warning-bg: #fdf3e2;
    --warning-text: #93600b;
    --radius: 10px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    display: flex;
    justify-content: center;
    padding: 64px 20px;
  }
  .wrap { width: 100%; max-width: 540px; }
  .brand { font-size: 19px; font-weight: 700; letter-spacing: -0.01em; margin-bottom: 20px; }
  .brand-watch { color: var(--text); }
  .brand-klyp { color: var(--accent); }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 28px 32px;
  }
  h1 { font-size: 20px; margin: 0 0 10px; letter-spacing: -0.01em; }
  h2 { font-size: 12.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 26px 0 10px; font-weight: 700; }
  h2:first-of-type { margin-top: 0; }
  p { line-height: 1.6; color: var(--muted); margin: 0 0 16px; font-size: 14.5px; }
  p.lead { color: var(--text); font-size: 15px; }
  a { color: var(--accent); }
  form { margin-top: 4px; }
  .btn {
    display: inline-flex; align-items: center; gap: 8px;
    background: var(--accent);
    color: #fff !important; border: none; border-radius: 8px;
    padding: 10px 18px; font-size: 14.5px; font-weight: 600;
    cursor: pointer; text-decoration: none !important;
  }
  .btn:hover { background: #5b21b6; }
  .btn-ghost { background: transparent; border: 1px solid var(--border); color: var(--text) !important; }
  .btn-ghost:hover { background: var(--card-2); }
  input[type=text] {
    background: #fff; border: 1px solid var(--border); color: var(--text);
    border-radius: 8px; padding: 11px 13px; font-size: 15px; width: 100%;
    margin-bottom: 14px;
  }
  input[type=text]:focus { outline: 2px solid var(--accent); border-color: transparent; }
  .badge {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 4px 10px; border-radius: 999px; font-size: 12.5px; font-weight: 600; margin-bottom: 14px;
  }
  .badge-success { background: var(--success-bg); color: var(--success-text); }
  .badge-warning { background: var(--warning-bg); color: var(--warning-text); }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 11px 13px; background: var(--card-2); border: 1px solid var(--border);
    border-radius: 8px; margin-bottom: 8px;
  }
  .row-label { font-size: 12.5px; color: var(--muted); margin-bottom: 3px; }
  .row-url { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; word-break: break-all; }
  .row-note { font-size: 11.5px; color: var(--muted); margin-top: 3px; }
  .copy-btn {
    flex-shrink: 0; background: #fff; border: 1px solid var(--border);
    color: var(--text); border-radius: 6px; padding: 6px 11px; font-size: 12px;
    cursor: pointer; font-weight: 600; font-family: inherit;
  }
  .copy-btn:hover { background: var(--card-2); }
  .footer-links { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 13px; }
  .alert { background: var(--warning-bg); border-radius: var(--radius); padding: 14px 16px; margin-bottom: 20px; }
  .alert p { color: var(--warning-text); margin: 0 0 12px; font-size: 14px; line-height: 1.5; }
  .alert .btn-row { display: flex; gap: 8px; }
  .alert .btn { padding: 8px 14px; font-size: 13.5px; }
  .alert .alert-note { margin: 10px 0 0; font-size: 12.5px; color: var(--warning-text); }
</style>
</head>
<body>
  <div class="wrap">
    <div class="brand"><span class="brand-watch">Watch</span><span class="brand-klyp">Klyp</span></div>
    <div class="card">${body}</div>
  </div>
  <script>
    function copyText(btn, text) {
      navigator.clipboard.writeText(text).then(() => {
        const original = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = original; }, 1200);
      });
    }
  </script>
</body>
</html>`;
}

function urlRow(label, url, note) {
  return `<div class="row">
    <div>
      <div class="row-label">${escapeHtml(label)}</div>
      <div class="row-url">${escapeHtml(url)}</div>
      ${note ? `<div class="row-note">${note}</div>` : ''}
    </div>
    <button class="copy-btn" onclick="copyText(this, '${escapeHtml(url)}')">Copy</button>
  </div>`;
}

app.get('/', (req, res) => {
  if (!channelLogin) {
    return res.type('html').send(renderPage('Setup', `
      <h1>Welcome</h1>
      <p class="lead">Let's get your channel connected. Enter your Twitch
      channel login name — the lowercase part of your channel URL after
      twitch.tv/.</p>
      <form method="POST" action="/api/setup">
        <input type="text" name="channel" placeholder="e.g. klyptics" required />
        <button type="submit" class="btn">Continue →</button>
      </form>
    `));
  }
  res.redirect('/status');
});

app.post('/api/setup', (req, res) => {
  const channel = (req.body.channel || '').trim().toLowerCase().replace(/^@/, '');
  if (!channel) {
    return res.status(400).type('html').send(renderPage('Setup', `
      <h1>Channel name required</h1>
      <p class="lead">Go back and enter your Twitch channel login name.</p>
      <a class="btn" href="/">← Back</a>
    `));
  }
  channelLogin = channel;
  config = { ...config, channel };
  saveConfig(config);
  cachedBroadcasterId = null; // stale for the old channel, if any
  console.log(`[watchklyp] Channel set to #${channelLogin}.`);
  startChatBot(); // no-op if not authorized yet — that happens next, from /status
  res.redirect('/status');
});

app.get('/status', async (req, res) => {
  if (!channelLogin) return res.redirect('/');

  // Live-checked against Twitch, not just "does token.json exist on disk" —
  // catches the case where access was revoked from twitch.tv/settings/connections.
  const token = await getValidToken();
  const hasClipScope = token && token.scopes && token.scopes.includes('channel:manage:clips');

  let authBadge, authBody;
  if (!token) {
    authBadge = `<span class="badge badge-warning"><span class="dot"></span>Not authorized</span>`;
    authBody = `<p>Connect your Twitch account to start the chat bot and
      enable chrome-less playback.</p>
      <a class="btn" href="/auth/twitch">Authorize with Twitch →</a>`;
  } else if (hasClipScope) {
    authBadge = `<span class="badge badge-success"><span class="dot"></span>Authorized</span>`;
    authBody = `<p>Chrome-less playback is enabled.</p>`;
  } else {
    authBadge = `<span class="badge badge-warning"><span class="dot"></span>Missing permission</span>`;
    authBody = `<p>Authorized, but missing the clip-download permission.</p>
      <a class="btn btn-ghost" href="/auth/twitch">Re-authorize →</a>`;
  }

  const base = `http://localhost:${PORT}`;
  const autoStartSupported = isAutoStartSupported();
  const autoStartEnabled = autoStartSupported ? await getAutoStartStatus() : false;

  res.type('html').send(renderPage('Status', `
      ${(updateState.supported && updateState.updateAvailable) ? `
      <div class="alert" id="update-alert">
        <p><strong>Update available.</strong> ${escapeHtml(updateState.remoteMessage || 'A new version is on GitHub.')}</p>
        <div class="btn-row">
          <button class="btn" id="update-apply-btn" onclick="applyUpdate()">Update now</button>
          <button class="btn btn-ghost" onclick="dismissUpdate()">Not now</button>
        </div>
        <p class="alert-note" id="update-status-note"></p>
      </div>
      <script>
        function applyUpdate() {
          var btn = document.getElementById('update-apply-btn');
          var note = document.getElementById('update-status-note');
          btn.disabled = true;
          btn.textContent = 'Updating…';
          fetch('/api/update/apply', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (d.ok) {
                note.textContent = 'Applied — restarting, this page will reload automatically…';
                waitForRestart();
              } else {
                btn.disabled = false;
                btn.textContent = 'Update now';
                note.textContent = d.error || 'Update failed.';
              }
            })
            .catch(function () {
              btn.disabled = false;
              btn.textContent = 'Update now';
              note.textContent = 'Something went wrong starting the update.';
            });
        }
        function waitForRestart() {
          setTimeout(function retry() {
            fetch('/status', { cache: 'no-store' })
              .then(function () { window.location.reload(); })
              .catch(function () { setTimeout(retry, 1500); });
          }, 2500);
        }
        function dismissUpdate() {
          fetch('/api/update/dismiss', { method: 'POST' }).then(function () {
            var el = document.getElementById('update-alert');
            if (el) el.remove();
          });
        }
      </script>
      ` : ''}

      <h1>#${escapeHtml(channelLogin)}</h1>
      ${authBadge}
      ${authBody}

      <h2>Browser Source</h2>
      ${urlRow('Streamlabs OBS Browser Source', `${base}/browser-source.html`)}

      <h2>Stream Deck</h2>
      ${urlRow('Watch Clip', `${base}/api/latest-clip`, 'Same as typing !watch in chat')}
      ${urlRow('Stop', `${base}/api/stop`, 'Also stops clip cycling')}
      ${urlRow('Pause / Resume', `${base}/api/pause`, 'Only works during chrome-less playback')}

      <h2>Clip Cycling</h2>
      ${urlRow('Start cycling', `${base}/api/cycle/start`, 'Pair with switching into a scene')}
      ${urlRow('Stop cycling', `${base}/api/cycle/stop`, 'Pair with switching out of a scene')}

      ${autoStartSupported ? `
      <h2>Startup</h2>
      <div class="row" id="autostart-row">
        <div>
          <div class="row-label">Launch WatchKlyp when Windows starts</div>
          <div class="row-note" id="autostart-note">${autoStartEnabled ? 'Enabled — starts automatically at login' : 'Off — start it yourself each time'}</div>
        </div>
        <button class="copy-btn" id="autostart-btn" onclick="toggleAutoStart()">${autoStartEnabled ? 'Disable' : 'Enable'}</button>
      </div>
      <script>
        function toggleAutoStart() {
          const btn = document.getElementById('autostart-btn');
          const note = document.getElementById('autostart-note');
          const enabling = btn.textContent.trim() === 'Enable';
          btn.disabled = true;
          fetch('/api/autostart/' + (enabling ? 'enable' : 'disable'), { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              btn.disabled = false;
              if (d.ok) {
                btn.textContent = d.enabled ? 'Disable' : 'Enable';
                note.textContent = d.enabled ? 'Enabled — starts automatically at login' : 'Off — start it yourself each time';
              } else {
                note.textContent = d.error || 'Something went wrong.';
              }
            })
            .catch(function () {
              btn.disabled = false;
              note.textContent = 'Something went wrong — is the server still running?';
            });
        }
      </script>
      ` : ''}

      <div class="footer-links">
        <a href="/">Change channel</a> &nbsp;·&nbsp;
        <a href="https://www.twitch.tv/settings/connections" target="_blank" rel="noopener">Manage access on Twitch</a>
      </div>
  `));
});

app.get('/api/latest-clip', async (req, res) => {
  const result = await triggerLatestClip('streamdeck');
  res.json(result);
});

app.get('/api/stop', (req, res) => {
  stopCycling(); // universal kill switch — also halts an active clip cycle
  broadcast({ type: 'control', action: 'stop' });
  res.json({ ok: true });
});

app.get('/api/pause', (req, res) => {
  broadcast({ type: 'control', action: 'toggle-pause' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Auto-start toggle, driven from the status page — see setAutoStart() above.
// ---------------------------------------------------------------------------
app.get('/api/autostart/status', async (req, res) => {
  res.json({ supported: isAutoStartSupported(), enabled: await getAutoStartStatus() });
});

app.post('/api/autostart/enable', async (req, res) => {
  try {
    await setAutoStart(true);
    console.log('[watchklyp] Auto-start enabled — WatchKlyp will launch at Windows login.');
    res.json({ ok: true, enabled: true });
  } catch (err) {
    console.error('[watchklyp] Failed to enable auto-start:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/autostart/disable', async (req, res) => {
  try {
    await setAutoStart(false);
    console.log('[watchklyp] Auto-start disabled.');
    res.json({ ok: true, enabled: false });
  } catch (err) {
    console.error('[watchklyp] Failed to disable auto-start:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Live update endpoints, driven from the status page banner.
// ---------------------------------------------------------------------------
app.get('/api/update/status', (req, res) => {
  res.json({
    supported: updateState.supported,
    checking: updateState.checking,
    updateAvailable: updateState.updateAvailable,
    remoteMessage: updateState.remoteMessage,
    applying: updateState.applying,
    lastError: updateState.lastError,
  });
});

app.post('/api/update/apply', async (req, res) => {
  if (updateState.applying) {
    return res.status(409).json({ ok: false, error: 'Already updating — hang tight.' });
  }
  updateState.applying = true;
  try {
    await applyUpdate();
    console.log('[watchklyp] Update applied — restarting.');
    res.json({ ok: true, restarting: true });
    scheduleSelfRestart();
  } catch (err) {
    updateState.applying = false;
    console.error('[watchklyp] Update failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/update/dismiss', (req, res) => {
  updateState.dismissedSha = updateState.remoteSha;
  updateState.updateAvailable = false;
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Clip-cycling endpoints — meant to be hit by a Stream Deck button paired
// with switching into/out of a specific OBS scene (e.g. a multi-action:
// "Switch Scene" + "Website: /api/cycle/start"). /api/cycle/next is called
// by the browser source itself, not something you'd wire to a button.
// ---------------------------------------------------------------------------
app.get('/api/cycle/start', async (req, res) => {
  try {
    const clips = shuffle(await fetchOwnClips());
    if (clips.length === 0) {
      return res.json({ ok: false, message: `No clips found for #${channelLogin}.` });
    }
    cycling.active = true;
    cycling.clips = clips;
    cycling.index = 0;
    console.log(`[watchklyp] Clip cycling started (${clips.length} clips).`);
    advanceCycle();
    res.json({ ok: true, count: clips.length });
  } catch (err) {
    console.error('[watchklyp] Failed to start clip cycling:', err.message);
    res.json({ ok: false, message: err.message });
  }
});

app.get('/api/cycle/stop', (req, res) => {
  stopCycling();
  broadcast({ type: 'control', action: 'stop' });
  console.log('[watchklyp] Clip cycling stopped.');
  res.json({ ok: true });
});

app.get('/api/cycle/next', (req, res) => {
  if (cycling.active) advanceCycle();
  res.json({ ok: true });
});

app.get('/auth/twitch', async (req, res) => {
  try {
    if (!deviceAuth || deviceAuth.status !== 'pending') {
      await startDeviceAuth();
    }
    res.type('html').send(renderPage('Authorize', `
      <h1>Authorize on Twitch</h1>
      <p class="lead">Open this link and log in — it's already filled in, no
      code to type. You can do this from your phone if that's easier.</p>
      <a class="btn" href="${escapeHtml(deviceAuth.verification_uri)}" target="_blank" rel="noopener">Continue on Twitch →</a>
      <p style="margin-top:18px">If that link doesn't work, go to
      <a href="https://www.twitch.tv/activate" target="_blank" rel="noopener">twitch.tv/activate</a>
      and enter this code: <strong>${escapeHtml(deviceAuth.user_code)}</strong></p>
      <p id="auth-status" style="margin-top:20px">Waiting for you to authorize on Twitch…</p>
      <script>
        function checkAuth() {
          fetch('/auth/twitch/poll').then(function (r) { return r.json(); }).then(function (d) {
            if (d.status === 'authorized') {
              window.location.href = '/status';
            } else if (d.status === 'expired' || d.status === 'error') {
              document.getElementById('auth-status').textContent =
                'That link expired or something went wrong. Reload this page to try again.';
            } else {
              setTimeout(checkAuth, 2000);
            }
          }).catch(function () { setTimeout(checkAuth, 3000); });
        }
        checkAuth();
      </script>
    `));
  } catch (err) {
    console.error('[watchklyp] Failed to start device auth:', err.message);
    res.status(500).type('html').send(renderPage('Auth error', `
      <h1>Couldn't start authorization</h1>
      <p class="lead">${escapeHtml(err.message)}</p>
      <a class="btn" href="/auth/twitch">Try again →</a>
    `));
  }
});

app.get('/auth/twitch/poll', (req, res) => {
  if (!deviceAuth) return res.json({ status: 'none' });
  res.json({ status: deviceAuth.status, error: deviceAuth.error });
});

// Wrapped so it can retry on EADDRINUSE — most relevant right after an
// auto-update restart, where the previous process may not have fully freed
// the port yet by the time the new one starts. Without this, that handoff
// would be a race that occasionally crashed the freshly-restarted process.
function startServer(retriesLeft = 10) {
  const srv = app.listen(PORT, () => {
    console.log(`[watchklyp] Server running at http://localhost:${PORT}`);
    console.log(`[watchklyp] Browser source: http://localhost:${PORT}/browser-source.html`);
    console.log(`[watchklyp] Stream Deck trigger URL: http://localhost:${PORT}/api/latest-clip`);
    console.log(`[watchklyp] Stop URL: http://localhost:${PORT}/api/stop`);
    console.log(`[watchklyp] Pause/Resume URL: http://localhost:${PORT}/api/pause`);
    console.log(`[watchklyp] Clip cycling start/stop: http://localhost:${PORT}/api/cycle/start | /api/cycle/stop`);
    openBrowser(`http://localhost:${PORT}/`);
    startChatBot();
    // Staggered a few seconds after boot so it's not racing the chat bot's
    // own connection attempt and the token check above for the same local
    // network path right at process start.
    setTimeout(checkForUpdates, 5000);
    setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
  });

  srv.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && retriesLeft > 0) {
      console.warn(`[watchklyp] Port ${PORT} still in use — retrying in 1s (${retriesLeft} left)...`);
      setTimeout(() => startServer(retriesLeft - 1), 1000);
    } else {
      console.error('[watchklyp] Failed to start server:', err.message);
      process.exit(1);
    }
  });

  return srv;
}

startServer();

// Catch revocation (twitch.tv/settings/connections) while running, not just
// at next boot — check every 15 minutes and disconnect if it's gone stale.
setInterval(async () => {
  if (!chatClient) return;
  const token = await getValidToken();
  if (!token) {
    console.warn('[watchklyp] Access was revoked — disconnecting chat bot. Re-authorize at /auth/twitch.');
    try { await chatClient.disconnect(); } catch {}
    chatClient = null;
  }
}, 15 * 60 * 1000);
