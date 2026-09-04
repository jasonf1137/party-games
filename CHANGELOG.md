# Changelog

This project doesn't use git, so this file is the record of what's changed —
useful context before touching anything, and a place to keep adding entries
as the app grows.

## Highlights

Everything below is chronological and detailed - this section is a map,
not a substitute. Search for a bolded phrase to jump to the full entry.

**Most severe finding**: a crafted Heads Up settings update (a validated-
but-not-deduplicated category list feeding a nested pool-building loop)
could **freeze the entire server for every room**, not just the
attacker's - the single most severe bug found across this whole audit.
See "server-freeze" / "most severe finding of the session."

**Other real security fixes**: an `X-Forwarded-For` resolution bug that
resolved to the spoofable end of the header instead of the trusted one
(`trust proxy: true` → `1`, socket-side `getClientIp()` matched to fit);
a newly-disclosed `qs` CVE patched via npm `overrides` ahead of
`express`'s own upstream fix; free-text/array/scalar fields across every
socket handler (including `choice`/`votedFor` on four round-game types,
found later via the same pattern) brought under consistent shape
validation; a generic per-socket event-rate limit added where none
existed before; a real Content-Security-Policy added where none existed
at all, tuned against the app's actual resource inventory rather than a
generic preset; a per-IP rate limit on guessing room codes that don't
exist (previously unlimited - the ~1M-code keyspace could otherwise be
enumerated by a public stranger, not just brute-forced passwords on a
room already known to exist), plus the sweep-map leak found in that same
fix moments later; a catch-all Express error handler, closing off
Express's own default behavior of leaking full server-side stack traces
(real file paths included) into the public HTTP response whenever
`NODE_ENV` isn't `"production"` - true on every documented deploy path but
one; and a `Sec-Fetch-Site`-based check rejecting WebSocket connections
opened by some other page's script instead of this app's own front end
(raw WebSockets aren't covered by the browser's same-origin protections
`fetch`/XHR get). See "the threat model actually changed" below for why
several of these surfaced only once real public traffic became the plan.

**Most consequential correctness bug**: every round-game type (and
separately, Two Truths) silently omitted a player from the results screen
entirely if they simply didn't answer in time - not a rare edge case, an
everyday one, found only by an actual live playthrough since `playtest.js`'s
bots are "too well-behaved" to ever trigger it. Now permanently covered by
a regression test - see "Vanishes from results entirely."

**Also fixed**: double-fire bugs across all 8 "next round" handlers plus
start-game/play-again (a rapid double-click could silently skip a round
for everyone); tie-handling bugs that silently picked one "winner" on a
tied score/vote; a repeat-prevention gap across every fixed-content-pool
game; 12+ dead broadcast-data fields found via a systematic sweep; a
missing keyboard focus-trap on both modals; a WCAG contrast failure in
the global placeholder style; two PORT-handling edge cases (an out-of-
range value crashed with a raw stack trace; `PORT=0` printed a wrong URL);
a "zombie socket" bug where a backgrounded mobile tab could leave
`socket.connected` reading `true` long after the connection actually died.

**Added**: a Dockerfile/`.dockerignore`/`docker-compose.yml` (a third
deploy path, verified as rigorously as possible without Docker itself
installed here); expanded thin content pools (Rank It, Heads Up, Guess
the Crowd); a live search box and in-game rules-reminder modal; word
counts on Heads Up's category picker; a dynamic `/sitemap.xml` generated
from the actual request host rather than a static file, since this app
has no fixed domain until someone deploys it somewhere.

**Verified, not just fixed**: every documented deployment path
(`npm install`/`npm start`, `pm2`, Docker) actually tested end-to-end
where the tools were available, with honest notes on the two things that
couldn't be (a real Docker build, and this Windows machine's inability to
deliver a genuine cross-process SIGTERM to test graceful shutdown); the
app confirmed stable at true 24-player capacity and after ~7 hours of
continuous uptime; `.gitignore` validated against a real `git init` test,
catching a real gap (`.claude/` wasn't excluded); every game type's
server-returned field names cross-checked field-by-field against exactly
what the client reads for it, across all 23 game types, zero real
mismatches - see "completed a full field-name consistency sweep."

## 2026-08-31

### Hardening
- **Fixed a server-crashing bug**: any client sending a malformed payload
  (`null`, a string, a number, an array) to almost any socket event crashed
  the entire process, dropping every active room. Root-caused via fuzz
  testing (not caught by `playtest.js`, whose bots only send well-formed
  data) and fixed by normalizing payloads + wrapping every socket handler in
  try/catch, plus `uncaughtException`/`unhandledRejection` as a second layer.
- Fuzzing also found ~15 places in `games/room.js` where a "did everyone
  answer/vote" or "advance to next round" helper assumed `room.game` was
  always set, and ~13 places where `(x || "").trim()`-style coercion let a
  truthy non-string crash a string method — all fixed at the root.
- Found and fixed a self-inflicted regression: the `uncaughtException` net
  above was originally registered before the server started listening, which
  silently swallowed a real startup failure (port already in use) into a
  non-functional zombie process. Moved it inside `server.listen()`'s success
  callback so startup failures still crash visibly.
- Closed a settings-injection gap (fake Heads Up category names could empty
  the word pool), a password brute-force gap (no rate limit on join attempts
  — now 10 failed guesses/minute/IP), and a QR-endpoint DoS gap (unlimited
  requests, each doing real CPU work — now 30/minute/IP).
- Fixed a couple of minor resource leaks (`previousScores` in the client
  never cleared between rooms; the QR rate limiter's map had no periodic
  cleanup unlike the others) and added `.unref()` to background intervals.

### Accessibility
- The game-picker rows and votable answer cards were `<div>`s with only
  click handlers — not reachable by keyboard or announced by screen readers.
  Added `role="button"`/`tabindex`/`aria-label` plus one delegated
  Enter/Space handler.
- Every settings dropdown's `<label>` was missing its `for` attribute (the
  `id`s were already there) — fixed across all games' settings panels.
- Found and fixed a real WCAG AA contrast failure: `--text-faint` drops as
  low as 2.48:1 on some card surfaces. Swapped it for the already-passing
  `--text-dim` on the three spots using it for real text.

### New features
- **Streamer Mode** and an optional **join password**, both in a new "Room
  Settings" tab in the lobby.
- Three new games: **Guess the Year** 📅, **True or False** ❓, **Rank It** 🔢
  (a genuinely new tap-to-order mechanic, not a reskin).
- Host tools in the player list: **kick** and **transfer host**, both
  two-tap-confirm (no native browser dialogs).
- A **QR code** in every lobby, a **native share sheet** button, tap-to-copy
  on the room code, and a rotating tip on the waiting screen.
- Procedural **sound effects + vibration** (Web Audio, no asset files),
  togglable from a corner button; a tab-title flash for "your turn"/results
  while backgrounded.
- A PWA **manifest.json** + icon (installable to a home screen), a
  **"How it works"** onboarding modal, and a client-side render error
  boundary (mirrors the server-side one).

### Content accuracy
- Fact-checked all 60 trivia-style entries added this session. Found and
  fixed three real errors: Amazon.com's launch year (1994→1995, the founding
  vs. the site actually opening), a buildings-by-height ranking with Burj
  Khalifa and One World Trade Center swapped, and a sports-by-players
  ranking with an actual tie (Soccer/American Football both at 11) —
  replaced with Ice Hockey to make it answerable.

### Bug fix — multi-field forms losing typed text
Found via an actual browser pass (typing and waiting past a broadcast tick,
not just reading the code): **Two Truths and a Lie**'s 3 statement inputs and
**Category Countdown**'s 3 category-word inputs were both silently wiped back
to empty roughly once a second, because every active round's timer
rebroadcasts the whole room every second and `render()`'s "preserve the
focused field" logic only ever covers a *single* `id`'d element — these forms
had three fields and none had an `id` at all. In practice this made both
forms nearly impossible to actually type into. Fixed by tracking each form's
draft values client-side (`ttDraftStatements`/`ttDraftLieIndex` and
`catDraftWords`) and giving every field a real `id` so both the values *and*
keyboard focus survive a re-render. Verified by filling every field, waiting
2.5s (multiple broadcasts), and confirming everything survived, in both games.
Also checked the two canvas-drawing games for the same failure class: Draw It
was already safe (its own local `drawItLocalStrokes` draft array, since it
only submits strokes in one batch anyway); Doodle Guess tested clean twice,
including once where the round timed out mid-check — a real pointer gesture
on it survives the periodic re-render, unlike a bare text input would.

### Performance
- The server wasn't compressing anything — `express.static` doesn't gzip on
  its own, so `main.js` (127KB) was going out over the wire exactly as
  large as it is on disk. Added the `compression` middleware: `main.js` now
  transfers at ~26KB (about 4.8x smaller), same for `style.css` and the HTML
  shell. Verified the `Content-Encoding: gzip` header is actually present,
  that a client without gzip support still gets the plain response, and that
  the QR PNGs (already-compressed binary) are correctly left alone rather
  than double-compressed. Matters here specifically because the whole point
  of this app is joining from a phone, often on real cellular data.
- Added `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`, and
  disabled `X-Powered-By` (stops advertising "this is Express" for free).
  Deliberately *not* pulling in the full `helmet` package - its default CSP
  needs real tuning around this app's extensive inline `style="..."` usage,
  Google Fonts, and Socket.IO's script, and getting that wrong silently
  breaks the whole visual layout. These three headers carry none of that risk.
- Added `GET /health` (`{ status, uptimeSeconds, activeRooms }`) for whatever
  ends up watching the process in production - a platform's load balancer, a
  container orchestrator, an uptime monitor. Registered ahead of the SPA
  catch-all route on purpose, since an extension-less unknown path there
  falls through to serving `index.html` otherwise.

### Verification
- Full `playtest.js` regression suite (all 23 games + disconnect/timeout
  edge cases) re-run after every batch above — clean throughout.
- A custom fuzz script (garbage payloads across all 35 socket events) run
  repeatedly until it reached zero errors, not just zero crashes.
- Manually played all three new games through the real browser UI (not just
  `playtest.js`'s socket bots, which never touch client rendering code).
- Re-verified the actual cross-device flow — loaded the site via its LAN
  address, created a room, and joined it from a second independent
  connection also on the LAN address.
- `npm audit`: 0 vulnerabilities.

### More content accuracy passes
- Fact-checked the rest of the trivia-style content: all 20 Emoji Decode
  clues (a deliberate mix of movies *and* phrases, not movies-only, so a
  loosely-connected clue like "dog show" is by design, not an error), all
  20 Fib or Fact prompts, and all 30 True or False statements — all correct
  as written, nothing to fix.
- Found and fixed a real ambiguity in **Odd One Out**: `Shark, Dolphin,
  Whale, Penguin` had two competing valid answers (Shark is the only fish
  among three mammals, *or* Penguin is the only non-marine animal - both
  defensible as "the odd one out"). Swapped Shark for Seal, so the set is
  unambiguously "marine mammal, marine mammal, marine mammal, bird."

### Bug fix — rounds stalling on a player who's gone
Every "wait for everyone" phase (round-game answering, Prompt Battle/Fib
answering *and* voting, Draw It drawing *and* voting, Two Truths writing
*and* guessing, Doodle Guess) only ever rechecked "is everyone done?" right
after a player's own submission - kicking the one remaining holdout, or
having them silently disconnect, left the round sitting through the *entire*
phase timer (often 15-20+ seconds) even though every player still present
had already finished. Fixed by adding `checkPhaseAdvanceAfterDeparture` in
`server.js`, called from both `kick-player` and `handleDisconnect`, which
runs that exact same "everyone done?" check for whichever phase the current
game is actually in. Verified with two throwaway socket-client scripts (not
just reasoning about the code): got 3 of 4 players to answer a trivia round,
then kicked the last one - round advanced to results in ~106ms, not the 20s
timer. Repeated with a real disconnect instead of a kick - same ~108ms
result. Full `playtest.js` regression still clean afterward (all 23 games +
the existing disconnect/timeout edge cases).

**Word Bomb needed a separate, worse version of the same fix.** It isn't a
"wait for everyone" game, it's a turn rotation with lives, and kicking a
player didn't just risk one wasted timeout - `wordBombAlivePlayers` counted
lives only, never checking whether the player was still actually in the
room, so a kicked player's turn kept coming back around every rotation,
wasting a full `turnTimeSeconds` timeout *each* time before finally losing a
life, for up to `startingLives` cycles (default 3) before they were finally
excluded. With exactly 2 players left, kicking one wouldn't end the game at
all until those wasted cycles ran out. Fixed by having `wordBombAlivePlayers`
also require `room.players.has(token)`, splitting the win-check out of
`wordBombAdvanceTurn` into its own `wordBombFinishIfOneRemains` (so a
departure can trigger it without also force-skipping whoever's actual turn
it is), and having `checkPhaseAdvanceAfterDeparture` call that plus fail the
current turn immediately if the departed player was the one on the clock.
Verified with two more scenarios: kicking the current turn-holder (turn
advanced in ~108ms, not the 20s `turnTimeSeconds`), and kicking players down
from 4 to exactly 1 remaining (game ended and declared the winner in
~108ms, not several wasted `startingLives × turnTimeSeconds` cycles). Full
regression clean afterward.

Closed the same gap for **Doodle Guess**: kicking the current artist left
every guesser staring at a frozen canvas for the rest of the (70s default)
draw timer, since nobody left could actually draw anything. Added a check
to the same dispatcher - if the departed player was the artist, end the
turn immediately instead of waiting it out. Verified across three separate
runs (random turn order picks a different artist each time) - turn ended
~107ms after the kick every time, regardless of which of the three bots
happened to be drawing.

### Security fix — every IP-based rate limit was bypassable by anyone
`app.set("trust proxy", true)` was unconditional, meaning the server trusted
whatever `X-Forwarded-For` value *any* direct client sent it as the real
visitor IP - verified with a plain `curl -H "X-Forwarded-For: ..."` against
the running server (no proxy involved) changing what `req.ip` resolved to
on request. Since every rate limit here (room creation, QR requests, wrong
room-password guesses) is keyed by that IP, anyone could bypass all three
just by varying the header per request - including on the app's *primary*
documented use case, direct LAN access with no reverse proxy at all, where
a prankster on the same wifi could brute-force a room password or spam room
creation completely unthrottled. Separately, `socket.handshake.address`
(used for the room-creation and password limits) turned out to never read
that header *at all* regardless of the Express setting - confirmed by
reading `engine.io`'s source directly (`this.remoteAddress =
req.connection.remoteAddress`, no `X-Forwarded-For` handling anywhere in
the package) and by comparing `req.ip` against `socket.handshake.address`
for the same spoofed request side by side. That second bug meant even a
*legitimate* reverse-proxy deployment would have every socket connection
collapse onto the proxy's one IP, turning per-visitor limits into one
shared global bucket.

Fixed by making proxy trust opt-in: `TRUST_PROXY=1` (env var, off by
default) now gates both `app.set("trust proxy", ...)` for the HTTP routes
*and* a new `getClientIp(socket)` helper (parses `X-Forwarded-For` the same
way Express does, only when the env var is set) used everywhere the code
used to read `socket.handshake.address` directly. Verified all four
combinations against the live server: spoofing 35 different fake IPs at the
QR endpoint with `TRUST_PROXY` unset still hit the real 30/min limit
(header ignored, as intended); the same test with `TRUST_PROXY=1` let each
spoofed IP through independently while the *same* spoofed IP still got
rate-limited after its own 30 (proving the header is genuinely respected,
for a real proxy deployment); and the socket-side room-creation limit (8/min)
held even across 15 connections each carrying a different spoofed header,
with `TRUST_PROXY` unset. README's deploy section updated with the env var
for all three deployment paths (Render/Railway/Fly.io, VPS+Caddy/nginx) and
an explanation of why it defaults off.

### Accessibility — screen changes were completely silent to screen readers
`render()` fully replaces `#app`'s content on every round/phase change (a
new round starting, results coming in, it becoming your turn, the game
ending) - none of that was ever announced to a screen reader, only the
one-off toast notification had `aria-live`. Fixed with a second, visually
hidden (`.sr-only`, not `display:none` - stays reachable by assistive tech)
`aria-live="polite"` region (`#screenAnnouncer`) that gets set to whichever
heading (`h1`/`h2`/`h3`) the new screen just rendered, gated by the same
`isNewScreen` check already used for the entrance animation/confetti/sound/
title-flash - so it fires once per genuine screen change and never on the
once-a-second timer re-broadcasts. Reuses each screen's existing heading
text instead of hand-writing separate copy per game/phase (23 games' worth
of surface area), so it stays in sync automatically as screens change.
Verified live: confirmed the element exists with the right role/aria-live
and is genuinely invisible (clipped, `offsetWidth: 1`) but present in the
DOM, then watched it correctly update across three real screen transitions
(landing → game picker → game settings → lobby) with a screenshot
confirming no visual/layout change from adding it.

Also gave the "How it works" modal real dialog semantics - it had none:
no `role="dialog"`/`aria-modal`, no `aria-labelledby`, focus stayed wherever
it was when the modal opened instead of moving into it, and there was no
Escape-to-close. Added all four, plus focus returning to the trigger button
on close. That last part exposed a real bug while testing it: the close
handler stored the trigger button element on open and called `.focus()` on
that same reference on close, but `render()` fully rebuilds `#app` from an
HTML string in between - the stored reference was a detached, silently-inert
node by the time `.focus()` ran, so focus was landing on `<body>` instead.
Fixed by re-querying `#howItWorksBtn` by id after the close-triggered
re-render rather than trusting the pre-render reference. Verified live for
all three ways to close it (✕ button, "Got it!", Escape) - each correctly
returns focus to the button that opened it.

Last one from the same pass: the room-code tap-to-copy handler had an empty
rejection callback (`() => {}`) - if `navigator.clipboard.writeText` failed
(denied permission, non-secure context, etc.) or `navigator.clipboard`
didn't exist at all, tapping the code did *nothing visible whatsoever*,
which reads as broken rather than as "already copied." The sibling "copy
invite link" button one function up had the same gap for the
`!navigator.clipboard` case specifically (only its `.writeText()` rejection
had a fallback). Fixed both to fall back to showing the code itself as a
toast either way. Verified live by monkey-patching
`navigator.clipboard.writeText` to reject and confirming both buttons now
show `"Room code: XXXX"` instead of doing nothing.

### Small UX addition — a confirmation when reconnecting actually finishes
The client already showed a "Reconnecting…" toast on disconnect, but
nothing confirmed it had actually worked - that toast auto-hides after
~3s regardless of whether the reconnect finished by then, so on a slower
reconnect the screen just quietly resumes with no acknowledgment. Added a
"Reconnected!" success toast, shown only when this is a genuine reconnect
(not the first-ever page load) *and* the rejoin actually succeeded - reuses
the existing, already-verified rejoin-by-token flow, just adds one toast
call gated by a small boolean flag.

Getting a *true* live end-to-end test of this took a second attempt: the
obvious methods all fail for the wrong reasons (restarting the server wipes
its in-memory room state entirely, so the rejoin correctly fails instead of
exercising the success path; reloading the page resets the very
"was this a reconnect" flag under test). Solved it by temporarily exposing
the socket as `window.__testSocket` right after creation, driving a real
`disconnect()` → `connect()` cycle on the *actual* live socket the page
itself uses (confirmed it was the same instance - disconnecting it
triggered the real "Reconnecting…" toast), watching `toast-success` /
"Reconnected!" appear for real, confirming the room/session survived
intact, then removing the temporary line before finalizing (confirmed
gone via `grep` and a fresh page load). Full regression re-run clean
afterward.

Followed up with the more important version of the same test - reconnecting
*mid-game*, not just in the lobby - using the same temporary
`window.__testSocket` technique: started a real Trivia round, disconnected
partway through a question, waited, then reconnected. Confirmed the client
lands back on the *exact same round and question* it left (not reset to
lobby, not stuck), the "Reconnected!" toast fires correctly, and the
timer had kept counting down server-side the whole time the connection was
down and picked up in sync on reconnect - exactly the behavior a real
"phone locked for a few seconds mid-round" moment needs. Removed the
temporary line again afterward.

### Security/correctness fix — a kick didn't stick if the target was offline
Found by specifically chasing down one more edge case around the same
kick/reconnect machinery just verified above: kicking a player who is
*disconnected* at the moment of the kick didn't actually stick. The
"kicked" event that makes a player's own client clear its stored session
(`clearSession()`, which is what stops it from ever trying to rejoin again)
only reaches an actively-connected socket - someone who'd dropped offline
right before being kicked never receives it, so their device kept holding
a token that no longer belonged to anyone. Once they came back online, the
client's normal auto-reconnect-with-stored-token logic (the same one
verified working correctly above) would fire `join-room` with that stale
token - and the server's own fallback ("token not found → treat as a brand
new join") would silently let them right back in as a new player with a
new token, undoing the kick entirely. Confirmed with a throwaway script
before touching anything: join a room, disconnect without leaving,
kick that (now-disconnected) player, then reconnect with their old token -
they were let back in every time.

