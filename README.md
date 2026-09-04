# Party Games

Real-time party games for your group chat — 23 games, no app to install, no
accounts. One player hosts a room, everyone else joins with a 4-letter code
from their own phone.

Hosting a stream? Flip on **Streamer Mode** from the lobby's Room Settings
tab to blur the room code on screen (tap it to peek), and optionally set a
**join password** so only people you've actually invited can get in.

Other host tools live right in the player list: tap 👑 to hand host control
to someone else, or ✕ to remove a disruptive player (both ask you to confirm
with a second tap). Joining is also a scan away — every lobby shows a QR code
next to the room code. The whole thing installs to a phone's home screen too
(there's a real `manifest.json`), and plays a few small sound/vibration cues
for turns, reveals, and wins — muffle those anytime with the speaker icon in
the corner.

## Running locally

```bash
npm install
npm start
```

Open `http://localhost:3000`. Set `PORT=xxxx` before `npm start` to use a
different port.

## Testing without real players

`scripts/playtest.js` drives full games end-to-end over real socket
connections (host actions and player actions both simulated) — useful for
regression-testing after any change:

```bash
node scripts/playtest.js                    # 4 players, localhost:3000
node scripts/playtest.js http://host:port 7 # 8 players, a different server
npm test                                    # same as the first line above
```

`scripts/simulate-players.js` is the lighter-weight version for manual
testing — it joins a *real* room you're hosting in your own browser and
plays along as bots, so you can test solo instead of recruiting friends:

```bash
node scripts/simulate-players.js <ROOM_CODE> 3
```

### Before trusting a change is done

`playtest.js` passing only proves the happy path and the server-side logic
are right — it's not the whole picture. Each of these has caught a real bug
that `playtest.js` alone missed:

1. **`playtest.js` regression** (above) — catches broken gameplay logic.
2. **A quick fuzz pass** if you touched `server.js` or a socket handler:
   fire a handful of malformed payloads (`null`, a bare string, an array, an
   object with the wrong field types) at whichever event you changed. Bots
   only ever send well-formed data, so this is the only thing that's ever
   caught a payload crashing the *entire* server. A five-minute throwaway
   script beats trusting the destructuring defaults are enough.
3. **An actual browser pass** for anything client-side — `playtest.js`
   never loads `main.js`, so it can't tell you a new screen fails to render
   or a button isn't wired up.
4. **The real cross-device flow**, periodically — open the site via its LAN
   address (printed at startup) rather than `localhost`, and join from a
   second connection on that same address. `localhost` alone can't tell you
   the QR code or same-origin socket connection work for someone else's phone.
5. **Fact-check any new trivia-style content** (dates, orderings, true/false
   claims) — this has caught real errors, including a factual date, a
   backwards ranking, and a tied "ranking" question with no correct answer.
6. **For any array a client can submit**, also try one *individually valid*
   value repeated many times, not just malformed ones — a plain type/shape
   fuzz pass (#2) won't catch this, since every element passes on its own.
   This is a distinct, real failure mode from #2: it caught a crafted Heads
   Up settings update that could freeze the *entire* server (every room, not
   just the sender's), because a validated-but-not-deduplicated category
   list fed a loop whose size scaled with the array's length.
7. **During a real browser playthrough (#3), deliberately let the clock run
   out on at least one player without answering** — `playtest.js`'s bots are
   too well-behaved to catch this on their own; they always submit something
   within the time limit, so a player who's simply slow, distracted, or just
   doesn't answer is a gap the automated regression can't see. This is what
   caught every round-game type silently omitting a non-answering player
   from the results screen entirely instead of showing "no answer."
   `playtest.js` now automates one representative instance of this (a silent
   holdout in a Trivia round) so a regression there won't need a human to
   catch it again, but the general principle still applies to any *other*
   "did everyone respond" screen a future game or feature adds — a
   silent-player check there needs its own explicit test, not an assumption
   that the one covers it.

## Deploying to your own domain

This is a plain Node.js + Express + Socket.IO app — no build step, no
database. Any Node host works. A few straightforward options:

**Render / Railway / Fly.io** (easiest — free/cheap tiers, git-push deploys)
1. Push this folder to a GitHub repo.
2. Create a new Web Service pointing at the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Point your domain's DNS at the host they give you (usually a CNAME).
5. Set the `TRUST_PROXY=1` environment variable in the service's settings —
   these platforms all terminate TLS at their own edge and forward the real
   visitor IP via `X-Forwarded-For`, same as the VPS+Caddy/nginx path below.

**A VPS you already have** (DigitalOcean, Linode, etc.)
1. Copy the project over (`git clone` or `scp`), `npm install`.
2. Run it under a process manager so it survives reboots/crashes:
   ```bash
   npm install -g pm2
   pm2 start server.js --name party-games
   pm2 save && pm2 startup
   ```
3. Put a reverse proxy (nginx or Caddy) in front for HTTPS + your domain.
   Caddy is the least fiddly — a `Caddyfile` this simple gets you free
   auto-renewing HTTPS:
   ```
   yourdomain.com {
     reverse_proxy localhost:3000
   }
   ```
4. Set `TRUST_PROXY=1` in the app's environment once it's actually behind
   that proxy (e.g. `TRUST_PROXY=1 pm2 start server.js --name party-games`,
   or add it to `pm2`'s env config) — see the note below for why this
   matters and why it isn't on by default.

**Docker** (a `Dockerfile` is included — no build step in the app itself
means no multi-stage build needed, just `npm ci` and run)
```bash
docker build -t party-games .
docker run -d -p 3000:3000 --name party-games party-games
```
Runs as the image's built-in low-privilege `node` user, and responds
correctly to `docker stop`'s `SIGTERM` (the app's own graceful-shutdown
handler). Set `TRUST_PROXY=1` (`-e TRUST_PROXY=1`) the same as the other
paths once there's a real reverse proxy in front — a bare container with a
port published directly has no proxy, so leave it unset in that case.
Change the published port on the left of `-p` (e.g. `-p 8080:3000`) to
move it, or set `-e PORT=...` to change what the container listens on
internally too.

A `docker-compose.yml` is included too, for `docker compose up -d` instead
— same defaults, restarts automatically unless you explicitly stop it, and
keeps `TRUST_PROXY` as a commented-out line ready to uncomment rather than
a flag to remember.

### Things to double check before going live
- **WebSocket support**: Socket.IO falls back to polling, but for the
  smoothest experience make sure your host/proxy doesn't block WebSocket
  upgrades (nginx needs `proxy_set_header Upgrade $http_upgrade;` and the
  `Connection "upgrade"` header if you're not using Caddy).
- **Room cleanup**: empty rooms are swept automatically after ~3 minutes,
  so the server won't leak memory over a long-running session.
- **No persistence**: everything lives in memory. A server restart drops
  all active rooms — fine for a casual party app, worth knowing.
- **Scaling**: if you ever run this behind multiple server instances,
  you'd need Socket.IO's Redis adapter for cross-instance room state —
  not needed for a single instance, which comfortably handles many
  concurrent rooms.
- **`TRUST_PROXY`**: off by default, on purpose. Every per-IP rate limit
  below relies on knowing the real visitor's IP — with no reverse proxy in
  front (true both for direct LAN party use, the app's primary case, *and*
  for a bare VPS with no Caddy/nginx), a client can hand the server whatever
  `X-Forwarded-For` value it wants, so trusting that header unconditionally
  would let anyone bypass every rate limit below just by varying it per
  request. Only set `TRUST_PROXY=1` once there's an actual reverse proxy (or
  a platform like Render/Railway/Fly.io) in front setting that header for
  you — see the deploy steps above for where.
- **Already handled for you**: a per-IP rate limit on room creation and on
  QR-code requests, a per-IP rate limit on wrong room-password guesses (so a
  password can't just be brute-forced) *and* on room codes that don't exist
  at all (so the ~1M-code keyspace can't be enumerated by a stranger who was
  never actually given a code — 10 failed lookups per IP per minute, only
  counting genuine misses so a real mistyped code is never penalized), a
  per-socket rate limit on every *in-game* event too (so one connected
  client can't flood a room by calling any single event far faster than real
  interaction ever would), a 24-player room cap, gzip compression, a real
  Content-Security-Policy plus the usual safe security headers, a check that
  rejects a WebSocket connection opened by some unrelated page's script
  instead of this app's own front end (raw WebSockets aren't covered by the
  browser's same-origin protections the way `fetch`/XHR are), and a clean
  shutdown on `SIGTERM`/`SIGINT` (so a `pm2 restart` or container redeploy
  doesn't hard-drop connections mid-request) are all built in — nothing to
  configure. Every socket handler is also wrapped so a malformed
  or unexpected message from one client gets logged and ignored rather than
  crashing the process for everyone else, and a matching catch-all on the
  HTTP side means an unhandled error in any Express route logs the real
  error (with its stack trace) to your server's own logs while the actual
  visitor only ever sees a generic message — never a leaked stack trace
  with your server's real file paths, regardless of whether `NODE_ENV` is
  set. A player who's kicked or
  disconnects doesn't leave everyone else stuck waiting on them either — the
  round or turn they were holding up moves on right away instead of sitting
  out the full phase/turn timer, and a kick actually sticks even if the
  target was offline when it happened. Every setting and free-text field is
  also validated for *shape*, not just checked for presence — numbers are
  range-checked and rounded to whole numbers, text is length-capped without
  ever splitting a multi-byte character, and any array a client can submit
  is length-capped. Settings arrays checked against a fixed whitelist (like
  Heads Up's categories) are also deduplicated, not just filtered — that
  part matters more than it sounds: without it, one crafted message
  (repeating a single otherwise-valid value many times, something a
  presence-only filter can't catch) could force a server-side loop into
  building a wildly oversized structure — and since Node is single-threaded,
  that doesn't just affect the sender, it blocks every room on the process
  until it finishes.
- **Health check**: `GET /health` returns `{ status: "ok", uptimeSeconds,
  activeRooms }` — point your platform's health check / uptime monitor at
  it if it wants one.
- **Search visibility**: `GET /sitemap.xml` is generated per-request from
  the actual domain you're deployed on (this app has no fixed URL until you
  pick one, so a static file would need editing per deployment) — submit
  `yourdomain.com/sitemap.xml` in Google Search Console / Bing Webmaster
  Tools once you're live. `robots.txt` already allows crawling by default.

## Project structure

- `server.js` — Express + Socket.IO wiring, one handler per game event.
- `games/room.js` — all room/game state and scoring logic (no I/O).
- `games/*-data.js` — the word lists, trivia questions, prompts, etc.
- `public/` — the entire client: `index.html`, `css/style.css`,
  `js/main.js` (one file, no build step, no framework), `manifest.json` +
  `icon.svg`/`icon-512.png`/`icon-512-maskable.png` for "Add to Home
  Screen" (the PNGs cover iOS Safari and maskable-icon platforms, which
  don't reliably rasterize the SVG), `sw.js` (a minimal service worker -
  no offline caching, since every screen needs a live socket connection;
  registered purely so Chrome/Android's install prompt shows up), `og-
  image.png` for the social-share preview, and `robots.txt`.
- `scripts/` — the two testing tools described above.
- `CHANGELOG.md` — there's no git history here, so this is the record of
  what's changed and why. Worth a skim before making sweeping changes.
- `.gitignore` — ready for whenever this becomes an actual git repo (e.g.
  the "push this folder to a GitHub repo" step above), so `node_modules/`
  doesn't end up committed on the very first `git add .`.
- `Dockerfile` / `.dockerignore` / `docker-compose.yml` — for the Docker
  deploy path above.