Fixed by giving each room a `kickedTokens` `Set`, populated whenever
`kick-player` actually removes someone, checked in `join-room` *before*
the "not found" fallback can treat it as a new join - a kicked token now
gets a clean `"You were removed from this room."` error instead of quietly
succeeding, whether the target was online or offline at the moment of the
kick (this also closes a related, narrower gap: even a *connected* kicked
player's rejoin attempt is now refused server-side regardless of whether
their own `clearSession()` happened to run in time). Room-scoped and needs
no separate cleanup - it's garbage-collected along with the room itself by
the existing empty-room sweep. Verified the exact fix with the same
throwaway script, now failing correctly with `"You were removed from this
room."`, and confirmed a full `playtest.js` regression still passes -
this touches `join-room`, one of the most heavily-used paths in the app.

One more gap in the same area: when the client's auto-reconnect-with-
stored-token attempt failed for *any* reason (now including the above),
the error was silently discarded - the user just found themselves dumped
back on the landing page with zero explanation. Added `showToast(res.error
|| "Couldn't rejoin your room.")` to that failure path. Verified the whole
chain together, live, with two bots and a real browser tab: hosted a room
from a script, joined the browser tab in as "Victim2", disconnected its
socket (via a temporarily-exposed `window.__testSocket`, same technique as
the reconnect-toast verification above), had the host script detect the
disconnect and kick that token, then reconnected the browser's socket and
watched the exact `"You were removed from this room."` toast appear with
correct error styling, landing cleanly on the home screen - not a
code-reading inference, an actual end-to-end run of the real failure mode
this session found. Removed the temporary line again afterward.

### Verified at max capacity and through the real UI
- `playtest.js` always defaults to 4 players, so the documented
  `MAX_PLAYERS_PER_ROOM = 24` cap had genuinely never been exercised. Ran
  it with 24 total players (host + 23 bots) - room creation/join correctly
  allowed exactly 24, and all 23 games (headsup's 24 sequential turns and
  doodle's 24 drawing turns included) plus the disconnect/timeout edge
  cases finished clean, with correct per-player scoring throughout.
- Verified Streamer Mode live end-to-end for the first time this session
  (earlier passes only checked the setting itself): the room code renders
  genuinely blurred, tapping it reveals the real code, and it automatically
  re-blurs after the 4-second peek window.
- Verified kick and host-transfer through the real UI with two independent
  browser sessions (not just `playtest.js`'s socket bots) - two-tap confirm
  correctly shows "Kick?" before acting and reverts if not followed up, the
  host-transfer button is correctly disabled for a disconnected target, and
  a kicked player is cleanly removed from the room.
- Confirmed the QR code / invite link's `?room=CODE` URL is actually read
  client-side and pre-fills the join screen's room code field (was already
  implemented; hadn't been checked end-to-end before).

### Small polish
- Added `"test": "node scripts/playtest.js"` to `package.json` - `npm run
  playtest` already worked, but `npm test` is the convention most tooling
  and habit reach for first. Mentioned it in the README too (it hadn't been,
  right after adding it).
- Verified the sound toggle live: mute/unmute correctly updates the icon,
  aria-label, and persists across a reload; starting a real game with sound
  enabled produced zero console errors from the Web Audio path. Also
  confirmed leaving a room mid-round (not just from the lobby) works
  cleanly. Re-confirmed the README's "23 games" count against
  `R.GAME_IDS.length` - still accurate.

### Real social-share preview and a working iOS home-screen icon
Two related gaps, both boiling down to "no actual raster image asset
exists, only the 218-byte `icon.svg`": there was no `og:image`/
`twitter:image` at all (so pasting the invite link into WhatsApp/iMessage/
Slack/Discord would show a bare text preview, not a card), and
`apple-touch-icon` pointed at that same SVG - which iOS Safari doesn't
reliably rasterize, unlike the PWA manifest's SVG icon which Chrome/Android
handle fine. (`og:url` deliberately *not* added: this file is served as-is
on whatever domain someone deploys it to per the README's multiple
deploy paths, so a hardcoded URL would only be correct for one of them -
`og:image` uses a relative path instead, which real crawlers resolve
against the page's own URL correctly.)

No image-generation library existed in this project and adding one felt
like overkill for two static assets, so generated both by rendering real
HTML/CSS (matching the app's actual colors/fonts/dice mark) through
headless Edge (`msedge.exe --headless --screenshot=...`, already installed
on Windows, no new dependency) - `public/og-image.png` (1200×630, the
standard OG size) and `public/icon-512.png` (512×512, full-bleed with no
baked-in corner rounding since iOS applies its own mask). Wired up
`og:image`/`og:image:width`/`og:image:height`, upgraded `twitter:card` to
`summary_large_image` and added the matching `twitter:title`/
`twitter:description`/`twitter:image`, switched `apple-touch-icon` to the
new PNG, and added the PNG as a second manifest icon alongside the existing
SVG one. Verified live: both files serve with `200`/`image/png`, the meta
tags read back correctly, and the page still renders with zero console
errors.

Caught a follow-up issue in my own new icon while double-checking it: the
manifest declared both icons (the pre-existing SVG *and* the new PNG) as
`"purpose": "any maskable"`, but neither is actually built for that -
`maskable` requires the important visual content to stay within an
inner ~80%-diameter "safe zone," since platforms that use it (mainly
Android adaptive icons) crop the full-bleed square into a circle/squircle
of their own choosing, and both icons have the dice glyph running almost
edge-to-edge. Rather than just drop the (pre-existing, inaccurate) claim,
generated a proper third variant the same way as the others - same
background, dice glyph shrunk and centered to fit the safe zone - and split
the manifest into three correctly-labeled entries: the SVG and the
full-bleed PNG as `"purpose": "any"`, and the new `icon-512-maskable.png`
as `"purpose": "maskable"`. Verified the new file serves correctly and the
manifest is still valid JSON.

### Bug fix — Heads Up could get permanently stuck
Found by specifically re-checking whether Heads Up had the same
departed-player stall class as everything else this session, since it
hadn't been covered yet: its "ready" phase (after a turn starts but before
the performer taps "Start My Turn") has **no timer at all**, and - unlike
every other phase in this game - the client never renders a host skip
control there either (`#nextTurnBtn` only appears in the "summary" phase
template). If the performer was kicked, or simply disconnected, before
starting their turn, absolutely nothing would ever move the round along -
not a timeout, not a host button. The only way out was abandoning the game
entirely. Fixed with the same dispatcher used for every other game this
session: if the departed player was the current performer and the phase is
still "ready", immediately advance to the next turn via the existing
`headsUpNextTurn`. ("active" phase already has its own countdown timer
that ends the turn regardless of who's still around, so it didn't need
this.) Verified with a throwaway script across 3 runs (turn order is
randomized, so retried until a bot rather than the host held the
performer slot) - turn correctly advanced to a new performer in ~106-111ms
every time, instead of the indefinite hang the unfixed code would have
produced (the test's own 5s timeout would have failed loudly had the bug
still been present). This is arguably the most severe of the
departure-stall bugs found this session - the others cost a wasted timer
wait, this one had no recovery path at all.

### Small hygiene fix — a dev-only package listed as a production dependency
`socket.io-client` was under `dependencies` in `package.json`, but grepping
confirmed `server.js`/`games/`/`public/` never touch it - it's only ever
`require()`'d by `scripts/playtest.js` and `scripts/simulate-players.js`
(the client browser gets its own socket.io client from the bundled
`/socket.io/socket.io.js` the `socket.io` server package serves, a
completely separate thing). Moved it to `devDependencies`, regenerated
`package-lock.json`, and verified two ways: `npm ls --omit=dev --all` now
correctly shows only `socket.io` (not `socket.io-client`) in a
production-only tree, and `npm test` still runs the full regression clean
with the reclassified dependency. Doesn't change anything about how the
app actually runs - `npm install` without `--omit=dev` still installs it -
this only matters for a leaner production install (e.g. `npm ci
--omit=dev` in a Dockerfile), which now correctly skips a package the
running server never needed in the first place.

Also added a `.gitignore` (`node_modules/`, `.env`/`.env.local`, common
OS/editor cruft) - this project isn't a git repo yet, but the README's own
deploy steps tell a future reader to "push this folder to a GitHub repo" or
`git clone` it onto a VPS, and without this the very first `git add .`
would have committed the entire `node_modules` tree (132 packages) into
history. Verified the patterns actually work, not just that they look
right: built a throwaway git repo in a scratch directory with the same
`.gitignore`, matching `node_modules/`, `.env`, and `.DS_Store` files, and
confirmed `git add -A` only staged the two files that should've been
tracked.

### Accessibility — closed the `prefers-reduced-motion` coverage gaps
The app already respected `prefers-reduced-motion: reduce` in several
places (the screen entrance animation, the kick-confirm pulse, the modal,
the low-time timer pulse, the leaderboard bar fill, the waiting-tip dots) -
but a full audit of every `animation:` declaration in `style.css` found
five more that had no override at all: the trophy icon on the winner
screen, the score-bump row highlight + floating "+100" text, and the
winning row's pop-in on the final leaderboard. Also found a genuine
asymmetry while fixing these: `.host-btn.confirm` uses the exact same
`kickPulse` animation as `.kick-btn.confirm` right above it, but only the
kick button had a reduced-motion override.

Worth recording *how* these were fixed, not just that they were: a
same-specificity CSS rule inside a matching `@media` block does **not**
automatically win over a plain rule for the same selector - normal
cascade/source-order rules still apply on top of the media match, so the
override has to come *after* the rule it's overriding in source order, not
just be wrapped in the media query. Caught this before it shipped by
testing the mechanic in isolation first (an always-true `@media (min-width:
0px)` block standing in for `prefers-reduced-motion: reduce`, since this
browser's actual OS-level setting can't be toggled from here) - a rule
placed *before* the animated declaration it was meant to override did
nothing, confirming the fix needed reordering, not just adding the
selector to an existing block. All five new overrides were placed
correctly (verified against the pre-existing ones, which turned out to
already all be correctly ordered - `.host-btn.confirm` was the one
outlier). Verified CSS brace balance and a clean visual reload/console
afterward; being a pure client-side CSS change, the socket-based
`playtest.js` regression wasn't the relevant check here.

### Bug fix — Trivia and Quick Math didn't actually reward speed
Their own descriptions in the game picker say "faster than your friends"
and "as fast as you can" - found while spot-checking every game's
description against its real scoring logic (not just its data content,
already fact-checked earlier). Both actually paid a flat 500 points for
any correct answer regardless of when in the round it landed - answering
in the first second scored exactly the same as answering with one second
left. Rather than just softening the copy to match the weaker mechanic,
implemented the mechanic the copy already promises: a shared
`speedBonusPoints(g, payload, base, maxBonus)` helper in `room.js`
(300 base + up to 200 more, decaying linearly with `g.timeLeft` at the
moment of submission down to `g.answerTimeSecs`) - same 500-point ceiling
as before for an instant answer, but a last-second correct answer now
scores 300 instead. `roundGameSubmitAnswer` now stamps every answer with
`timeLeftAtSubmit` to make this possible; every *other* round-game type's
flat scoring is untouched (only the trivia and quickmath branches call the
new helper). No client changes needed - the player list already computes
`score - previousScore` generically for its "+123" bump animation, so a
variable bonus just works. Verified live with two players answering the
exact same, deterministically-correct choice (looked up from
`trivia-data.js`/computed directly for quickmath, not a blind guess) at
different times within the round - the fast answer scored 500, a ~10s-late
answer on a 15s round scored 367, matching the formula exactly. Full
`playtest.js` regression clean afterward, confirming every other game
type's scoring is unaffected.

### Hardening — no in-game socket event had any rate limit at all
Found while auditing every handler's authorization (a separate, clean
pass): `create-room`/QR requests/wrong passwords already had per-IP rate
limits, but every *in-game* event - `doodle:stroke`, every `submit-answer`/
`submit-vote`/`submit-lie`, all 14+ of them - had none. Each one
unconditionally calls `broadcastRoom()` on every invocation, even a
redundant repeat, so nothing stopped a single connected client (scripted or
just broken, not necessarily malicious) from calling any one of them far
faster than real interaction ever would and flooding everyone else in that
client's room. Checked the realistic legitimate ceiling first -
`doodle:stroke`, the highest-frequency candidate, turned out to only fire
once per *completed* pointer gesture (`pointerup`/`pointerleave`/
`pointercancel`), not per `pointermove`, so even fast scribbling is nowhere
close to a flood rate.

Fixed with one generic addition to the existing per-connection `socket.on`
wrapper (the same one that already normalizes payloads) rather than
patching 14+ handlers individually: a per-socket, per-event-name sliding
window, 30 calls/sec, silently dropping anything past that. The one real
subtlety: several of these events take an ack callback the client is
waiting on (`create-room`, `join-room`, ...) - naively dropping a
rate-limited call would leave a client-side "joining…" flag stuck `true`
forever with zero explanation, worse than just refusing. The wrapper now
detects a trailing callback argument and still invokes it with `{ ok:
false, error: "Too many requests - slow down a bit." }` when limited, so
the client always gets a real response either way. Verified live: firing
40 near-simultaneous `join-room` calls got exactly 30 through with the
normal error and 10 correctly rate-limited, and *every single one* of the
40 acks arrived (none hung) - plus confirmed a single normal call still
works exactly as before. Full `playtest.js` regression (which drives real
gameplay at whatever speed Node's event loop allows, well under this
limit) still clean afterward.

### Bug fix — Streamer Mode's copy-protection likely didn't work on Safari at all
Found while checking the CSS for other Safari-specific gaps after fixing
the accessibility `prefers-reduced-motion` ordering issue. `.room-code.
blurred` sets `user-select: none` to stop the code being selected/copied
out from under the visual blur (blur alone is purely cosmetic - the text
underneath is still there and copyable regardless of how blurred it looks,
which would defeat the entire point of Streamer Mode). Safari has never
shipped the *unprefixed* `user-select` property - it still requires
`-webkit-user-select` even in its newest versions - so without that
prefix, this protection was silently a no-op on every iPhone, iPad, and
Mac, for an app whose stated audience is explicitly "friends on their
phones." Added the `-webkit-user-select: none;` prefix alongside the
existing line. Also added the equivalent `-webkit-backdrop-filter` prefix
next to the "How it works" modal's `backdrop-filter: blur(2px)` for the
same reason, though that one is lower-stakes - the modal's actual
readability comes from the `rgba(0,0,0,0.6)` dark overlay underneath, so a
missing blur there degrades gracefully rather than silently failing at the
one thing a feature exists to do.

Honesty about verification: this environment doesn't have real Safari
available to test against, so I confirmed the CSS itself is valid and
correctly computed (both the prefixed and unprefixed properties apply,
`filter: blur(9px)` still works, no visual regression to anything else) -
the Safari-specific behavior claim is based on WebKit's well-documented,
long-standing prefix requirement for this property, not a literal live
test against the actual browser.

### Bug fix — round-based games could repeat the same question in one sitting
Every one of the 12 fixed-content-pool round-game types (Trivia, Would You
Rather, Most Likely To, Emoji Decode, Guess the Crowd, Anagram Blitz, Odd
One Out, Never Have I Ever, Riddle Me This, Guess the Year, True or False,
Rank It) picked its next prompt with a blind `randomFrom(pool)` every
round, with nothing tracking what had already been shown *within that same
game*. Computed the actual odds rather than assuming this was fine at
typical pool sizes: even at *default* round counts, this was a 42-46%
chance of showing a repeated question in a single sitting; at the max
allowed round count, 93-99.6%, depending on the game. That reads as a real
bug to players ("didn't we just get this one?"), not as "the content pool
is a bit thin."

Fixed with a `pickUnusedFrom(pool, usedIndices)` helper in `room.js`,
tracked per-game via a new `usedPromptIndices` Set on `room.game` (reset
each new game, shared across all rounds of that one session) - falls back
to allowing a repeat only once every entry in the pool has genuinely been
shown already, which doesn't happen in practice today since every pool
(12-36 entries) comfortably exceeds the 10-round max any of these games
allow. `startRoundGame` had to be restructured slightly (`prompt` is now
set as a separate statement after `room.game` exists, not inline in the
object literal) since the tracking Set needs to exist before the first
`generateRoundPrompt` call can reference it. `category`/`quickmath`/
`countdownletters` were deliberately left untouched - they're not
fixed-pool games (procedural generation or a letter+3-of-N-categories
combination), so a literal repeat is either impossible or astronomically
unlikely already.

Verified two ways: a unit test of `pickUnusedFrom` in isolation (10 draws
from a 3-item pool - first 3 correctly all-unique, later draws correctly
allow a repeat once exhausted, no crash), and a live end-to-end test of
Rank It at its 99.6%-repeat-odds worst case (12-item pool, 10 rounds) run
5 times - zero repeats across all 5 full games (50 rounds total). Full
`playtest.js` regression clean afterward.

Fixing that raised the obvious follow-up: are there other games with their
*own* separate word/prompt-selection code this didn't reach? Checked every
bespoke (non-generic-round-game) game's selection logic against the same
math:
- **Trivia Survival** had its own separate `randomFrom(triviaData)` call
  (not routed through the generic engine's now-fixed one) - same pool as
  regular Trivia, same problem, worse in practice since it defaults to
  more rounds relative to the pool (~80% repeat chance at 8 rounds, the
  default, scaling toward ~100% at its 20-round max). Fixed the same way.
- **Doodle Guess and Draw It** share one 30-word pool across their turns/
  rounds, and this app explicitly supports up to 24 players - with one
  turn per player (or more, with Doodle's `roundsPerPlayer` setting), that
  put the repeat odds at ~19% for a 4-player game, ~64% at 8, and a
  guaranteed 100% at the 24-player max this project specifically load-
  tested earlier. Fixed both with their own independent tracking (separate
  `usedWordIndices` per game type, even though they draw from the same
  pool - a Doodle Guess session and a Draw It session shouldn't constrain
  each other).
- **Prompt Battle and Fib or Fact** turned out to already be safe - both
  shuffle their *entire* prompt pool once at game start and index into it
  sequentially by round number, rather than re-picking randomly each
  round. Confirmed their round caps (10 and 8) stay safely under their
  pool sizes (30 and 20), so this pattern already guarantees no repeats.
- **Category Countdown, Quick Math, Countdown Letters** are correctly
  unaffected - none of them pick one fixed item from a list each round (a
  letter+3-of-N-categories combination, procedurally generated numbers,
  and a weighted-random 9-letter draw, respectively), so a literal repeat
  is either impossible or negligible for those already.

`startDoodle`/`startDrawIt`/`startTriviaSurvival` needed the same
object-literal restructuring as `startRoundGame` (the tracking Set has to
exist before the first pick can reference it). Verified live: Trivia
Survival at 10 of its 20-question pool (would've been ~93% likely to
repeat) - zero repeats across 10 rounds; Doodle Guess with all 8 players
(the pool-vs-player-count math above) - zero repeats across all 8 turns.
Full `playtest.js` regression clean afterward.

### Bug fix — a tie for first place only celebrated whoever joined first
The final leaderboard's gold "winner" row highlight was `i === 0 ? "is-
winner" : ""` - the *first* row in the score-sorted array, not every row
sharing the top score. Since `Array.prototype.sort` is stable, a genuine
tie preserves original join order, so two players finishing with identical
scores would see only whichever one joined the room *first* get the gold
highlight, the 🥇 medal, and (separately, in `playScreenTransitionSound`)
the "you won!" sound effect - the other, despite an identical score, got
treated as if they'd lost. Reproduced the exact bug against the real
production code before fixing it: constructed a tied scenario (two
players at 800, matching the old `top = sorted[0]` logic) and confirmed
the second tied player was denied the win sound under the old code.

Fixed both spots to compare *scores*, not array position - the leaderboard
now marks every row matching the max score as a winner, and implements
proper competition ranking (tied players share a medal/rank, the next
distinct score correctly skips ahead - 🥇🥇🥉, not 🥇🥈🥉) rather than just
skipping the highlight; the sound-effect check now compares the viewing
player's own score against the top score across all players, not "am I
literally first in the array." Verified by running the exact new logic
against the same constructed tie - both tied players now correctly get
the gold highlight, the shared 🥇, and the win sound, while a real 3-player
game confirmed 3rd place correctly renders 🥉 (not 🥈) when 1st place is
shared by two. Also set up a genuine live tied game (two players always
picking the majority choice in Would You Rather, guaranteeing identical
scores) and confirmed the server reports the expected equal final scores.
Full `playtest.js` regression clean afterward - this only touches
finished-screen rendering and the transition sound, nothing server-side.

### Bug fix — a Most Likely To vote tie shorted the actual points, not just the display
The leaderboard tie bug above raised an obvious question: is there a
version of this with *real scoring consequences*, not just a cosmetic
display issue? Yes - Most Likely To's per-round scoring picked exactly one
`winner` via `count > max` (strict greater-than) over vote tallies, same
"whoever's encountered first wins ties" flaw. In a tie for most votes -
genuinely common voting for one of a handful of friends, not a rare edge
case - only one tied player got the 300-point "you were voted most likely"
bonus, and everyone who'd voted for the *other* tied player got nothing
for correctly picking someone who, by the numbers, tied for the win.

Fixed to find every token tied for the max vote count, award the 300-point
bonus to each, and credit the 100-point "matched the winner" bonus to
anyone whose vote matched *any* tied winner - `winner`/`winnerName`
replaced with `winners`/`winnerNames` arrays. Updated the results-screen
client to match: "Winners: Alice & Bob" for a tie (natural English list
formatting for any number - "Alice", "Alice & Bob", "Alice, Bob & Carl"),
"Winner: Alice" unchanged for the normal case. Verified live: a genuine
4-player round with a real 2-way tie (2 votes each for two different
players) - both tied players correctly scored 300, both voters correctly
scored 100 each; a normal 3-player round with a clear single winner
scored exactly as before (unaffected); and the label-formatting logic
checked directly for 0/1/2/3-winner cases. Full `playtest.js` regression
clean afterward.

### Small fix — Countdown Letters' "longest word" fun fact could drop a tie
Same audit pass, lower stakes: the round-results "Longest word: X" label
picked one word via strict `>` comparison on length - if two players
submitted different words of the same (longest) length, only the first one
seen got named. Actual *scoring* was never affected by this (every valid
word already scores independently by its own length, no winner-takes-all
logic here) - purely a "fun fact" label silently crediting one of two
equally-deserving words. Fixed to track every unique word tied for the max
length (`longestWords` array, replacing the single `longest` string) and
updated the label to list all of them ("Longest words: HOUSE, MOUSE").
Verified live: two players submitting different 3-letter combinations of
the same length from the same random letter pool - both correctly appear
in `longestWords`, both scored their own points independently as before.
Full `playtest.js` regression clean afterward.

### New feature — search the game list
23 games is a lot to scroll through as one flat list, especially the
second+ time a host already knows which game they want. Added a live
search box (`🔍 Search 23 games…`) above the game picker, matching against
each game's title *and* description as you type - filters by directly
showing/hiding `.game-row` elements on the `input` event rather than
running a full `render()` per keystroke, so it can't collide with (or be
slowed down by) the render pipeline's own focus-preservation logic. Shared
by both places the game list appears (the "Create a Room" browse screen
and the lobby's "‹ Change game" view) via one `bindGameSearch()` function.
The typed query persists across navigating into a game's settings and back
("‹ Back to games") via a module-level variable, and shows a "No games
match your search" message when nothing matches. Verified live: filtering
by a title word, filtering by a description-only word, the empty-match
state, clearing back to all 23, query persistence across navigation, both
call sites independently, no console errors, Enter key doing nothing
unexpected (no wrapping `<form>` to accidentally submit), and the input's
accessible name correctly exposed as "Search games" in the accessibility
tree.

### New feature — a rules reminder during actual gameplay
The landing page's "How does this work?" only ever explains the app in
general (host, join, play) - a player who joins an already-started room via
its code lands directly on the gameplay screen, having never seen that
explainer, with no way to check what a specific *unfamiliar* game (Word
Bomb, Rank It, Category Countdown...) actually wants from them. Added a
second ❓ button, next to the sound toggle, visible only while a game is
actually in progress (`room.state === "playing"`) - tapping it shows that
game's own existing `GAME_META` title/icon/description in a small modal, no
new content to author or keep in sync with the picker's own descriptions.

Deliberately built as a static element living outside `#app` in
`index.html` (`#gameHelpBtn`/`#gameHelpBackdrop`), shown/hidden and filled
in via direct DOM manipulation rather than through the normal `render()`
pipeline - `#app` gets fully replaced on every render, including the
once-a-second timer re-renders during an active round, so routing this
through render() would mean rebuilding whatever game screen is currently up
just to pop a modal, risking the careful per-field draft-state some forms
(Two Truths, Category Countdown) depend on to survive those re-renders.
Reuses the same dialog semantics already built for "How it works"
(`role="dialog"`, `aria-modal`, focus moved in on open and restored to the
trigger button on close, Escape-to-close) rather than reinventing them.
Verified live end-to-end: hidden on the landing page, hidden in the lobby,
correctly appears the moment a real 2-player game actually starts, shows
the right icon/title/description for the active game, Escape closes it and
restores focus, hides again after leaving the room - plus confirmed via the
already-rendered game picker that all 23 games have complete icon/title/
description data (the exact fields this reads), so the same code path
works for any of them, not just the one tested end-to-end. Full
`playtest.js` regression clean afterward.

Found one real edge case while specifically testing for it: if the game
finished (or the room otherwise left "playing") *while the help modal was
open*, nothing closed it - a player would be left staring at stale rules
over a screen that had already moved on to the final leaderboard, and
Escape/closing it would try to restore focus to the trigger button, which
had just gone `display:none` (a silent no-op, not a crash, but focus would
land nowhere useful). Fixed by having `updateGameHelpButton()` - already
called at the end of every `render()` - force-close the modal too whenever
it detects the game is no longer active. Verified with a clean, isolated
test (manually opened the modal, triggered a real `render()` via clicking
"How does this work?" from a genuinely-landing-page state, confirmed the
modal correctly force-closed) after an earlier, messier live-orchestration
attempt gave confusing results that turned out to be from overlapping
background test scripts and a `localStorage` rejoin race, not an actual
bug - re-confirmed the fix was right by isolating the test properly rather
than trusting the noisy first attempt. Full `playtest.js` regression clean
afterward.

### Bug fix — an invalid PORT crashed with a cryptic Node internals error

`server.js` read `const PORT = process.env.PORT || 3000` with no validation
and no `server.on("error", ...)` handler anywhere in the file - only the
`server.listen(PORT, () => {...})` success path was wired up, so a listen-
time failure was an *unhandled* `'error'` event.

Traced the actual failure mode a deployer would hit with a typo'd `PORT`
(e.g. `PORT=abc`): Node's `net.Server.listen()` treats a non-numeric first
argument as a named-pipe path rather than a port number, so the resulting
crash was `Unhandled 'error' event` / `Error: listen EACCES: permission
denied abc` - nothing in that message points at `PORT` being the problem,
and the existing `uncaughtException`/`unhandledRejection` handlers never
even see it, since (correctly, by earlier design) they're registered
*inside* the listen success callback so they can't mask a listen-time
failure. Reproduced this with the real `server.js`, not just a simplified
snippet, to confirm it wasn't just a quirk of an isolated test.

Fixed by adding a `server.on("error", (err) => {...})` handler, registered
*before* `server.listen()`, that distinguishes the cases and exits with a
clear, actionable message instead of a raw stack trace:
- `EADDRINUSE` → "Port N is already in use - stop whatever else is using
  it, or set PORT to something else."
- `EACCES` with a non-numeric `PORT` → "Couldn't start on PORT="abc" -
  that's not a valid port number. PORT should be a plain number (e.g.
  PORT=3000)." (this also naturally covers the real-but-rarer case of a
  numeric port under 1024 without elevated privileges, since that also
  throws EACCES - the message there just won't mention "not a valid port
  number" since the value *is* numeric, falling through to the generic
  branch instead)
- anything else → the raw `err.message`, still with a clear "Failed to
  start the server:" prefix

Every branch still calls `process.exit(1)`, deliberately preserving the
existing philosophy from the TRUST_PROXY/EADDRINUSE work earlier - a
listen-time failure should crash loudly with a real non-zero exit code for
a process manager to see, not be silently swallowed or retried.

Verified directly against the real server: `PORT=abc node server.js` now
exits 1 with the clear "not a valid port number" message instead of a raw
stack trace; running a second instance on the already-occupied port 3000
still exits 1 with the "already in use" message (confirms EADDRINUSE
behavior is unchanged from before this fix); `PORT=3999 node server.js`
(a genuinely free port) still starts up normally and logs the usual
LAN-address banner, confirming the new handler doesn't interfere with the
success path. Restarted the live dev server to pick up the change. Full
`playtest.js` regression clean afterward.

### Accessibility — the game search box was silent to screen readers

Added along with the search box itself was a `<p id="gameSearchEmpty">`
"No games match your search" message, but it's just plain text - shown by
toggling `display`, which does nothing for a screen reader unless the
element is already wired up as a live region. A sighted player sees the
list shrink to zero rows instantly; a screen reader user typing a query
got no feedback at all about how many (if any) games still matched,
short of manually re-navigating the entire list after every keystroke.

Fixed by announcing the match count through the same shared `#screenAnnouncer`
live region (`role="status" aria-live="polite"`) the screen-transition
announcer already uses, debounced 400ms after the user stops typing so it
announces once per pause rather than once per keystroke. Caught and fixed
a grammar bug in my own first draft before shipping it (`1 game match`
instead of `1 game matches`) by testing the singular case specifically,
not just assuming the pluralization branch was right.

Caught a second, more consequential bug the same way: reusing the shared
announcer meant a debounce timer left pending from the search screen could
still fire ~400ms after the player already clicked a game row and moved on
- silently overwriting the *new* screen's just-announced heading with a
stale "N games match" message from the screen they'd already left. Fixed
by hoisting the debounce timer out of `bindGameSearch()`'s local scope to
module scope, and having `render()`'s existing `isNewScreen` branch (which
sets the announcer for every real screen change) cancel it before setting
the new heading.

Verified all of this live end-to-end, not just read through: typing "trivia"
announces "2 games match "trivia""; typing a no-match query announces "No
games match "...""; clearing the query silences the announcer; typing
"heads up" (a single match) announces "1 game matches "heads up"" with
correct grammar; and, specifically reproducing the race, typing a query and
immediately clicking a matching game row before the 400ms debounce elapsed
left the announcer correctly reading the new screen's heading a full second
later, confirming the stale timer never fired. Full `playtest.js` regression
clean afterward.

### Bug fix — a fractional room setting (rounds, timer, lives) would visibly break the UI

`clamp(v, lo, hi, fallback)` — the helper every room-settings field
(`rounds`, `answerTime`, `turnDuration`, `startingLives`, `maxRounds`,
`drawSeconds`, `voteSeconds`, `writeSeconds`, `guessSeconds`, ...) goes
through when a host updates settings - only bounds the *range* of a value,
not its *shape*. The client-side settings form only ever sends whole
numbers, but nothing on the server enforced that independently: a scripted
or buggy client sending e.g. `{ trivia: { rounds: 3.7 } }` over the raw
`update-settings` socket event would sail straight through `clamp(3.7, 1,
10, ...)` unchanged and get stored as-is.

That fractional value is never reformatted anywhere downstream - the round
counter and phase timer both interpolate it directly into the UI
(`` `Round ${g.round} of ${g.totalRounds}` ``, `` `${g.timeLeft}` `` on
every tick since `timeLeft` just gets `-= 1`'d each second) - so every
player in the room would have seen "Round 1 of 3.7" and a countdown
ticking 45.5, 44.5, 43.5... for the entire game, a real, visible glitch
reachable by anything that can open a websocket, not just a rare edge case.

Fixed by adding `clampInt()`, identical to `clamp()` but rounding to a
whole number first, and switching every settings field's clamp call (20
call sites across `applySettings`) to it - deliberately *not* changing
`clamp()` itself, since it's also used for stroke-point `x`/`y` coordinates
in Doodle Guess and Draw It, where fractional values in [0, 1] are the
entire point of the field; rounding those would collapse every drawn point
onto a corner. Kept the two use cases on separate functions rather than
adding a "round or not" flag, so a future settings field added to
`applySettings` gets the correct behavior (integer) by default just by
using `clampInt`, without needing to remember a flag.

Verified directly against the real server with a throwaway raw-socket
script (not just code review): sent `{ trivia: { rounds: 3.7, answerTime:
45.5 } }` over `update-settings` and confirmed the room's broadcasted
settings came back as `rounds: 4, answerTime: 46` — both whole numbers,
correctly rounded (not floored/truncated) either direction. Confirmed via
source that the four stroke-coordinate call sites (Doodle Guess and Draw
It, `x`/`y` each) were deliberately left on the original `clamp()` and are
still exercised with fractional values by `playtest.js`'s own doodle test.
Restarted the live server to pick up the change. Full `playtest.js`
regression clean afterward.

### Bug fix — an emoji-heavy name could truncate into a broken glyph

`sanitizeName()` (and 4 similar free-text truncation sites) capped length
with plain `str.slice(0, n)`, which counts UTF-16 *code units*, not the
"characters" a person would count. Most emoji (a surrogate pair, 2 units)
sitting right on the cutoff boundary gets sliced in half, leaving a lone
unpaired surrogate at the end - not valid UTF-16 on its own, so it renders
as a broken/replacement-character glyph wherever that name shows up
(player list, results, everywhere). Confirmed concretely, not just in
theory: `"A" + "😀".repeat(10)` (21 UTF-16 units) sliced to 20 produced
`"A😀😀😀😀😀😀😀😀😀\ud83d"` - a dangling high surrogate.

Fixed with a shared `truncateText(str, maxLen)` helper built on
`Intl.Segmenter` (grapheme granularity, available since Node 16, confirmed
present on this Node v24 install) - it truncates by actual grapheme
cluster, so a plain emoji never gets split, and neither does a multi-
codepoint sequence (ZWJ family emoji, flag emoji made of two regional-
indicator symbols, skin-tone modifiers) that a naive "iterate by codepoint"
fix would still mishandle. Verified all three cases directly: 10 plain
emoji past the boundary, 25 ZWJ family emoji past the boundary, and 25 flag
emoji past the boundary all truncate to exactly 20 whole graphemes with no
broken cluster and no lone surrogate in any case.

Applied to every free-text truncation site that shares this exact pattern:
player names (20), Prompt Battle answers (140), Fib or Fact lies (100),
Doodle Guess guesses (40), and Two Truths and a Lie statements (80). Left
the room password's own truncation (40) on plain `.slice()` - it's only
ever compared (`===`), never rendered, so a mid-surrogate cut there has no
visible-glitch consequence, unlike everywhere else on this list.

### Hardening — round-game free-text answers had no length limit at all

While auditing the truncation sites above, found a related but more
serious gap one layer up: `roundGameSubmitAnswer()` - the generic handler
shared by all 15 round-game types - stored the client's raw payload
completely unvalidated (`{ ...payload, timeLeftAtSubmit: g.timeLeft }`),
no length cap of any kind. `scoreRoundGame()` only ever runs `asString()`
on these fields (a type coercion) before storing/displaying them, so
Emoji Decode, Category Countdown, Anagram, and Riddle's free-text answers
had *zero* size limit server-side - the client's own `maxlength` on the
input is purely a UI courtesy a scripted client can ignore outright.
Socket.IO's default 1MB/message transport cap is the only thing that
would've stopped an actually catastrophic payload, but even a few KB is
already far past anything a real answer looks like, and every submission
gets broadcast to *every* player's `room-update` and rendered in the
results screen - one misbehaving client could've visibly wrecked the
results screen (and burned bandwidth re-broadcasting the blob) for the
whole room, not just themselves.

Fixed by capping each affected field at submission time, matching the same
limit the client's own `<input maxlength>` already advertises for that
field (so this isn't a new, made-up number - it's enforcing what the UI
was already promising): Emoji Decode 60, Anagram 20, Riddle 60, Category
Countdown 20 (via the same new `truncateText()`), plus Category Countdown's
per-round `words` array capped to 3 entries (matching the fixed 3 categories
per round) so an oversized array can't be sent either, not just oversized
individual words.

Verified directly against the real server: submitted a 50,000-character
riddle answer over the raw `roundgame:submit-answer` event and confirmed
the room's broadcasted result came back with the answer truncated to
exactly 60 characters, matching Riddle's own client-side limit. Restarted
the live server to pick up both fixes. Full `playtest.js` regression clean
afterward.

### Hardening — Word Bomb had the same missing-length-cap gap, with a worse consequence

Same audit, one more instance: `wordBombSubmit()` stored the client's raw
word with no length limit, same as the round-game gap fixed above - but
here the consequence is worse. A round-game answer overwrites one Map
entry per player per round (`g.answers.set(token, ...)`), so an oversized
payload only ever bloats one broadcast. Word Bomb's equivalent,
`g.usedWords`, is a `Set` that accumulates for the *entire game* and is
never cleared until it ends - a misbehaving client repeatedly crafting an
oversized-but-technically-valid word (padding plus the required fragment)
across many turns could grow it unbounded over a long game, not just bloat
one broadcast like the round-game case.

Fixed the same way: `truncateText()`, capped to 40 - matching Word Bomb's
own `<input maxlength="40">`. Verified directly against the real server: a
50,000+ character crafted word (`fragment + "a".repeat(50000)`) came back
in the broadcasted `lastResult` truncated to exactly 40 characters and
still correctly `valid: true` since the required fragment was preserved
(placed at the front, which truncate-from-the-start keeps) - and, to make
sure the fix's direction wasn't accidentally backwards, also confirmed
putting the fragment at the *end* of the same oversized word correctly
came back `valid: false`, since truncating from the start removes it.
Restarted the live server. Full `playtest.js` regression clean afterward.

### Bug fix — a double-tap on "Next Round"/"Next Turn" silently skipped a round for everyone

Every one of the 8 "advance to next round/turn" functions across every
game type - Heads Up, Prompt Battle, the 15-type round-game engine, Fib or
Fact, Trivia Survival, Doodle Guess, Two Truths and a Lie, Draw It - had
the same gap: no guard requiring the game to actually be in its
pre-advance phase (results/summary/reveal) before advancing. Nothing else
was stopping this either: the client's "Next Round"/"Next Turn" button has
no debounce or disabling after the first click, and there's no round-trip
to the server in between a first and second click to naturally prevent it.
A rapid double-click or double-tap (genuinely easy to do by accident,
especially on mobile with any input lag) fires the same socket event
twice, and since both land before the first broadcast re-renders the
button away, both get processed - silently incrementing the round/turn
counter twice and skipping an entire round of content for every player in
the room, not just the host who clicked.

Fixed by requiring each function's own specific pre-advance phase before
allowing it to run (`"results"` for Prompt Battle/round-games/Fib/Trivia
Survival/Draw It, `"summary"` for Heads Up/Doodle Guess, `"reveal"` for
Two Truths) - a second, near-simultaneous call now finds the phase already
moved on by the first and is correctly rejected as a no-op.

Heads Up needed a different shape of fix: `headsUpNextTurn` is also called
internally by the departure-recovery path (`checkPhaseAdvanceAfterDeparture`)
when a performer disconnects before ever starting their turn, from the
*"ready"* phase specifically - not "summary". A blanket `phase !== "summary"`
guard inside the function itself would have silently broken that recovery
path (previously fixed and documented earlier this session) the moment it
was needed. Caught this by checking every call site of all 8 functions
*before* editing, not after - found this function has two legitimate
callers from two different phases, the other seven only have one. Fixed by
placing the phase guard at the `"headsup:next-turn"` *socket handler* level
instead of inside the shared function, leaving the function itself (and
the untouched departure-recovery call site) exactly as they were.

Verified live against the real server, not just by reading the code: fired
`roundgame:next-round` twice back-to-back at the results screen and
confirmed the round counter advanced by exactly one (1→2), not two; for
Heads Up specifically (only 2 players, so a double-advance would push
`turnIndex` to 2 - at or past `turns.length` - which ends the *entire game*
rather than starting a second turn), fired `headsup:next-turn` twice after
a real turn-timer expiry and confirmed the result was a normal "ready"
phase for the second player's turn, not a premature "finished" - proving
only one advance happened. Restarted the live server. Full `playtest.js`
regression clean afterward (which exercises every game type's normal
single-advance flow, confirming none of the 8 new guards broke the
legitimate case).

### Bug fix — the same double-tap gap on "Start Game" and "Play Again"

Same root cause as the "Next Round"/"Next Turn" fix above, found by
checking for the same pattern elsewhere: `start-game` and `play-again`
had no guard against being called when the room wasn't actually in the
phase they're meant for (`"lobby"` and `"finished"` respectively) - and
neither button has any client-side debounce. Every `start*` function
unconditionally calls `resetScores()` and re-randomizes turn order/prompt
selection from scratch, so a rapid double-click would silently
re-initialize the just-started game a moment later - not a "skipped
round" like the next-round bug, but a wasted/discarded initial state
(different random shuffle, different first question) that could produce a
brief visible flicker for players whose client renders the first
broadcast before the second one silently overwrites it.

Fixed by adding a `room.state` check to each - `!== "lobby"` for
start-game, `!== "finished"` for play-again - confirmed safe by checking
the client only ever shows each button in exactly that state (so the
legitimate single-click path is unaffected). `return-to-lobby` was
deliberately left alone - repeated calls just set the same
state/currentGame/game fields to the same values, genuinely idempotent,
no observable harm either way.

Verified live against the real server: fired `start-game` twice rapidly
and confirmed only one distinct trivia prompt was ever broadcast (the
second call correctly found `room.state` already flipped away from
`"lobby"` by the first); played a full round through to the finished
screen, then fired `play-again` twice rapidly and confirmed the same -
only one distinct prompt observed, meaning the second call was correctly
rejected. Restarted the live server. Full `playtest.js` regression clean
afterward.

### Bug fix — the "Reconnecting…" message disappeared while still genuinely disconnected

Found while directly observing what a player actually sees during one of
this session's own routine live-server restarts (an operational check, not
a code-review one) - the client's `showToast()` is a generic, one-size
helper: every message, including "Reconnecting…", auto-hides after a fixed
3.2 seconds regardless of what it's describing. That's correct for a
one-off event ("Reconnected!", "Incorrect password") but wrong for a
message describing an *ongoing state* - any real disconnect longer than
3.2s (a phone losing signal for a few seconds, a wifi hiccup, a server
restart) left the toast gone while the socket was still genuinely down,
and nothing else in the UI reflects connection state at all. A player in
that gap sees a frozen, stale screen with zero indication anything is
wrong - indistinguishable from the app just being broken.

Confirmed this concretely by watching a real disconnected browser session,
not just reading the code: stopped the live server, waited past 3.2s, and
inspected the toast element directly - text was still "Reconnecting…" but
`hidden: true`, exactly as suspected.

Fixed by adding an optional `persistent` flag to `showToast()` that skips
the auto-hide timer, used only for the "Reconnecting…" call - every other
call site is unchanged (defaults to the existing auto-hide behavior).
`socket.on("connect", ...)` already had its own "Couldn't rejoin"/
"Reconnected!" toasts on the success/failure paths, both correctly still
using the default (non-persistent) behavior since those describe one-time
events, not ongoing state.

Verified live end-to-end: stopped the server, waited 5s (well past the old
3.2s cutoff), confirmed the toast was still visible and still read
"Reconnecting…"; restarted the server and confirmed the eventual
follow-up toast (in this case "That room code doesn't exist" - the full
server restart wiped the in-memory room, so rejoin correctly failed with
its own explanatory, appropriately-transient message) auto-hid normally,
confirming the persistent flag didn't leak into the unrelated call sites.
Full `playtest.js` regression clean afterward.

### Accessibility — confetti was missing from the `prefers-reduced-motion` audit

Found while re-checking the newer UI additions against the earlier
`prefers-reduced-motion` sweep (see the "closed the coverage gaps" entry):
`spawnConfetti()` throws 46 pieces across the full viewport on every win,
each animated via `confettiFall` (a full-height fall plus a 600-degree
rotation) - the largest-scale motion anywhere in this app by far, and
exactly the kind of thing `prefers-reduced-motion` exists to suppress. It
had no override at all, because the earlier audit swept every *static*
`animation:` declaration in the stylesheet, and this one is JS-spawned
(the class exists in CSS, but nothing calls attention to it needing the
same treatment unless you're specifically thinking about every path that
creates an animated element, not just every animated selector already on
the page).

Fixed with `@media (prefers-reduced-motion: reduce) { .confetti-piece {
animation: none; opacity: 0; } }`, placed after the base rule (same
source-order requirement as every other override in this file).
`opacity: 0` rather than just `animation: none` - the pieces start
positioned at `top: -12px` (just off the top edge), so freezing without
hiding would leave 46 invisible-anyway elements sitting there uselessly;
the existing JS cleanup `setTimeout` still removes them after 4.5s either
way, no JS change needed.

Verified via the CSSOM directly (this browser tool can't toggle the actual
OS-level motion preference): confirmed both rules parse correctly and in
the right order (base rule, then the media-query override, matching
specificity - same mechanic already validated for the other 8 overrides in
this file), and that `prefers-reduced-motion: reduce` is valid,
recognized media-query syntax via `matchMedia()`. Not a server-side or
game-logic change - no regression run needed, `playtest.js` never loads
CSS.

### Hardening — Rank It's order array had the same missing-cap gap, in array shape

Found by applying the same lesson as the confetti fix just above: an audit
method scoped to one *shape* of a bug only catches instances in that
shape. The free-text length-cap fix earlier this session covered every
string field in the round-game engine (`ROUND_GAME_TEXT_LIMITS`) and
Category Countdown's `words` array specifically - but missed Rank It's
`order` array, because that fix was scoped to "free text," not to every
unbounded payload shape. `roundGameSubmitAnswer` still spread `order`
straight through raw with no cap on either the array's length or what its
individual elements could be.

A legitimate `order` is always exactly `correctOrder.length` (4 today)
plain numeric indices - an oversized array, or one containing a few huge
string/object elements instead of numbers, already failed to score
(`guessOrder[pos] === idx` just evaluates to `false` for anything that
isn't the right number in the right position) but was still stored and
broadcast to every player in the room raw, same bloat risk as the earlier
text-field gap.

Fixed by capping the array to 20 elements and coercing every element to
either a genuine finite number or `-1` (a sentinel that can never match a
real index, preserving the exact same "just fails to score" behavior for
garbage input, just without the size risk).

Verified directly against the real server: submitted a 96-element order
array mixing valid indices with a 50,000-character string and a large
object, and confirmed the broadcasted result came back capped to exactly
20 elements with the oversized entries correctly coerced to `-1` (and the
valid `0, 1, 2, 3` entries preserved in their positions) - not just
silently truncated to whatever length happened to work. Restarted the
live server. Full `playtest.js` regression clean afterward.

### Security/stability fix — a crafted Heads Up settings update could freeze the whole server

Found by pushing the "same gap, different shape" question from the last
two fixes one step further: `applyRoomSettings`'s Heads Up categories
validation filters out unrecognized category names, but - unlike every
numeric/text field fixed earlier - never deduped the result. Every element
individually passes as long as it's *a* real category name, so a client
sending the same valid name repeated many times over sails straight
through with no single invalid element to catch.

That array becomes `g.categories` in `refillDeckIfNeeded`, which does
`for (const cat of g.categories) { for (const w of headsUpData[cat]) {
pool.push(w) } }`. A million duplicate categories means a million
redundant passes each appending that category's full word list again - a
pool array potentially tens of millions of entries long, built in one
synchronous loop. This isn't the "broadcast bloat" class of the last two
fixes - Node is single-threaded, so a loop that size doesn't just bloat
one room's state, it blocks the entire event loop and **freezes the server
for every player in every room** until it finishes (or the process runs
out of memory first). The most severe finding from this whole audit
thread, reachable by anyone who can open a websocket to a room they host.

Grepped every other `.filter()` call in the file to check whether this
"filter validity without deduping a set of options" shape recurs
elsewhere - confirmed it doesn't; every other filter operates on internal
server state (player lists, vote counts, pool indices), not a raw
client-supplied array being checked against a whitelist. This was a
one-off, not a pattern.

Fixed by deduping (`[...new Set(...)]`) alongside the existing filter -
with only 7 real category names, the deduped result can never exceed 7
elements regardless of what a client sends.

Verified directly against the real server, not just reasoned about (an
actual million-entry submission wasn't worth risking against the live
dev server given the exact freeze this is meant to prevent): submitted
10,003 categories - 10,000 duplicates of a valid name, one invalid name,
one different valid name - and confirmed the broadcasted settings came
back as exactly `["Movies","Occupations"]`, the invalid entry rejected
and the 10,000 duplicates collapsed to one, processed in ~2ms of actual
handler time. Restarted the live server. Full `playtest.js` regression
clean afterward.

### Hardening — my own truncateText() fix from earlier this session had a residual cost gap

Same investigation thread as the last three fixes, turned on my own
earlier work: `truncateText()`'s `Intl.Segmenter` pass is O(input length) -
it processes the *entire* raw string into grapheme clusters before ever
truncating anything, so a near-1MB input (Socket.IO's default transport
ceiling; confirmed no override exists in this app) still cost the full
segmentation work even though only the first 20-140 characters are ever
kept. Measured concretely: a single 900KB call took ~150ms. Not remotely
the severity of the Heads Up freeze - one call doesn't block the *whole*
server for an extended period - but every handler that accepts a name or
free-text answer calls this on every submission, so a client repeatedly
sending near-max payloads turns a "should be instant" field into a
sustained, real, repeatable cost against the shared event loop.

First instinct was to pre-slice to a "generous units-per-grapheme margin"
before segmenting (e.g. `maxLen * 20` UTF-16 units) - checked this against
real data before shipping it and it's actually unsafe: Unicode's ZWJ
grapheme-cluster rule has no enforced per-cluster length limit (chaining
emoji with ZWJ keeps producing a single grapheme no matter how many are
joined), so a crafted input could be one giant "character" by grapheme-
counting rules that silently defeats any per-grapheme margin and lets the
full untruncated string back out.

Fixed instead with a flat, empirically-chosen 10,000 UTF-16-unit pre-slice
(plain `.slice()`, O(1)) before the segmentation pass - bounds the
segmentation input regardless of what any single cluster tries to claim.
The number itself wasn't guessed: measured real complex multi-person/
skin-tone emoji clusters at up to 17 units each, meaning the largest
`maxLen` in this file (140, Prompt Battle answers) needs up to 140×17=2380
units of headroom just for *legitimate* content - a first guess of
~20-24 units/grapheme was dangerously too tight against that. 10,000 gives
comfortable margin above the real-world number while keeping the
segmentation cost negligible either way.

Verified concretely, not just reasoned about: confirmed 140 realistic
complex-emoji characters (1680 raw units) still round-trip through
unchanged (no unintended truncation from the new cap); confirmed a 900KB
adversarial input's cost dropped from ~150ms to ~2ms; and verified against
the real running server with an actual 900,000-character name over a real
`create-room` socket call - ack came back in 15ms (network transfer
included) with the name correctly stored truncated to 20 characters.
Restarted the live server. Full `playtest.js` regression clean afterward.

### Documentation — README's security summary didn't mention shape validation

The "Already handled for you" section lists what a deployer doesn't need
to worry about (rate limits, the 24-player cap, crash isolation, disconnect
handling) but said nothing about the shape-validation work from this
session's audit - including the Heads Up DoS fix, the most severe finding
of the whole session. Since this section exists specifically to answer "is
this safe to expose publicly," leaving out the one fix that prevented a
single crafted message from freezing the entire server for every room was
a real gap in an otherwise-accurate summary, not just a missing nice-to-
have detail.

Added a concise addition covering the general shape-validation guarantee
(numbers range-checked and rounded, text length-capped without splitting
characters, arrays capped and deduplicated) and specifically why the
dedup part matters - a presence-only check can't catch "this value is
individually valid, repeated many times," and unlike a normal per-request
slowdown, an event-loop-blocking bug on a single-threaded server affects
every room on the process, not just the sender's own.

### Documentation — the testing-discipline checklist didn't cover the technique that found the DoS bug

Added a 6th item to "Before trusting a change is done" for the specific
technique that caught the Heads Up freeze: submitting one *individually
valid* array element repeated many times, not just malformed ones. This is
a genuinely distinct failure mode from the existing "fuzz pass" item (#2,
which tests wrong types/shapes) - a type/shape fuzzer sends garbage that
fails validation; this technique sends something that *passes* every
per-element check and only breaks because nothing deduped the results.
Worth documenting as its own checklist item since it's exactly the kind of
test that's easy to skip ("every individual value is valid, what could go
wrong") right up until it freezes the whole process.

### Bug fix — a player who ran out the clock without answering vanished from results entirely

Found doing an actual live playthrough in the browser (not `playtest.js` —
its bots always submit an answer within the time limit, so this path had
never been exercised by the automated regression at all): every one of the
15 round-game types built their results list by iterating `g.answers`, a
Map that only ever gets an entry when a player actually calls
`roundgame:submit-answer`. A player who was present and connected for the
whole round but simply hadn't answered when the timer ran out - an
ordinary, frequent situation, not a rare edge case - wasn't shown as "no
answer": they were missing from the results screen entirely, with no row,
no indication they were even in the round.

The client's own rendering was already written expecting this case to be
representable (`res.choice != null ? ... : "no answer"` for
trivia/quickmath/truefalse/guesstheyear, `res.guess != null ? ... : "no
answer"` for Guess the Crowd, `s.word || "—"` for Category Countdown) - the
gap was entirely on the server side never actually producing that data.

Fixed with a new `allAnswerEntries(room)` helper that iterates every player
still in the room instead of `g.answers` directly, leaving `payload`
`undefined` for anyone who didn't submit. Every branch's *existing*
`payload && payload.x` null-safety already does the right thing
automatically with this wider iteration source - confirmed by reading
every one of the 15 branches first, not assumed, and specifically checked
for a subtler trap: two separate vote-*counting* loops (Would You
Rather's A/B tally, Never Have I Ever's have/haven't tally) use `else`
branches that would have silently miscounted a non-answer as a specific
choice if their iteration source were broadened the same way - correctly
left those two (and Most Likely To's already-`continue`-guarded counting
loop, and the two closest-guess ranking helpers, which filter out null
guesses regardless) on the original `g.answers`-only source, since a
non-answer shouldn't count toward "what did people actually choose."

Verified live against the real server for two structurally different
result shapes: a Trivia round where one player answered and the other
was deliberately left silent through the real 8-second timer - the
silent player now appears in the broadcasted results (previously would
have been completely absent) with `choice`/`correct` both `undefined`,
which the client's loose `!= null` and truthy checks already treat
identically to `null`/`false`; and a Category Countdown round with the
same setup, confirming the non-answering player appears in *every*
category's submission list with an empty word (rendering as the client's
own "—" fallback). Restarted the live server. Full `playtest.js`
regression clean afterward, including the existing mid-game-disconnect
test (a disconnected-but-still-present player now also correctly shows as
"no answer" instead of vanishing, without breaking the departure-handling
logic that's unrelated to this fix).

### Documentation — added the testing-discipline item that found the "vanishes from results" bug

7th item on "Before trusting a change is done": deliberately let the clock
run out on a player without answering during a browser playthrough.
`playtest.js`'s bots are too well-behaved (always act, always in time) to
ever exercise this path on their own - a real human being slow,
distracted, or simply not answering is a coverage gap only a live
playthrough with that specific scenario in mind can catch, which is
exactly how the "non-answering player vanishes from round-game results"
bug (above) was found.

### Bug fix — same "vanishes from results" gap in Two Truths and a Lie's reveal

Same class as the round-game fix above, found by deliberately checking
every OTHER game with a similar "did everyone respond" results screen
rather than assuming the round-game engine was the only place this could
happen. Two Truths and a Lie's reveal built `guessResults` by iterating
`g.guesses` directly - a player who was present the whole guessing phase
but simply never submitted a guess before the timer expired was missing
from the reveal screen entirely, same underlying gap.

Checked every other game with this shape of results display first, not
assumed vulnerable: Prompt Battle, Fib or Fact, and Draw It are all
*submission*-centric (a list of answers/lies/drawings with vote counts,
not a per-player list) - a non-submitter genuinely has nothing to show
there, so they're not affected. Trivia Survival was already correct -
it already iterates every player with an explicit `has(token) ? ... :
null` check, a good existing reference for how this should work.

This one needed more than just widening the iteration source, unlike the
round-game fix: the reveal function's counting logic (`fooled`, which also
sets the spotlight player's own score via `fooled * 100`) and the
per-guesser 200-point award were both computed in the *same* loop as the
results list, so naively broadening it would have silently counted a
non-guesser as "fooled" and inflated the spotlight player's score - the
same trap avoided for Would You Rather/Never Have I Ever's counting loops
in the earlier fix. Fixed by iterating every player (excluding the
spotlight, who never guesses their own lie), adding a `guessed` boolean to
distinguish "didn't guess" from "guessed and got it wrong," and gating
both the score award and the `fooled` tally on `guessed` being true.

The client only had a binary "found the lie"/"got fooled" display, so this
also needed a client-side change (unlike the round-game fix, whose client
was already written expecting the missing case): added a third state -
"⏱️ didn't guess" - alongside the existing two.

Verified live against the real server: 3 players, one deliberately silent
through a real 10-second guessing-phase timeout - the reveal came back
with the spotlight player correctly excluded, the real guesser's guess
preserved exactly, and the silent player correctly present with
`guessed: false, guess: null` instead of being absent. Restarted the live
server. Full `playtest.js` regression clean afterward.

### Content — expanded Rank It and Heads Up's thinner pools

Not a bug fix - the earlier repeat-prevention/no-repeat-until-exhaustion
mechanisms (this session's `pickUnusedFrom` for round-games, and Heads
Up's pre-existing shuffle-deck-and-reshuffle-on-exhaustion pattern,
verified correct while investigating this) were already working exactly
as designed. But "correctly reshuffles once exhausted" and "has enough
content that exhaustion is rare" are separate concerns - checking actual
pool sizes across every data file turned up two genuinely thin ones worth
padding out for a better experience over a long party session, not just a
short test game.

**Rank It** (`rankit-data.js`): 12 -> 22 ranking prompts. Added 10 new
ones spanning mountains, US state land area, leg counts, liquid boiling
points, continent population, tech-invention years, US presidential term
start years, ocean/lake/sea max depth, country land area extremes, and
major scientific breakthroughs by year. Deliberately picked topics with
large, indisputable gaps between items and stable, well-documented figures
- avoided anything with contested rankings, frequently-revised counts (like
planetary moon counts), or dollar-figure comparisons that go stale over
time, matching the "fact-check any new trivia-style content" discipline
this session established for a real reason: an earlier pass caught a tied
"ranking" question with no correct answer, so every new entry here was
checked for a clean, unambiguous order before being added, not just
plausibility. Verified every existing entry's ordering too while auditing
the file (all correct, nothing to fix) before adding to it.

**Heads Up** (`headsup-data.js`): the 4 thinnest categories brought up
from 14-16 words to 20-24, matching the fuller ones (Animals 24, Movies/
Occupations 20) - Celebrities 16->24, Actions (Charades) 16->24, Food &
Drink 16->24, Things at School 14->24 (the thinnest, given the most).
Combined pool across all 7 categories: 126 -> 160 words. Checked for
duplicate words within each category before and after (none).

Verified directly, not just by re-reading the new arrays: for Rank It,
confirmed all 22 entries load with the correct 4-item shape and no
duplicate titles; for Heads Up, replicated the app's own actual pool-
building logic (`for (const cat of categories) for (const w of
headsUpData[cat]) pool.push(w)`) against the real data module and
confirmed a sample of 12 new words from every expanded category are
genuinely present in the resulting 160-word combined pool - not just
sitting in the source file. Restarted the live server for both changes
(a `require()`'d data module needs a fresh process to be picked up, same
as any other server-side change). Full `playtest.js` regression clean
after each restart.

### New feature + cleanup — category word counts in Heads Up's picker, and dead broadcast data removed

While polishing Heads Up's category picker to show each category's word
count next to its checkbox (a natural follow-up to just having expanded
several categories - a host choosing between "Occupations (20)" and
"Things at School (24)" now has real information to go on, not just a
name), tried to read the count from `catalog.headsUpCategoryCounts` and
got `undefined` client-side despite the field existing server-side.

Root cause: `headsUpCategoryCounts` (and `headsUpCategories`, right next
to it) was being computed and broadcast inside `serializeFor()` - the
per-room state sent on every `room-update`, for every room, regardless of
game type - but the client never actually read either field from `room`
anywhere; the category-picker UI on both the pre-room "browse and
configure" screen and the in-room lobby's "change game" screen was always
built from a *different* object, `catalog`, fetched once from
`/api/catalog` at page load. Confirmed with a direct grep across the whole
client for both field names before touching anything - genuinely zero
consumers of the `room.*` copies, not just an oversight in this one place.

Fixed properly rather than patching around it: added
`headsUpCategoryCounts` to `getCatalog()` (the actual, correct source
`catalog` is built from - `headsUpCategories` was already there), and
deleted both now-fully-redundant fields from `serializeFor()`. Net effect:
the feature actually works, *and* every room-update broadcast - for every
room, playing any of the 23 games, not just Heads Up - got two dead
fields lighter, since that computation and its JSON payload were
previously being redone on literally every broadcast for no reason
anyone ever read.

Verified directly: confirmed via a raw request that `/api/catalog` now
returns the correct per-category count for all 7 categories (matching the
real data file exactly, including the just-expanded ones - Animals 24,
Movies 20, Celebrities 24, Occupations 20, Actions (Charades) 24, Food &
Drink 24, Things at School 24); confirmed live in the browser that the
category checkboxes render with the correct counts inline, cleanly
positioned (no wrapping/layout break) using the existing `.hint` styling.
Restarted the live server. Full `playtest.js` regression clean afterward.

### Cleanup — 12 more dead fields found across every game's broadcast payload

Directly prompted by the `headsUpCategoryCounts` fix above: if one field
could sit in `serializeFor()`'s broadcast for months with zero consumers,
the obvious next question was whether it was the only one. Rather than
guess, cross-referenced every field in every one of the 9 per-game-type
broadcast blocks (~90 fields total) against actual usage in `main.js`,
then manually verified each flagged case by reading the real render code
(not trusting the crude automated pass alone) - confirmed 12 more,
spanning 7 of the 9 game types, with zero false positives:

- **headsUp**: `performerToken`, `turnDuration`, `passedCount`, `categories`
- **wordBomb**: `phase`, `turnSeconds`, `winnerName`
- **roundGame**: `yourAnswer`
- **fib**: `yourLie`, `yourVote`
- **doodle**: `artistToken`
- **twoTruths**: `spotlightToken`

Two clear patterns explain almost all of them. **The "already-a-boolean"
pattern** (`performerToken`/`artistToken`/`spotlightToken`, and separately
`phase` for Word Bomb specifically): the server already computes and sends
the exact boolean a client needs (`isPerformer`/`isArtist`/`isSpotlight`),
making the raw token redundant *for that purpose* - confirmed this isn't a
blanket rule by checking Word Bomb's `currentToken`, which the client
*does* need, because there the client itself compares it against every
player in a list (no pre-computed per-player mapping exists), unlike the
single "is it me" checks the other three cover. **The "form unmounts
instead of echoing" pattern** (`yourAnswer`/`yourLie`/`yourVote`): every
one of these games hides its answer-submission form entirely once
`hasAnswered`/`hasVoted` is true, replacing it with a static "locked in"
message - there's no "edit your answer" flow anywhere, so the actual
submitted value never needs to come back down to the client that sent it.
`turnDuration`/`turnSeconds` were separately dead because neither Heads Up
nor Word Bomb renders a "X of Y seconds" total, only the live countdown;
`passedCount`/`categories`/`winnerName` were each redundant with something
else already sent (`passedWords.length`, nothing displays mid-game
categories, and the generic `finishedScreen` never reads a per-game
winner field at all).

Verified no false positives a different way too: grepped for any
`...h`/`...w`/`...g`/`...f`/`...d`/`...t` object-spread pattern that could
consume a field without naming it directly - none exist anywhere in
`main.js`, so the per-field check couldn't have missed a spread-based
consumer.

Removed all 12. Restarted the live server. Full `playtest.js` regression
clean. Also did a partial live-browser check (Heads Up's "ready" and
"active" phases specifically, the most fields-touched game) confirming no
console errors and correct rendering with the trimmed payload - stopped
short of also confirming the "summary" phase live after a scripted guest
bot hit reconnection friction rejoining mid-game, since the source-level
proof (zero references, confirmed via both automated cross-reference and
manual reads, plus the spread-pattern check) is actually the stronger
guarantee here: a field with no read site anywhere in the client cannot
possibly throw when removed, regardless of which phase renders.

Also fixed a real self-inflicted mistake mid-investigation, worth
recording: a `Get-Process -Name node | Where-Object {...}` cleanup command
meant to stop a stray guest-bot process had a filter bug and killed the
live server too (silently, since PowerShell process kills don't surface
loudly) - caught immediately via the next health check failing, not
assumed fine. Restarted clean and re-ran the *entire* regression from
scratch rather than trusting the interrupted one.

### Verified at true max capacity after a full day of changes

Hadn't been re-run since early in this session, and a large number of
server-side changes had accumulated since then (12 broadcast-field
removals, new Rank It/Heads Up content, the category-count feature, the
double-fire guards, the length-cap/dedup hardening). Ran the full
`playtest.js` suite at 24 players (`node scripts/playtest.js
http://localhost:3000 23`) - genuine max room capacity, not a token sample
- through every game type: "No issues found," same clean result as every
smaller run. Server memory grew from a 70.5MB baseline to 98.9MB handling
24 concurrent connections through the entire game roster, then held
steady (not climbing further) once the bots disconnected - consistent
with normal V8 GC timing, not a leak signature. Confirmed the finished
test room correctly sat in its 3-minute empty-room grace period afterward
rather than lingering forever (an already-verified mechanism from earlier
this session, re-confirmed live rather than assumed still correct).

### Verified `simulate-players.js` still works end-to-end

The README's second testing tool (manual solo-testing via fake players
joining a real room) had never actually been run live this entire
session - every verification so far used `playtest.js` exclusively.
Given how much server-side code changed today, confirmed it independently
rather than assuming it still works because `playtest.js` does (they're
separate scripts with separate join/play logic, so one working says
nothing about the other).

Ran it for real against a live room: bots joined correctly, one bot
correctly detected it was the Heads Up performer and self-started its
turn ("[Bot Nova] starting their turn"), and its answer loop worked
correctly - `correctCount` climbed steadily (0 to 62 in ~6 seconds, a
sustained ~10/sec pace safely under the 30/sec per-event rate limit added
earlier this session, confirming no conflict there). Incidentally also
stress-tested the expanded Heads Up word pool (126 -> 160 words earlier
today) under sustained rapid-fire play with no errors.

### Verified the kick/transfer-host two-tap confirmation live

Another mechanic exercised only via scripted socket calls all session,
never through the actual UI's confirmation flow described in the README
("tap 👑/✕ ... both ask you to confirm with a second tap"). Verified the
real behavior: a single click arms it (`pendingKickToken` set, button
re-renders to "Kick?" with a `.confirm` class, auto-resets after 3s if
untouched), and a second click within that window actually calls
`kick-player` and removes the player. Confirmed via the host's live
browser view that the target player was genuinely removed from the list.

Hit - and cleanly resolved - the same tool-call-latency trap documented
earlier today: checking the button's state in a *separate* tool call after
clicking it kept showing the unarmed state, because more than the 3-second
confirm window had already elapsed between calls. Fixed by doing both the
click and the state check inside one `javascript_exec` call with a small
in-page `setTimeout`, which correctly showed the armed "Kick?" state, then
did both clicks (500ms apart) in one call to complete the actual kick.
Didn't separately re-test `transfer-host`'s identical confirm pattern -
same file, same mechanism, already read together with the kick button and
confirmed structurally symmetric.

### Verified the QR code and invite-link sharing, never checked live this session

Both mentioned prominently in the README ("every lobby shows a QR code,"
"share invite link") but never actually loaded in a browser this session.
QR code: confirmed `/api/qr/<CODE>` returns a real 200 PNG (2017 bytes),
and the `<img>` tag in the lobby actually loads it (`complete: true`,
240x240 real natural dimensions, not a broken 0x0 image). Invite link:
clicked the actual button and confirmed the full fallback chain works -
`navigator.share` → `navigator.clipboard.writeText` → a toast showing the
plain room code - correctly landed on the final fallback in this automated
browser context (neither Share nor Clipboard succeeded here, as expected
outside a real user gesture/secure-context nuance), surfacing "Room code:
CNGW" rather than failing silently. Both features confirmed genuinely
working, not just present in the code.

### Verified Room Settings (streamer mode + join password) end-to-end

Neither the Streamer Mode toggle nor the Join Password feature had been
exercised through the actual Room Settings UI this session (the streamer
mode CSS/prefix work earlier this session touched the styling, not this
flow). Verified live: toggling Streamer Mode correctly applies
`.room-code.blurred`, and tapping the blurred code correctly adds
`.revealed` (the "tap to peek" behavior). Setting a join password updates
the UI to "A password is set" with a Clear option, and - checked at the
protocol level, not just the UI - actually enforces it: a join attempt
with no password or the wrong password is rejected with a clear
"Incorrect password." error and `needsPassword: true` (which drives the
client's auto-focus-the-password-field behavior), while the correct
password succeeds. Full Room Settings surface now confirmed genuinely
functional, not just present.

### Verified the "How does this work?" modal, with a self-caught false alarm along the way

Never exercised live this session. Confirmed open (button click shows the
4-step explainer), close via the ✕ button, and close via Escape all work
correctly, with focus correctly landing in the modal on open and
restoring to the trigger button (`howItWorksBtn`) on close.

Briefly suspected a bug mid-check: after closing, `#howItWorksBackdrop`
was gone from the DOM entirely rather than just hidden via a class, which
looked wrong against the "static element outside #app, toggled via a
hidden class" pattern this session's memory already documents for the
in-game help modal. Checked the source before concluding anything:
`#howItWorksBackdrop` is actually declared *inside* the home screen's own
template (line ~1114), conditionally included in `render()`'s output
based on `showHowItWorks` state - a different, equally valid pattern from
the game-help modal, not a bug. Confirmed correct behavior once checked
against the right mental model instead of assuming every modal in the app
uses the same implementation pattern.

### Bug fix — Quiz or Die's own description stated a wrong, hardcoded life count

Found by systematically cross-checking every game's `GAME_META` description
(the text shown in the picker and reused as-is by the in-game help modal)
against its actual, current mechanics - not assumed accurate just because
it read plausibly. Trivia Survival's ("Quiz or Die") description said "miss
three and you're eliminated" as if 3 lives were fixed, but `startingLives`
is a real, host-adjustable setting (1-4 via the actual settings dropdown,
clamped 1-5 server-side) - the claim was simply wrong for any host who
picked anything other than the default. Word Bomb has the identical
"lose a life" mechanic with the identical settings shape, but its own
description was already written generically ("or lose a life," no number
committed) - confirming this wasn't a structural constraint of the wording,
just an inconsistency between two otherwise-parallel descriptions.

Fixed by rewording to match Word Bomb's already-correct pattern: "Answer
trivia or lose a life — run out of lives and you're eliminated" - accurate
regardless of the configured starting-lives count. Grepped the whole repo
for any other hardcoded "three" reference to this mechanic first - none
found, so this was the only place. Verified live in the browser (the
picker renders the corrected text) and restarted nothing since this is a
static client file needing no server change. Full `playtest.js` regression
clean afterward.

### Hygiene fix — `.gitignore` didn't cover generic log files, and two had leaked into the project root

Found doing a full directory listing to sanity-check `.gitignore`
coverage: `server.log`/`server.err.log` - artifacts from this session's
own `node server.js` stdout/stderr redirects during restart-and-test
cycles - were sitting directly in the project root, and `.gitignore` only
covered the specific `npm-debug.log*` pattern, not a general `*.log` rule.
If this project is ever turned into the git repo the README's deploy
guidance assumes, these operational artifacts would have been committed
by accident - not sensitive content (just the routine startup banner),
but still clutter that doesn't belong in source control.

Fixed by adding a general `*.log` rule alongside the existing
`npm-debug.log*` one, and cleaned up the two stray files - had to restart
the live server first since the running process still held them open for
writing (Windows file locking), redirecting its stdout/stderr to the
scratchpad instead of the project root this time so the same thing can't
recur from routine server restarts during testing. Full `playtest.js`
regression clean afterward.

### Documentation — README's Project Structure list was missing 4 real files

Found doing a complete, careful re-read of the whole README rather than
just re-verifying specific claims already checked today. The `public/`
bullet named `manifest.json` + `icon.svg` for "Add to Home Screen" but
never mentioned `icon-512.png`/`icon-512-maskable.png` - both real files,
both referenced by the actual `manifest.json`, both serving that exact
same purpose (added earlier this session specifically because iOS Safari
and maskable-icon platforms don't reliably rasterize the SVG) - nor
`og-image.png` (the social-share preview image, itself already referenced
elsewhere via the `og:image` meta tag) or `robots.txt` (a file that
turned up for the first time this session during an unrelated filesystem
sweep). Fixed by listing all three additional purposes so the bullet
matches what's actually in the directory. No functional change - `public/`
already worked correctly; this was purely the README's own description of
it falling behind the directory's real contents.

### Hardening — Doodle Guess's streaming strokes had no cap, unlike Draw It's batch submission

Found doing a complete, line-by-line read of `room.js` rather than
targeted checks - noticed `doodleAddStroke` (called once per completed
pointer gesture while an artist draws live) caps each individual stroke
to 300 points but never capped how many strokes could accumulate in
`g.strokes` over one turn, unlike `drawItSubmit` (Draw It's single final-
submission equivalent), which already caps at 60 strokes. The generic
per-socket rate limiter (30 events/sec) bounds the *rate* a scripted
client could call `doodle:stroke`, but not the cumulative total over an
entire draw phase (up to 120 seconds by settings) - a sustained script
could still push thousands of strokes before the timer ran out.

This matters more than a one-off oversized message would: `g.strokes` is
broadcast in full on every `room-update` for the rest of that turn, so
each additional accepted stroke doesn't just cost once - it makes every
subsequent broadcast bigger too, for as long as the turn continues.

Fixed by capping `g.strokes.length` at 500 (comfortably above anything a
real person could produce, even drawing very quickly with many small pen-
lifts) - `doodleAddStroke` now rejects (returns `false`, same as its
existing phase/artist-mismatch rejection paths) once the cap is hit.
Confirmed `doodleClear` still correctly resets the array to empty first,
so even a script alternating clear-and-refill can never make any single
broadcast exceed 500 strokes' worth of data - the actual property being
protected - regardless of how many clear cycles happen over the turn.

Verified directly against the actual functions (bypassing the socket/rate-
limiter layer, which would have conflated two different limits): 700
`doodleAddStroke` calls in a tight loop accepted exactly 500 and rejected
the rest, `g.strokes.length` stayed at exactly 500; confirmed `doodleClear`
resets to 0 and a fresh budget of strokes is accepted afterward, so
legitimate use (a real artist who calls Clear) is unaffected. Restarted
the live server. Full `playtest.js` regression clean afterward.

### Cleanup — two vestigial always-empty ternaries found via a complete read of main.js

Found while completing a full, line-by-line read of `main.js` (all 3262
lines) - two template expressions, `${picked ? "" : ""}` in Rank It's
answer buttons and `${entry.isYours ? "" : ""}` in Draw It's voting
gallery, evaluate to the exact same empty string regardless of the
condition. Zero functional effect either way - not a bug, just dead
code, likely leftover from an earlier version that used these to toggle
a class before something else made it redundant. Removed both. Grepped
the whole file afterward for the same `? "" : ""` pattern to confirm
no third instance was missed - none found. Full `playtest.js` regression
clean afterward (expected, since the change is byte-for-byte equivalent
output either way).

This completes a full, line-by-line read of every major file in the
project today - `server.js` (909 lines, clean), `style.css` (829 lines,
clean), `room.js` (2459 lines, found and fixed the doodle stroke-count
cap gap), and now `main.js` (3262 lines, found and fixed these two dead
ternaries). Combined with the earlier README and .gitignore fixes found
via the same "read the whole file, not just what a targeted check would
hit" method, this approach found 6 genuine issues across the whole
session that more narrowly-scoped checks had missed.

### Content — brought Guess the Crowd's pool up to the same 20-entry baseline

A final definitive re-count of every content data file (checking for
anything missed by earlier informal counting) confirmed `pollguess-data.js`
was the last round-game prompt pool still below the ~20-entry baseline
every other one settled at (18, versus 20-50 everywhere else). Added 2
more - restaurant-review-checking and keeping an unwanted gift - fresh
topics not overlapping any existing pollguess entry or any Never Have I
Ever prompt (checked against both). Verified: 20 entries, correct shape
(numeric 0-100 answers), no duplicate questions. Restarted the live
server. Full `playtest.js` regression clean afterward.

### Documentation fix — README overclaimed array validation as uniform when it isn't

Found doing a full, careful re-read of README.md end to end (not just the
sections touched by today's specific fixes) - the "Already handled for
you" section said "any array a client can submit is both length-capped
and deduplicated," stated as a blanket property. Checked this against the
actual code for every array-accepting field: Heads Up's categories really
are both (the fix documented earlier this session), but Rank It's `order`
(capped to 20, `.slice(0, 20).map(...)`) and Category Countdown's `words`
(capped to 3) are only ever length-capped - never deduplicated, correctly,
since duplicate elements in those arrays don't feed a loop whose cost
scales with the count the way Heads Up's whitelist-matching categories
did. The overclaim generalized one specific fix's rationale into a
universal promise that wasn't actually true for two of the three
array-accepting settings/answers in the codebase.

Reworded to state the real, narrower claim: every array is length-capped,
and *whitelist-checked settings arrays specifically* (Heads Up's
categories) are also deduplicated, with the "why" explanation attached to
that narrower claim instead of the broad one. Verified nothing else in
the README makes a similarly-overbroad claim - re-read the entire
"Already handled for you" list line by line against the actual current
code for every other item (gzip compression, the QR-code rate limit, the
24-player cap, the SIGTERM/SIGINT shutdown, the per-socket event rate
limit) and confirmed each one is accurate as stated. Documentation-only
change, no code touched - no regression run needed for this specific fix,
though the same regression cycle already in flight from other work this
session covers the underlying code either way.

### Regression suite — permanently automated the "non-answering player" test scenario

README testing-discipline item #7 (added earlier this session) documented
that `playtest.js`'s bots are "too well-behaved" to ever exercise a player
who simply doesn't answer - the exact gap that let the "vanishes from
results" bug ship undetected for however long it had existed. That's a
real, standing gap in automated coverage, not just a one-time manual check
- worth closing permanently rather than relying on remembering to retest
it by hand after every future change to this code path.

Added a new scenario to `playtest.js`'s `main()`: starts a fresh Trivia
round, has every connected player except one silent holdout answer
normally, and asserts the holdout still appears in the broadcasted
`resultsData.results` with no `choice` (not silently absent) once the
round times out on its own - the exact shape of the original bug.

Validated the test itself is meaningful, not just present - a test that
can never fail provides no actual protection. Deliberately reverted
`scoreRoundGame`'s trivia branch back to the original buggy pattern
(iterating `g.answers` directly instead of `allAnswerEntries`), restarted
the server, and confirmed the new test genuinely fails against the broken
code (it did - a `waitFor` timeout, since the departed-then-restored-
without-crashing behavior differs subtly enough from a simple "assertion
false" that the exact failure text differs, but it unambiguously flags a
real problem either way). Restored the fix, restarted again, and ran the
*full* suite three consecutive times clean to rule out the new test being
inherently flaky before trusting it as a permanent addition - a flaky
test is worse than no test, since it erodes trust in "No issues found" as
a signal. All three passes: clean, "No issues found," same holdout
(TestBot2) each time.

### Bug fix — a QR code/invite-link tab kept re-prefilling a stale room code forever

Found auditing the full QR-code-to-join pipeline end to end (generation,
URL format, client-side parsing, prefill, escaping, room-code collision
handling - a previously-uncovered thread, everything else in it checked
out clean). The client reads `?room=CODE` from the URL on connect to
prefill the join screen, but never removed it afterward - `history.
replaceState` was never called anywhere in the file. A tab opened from a
shared invite link or scanned QR code would keep that query param in the
address bar indefinitely, including after the player joined, played, and
left. Any later refresh of that same tab (or reopening it from browser
history/a bookmark) would silently re-read the same now-likely-defunct
room code and dump the player back onto a pre-filled join screen instead
of a clean landing page - not a crash (clicking Join on a dead code just
shows the existing "room doesn't exist" error), but a real, avoidable
rough edge for exactly the common case this app is built around: a link
shared once in a group chat and clicked again days later.

Fixed by stripping the query param from the visible URL via `history.
replaceState(null, "", location.pathname)` immediately after reading it
into the `urlRoom` variable, on the first `connect` - the value still
gets used normally for prefilling either the fresh-join or failed-rejoin
path, so this doesn't change any existing behavior *this* session, only
removes the persistence of the URL param for a future page load in the
same tab.

Verified live end-to-end: navigated to `/?room=ABCD`, confirmed the URL
became a clean `/` immediately while the join screen still correctly
showed "ABCD" pre-filled (the cleanup didn't break the feature it's
cleaning up after); refreshed from that clean state and confirmed the
landing page now shows normally instead of re-prefilling; confirmed no
console errors either time. Full `playtest.js` regression clean
afterward (this is a client-only change `playtest.js` can't exercise
directly, so the live browser check above is the real proof here - the
regression run is the standard "did anything else break" sanity check).

### Verified — Streamer Mode + room password pipeline audited end to end, no issues

A full pipeline audit (settings UI -> host-gated socket event -> server-
side validation/storage -> broadcast -> client rendering -> join-time
enforcement), the same style of check that caught the QR/invite-link URL
issue above - everything here came back correct, no changes needed.

Notably included one real near-miss worth recording: grepping only
`games/room.js` for callers of `applyRoomSettings` (the function that
actually sets `room.streamerMode`/`room.password`) found zero call sites,
which briefly looked like dead code for a headline, security-relevant
feature. It isn't - the function is called from `server.js` (a different
file: once in `create-room` for up-front settings, once in a dedicated
`update-room-settings` handler, both correctly gated to
`player.token === room.hostToken`), which a same-file-only grep can't see.
Caught before concluding anything by tracing the client's actual emit
call next rather than trusting the first negative result.

Verified live end-to-end rather than stopping at the code read: toggling
Streamer Mode genuinely applies a real `blur(9px)` CSS filter to the
room code (not just a class name with no effect) and hides the QR code
entirely - a scannable QR code would trivially defeat a blurred text
code, so hiding it outright, not just leaving it visible, is the correct
behavior, confirmed deliberate by reading the template's structure.
Tap-to-reveal correctly drops the blur to 0px and auto-re-hides after
exactly ~4s. Password enforcement tested with a real raw socket client
against a real password set through the actual UI: no password rejected,
wrong password rejected, correct password accepted - all three cases
returning the expected `ok`/`error` shape.

### Verified — transfer-host confirmed correct via a real 2-client test

Closes out the host-tools audit alongside kick/streamer-mode/password
above. Server-side matches kick's already-verified pattern exactly (host-
gated, can't target self, target must exist and be connected - correctly
blocks handing control to someone offline with no way to act on it), and
the client reuses the identical double-tap-to-confirm UI shape already
proven for kick. Verified live with two real socket clients rather than
just pattern-matching the code: after a transfer, the new host's own
`room.isHost` flips to `true` and the original host's flips to `false` in
the same broadcast - the exact flag the client's host-only controls are
gated on - confirming both sides update correctly, not just the player list.

### Verified — full room-isolation sweep across both server-side files, no leaks

A fundamental correctness property for a multi-tenant real-time app like
this - if any per-room state ever accidentally lived at module scope
instead of on the `room`/`room.game` object, it would silently leak
between completely unrelated groups of players (one room's trivia
question repeat-tracking affecting another room's, for instance). Never
explicitly swept for this directly, so did a complete audit: listed every
single top-level (module-scope) `const`/`let` declaration in both
`games/room.js` and `server.js` and categorized each one.

Every declaration in both files is one of exactly three legitimate
categories, with zero exceptions: (1) genuinely immutable shared data or
config - the game data files (word/trivia/prompt pools, meant to be
identical across every room), numeric limits, the game-type ID lists; (2)
a stateless utility or factory - the nanoid generators, the shared
`Intl.Segmenter` instance (segmenting is a pure function of its input,
reused purely to avoid reconstructing it per call); (3) state that's
*deliberately* global because its whole purpose is cross-room - the
`rooms` registry itself, the socket-id-to-room `sessions` map, and the
two IP-keyed rate-limit Maps (room creation, password attempts - both
have to apply across every room a given IP touches, not reset per-room,
or the rate limit would be trivially bypassable by just switching rooms).

Specifically re-confirmed this session's own additions are correctly
scoped: `usedPromptIndices`/`usedWordIndices` (the repeat-prevention
tracking added earlier) live on `room.game`, freshly re-created with
`new Set()` at the start of every game - not a module-level Set that
could accidentally accumulate across different rooms' games.

No changes needed - documented as a deliberate, verified-clean sweep
rather than left as an unstated assumption.

### Bug fix — a player's Rank It order or in-progress drawing could bleed into their next room

Found by applying the exact same technique as the server-side room-
isolation sweep above, aimed at the client instead: listed every
module-scope `let` in `main.js` and checked which represent per-round
draft state that needs resetting on `clearSession()` (leaving a room).
Two Truths and Category Countdown's drafts were already correctly reset
there - Rank It's `rankItOrder`/`rankItRoundKey` and Draw It's
`drawItLocalStrokes`/`drawItLocalStrokesRound` were not, an inconsistency
between otherwise-sibling patterns.

Both are guarded by a "has the round changed" key comparison before
resetting, but neither key is unique enough to guarantee a stale value
from a *previous, unrelated room* can't accidentally match a new room's
key: Rank It's key is `` `${round}:${promptItems.join("|")}` `` - needs
the same round number *and* the same randomly-drawn prompt text to
collide (uncommon but real, especially likely to recur across quick
repeated test sessions given the pool is only ~22 prompts). Draw It's
key is a bare round number with no content mixed in - collides on round
number alone, so more easily hit if a player leaves mid-drawing (before
submitting) and a fresh room's game reaches the same round number while
they're the artist again. Either way, without a reset, a player could
see a completely unrelated previous room's leftover item ordering or
in-progress canvas strokes silently appear in a brand new room's game.

Fixed by adding both to the same reset block `clearSession()` already
uses for the other two drafts. Verified live: triggered a real
`clearSession()` via the "Leave room" button and confirmed no console
error (the fix references `drawItLocalStrokes`/`drawItLocalStrokesRound`,
declared later in the file than `clearSession` itself - safe in this
single-IIFE structure since `clearSession` is never called until after
the whole script has finished its initial synchronous run, but worth
confirming directly rather than assumed). Full `playtest.js` regression
clean afterward (this is a client-only fix `playtest.js` can't exercise
directly - the live check above is the real proof, the regression run is
the standard "did anything else break" sanity check).

### Re-verified at true max capacity after this session's later batch of changes

Re-ran the full suite at 24 players again, since a substantial batch had
accumulated since the last max-capacity run (the dead-broadcast-field
cleanup, new Rank It/Heads Up content, the double-fire guards, length-cap/
dedup hardening, the round-game and Two Truths results-completeness
fixes, the new permanent non-answering-player regression test, the URL
cleanup fix, and the draft-state reset fix). Clean - "No issues found,"
same as every prior run, and specifically confirmed the newly-added
non-answering-player regression test itself scales correctly to a real
24-player room, not just the default 4-player sample.

Server memory sat at 130MB afterward, up from the 98.9MB recorded earlier
in the session - expected given this same long-lived process (uptime ~56
minutes by this point) has now absorbed many additional full-suite runs,
browser sessions, and live socket tests since that measurement, not a new
data point suggesting a leak on its own. The room-cleanup mechanism
itself was independently re-verified as still correct throughout the
session (rooms actually removed from the registry, not just idle) -
what matters isn't the absolute number in isolation but whether cleanup
still works, which it does.

### Verified — actual touch-drawn input confirmed working end to end on Draw It's canvas

A dimension not yet specifically tested this session: real touch-gesture
input on the drawing canvas, not just mouse clicks under desktop
emulation. This app is explicitly built for phones, and drawing is one of
its more input-complex mechanics, so this was worth confirming directly
rather than assumed from the code alone.

Read the implementation first: the canvas uses the standard Pointer
Events API (`pointerdown`/`pointermove`/`pointerup`/`pointerleave`/
`pointercancel`), which correctly unifies mouse, touch, and pen input
under one set of listeners rather than needing separate touch-specific
handling - and the canvas has `touch-action: none` set, which correctly
stops the browser from hijacking a finger-drag as a page-scroll gesture
instead of a drawing stroke. Both are the right, mobile-correct choices.

Verified live under mobile viewport emulation (375x812) with a real
2-player game: dispatched a genuine stroke as `PointerEvent`s with
`pointerType: "touch"` explicitly set (matching what a real touchscreen
actually fires) - confirmed via raw canvas pixel inspection (not just "no
error thrown") that 1,772 non-white pixels were genuinely rendered
locally, then submitted the drawing and confirmed the voting gallery's
re-rendered version shows the *exact same* 1,772 non-white pixel count -
proving the full pipeline (touch input -> local render -> stroke capture
-> socket submission -> server storage -> broadcast -> gallery re-render)
works correctly end to end, not just that individual pieces look right in
isolation. No issues found - confirms mobile drawing genuinely works, not
just plausibly should.

### Verified — Doodle Guess's real-time streaming canvas also confirmed correct under real touch input

Same check as Draw It above, extended to Doodle Guess's own separate
canvas implementation - genuinely worth its own verification since it's
architecturally different (streams each completed stroke immediately via
`doodle:stroke` on every `pointerup`, rather than accumulating locally
and submitting once at the end like Draw It), and specifically relevant
given the `doodleAddStroke` 500-stroke cap fixed earlier this session -
worth confirming that fix didn't disturb normal, legitimate touch drawing.

Also uses `canvas.setPointerCapture(evt.pointerId)` on `pointerdown` -
correctly keeps receiving pointer events for that touch even if a fast or
imprecise finger movement briefly exits the canvas's bounds mid-stroke,
which would otherwise lose the drag.

Verified live under mobile viewport emulation with a real 2-player game
(host as artist, a raw socket-connected guest bot as the guesser):
dispatched a real touch-typed `PointerEvent` stroke on the artist's
canvas, confirmed via raw pixel inspection that it genuinely rendered
locally (1,512 non-white pixels), and confirmed the guest player's own
room-update stream showed the stroke arrive in real time (`strokes.length`
went from 0 to 1 within the same test, correct `phase: "drawing"` and
`isArtist: false` on the guesser's own side) - proving the whole
streaming pipeline, not just the local canvas, works correctly with
genuine touch input.

### Bug fix — the new non-answering-player regression test had its own genuine intermittent race

Follow-up to the test's own entry above. Despite that entry's "ran the
full suite three consecutive times clean" validation, a later regular
regression run failed with the exact same symptom the earlier deliberate-
revert test had produced: a `waitFor` timeout waiting for "results," never
reached. Since nothing related to that code path had changed, this meant
either the earlier 3-clean-run validation had gotten lucky, or there was a
genuine, rarer intermittent issue the smaller sample missed - taken
seriously rather than dismissed as one-off noise, per this project's own
"a flaky test is worse than no test" principle.

Root-caused with temporary diagnostic logging (state snapshots on every
tick, plus a full dump on failure) rather than guessing - reproduced the
failure on the 5th of 5 runs and captured the smoking gun: the room's
`round` counter had reached 2 despite `totalRounds` being 1, with `phase:
"finished"` - the server-side sequencing was always exactly correct
(round 1 -> results -> next round requested -> since round 2 >=
totalRounds 1, correctly finished), just faster than the test observed.

The actual bug was in the test itself, not the app: the "answerers" - every
connected player except the one deliberate holdout - were driven through
their normal `tick()` method, reused from the main game-playing loop
earlier in the file for convenience. That method's normal job also
includes auto-clicking "next round" the instant it sees a "results" phase
- necessary for bots playing a full game start to finish elsewhere, but
directly counterproductive here, where the test needs to *observe* results
before anything advances past it. One of the answerers is `host`, whose
"next round" click actually succeeds server-side (a non-host's is silently
rejected) - so on any run where that auto-advance fired before the test's
own polling loop caught the "results" phase, the round skipped straight to
"finished" and the wait timed out. A genuine race between the test's own
two independent consumers of the same event, not a race in the app.

Fixed by having answerers submit their one required answer via a direct,
one-time `roundgame:submit-answer` emit instead of their general `tick()`
- they no longer participate in the "click next round" behavior for this
specific test at all, so there's nothing left to race against the "wait
for results" check.

Validated far more rigorously than the first time, specifically because
the first validation's insufficiency is exactly what caused this: ran the
corrected test as three separate, individually-launched, closely-monitored
processes (not sequential iterations sharing any state) rather than a
single script looping the same suite N times, watching each one's real-time
progress rather than only checking pass/fail at the end. All three passed
cleanly with entirely normal timing (~3m40-50s each), no hangs, no
timeouts anywhere in the run. Also hit, and correctly identified as
unrelated: a `for`-loop-wrapped batch of runs appeared to hang for over 30
minutes on its very first iteration - investigated directly (server
health-checked as fine throughout, the stuck process's own output was
frozen at just its startup banner) rather than assumed related to this fix,
stopped precisely via its known PID, and the same test code confirmed
healthy immediately after via the three individual runs above - almost
certainly a shell/pipe-buffering artifact of that specific execution
context (this environment's Bash tool has shown genuine infrastructure
flakiness before this session), not a second bug.

### Hardening — the same test race found and fixed proactively in a sibling test

Applying the lesson from the entry directly above to itself: pushed the
question "does this exact race pattern exist anywhere else" across the
rest of `playtest.js`'s custom edge-case tests, rather than considering
the class closed after fixing the one instance that had actually failed.

Found a second, structurally identical risk in the "voting-phase timeout"
test (Prompt Battle, `rounds: 1`): its `votingTicker` kept calling `tick()`
on every connected voter - including `host` (always `all[0]`, never the
holdout, which is always `active`'s *last* element) - straight through the
moment the test's own `waitFor` was watching for "results" to appear.
`tick()`'s normal-gameplay logic auto-clicks "next round" the instant it
sees "results," and host's click actually succeeds server-side (a non-
host's is silently rejected) - the same race as the round-game test,
never yet observed failing here across dozens of runs this session, but
structurally present for the identical reason. Confirmed by reading the
array construction directly (`all = [host, ...botClients]`, `holdout =
active[active.length - 1]`) rather than guessing.

Fixed proactively, before it ever produced an observed failure, by having
the ticker check whether every voter has already voted and clear itself
at that point - once voting is done, there's no more legitimate reason
for `tick()` to run at all until results appears, so removing the calls
entirely (rather than trying to special-case which action `tick()` should
take) removes the race outright. Verified with a fresh, individually-
monitored full-suite run: both edge-case tests passed cleanly with
completely normal timing, no hang, no timeout.

Checked the third custom test ("mid-game disconnect resilience") for the
same pattern and confirmed it's genuinely unaffected, not just untested:
it only waits for the *earlier* "voting" phase (reached via the normal
"everyone answered" transition), never "results" - the specific phase
`tick()`'s auto-advance is gated on is never reached while that test's own
ticker is still running, so there's no shared event for the two to race
over in the first place.

### Small fix — the sound-mute button showed up uselessly on the no-JS fallback

Checked something read earlier but never actually verified: the
`<noscript>` "JavaScript is required" fallback message. Every other
static element living outside `#app` was already hidden by default in
the raw HTML for a genuinely unrelated reason (their own `.hidden`
class/pre-set state, needed for the normal JS-enabled app too) - except
the sound-mute button, which has no reason to hide itself when JS is
actually working. With JS disabled, though, its click handler (attached
in `main.js`, which never runs) never gets wired up, so it would sit
uselessly in the corner right next to the "enable JavaScript" message -
real, verified clutter around an already-inert page, confirmed by fetching
the raw server response directly rather than assumed from reading the
template alone.

Fixed with a second, separate `<noscript><style>#soundToggle { display:
none; }</style></noscript>` block - `<noscript>` styles are ignored
outright by any browser with JS enabled, so this can't affect the normal
case. Verified both directions: the raw HTML response shows the new block
correctly present, and a live JS-enabled browser check confirmed the
button's computed style is unaffected (`display: block`, fully visible,
exactly as before).

### New feature — a minimal service worker for PWA install-prompt eligibility

The README/landing page already claims "This installs to a phone's home
screen too" as a real feature, backed by a correct `manifest.json` and the
right iOS-specific meta tags/icons - but no service worker existed
anywhere. iOS Safari's "Add to Home Screen" only ever needed the manifest
(already confirmed correct), but Chrome/Android's *automatic* install
prompt (`beforeinstallprompt`/the install banner) additionally requires a
registered service worker with a fetch handler before it'll offer to
install - without one, the claim likely held less reliably on Android than
implied.

Added `public/sw.js`, deliberately minimal: no caching strategy at all,
since this app is real-time-only (every screen needs a live socket
connection) and has no meaningful offline experience to serve - just
`install`/`activate` handlers (`skipWaiting()`/`clients.claim()` so a
redeployed worker takes over immediately, safe here since nothing is
cached that a stale worker could serve wrong) and a pass-through `fetch`
handler that forwards every request unchanged, purely to satisfy the
installability check. Registered from `main.js`, fully feature-detected
and best-effort (`if ("serviceWorker" in navigator) { ...register...
.catch(() => {}) }`) - a browser without support, or one that rejects
registration for any reason, just doesn't get the install prompt; nothing
else about the app depends on it.

Verified what could be verified here: the server correctly serves `/sw.js`
with `Content-Type: application/javascript` and a 200 status; the app
renders and functions completely normally with the registration attempted.
Registration itself failed in this specific testing environment - not from
a script or server-response problem (confirmed via raw HTTP fetch), but
from what a direct `.register()` call surfaced as a generic "unknown error
fetching the script," consistent with this environment's own sandboxed
browser (a distinct `Claude/...` Chromium build, not a real end-user
Chrome) deliberately restricting service worker registration - plausibly a
sandbox-security choice for an agent-embedded browser, not a bug in this
code. Full `playtest.js` regression clean regardless, since the addition
is entirely inert to server-side game logic. The actual install-prompt
behavior on a real Android device couldn't be confirmed end-to-end in this
session - worth a real-device check if that specific outcome matters.

### Small fix — a stray inconsistent toast message

Scanned every `showToast()` call site for tone/punctuation consistency.
Found one real, if minor, mismatch: "Password cleared." (both places it's
shown - the ternary in the password-save handler, and the dedicated clear
button) was the only `"success"`-typed toast in the whole file without a
trailing "!", unlike its sibling "Password set!" and every other success
message ("Reconnected!", "Invite link copied!", "Room code copied!").
Fixed both to "Password cleared!" for consistency. Everything else already
checked out: error messages consistently plain and matter-of-fact
("Couldn't join room.", "Enter a 4-letter room code."), the "How does this
work?" explainer's 4-step overview confirmed still fully accurate and
deliberately generic (not meant to enumerate every feature, which the
game-help button and waiting-room tips already cover). Full `playtest.js`
regression clean afterward (a pure text/punctuation change with no logic
behind it).

### Session hygiene — a stray `CHANGELOG.md` briefly written to the wrong directory

Caught during a final housekeeping pass, not by luck: the three entries
directly above this one were originally appended via a relative-path
`cat >> CHANGELOG.md` that landed in `C:\Users\ricfu\CHANGELOG.md` instead
of this file - this session's recurring Bash working-directory reset (see
memory) silently created a brand-new file there rather than erroring the
way a command needing to *read* an existing path (like `node
scripts/playtest.js`) reliably has all session. All three entries were
re-appended here from that stray copy, verbatim, and the stray file
deleted. Caught by re-reading this file's own actual tail before trusting
three consecutive "documented" claims, not by re-verifying the *app*
change each time - a reminder that a successful `cat >>`/Write call is not
proof it landed in the right *file*, only that it landed *somewhere*;
worth a periodic `pwd`-then-reread check specifically for append-style
documentation commands, since those fail silently in a way the app's own
require()-based commands don't.

### Security fix — a newly-disclosed `qs` vulnerability, patched via an npm override

`npm audit` (last checked clean, 0 vulnerabilities, much earlier this
session) now showed 3 moderate-severity advisories against `qs` - a
transitive dependency pulled in twice over, by both `express` directly
and by `body-parser` (which express bundles internally): an array-limit
bypass via bracket-key comma parsing, and a DoS via attacker-controlled
`isBuffer`. Nothing in this app's own dependency tree changed to cause
this - almost certainly a newly-published advisory that simply didn't
exist yet the last time this was checked, this many hours into the same
session.

Checked actual exposure before doing anything: grepped `server.js` for
`express.json()`/`express.urlencoded()`/`body-parser`/`req.query`/
`req.body` - none exist anywhere. This app never explicitly parses
request bodies and never reads `req.query`, so the specific vulnerable
code paths were plausibly never actually invoked by this app's own
routes regardless - real mitigating context, though not itself a reason
to skip a real fix that was available.

`npm audit fix` (and even `--force`) turned out to be a genuine no-op -
not caution on my part, `qs`'s already-published fix (`6.16.0`) exists,
but `express@4.22.2` pins its own internal dependency at `qs: "~6.15.1"`
(patch-only range), so npm can't auto-resolve past it until express
itself ships a new release bumping that range - purely an upstream
timing gap, not something `npm audit fix` could paper over on its own.

Fixed with npm's `overrides` field in `package.json` - `{ "qs":
"^6.16.0" }` - the standard, intended mechanism for exactly this
situation: pinning a transitive dependency to a patched version ahead of
the direct dependency's own update, without needing to fork or vendor
anything. Verified the override actually took: `npm ls qs` now shows
`6.16.0` resolved and deduped for *both* express's direct use and
body-parser's nested use, and `npm audit` reports 0 vulnerabilities.

Verified this didn't break anything, not just assumed a "patch bump"
would be safe: restarted the live server, confirmed both a plain request
and one with an array-bracket query string (`?baz[]=1&baz[]=2` - the
exact syntax shape the advisory concerns) both return clean 200s, and
ran the full `playtest.js` regression clean.

### Re-verified at true max capacity after the qs security fix and the rest of this session's later batch

Ran the full suite at 24 players once more, specifically to confirm the
`qs` override (and the noscript, service worker, and toast-punctuation
fixes alongside it) all hold up correctly together at scale, not just
individually. Clean - "No issues found," same as every prior run at any
player count. Server healthy afterward (85.3MB on a freshly-restarted
process, one test room correctly sitting in its empty-room grace period).

### Verified stability at the longest continuous uptime checked this session (~7 hours)

Every prior memory/stability check this session was within a closely-spaced
testing burst on the same process. This check came after a genuine multi-
hour real-world gap (the assistant's usage limit resetting and resuming),
giving the first true long-duration data point: server still healthy at
25,406s (~7 hours) uptime, memory at 95.0MB - up modestly from the 86.2MB
recorded a few hours earlier in this same process's life, consistent with
gradual, expected heap growth across many intervening regression runs
(each one creates and tears down dozens of rooms/games), not a leak
signature. Full `playtest.js` regression clean at this uptime too. Room
cleanup (already independently verified correct multiple times this
session) continues to hold - the one active room present was mid-grace-
period from the just-finished regression run, not an orphan.

### Accessibility fix — neither modal actually trapped keyboard focus

Checked something genuinely new this session: full keyboard-only
navigation, not screen-reader announcements (already covered earlier) or
mouse/touch interaction. Both modals (the game-help popup and "How does
this work?") are plain `<div>`s, not the native `<dialog>` element - which
means neither got a focus trap for free the way `<dialog>`/`showModal()`
would have provided automatically. Confirmed via code, not assumption:
grepped for any `keydown`-based Tab handling anywhere in the file - none
existed. A keyboard-only user tabbing through either open modal would
eventually tab straight out of it into whatever's next in the underlying
page, defeating the entire point of a modal (and, for the game-help popup
specifically, into a mid-game screen actively re-rendering underneath it).

Fixed by extending the existing delegated Escape-key listener (already
correctly handling both modals uniformly) to also intercept Tab/Shift+Tab
while either is open, wrapping focus between the modal's first and last
focusable element instead of letting it escape - including the edge case
where focus is still on the modal's own `tabindex="-1"` container (its
initial focus target on open, deliberately excluded from the wrap-target
list), which needed its own explicit check or Shift+Tab would have escaped
the trap on the very first backward tab.

Verified precisely, working around a real tool limitation: this
environment's synthetic `Tab` keypress (via the `computer` tool) doesn't
reliably trigger real browser tab-navigation, so verified by dispatching
genuine `KeyboardEvent`s directly instead - the same event shape a real
Tab keypress produces, exercising the exact listener code, not a
workaround around it. Confirmed for both modals: Shift+Tab from the
initial focus state correctly wraps to the last element, Tab from the last
element correctly wraps to the first, and - critically - a normal,
non-boundary Tab between two elements is correctly left un-intercepted
(`defaultPrevented` stays `false`), so ordinary tabbing between a modal's
buttons isn't broken by the trap. Escape-to-close re-verified working
after the refactor. Full `playtest.js` regression clean (client-only
change, so this is the standard sanity check rather than direct coverage).

### Accessibility fix — one real WCAG contrast gap found via computed ratios, not eyeballing

Checked a dimension not yet specifically audited this session: color
contrast, computed precisely (relative-luminance formula, not eyeballed
from hex codes) for every text/background pair in the palette. Found
`--text-faint` (#6B6672) fails WCAG AA for normal text on both `--bg` and
`--surface` (3.40:1 and 3.12:1, both below the 4.5:1 threshold) - though
it does clear the 3:1 "large text"/non-text threshold.

Most instances of this were already caught and fixed in an earlier pass
this session - three call sites carry an explicit `/* --text-faint fails
contrast at this size */` comment and already use `--text-dim` instead.
Checked the two remaining, uncommented usages individually rather than
assuming both were the same oversight: the game-picker chevron (`›`) is
genuinely fine as-is - a purely decorative glyph whose meaning is already
redundantly conveyed by the parent row's own `aria-label`, so it falls
under WCAG's graphical-object/non-text threshold (3:1), not the text
threshold (4.5:1), and passes that. The global `input::placeholder` rule,
though, was a real gap that had been missed - every text input across the
app (name, room code, passwords, every in-game answer field) rendered its
placeholder below the AA threshold.

Fixed by switching `input::placeholder` to `--text-dim` (6.58:1 / 6.04:1,
comfortably clearing AA), matching the exact pattern of the three fixes
already in the file. Verified live: computed style confirms the change
took effect, and a screenshot confirms the placeholder is still clearly
visually distinct from real entered text (not so bright it looks pre-
filled) while now being properly legible. Full `playtest.js` regression
clean (CSS-only change, so this is the standard sanity check).

### Bug fix — two real gaps found in the earlier PORT error handling, pushing the same edge-case sweep further

Went back to the PORT-handling fix from much earlier this session and
tested the edge cases that fix hadn't specifically covered - not the same
non-numeric-string/EADDRINUSE cases already verified, but a numeric-but-
out-of-range value and the special `PORT=0` case.

**Out-of-range numeric PORT crashed with a raw stack trace, bypassing the
existing fix entirely.** `PORT=99999999` (or anything > 65535) produces a
completely different failure mode than the non-numeric case the earlier
fix targeted: `net.Server.listen()` validates the port and throws a
`RangeError [ERR_SOCKET_BAD_PORT]` *synchronously*, before the async
`'error'` event the existing `server.on("error", ...)` handler listens for
ever fires - so that handler, despite being correct for every case it was
built for, never even gets a chance to run here. Separately confirmed
`PORT=-1` was already fine (Node's own heuristic treats a leading `-` as
non-numeric-looking, routing it through the already-handled async EACCES
path) - the gap was specifically "numeric-looking but out of range."
Fixed with an explicit range check (0-65535) before calling `listen()` at
all. Boundary-tested precisely: 65535 starts normally, 65536 fails with
the clear message.

**`PORT=0` (a legitimate "let the OS auto-assign a free port" pattern,
sometimes used in test/CI setups) printed a useless, wrong URL.** The
startup banner echoed the literal `PORT` env value verbatim - correct for
every normal case, but when `PORT=0`, the OS binds to some other, actually-
free port entirely, and the banner still said "http://localhost:0",
useless for actually finding the running server. Fixed by reading
`server.address().port` (the real bound port) instead of trusting `PORT`
once `listen()` has actually succeeded - a deployer using this pattern now
sees the real port. The three existing error-path messages (EADDRINUSE,
EACCES-non-numeric, and the new out-of-range one) correctly still show the
raw `PORT` value as configured, since none of those cases ever successfully
bind at all - there's no "real port" to report there.

Verified every case directly: out-of-range (99999999) → clear message,
exit 1; the exact boundary (65535 succeeds, 65536 fails); `PORT=0` → banner
now shows the real assigned port (confirmed varies per run, as expected for
an OS-assigned port); re-confirmed the three already-correct cases
(non-numeric, EADDRINUSE, a normal valid port) are unaffected by this
change. Restarted the live server. Full `playtest.js` regression clean
afterward.

### Security fix — X-Forwarded-For resolution trusted the wrong (spoofable) end of the header

Applying the "revisit an earlier fix's untested edge cases" technique
(from the PORT fixes above) to the `TRUST_PROXY` work from much earlier
this session - not "is TRUST_PROXY on/off correctly gated" (already
solid) but "once it's genuinely on, does it resolve to the *correct*
address."

Traced Express's actual `trust proxy` resolution through its real source
(`compileTrust` → `proxy-addr` → `forwarded`) rather than relying on
general recollection - confirmed precisely: `app.set("trust proxy",
true)` (a plain boolean, what this app had) trusts the *entire*
X-Forwarded-For chain unconditionally and resolves `req.ip` to the
**leftmost** entry - the original, client-supplied claim, still spoofable
by anyone even with a real reverse proxy in front, unless that specific
proxy is configured to overwrite (not append to) any X-Forwarded-For the
raw client already sent - a config detail this app has no way to verify
or control. The parallel Socket.IO-side `getClientIp()` had the identical
issue, `xff.split(",")[0]` - deliberately written to mirror Express's
behavior (per its own comment), so it faithfully mirrored the bug too.

This app's entire documented deployment topology is a *single* reverse
proxy hop (Caddy/nginx directly in front, or a PaaS terminating TLS at
its own edge) - no CDN or multi-hop chain anywhere in the README. For
that exact topology, Express's own idiom is `trust proxy: <hop count>`,
not `true` - passing `1` tells it to trust exactly one hop and correctly
resolves to the **rightmost** entry, the value the one actually-trusted
proxy itself observed, immune to anything the original client tried to
inject ahead of it.

Fixed both sides to match: `app.set("trust proxy", TRUST_PROXY ? 1 :
false)`, and `getClientIp()` switched from `.split(",")[0]` to
`.split(",").pop()`. Kept them intentionally consistent with each other,
same as before.

Verified empirically against the real running server, not just the
source trace - the strongest form of proof here, since this exact class
of bug is easy to convince yourself is fixed via reasoning alone and be
wrong: with `TRUST_PROXY=1`, sent 33 rapid requests to `/api/qr/AAAA`
with a *different, fake* leftmost X-Forwarded-For value on every single
request but the same real-looking rightmost value - confirmed they all
still counted against one shared bucket and correctly 429'd once the
limit was reached (the attack this fix exists to prevent, directly
reproduced and shown blocked). Separately confirmed two requests with
genuinely different rightmost values got independent, unblocked buckets
(ruling out an overcorrection that would merge all distinct real users
together). Repeated the same test against the Socket.IO side via raw
`create-room` calls with a spoofed header varying every time - exactly 8
succeeded (the real per-IP limit) before every further attempt was
correctly rejected, regardless of the ever-changing spoofed leftmost
value. Confirmed the default (`TRUST_PROXY` unset) path is completely
unaffected - a spoofed header is still ignored outright, exactly as
before. Restarted the live server. Full `playtest.js` regression clean
afterward.

### Follow-up verification — confirmed the `qs` fix survives a genuinely fresh install

The original fix's verification (`npm ls qs`, a live request with the
vulnerable query syntax) only proved the *currently running* server was
patched - not that the fix would actually apply for someone cloning the
project fresh later. Closed that gap: copied just `package.json` and
`package-lock.json` into an isolated temp directory (no access to the live
`node_modules`) and ran a genuine `npm ci` - correctly resolved
`qs@6.16.0` and reported "found 0 vulnerabilities," confirming the
`overrides` fix is durably encoded in the lockfile itself (npm bakes an
override's effect directly into each affected package's locked
version/resolved/integrity fields - there's no separate "overrides" key to
find in `package-lock.json`, which is expected, not a gap of its own).

### Investigated — the shutdown log message, and a platform limitation that blocks testing it further here

Live-tested the graceful-shutdown path (`shutdown(signal)`) for the first
time this session, not just read from code. First result was genuinely
good: sent a real SIGTERM to a fresh test instance with a connected
client - the process exited cleanly in ~23ms (nowhere near the 5s
force-exit fallback), and the connected client received a proper
`"transport close"` disconnect, not a hang or an abrupt reset. The core
mechanism works.

One thing was off, though: the `"SIGTERM received, shutting down..."`
console.log line never showed up in the redirected log file, reliably,
across several repeats. First hypothesis: `console.log` doesn't report
back when (or whether) a write actually completes, and `process.exit()`
runs from inside nested async callbacks a few lines later - a plausible
race on a redirected-to-file stdout. Applied the standard fix for exactly
that shape of problem (`process.stdout.write(msg, callback)`, starting
the actual shutdown sequence from inside the callback so the message is
guaranteed flushed first) - safe, standard practice, kept regardless of
what's below.

That fix didn't change the observed symptom, though, which prompted a
deeper isolated test (a minimal standalone script, a *synchronous*
`fs.appendFileSync` as the very first line of the SIGTERM handler -
about as hard to silently lose as a write can be) - and it never ran
either. Confirmed why: `process.kill(pid, "SIGTERM")` sent cross-process
on **Windows** doesn't invoke the target's `process.on("SIGTERM", ...)`
handler at all - Windows has no real POSIX signals, and Node's
implementation of a cross-process kill there is an unconditional
`TerminateProcess`, which the target process has no way to intercept or
react to. The original "missing log line" symptom was never actually a
stdout-flush race - it was the handler never running in the first place,
on this specific platform, for this specific way of sending the signal.

This means the `process.stdout.write` change is real, safe, standard
practice, and worth keeping - but it was **not actually validated** to
fix anything, since nothing in this environment can trigger a genuine,
handler-invoking SIGTERM to test it against. This app's actual documented
deployment targets (a Linux VPS, Render/Railway/Fly.io) all run on real
POSIX systems where SIGTERM is a real, deliverable signal and this
limitation doesn't apply - `pm2`/Docker/systemd there send a real SIGTERM
that Node's libuv correctly catches and routes to the JS handler, unlike
a Windows cross-process kill. Recording this honestly rather than
claiming a verified fix: the shutdown *mechanism* (io.close → server.close
→ process.exit, confirmed working via the first live test above) is
solid; whether the log-message ordering fix specifically resolves the
original symptom remains unconfirmed and would need a real POSIX
environment to test meaningfully.

### Follow-up — confirmed the signal-delivery limitation isn't SIGTERM-specific

Repeated the exact same isolated test from the entry above with SIGINT
instead of SIGTERM - identical result, the handler never ran. Confirms
the limitation is "any `process.kill(pid, <signal>)` sent cross-process on
Windows is an unconditional termination, regardless of signal name," not
something specific to SIGTERM. Doesn't change anything about the app or
the fix - just sharpens the finding for anyone testing this locally later:
a real, interactive Ctrl+C in an attached console uses a different Windows
mechanism (`GenerateConsoleCtrlEvent`) than a separate process calling
`process.kill()`, and wasn't tested here (every process this session was
launched detached, with no attached console to press Ctrl+C in) - it
might behave differently, but a real POSIX environment remains the only
way to meaningfully validate this app's actual SIGTERM-based shutdown path.

### New feature — a Dockerfile, the third documented deployment path

Added a minimal, single-stage `Dockerfile` (`node:24-alpine`, matching the
exact Node version this whole session's work has actually been tested
against) plus a `.dockerignore` (excludes `node_modules`, log files, `.git`
for whenever this becomes a real repo). Genuinely low-risk to add - a pure
new-file addition, no existing code touched - and directly leverages work
already done and verified earlier this session: `docker stop` sends a real
SIGTERM, which the app's own graceful-shutdown handler already responds to
correctly (confirmed via a real, live SIGTERM test - see the shutdown
entries above); `PORT` is already thoroughly hardened against every
edge case; and `npm ci` picking up `package-lock.json` automatically
carries the `qs` security override along for free.

`--omit=dev` skips `socket.io-client` (the only devDependency, used solely
by `scripts/playtest.js`/`simulate-players.js` for local testing, never
imported by `server.js` or `games/room.js`) - cross-checked every actual
`require()` call across both files against `package.json` first to
confirm nothing genuinely needed at runtime would be skipped, not assumed
safe from the dependencies/devDependencies split alone. Runs as the
official image's built-in low-privilege `node` user rather than root - an
easy, free hardening step for a container with no reason to run as root.
Uses exec-form `CMD ["node", "server.js"]` specifically (not a shell
string) so the container's PID 1 is `node` itself - a shell-wrapped CMD
would sit between the container runtime and the process, and could
swallow `docker stop`'s SIGTERM instead of forwarding it, silently
defeating the graceful-shutdown path this Dockerfile exists partly to
exercise correctly.

**Honestly could not build/run this with real Docker** - neither Docker
nor WSL (its usual backend on Windows) is installed on this machine, and
installing either is a real system-level change outside what to do
unilaterally for a testing convenience. Verified as thoroughly as possible
without it instead: manually confirmed every base-image/`COPY`/`RUN`/`CMD`
line against how this exact app is actually structured (not just
Dockerfile best-practice in the abstract), and - the strongest proof
available short of an actual build - reproduced the Dockerfile's core
`npm ci --omit=dev` step in an isolated directory, copied the real app
source in, and ran the genuine `server.js` against that exact production-
only dependency set: confirmed `socket.io-client` was genuinely absent
from the resulting `node_modules`, and that `/health`, `/api/qr/:code`,
and `/api/catalog` all responded correctly regardless. Recording this
limitation honestly rather than implying a build was actually verified -
whoever deploys this first should do a real `docker build`/`docker run`
smoke test before trusting it in production, same spirit as the SIGTERM
platform-limitation entries above.

Documented as the third option in README's "Deploying to your own domain"
(after Render/Railway/Fly.io and the bare-VPS+pm2 path), including the
same `TRUST_PROXY` guidance as the other two. Also caught and fixed a
second, real instance of the exact "Project Structure list goes stale"
gap found and fixed earlier this session while updating it for the new
files: `public/sw.js` (the service worker, added after that earlier fix)
had *also* gone undocumented there - the list needs re-checking against
the real directory contents after any change that adds a file, not just
fixed once.

### New feature — a docker-compose.yml alongside the Dockerfile

Small companion to the Dockerfile above: a minimal `docker-compose.yml`
(one service, current Compose V2 syntax - no `version:` key needed) so
`docker compose up -d` works as an alternative to the plain `docker
build`/`docker run` commands, with `restart: unless-stopped` and
`TRUST_PROXY` left as a commented-out line ready to uncomment rather than
a flag to remember each time. No YAML parser was available in this
environment to validate it the normal way (`docker compose config`, or
even a standalone `yaml` library - none installed, and installing one
just for this one-off check would be its own unnecessary dependency) -
verified as carefully as possible without one instead: confirmed no tab
characters anywhere (`cat -A`, which would show `^I` for any - YAML
strictly forbids tabs for indentation) and manually traced every
key's nesting level against the others. Documented in README (both the
Docker deploy section and Project Structure) alongside the same
Dockerfile-verification caveat from the entry above - this also hasn't
been run against a real `docker compose`, for the same reason.

### Bug fix — .gitignore missed a real local-tooling directory, caught by actually testing git init

Tested the exact flow the README's own first deploy option literally
describes as step 1 ("push this folder to a GitHub repo") for real, in an
isolated copy of the project (never touched the actual live directory -
this project intentionally isn't a git repo yet) - `git init && git add
.` - rather than assuming `.gitignore` was complete because it looked
reasonable.

Found `.claude/launch.json` - a small, harmless local config file (just a
dev-server name/command/port for the Browser preview tool used throughout
this session, predating this session by weeks) - would have been silently
committed on the very first `git add .`, the exact failure mode this
`.gitignore` already explicitly exists to prevent for `node_modules/`.
`.vscode/` and `.idea/` (other tools' equivalent local-config
directories) were already correctly excluded under "OS/editor cruft" -
`.claude/` is the identical class of thing, just a different tool, simply
missing from that same list.

Fixed by adding `.claude/` alongside its siblings. Verified precisely,
not just assumed fixed after adding the line: re-ran the exact same
isolated `git init`/`git add .` test and confirmed the staged file count
dropped from 42 to exactly 41 (removing only the one file), then listed
every one of the 41 remaining staged files individually - real source,
config, data, and asset files only, nothing extraneous, a genuinely clean
`git add .` result for the first time this project would actually be
committed.

### Verified — the pm2 deployment path actually works, tested for real

Continuing the "actually test what's testable" pass from the .gitignore
fix above: the VPS deployment section's `pm2 start server.js --name
party-games` had never been run for real this session, only read as
written instructions. `npx pm2` (no persistent global install needed)
made this testable without the invasive setup Docker/WSL would have
required.

Worth noting for anyone repeating this: even a bare `npx pm2 --version`
spawns a real, persistent background daemon (`pm2_home` under the user's
home directory) - more than a one-off command execution. Tested in an
isolated copy of the project (never the live one), on a free port: `pm2
start server.js --name party-games-test` correctly started the app under
process management (`online` status in `pm2 list`), and `/health`
responded correctly against it - confirming the actual documented command
genuinely works, not just reads plausibly. Cleaned up completely
afterward - `pm2 delete`, then `pm2 kill` to stop the daemon entirely,
removed its home directory, removed the isolated test copy - confirmed
via the real running server's own health check and a direct process list
that nothing from this test lingered and the actual live server was
unaffected throughout.

### Verified — the exact literal npm install / npm start commands the README documents

Closing the last small gap in the deployment-verification pass: the
Render/Railway/Fly.io section's exact literal commands ("Build command:
`npm install`. Start command: `npm start`") had been *approximated* all
session via direct `node server.js` invocations and `npm ci` (a different,
stricter command, used deliberately elsewhere for its own reasons) - never
the precise commands as literally documented. Tested for real in an
isolated copy with no pre-existing `node_modules`: `npm install` completed
cleanly, `npm start` correctly ran `node server.js` under it, and the
resulting server responded correctly to a real `/health` request.

Caught and fixed a small cleanup slip while wrapping up, worth recording
honestly: backgrounding `npm start` and later running `kill %1` only
killed the immediate `npm` CLI wrapper process, not the `node server.js`
child it had spawned - left two stray processes running (harmless,
isolated to the temp test directory, well away from the real app) until
caught via a direct process-list check rather than assumed clean from the
`kill` command succeeding. Stopped both by exact PID, confirmed via a
fresh process list that only the real live server remained, then finished
removing the test directory (which Windows had been refusing to delete
while the stray process still held it open - the underlying reason
`rm -rf` initially failed, and itself a useful confirmation that the leak
was real, not imagined).

### Bug fix — a backgrounded mobile tab could leave a "zombie" socket that looked connected but wasn't

Checked a real-world scenario specific to this app's stated mobile-first
audience, not yet investigated: switching apps or locking the screen mid-
game, then coming back. Mobile browsers routinely suspend a backgrounded
tab's JS entirely - the underlying connection can die silently during that
gap (the OS reclaiming it to save battery, or Engine.IO's own ~45s ping-
timeout elapsing with nothing running to notice it) - and `socket.connected`
can still read `true` afterward, since the 'disconnect' event that would
normally flip it never got a chance to run while the tab was frozen.

The existing `visibilitychange` listener only handled the title-flash
feature - nothing re-verified the connection when a tab became visible
again. A blind `socket.connect()` wouldn't have helped: it's a documented
no-op whenever `connected` already reads `true`, which is exactly the
broken state being targeted. A blind unconditional disconnect+reconnect
on every visibility change would have overcorrected the other direction -
showing a spurious "Reconnecting…" flash for the common case of a quick
app-switch-and-back that was never actually broken.

Fixed by tracking how long the tab was actually hidden, and only forcing
a `socket.disconnect()` + `socket.connect()` cycle past 60 seconds - a
little beyond Engine.IO's own worst-case dead-connection-detection window,
long enough that a real interruption plausibly happened, short enough to
still catch it reasonably promptly. The existing `connect` handler already
correctly handles re-authenticating and rejoining via the stored session
token/room code regardless of what triggered the `connect` event, so this
needed no changes elsewhere to integrate correctly.

Verified live, not just reasoned about - using this session's established
`window.__testSocket` debug-exposure technique (added temporarily, removed
and confirmed gone via grep after): mocked the read-only `document.hidden`
property and dispatched real `visibilitychange` events, with `Date.now()`
also mocked to simulate elapsed time without actually waiting. Confirmed a
short (100ms) hide correctly left the socket ID completely unchanged (no
spurious reconnect); confirmed a simulated 70-second hide correctly
produced a genuinely new socket ID with `connected: true`; then did the
full integration test inside a real room - created a room, simulated the
same 70-second hide, and confirmed the client both reconnected with a new
socket AND automatically rejoined the exact same room, with the room code
still correctly displayed afterward. Full `playtest.js` regression clean
(a client-only change it can't exercise directly - the live tests above
are the real proof here).

### Small improvement — reconnect immediately when the browser reports connectivity restored

Companion to the tab-visibility fix above, checking a related but
genuinely distinct scenario: a real network drop (airplane mode, losing
signal) rather than a frozen background tab. Unlike the frozen-tab case,
the page's JS never stops running here, so Socket.IO's own disconnect
detection and exponential-backoff reconnection (already confirmed
correctly configured earlier this session - 1-5s, jittered) already
handles this correctly on its own; nothing was actually broken.

Added `window.addEventListener("online", () => socket.connect())` purely
to tighten the last mile - the moment the browser reports connectivity is
back, attempt reconnecting immediately instead of waiting out whatever's
left of the current backoff delay (up to ~5s). `connect()` is a documented
no-op whenever already connected, so there's no downside to calling it
eagerly on every `online` event.

Verified live both directions: dispatched a real `online` event while
still genuinely connected and confirmed the socket ID stayed completely
unchanged (the no-op path, no adverse effect); then explicitly
disconnected the socket, dispatched `online` again, and confirmed it
correctly reconnected. Full `playtest.js` regression clean (a client-only
change it can't exercise directly).

### Verified — completed a full field-name consistency sweep across every game type

Extended the field-by-field verification (started earlier this session
for the 15 round-game types, which found zero mismatches) to the
remaining 8 bespoke game types: Prompt Battle, Fib or Fact, Trivia
Survival, Doodle Guess, Word Bomb, Heads Up, and Draw It. For each, read
the exact object `serializeFor()` returns in `room.js` side by side with
the exact client function in `main.js` that renders it, and confirmed
every field the client reads is actually present under the name it
expects.

**Result: zero real mismatches across all 23 game types.** Two things
worth recording as deliberate non-issues rather than gaps: Word Bomb's
`lastResult.timedOut` field is set server-side but the client's render
code never reads it (harmless unused data, not a bug); Trivia Survival
was already confirmed to iterate every player for its results, not just
those who answered, independent of this session's earlier "vanishes from
results entirely" fix class. This closes the investigation - any newly
added game type or field should get the same side-by-side check before
being considered done, rather than re-running this full sweep without new
cause.

### Security fix — four round-game answer fields had no shape validation, unlike their sibling text/array fields

Reading `scoreRoundGame()`'s branches side by side with the client for the
sweep above surfaced a real gap in the same bug class as the earlier
"Input validation" fixes (see the section on `emoji`/`anagram`/`riddle`/
`countdownletters`'s `text` and `rankit`'s `order`): those got an explicit
length/shape cap because a scripted client could otherwise submit an
unbounded string or array that gets stored and broadcast raw to every
player in the room. Four more fields turned out to have the identical
gap in a third shape - a small *scalar* (an index, an "A"/"B" pick, or
another player's token) that `scoreRoundGame()` only ever compares with
strict `===` or uses as a Map key, never size-checks:

- `trivia` and `oddoneout`'s `choice` (expected to be a number)
- `wouldyourather`'s `choice` (expected to be exactly `"A"` or `"B"`)
- `mostlikelyto`'s `votedFor` (expected to be another player's real token)

None of these were validated at all before `roundGameSubmitAnswer()`
stored them - a garbage value already failed to match/score (harmless),
but was still stored verbatim in `g.answers` and reflected raw into
`results[].choice` / `results[].votedFor` / the `voteCounts` object keys
on every `room-update` broadcast to the whole room, same as the pre-fix
text fields. Fixed by coercing anything that doesn't match the expected
shape to `null` (for `votedFor`, specifically requiring `room.players.has(v)`
so only a real, current player's token is accepted) - this preserves the
exact same "just fails to score" behavior a garbage value already had,
while eliminating the unbounded-size broadcast.

Verified with a live scripted adversarial client (not just `playtest.js`'s
well-behaved bots): sent a 500KB string in place of `trivia`'s `choice`
and confirmed it landed in the results broadcast as `null`, with the
`room-update` payload staying a normal ~1.9KB rather than ballooning;
repeated for `mostlikelyto`'s `votedFor` with the same result, and
separately confirmed a *legitimate* vote for another player's real token
still correctly appears in `voteCounts`, so the fix rejects garbage
without breaking real gameplay. Full `playtest.js` regression run twice
after restarting the server, both clean, with `trivia`/`wouldyourather`/
`mostlikelyto`/`oddoneout` all producing normal nonzero, varied scores -
confirming the coercion doesn't interfere with legitimate numeric/string
answers.

### Security hardening — added a real Content-Security-Policy, closing the one gap the earlier security pass had deliberately left open

The security-headers section had always deliberately skipped a CSP,
reasoning that `helmet`'s default policy would need real tuning against
this app's inline `style="..."` attributes and could silently break the
whole layout if gotten wrong. Rather than leave that as a permanent
trade-off, actually did the tuning: read the app's real resource
inventory instead of guessing at it - grepped for every `<script>` tag
(exactly two, both same-origin with a `src`, zero inline content, zero
inline event-handler attributes anywhere in `main.js` - every listener
uses `addEventListener`), confirmed Socket.IO's client script is
genuinely self-hosted at `/socket.io/socket.io.js` rather than pulled
from a CDN, confirmed no `eval`/`new Function` usage, and traced exactly
which external hosts are actually used (`fonts.googleapis.com` for the
stylesheet link, `fonts.gstatic.com` for the font files it pulls) and
which endpoints serve images (`/api/qr/:roomCode`, the inline SVG favicon
data URI).

That inventory produced a policy that's strict everywhere it safely can
be: `script-src 'self'` with no `'unsafe-inline'`/`'unsafe-eval'` at all
(nothing in the app needs either), `style-src` allowing `'unsafe-inline'`
only (inline style attributes are load-bearing throughout `main.js`'s
templates - retrofitting a nonce onto every one wasn't worth it for a
risk class far lower-severity than script injection, which stays fully
locked down) plus the one real external style host, `img-src 'self'
data:`, `connect-src 'self'` for the Socket.IO WebSocket, and
`object-src 'none'` / `base-uri 'self'` / `frame-ancestors 'none'` as
cheap extra hardening with no functional cost.

Verified live in the browser, not just header-inspected: loaded the app
fresh, confirmed the Google Fonts stylesheet actually resolved (37
`@font-face` entries registered, `Inter` correctly applied as the
computed body font), confirmed the full visual layout rendered
identically to before (screenshot-compared), created a real room through
the browser and confirmed the QR code image (`img-src`) and the
Socket.IO connection (`connect-src`) both worked end-to-end. One real
console error surfaced on load - a service worker registration failure -
but rather than assume it was CSP-caused, ran a direct A/B test:
temporarily stripped the CSP header, restarted, reloaded, and reproduced
the *exact same* failure with no CSP present at all. Confirmed via
`javascript_tool` that it's a pre-existing quirk of this Browser pane's
own automated-testing sandbox (service worker registration is commonly
restricted in headless/automated browser contexts), not a regression
from this change - restored the CSP immediately after confirming.
`playtest.js` regression run clean after the final restart (this is a
browser-security header with no effect on server-side game logic, so
this was a sanity check, not the primary verification for this change).

### Checked, not fixed — two more real angles, both came back clean

Two follow-up checks, each closing out a distinct question rather than
being padding:

- **Prototype pollution via the round-game answer-payload spread.**
  `roundGameSubmitAnswer`'s `const clean = { ...payload }` takes a
  client-controlled object and spreads it - worth checking directly
  whether a key literally named `__proto__` could pollute anything,
  rather than assuming spread is automatically safe. Traced the actual
  spec mechanics: object spread/rest use `[[DefineOwnProperty]]`
  semantics, not `[[Set]]`, so a `"__proto__"` key lands as an inert own
  property on the resulting object - never interpreted as an actual
  prototype link. Confirmed no other code path in `room.js`/`server.js`
  does a `for...in`/bracket-assignment merge on client input (which
  *would* trigger the dangerous setter) - genuinely not exploitable, not
  just unlikely.
- **Re-ran `npm audit`** to check for anything newly disclosed since the
  `qs` CVE fix earlier this session - zero vulnerabilities at every
  severity level, and the `overrides` pin in `package.json` confirmed
  still in place.

### Security fix — room codes could be guessed at unlimited speed, only a real gap once the threat model actually changed

Every existing rate limit in this app (room creation, wrong password
guesses) was designed against a "friends on the same wifi, or a host who
shares the code with people they know" threat model. Revisiting that
assumption directly in light of the site now heading toward a real public
launch - a stranger who's never been told a code, searching the site up
cold - surfaced a real, previously-correct-for-its-context gap: room
codes are 4 characters from a 32-character alphabet (deliberately small,
for "easy to read aloud to a friend" - not a security boundary by
design), giving ~1,048,576 possible codes. Guessing a *wrong* code had
**no rate limit at all** - only wrong *passwords* on a room already known
to exist were throttled. A scripted client could fire `join-room` guesses
essentially as fast as the transport allows (capped only by the existing
generic 30/sec-per-event-name limiter, which is per-*socket* and resets
on every new connection) with zero per-IP cost, realistically enumerating
which of the ~1M codes are currently active and dropping into a
completely unrelated, passwordless stranger's game - a real privacy/
griefing vector that the LAN-party threat model this app was originally
built and audited for never had to consider.

Fixed with the same shape as the existing password-guess limiter right
next to it: a per-IP limit (10 failed lookups per 60 seconds - same
values as the password limiter, for consistency) that only counts
lookups for a code that turned out not to exist, so a real player
re-typing a fat-fingered code never notices it. Verified live with a
scripted client: the first 10 random-code guesses from one IP all
correctly returned "doesn't exist," attempts 11-14 were all correctly
rejected with the rate-limit message, and - critically - a completely
separate connection joining a real room with its actual correct code
succeeded normally throughout, confirming the limiter doesn't interfere
with legitimate play. Full `playtest.js` regression clean after
restarting the server.

### Bug fix — found a real gap in the fix above, immediately after making it

A periodic sweep already existed to keep `createTimestamps` and
`passwordAttempts` (the room-creation and password-guess rate limiters)
from growing forever across a long-running process, since each is a
permanent per-IP Map entry until explicitly cleaned up. Adding
`roomCodeGuesses` above followed the exact same shape as
`passwordAttempts` - except that shared sweep's `setInterval` still only
listed the original two maps by name, so the new one was silently left
out. Under real public traffic (many distinct visitor IPs over the life
of the process, not the same handful of friends reconnecting), this would
have been a genuine slow memory leak - one permanent Map entry per unique
IP that ever failed a room-code guess, never freed.

**Caught by revisiting the fix's own dependencies, not by a separate
audit** - the same "does a fix's assumptions hold everywhere they need to"
instinct behind the PORT and X-Forwarded-For fixes earlier this session,
just applied to a `setInterval` instead of a function this time. Fixed by
adding `roomCodeGuesses` to the existing sweep loop.

**Verified the cleanup actually fires, not just that the code looks
right**: rather than trust the mirrored logic by inspection, copied the
project into an isolated scratchpad directory, temporarily shrank the
window (60s → 2s) and sweep interval (5min → 3s) in that copy only, added
a temporary debug route exposing each map's live size, and drove it with
a scripted client. Confirmed `roomCodeGuesses` went from 0 → 1 after a
few failed guesses, then genuinely back to 0 six seconds later once the
entry aged past the window and a sweep pass ran - not just an empty array
sitting in the Map, an actual deleted key. Hit one detour along the way:
the debug route initially returned the app's `index.html` instead of its
own JSON - traced to a pre-existing, legitimate SPA catch-all route
(`app.get(/^\/(?!api\/|socket\.io\/).*/, ...)`, for deep-link support)
registered earlier in the file and matching any extension-less path
first; moved the debug route above it in the isolated copy and confirmed
that fixed it. Discarded the entire scratchpad copy afterward - the real
`server.js` only ever received the one-line sweep addition, never the
temporary window/interval/debug-route changes. Restarted the real server
with the fix and ran `playtest.js` clean.

### New feature — a dynamic sitemap.xml, following through on a public-launch item raised earlier

Search visibility came up directly (a real ask, not invented busywork):
`GET /sitemap.xml` now exists, listing the one real URL this single-page
app has. Generated per-request from the actual `req.protocol`/`Host`
rather than a static file with a hardcoded domain baked in - this app is
explicitly meant to be deployed to whatever domain someone points at it
(same reasoning already behind `index.html`'s relative `og:image` path),
so a static sitemap would silently be wrong on every deployment but the
one it was written for, and nobody would remember to hand-edit it per
redeploy. Deliberately not wired into `robots.txt` (a genuinely static
file, so it has the identical domain problem and no way around it) -
Search Console/Bing Webmaster Tools take a sitemap submission directly,
which doesn't need it.

Treated `Host` as the client-controlled value it actually is, not
implicitly-trusted server config: escaped it for XML special characters
before interpolating, matching how every other client-derived value
reflected back to a caller is treated elsewhere in this app. Verified
live: a normal request correctly resolves to the real request's own
origin, and a request with a deliberately hostile `Host` header
(`evil.com"><script>alert(1)</script>`) came back correctly escaped
(`&quot;&gt;&lt;script&gt;...`) rather than breaking the XML's
well-formedness. Full `playtest.js` regression clean after restarting the
server; README updated with the Search Console submission step.

### Security fix — the server was one bug away from handing strangers its own source layout

No custom Express error-handling middleware existed anywhere in this app,
which meant any unhandled error in any Express route would fall through
to Express's *own* default error handler - and that default handler
includes the **full stack trace** (real filesystem paths, the internal
Express/serve-static call chain, exact line numbers) directly in the
HTTP response, whenever `NODE_ENV` isn't `"production"`. Checked, not
assumed: none of this app's real documented deployment paths
(Render/Railway/Fly.io, a bare VPS + `pm2`) ever set `NODE_ENV` at all -
only the Dockerfile path happens to, incidentally. So on every deployment
path but one, this was live and waiting for the first unhandled bug to
actually hand a random stranger a working map of the server's own source
tree. No route currently throws unhandled today (the app's one `async`
route already fully self-catches), but nothing before this fix would have
contained a *future* bug from doing exactly that - the same "don't rely
on every call site staying perfect forever" reasoning behind the
Socket.IO side's existing per-handler try/catch wrapping, just missing on
the HTTP side until now.

**Proved the leak before fixing it, then proved the fix**: added a
route that deliberately throws to an isolated scratchpad copy, confirmed
the raw response really did include the full absolute path stack trace
exactly as described; fixed the real app by adding one catch-all Express
error handler (registered last, as required for it to actually catch
every route above it) that logs the real error server-side and returns
only `{"error": "Something went wrong."}` with a 500 to the client - same
split already used for Socket.IO's own error handling. Re-ran the
identical throw test against the fixed code in a fresh isolated copy:
client response was the clean generic message with no stack trace at all,
while the full real error (stack trace included) still landed in the
server-side log both times - confirming the fix protects the public
response without costing any real debuggability for whoever's actually
running the server. Discarded both scratchpad copies after. Restarted
the real server with the fix and ran `playtest.js` clean.

### Security fix — Socket.IO now rejects cross-origin connections, following through on the item deferred above

`new Server(server)` was created with no `cors`/`allowRequest` option,
and Engine.IO's own default (traced directly in `node_modules/engine.io`,
not assumed) is `cors: false` with no origin allowlist at all - it only
rejects a header with literally invalid characters, nothing else. Unlike
`fetch`/XHR, a raw WebSocket connection isn't subject to the browser's
Same-Origin Policy, so a completely unrelated page could open a socket
connection to this app and emit any of its events.

Worth being precise about the actual severity, not just the existence of
the gap: this app's auth is `localStorage`-based, not cookie-based
(confirmed - `session.token` is read from `localStorage.getItem
("pg_token")` and only ever sent explicitly in a `socket.emit` payload).
`localStorage` is strictly same-origin isolated, so a cross-origin page's
JS has **no way to read a real visitor's actual token** - this rules out
the classic CSRF/session-hijack impact missing origin checks usually
enable. The real exposure was narrower: a malicious page could act as one
more anonymous connection using the victim's own IP - something an
attacker could already do directly, just distributed across unwitting
third-party visitors' IPs if that page got real traffic.

This was initially recorded as a deliberately-deferred, known gap (the
entry immediately above, before this rewrite) rather than fixed on the
spot, specifically because the correct enforcement point - Engine.IO's
`allowRequest` hook, which runs before *every* transport including the
initial polling handshake every client makes before any upgrade - getting
it even slightly wrong risks rejecting legitimate same-origin connections
and taking the whole app offline for every player, a far worse failure
than the low-severity gap it would close. That needed real empirical
verification of what browsers actually send on this app's own
same-origin handshake before it was safe to ship. Done immediately after
as a direct continuation, not a separate task:

**What the verification found, and why it changed the plan.** Set up an
isolated scratchpad copy logging every handshake's headers, then drove a
*real* browser (not a script) through this app's own same-origin
connection. `Origin` was absent entirely on the polling handshake -
confirming the exact risk that made an Origin/Host-based check
dangerous to ship blind. But `Sec-Fetch-Site` (part of the standard
Fetch Metadata headers - sent by every modern browser on every request
type, WebSocket handshakes included, not just fetch/XHR) was reliably
present as `"same-origin"` on every attempt. This turned out to be a
strictly better mechanism than the Origin/Host comparison originally
planned, for a reason beyond just being observed reliable: it's computed
entirely by the browser from the actual connection target, needing zero
server-side knowledge of "what's our real domain" - unlike Origin/Host
matching, which would have needed the same `TRUST_PROXY`-aware
resolution `X-Forwarded-For` gets elsewhere in this file, and getting
*that* wrong would have broken every deployment behind a reverse proxy
that doesn't happen to forward `X-Forwarded-Host` correctly.

Implemented as: reject only when `Sec-Fetch-Site` is present *and* not
`"same-origin"`; allow everything else, including its total absence
(older browsers, non-browser clients - never the threat model an origin
check protects against anyway, since a scripted attacker was never
routed through a browser's Sec-Fetch-Site logic to begin with). This
structurally can only ever reject a request that *positively* signals
cross-origin - it can never reject one merely silent about it, which is
what keeps the "break legitimate connections" failure mode off the
table entirely, regardless of deployment topology.

**Verified all three cases directly before shipping, not just the happy
path**: a real browser's same-origin handshake (checked live, both via
the isolated copy and, after implementing the fix, against this app's
actual production `server.js` - a genuine room created end-to-end
through the UI, exactly the way a real player would); a simulated
cross-site request (`Sec-Fetch-Site: cross-site` via a raw `curl`)
correctly rejected with `403`; a request with no `Sec-Fetch-Site` header
at all correctly still allowed through, matching prior behavior exactly
(confirmed this doesn't break `playtest.js`'s own bot clients, which
connect via `socket.io-client` directly rather than a browser). Full
`playtest.js` regression clean on the real server after restarting; both
scratchpad copies discarded after use.

### Security fix — closed the identity-hijack gap flagged earlier this session (not just mitigated)

A player's `token` was doing two jobs at once: the id every other player's
client sees for that player (needed for kick/vote/results), and the sole
credential `join-room` accepted to reclaim that exact identity. Since it's
broadcast in plain sight to everyone in the room, anyone in it - including
the host - could be silently impersonated by another player who copied
their token off the broadcast, no server-side way to tell the difference
from that player's own legitimate reconnect. A previous pass only closed
the *silent* part (the displaced player now gets force-disconnected with a
clear reason instead of nothing happening); the impersonation itself was
left open, flagged for a real fix rather than patched partially.

Fixed by giving each player a second value, `secret` - generated
server-side only (`addPlayer` in `games/room.js`), returned once via
`create-room`/`join-room`'s own callback, and never included in
`playerList()` or any room-update broadcast. `join-room` now requires the
stored token to also come with its matching secret before treating the
call as a reconnect; a mismatch (including simply omitting it) is
rejected outright with a clear error rather than silently falling through
to "new player." The public `token` keeps doing everything else exactly
as before - it's still the id used for kicks, votes, results - since none
of that was ever the actual problem.

Verified live with a scripted adversarial client: confirmed `secret`
never appears anywhere in the room-update broadcast; confirmed reading a
victim's real `token` off that broadcast and attempting to reconnect as
them with a guessed/missing secret is rejected
(`{"ok":false,"error":"Invalid session - please rejoin."}`); confirmed
the real victim stays fully connected and unaffected throughout: no
disconnect, no dropped session; and confirmed the *legitimate* path (the
real token with its real secret) still works, so this rejects only actual
impersonation, not normal reconnects. Full `playtest.js` regression clean
after restarting, confirming ordinary create/join/reconnect flows -
which the bots exercise on every run - are unaffected.
