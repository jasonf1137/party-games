const path = require("path");
const http = require("http");
const os = require("os");
const express = require("express");
const compression = require("compression");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

const R = require("./games/room");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Unlike fetch/XHR, a raw WebSocket connection isn't subject to the
  // browser's Same-Origin Policy - Engine.IO's own default (traced
  // directly: `cors: false`, no allowlist) rejects nothing based on
  // origin, so any unrelated page's script could otherwise open a socket
  // here and act as one more anonymous connection using a visitor's own
  // browser/IP. Real but narrow risk given this app's auth lives in
  // localStorage (strictly same-origin-isolated, unlike cookies) - a
  // cross-origin page can't read a real visitor's token, so this can't
  // hijack a session, only add distributed noise if a malicious page
  // gets real traffic.
  //
  // `Sec-Fetch-Site` (part of the standard Fetch Metadata headers, sent
  // by every modern browser on every request including a WebSocket
  // handshake - not fetch/XHR-only) is the right signal here specifically
  // *because* it's computed by the browser from the actual connection
  // target, with zero server-side knowledge of "what's our real domain"
  // needed - unlike an Origin/Host comparison, which would need the same
  // TRUST_PROXY-aware resolution X-Forwarded-For gets above, and getting
  // that subtly wrong would risk rejecting legitimate connections behind
  // a real reverse proxy. Verified empirically before shipping, not
  // assumed: a real same-origin browser handshake (this app's own,
  // observed live) reliably sends "same-origin" on every attempt; a
  // simulated cross-site request was correctly rejected (403); a request
  // with no Sec-Fetch-Site at all (older browsers, non-browser clients -
  // never blocked by an origin check anyway, since a scripted attacker
  // was never routed through a browser's Sec-Fetch-Site logic in the
  // first place) still gets through, matching current behavior exactly -
  // so this can only ever reject a request that *positively* signals
  // cross-origin, never one that's merely silent about it.
  allowRequest: (req, callback) => {
    const secFetchSite = req.headers["sec-fetch-site"];
    callback(null, !(secFetchSite && secFetchSite !== "same-origin"));
  }
});

// Only trust X-Forwarded-For when an env var says there's an actual reverse
// proxy in front (Caddy/nginx per the README's deploy guide) setting it -
// set TRUST_PROXY=1 there. Defaulting this to true would be actively
// harmful: this app's primary documented use case is direct LAN access with
// no proxy at all, and *any* direct client can put whatever they want in
// that header - trusting it unconditionally would let someone on the same
// wifi bypass every IP-based rate limit below just by varying the header on
// each request (verified: a bare `curl -H "X-Forwarded-For: ..."` against
// this server with no proxy involved does exactly that when this is `true`).
//
// Passing `1` here rather than the boolean `true` matters even once this IS
// on, and isn't just a style choice - traced through Express's own
// `compileTrust`/`proxy-addr` source to confirm precisely: `true` trusts
// the *entire* X-Forwarded-For chain unconditionally and resolves `req.ip`
// to the leftmost entry, which is the ORIGINAL, client-supplied value -
// still spoofable by anyone, even with a real reverse proxy in front,
// unless that proxy is specifically configured to overwrite rather than
// append to any X-Forwarded-For the raw client already sent (not every
// nginx config does this: `proxy_add_x_forwarded_for` appends). `1` tells
// Express "trust exactly one hop" (this app's entire documented topology -
// one proxy, directly in front, no CDN), which resolves to the *rightmost*
// entry instead - the value that specific trusted hop itself observed,
// immune to whatever the original client tried to inject ahead of it.
const TRUST_PROXY = process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";
app.set("trust proxy", TRUST_PROXY ? 1 : false);

// Socket.IO/Engine.IO does NOT inherit Express's "trust proxy" setting -
// socket.handshake.address always comes straight from the raw TCP
// connection (verified against engine.io's source, which never reads
// X-Forwarded-For at all), so a reverse-proxied deployment would otherwise
// see every socket connection as coming from the proxy's one IP, silently
// turning the room-creation and password rate limits below into one shared
// global bucket instead of a per-visitor one. Deliberately mirrors the
// *rightmost*-entry resolution `trust proxy: 1` gives Express above (not
// simply "first entry," which would reintroduce the same spoofing gap
// explained there) - same single-trusted-hop assumption, same reasoning,
// kept consistent between the HTTP and socket sides rather than each
// re-deriving it independently.
function getClientIp(socket) {
  if (TRUST_PROXY) {
    const xff = socket.handshake.headers["x-forwarded-for"];
    if (xff) return xff.split(",").pop().trim();
  }
  return socket.handshake.address;
}

// Express doesn't gzip anything on its own, and this app's whole point is
// "friends joining from their phones" - often on real cellular data, not a
// desk. Compresses main.js (~5x smaller), style.css, and the QR PNGs for
// free; harmless if a reverse proxy in front also compresses.
app.use(compression());

// A few cheap, safe security headers, plus a real Content-Security-Policy.
// Still deliberately not pulling in the full `helmet` package - its default
// CSP is meant to be tuned per-app, and hand-writing this one directly
// against what the app actually loads (verified below, not guessed) is
// clearer than fighting a preset's defaults down to the same result.
app.disable("x-powered-by");

// Inventory this CSP is built from - every external resource and script
// path the app actually has, checked directly rather than assumed:
//   - Exactly two <script> tags in index.html, both same-origin with a
//     `src` (Socket.IO's own client, self-served at /socket.io/socket.io.js
//     by the socket.io package - not a CDN - and /js/main.js) - zero inline
//     <script> content and zero inline event-handler attributes (onclick=
//     etc, grepped for and confirmed absent - every listener in main.js is
//     addEventListener), so script-src needs no 'unsafe-inline'/'unsafe-eval'
//     and no external host at all.
//   - style-src DOES need 'unsafe-inline': main.js's templates render
//     plenty of inline style="..." attributes, and retrofitting a nonce
//     onto every one of those across 3000+ lines isn't worth doing for a
//     risk class (CSS injection) far lower-severity than script injection -
//     also covers the one inline <style> block in index.html's <noscript>
//     fallback. Plus fonts.googleapis.com for the Google Fonts stylesheet
//     link, and fonts.gstatic.com (via font-src) for the font files it
//     pulls.
//   - img-src needs 'self' (the /api/qr/:roomCode QR endpoint, favicon/
//     og-image files) and data: (the inline SVG favicon <link>).
//   - connect-src 'self' covers the same-origin WebSocket upgrade.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'", // no legitimate use of plugins/Flash-era embeds here
  "base-uri 'self'", // blocks a <base> tag injection from redirecting relative URLs
  "frame-ancestors 'none'" // the modern, CSP-level equivalent of X-Frame-Options below
].join("; ");

app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff"); // stop MIME-sniffing a response into something it isn't
  res.set("X-Frame-Options", "DENY"); // this app has no legitimate reason to ever be iframed - blocks clickjacking
  res.set("Content-Security-Policy", CSP);
  next();
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/api/catalog", (req, res) => res.json(R.getCatalog()));

// Standard health check for whatever's watching the process (a platform's
// load balancer, a container orchestrator, an uptime monitor) - cheap,
// no auth needed, nothing sensitive in the response.
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptimeSeconds: Math.floor(process.uptime()), activeRooms: R.rooms.size });
});

// Generated at request time rather than a static file, and deliberately not
// referenced from robots.txt (which - being a plain static file, unlike
// this route - can't know the real domain either) - same reasoning as
// index.html's og:image being a relative path: this app is meant to be
// deployed to whatever domain someone points at it (see the README), so a
// sitemap hardcoding one specific domain would silently be wrong on every
// other deployment and need a manual edit nobody would remember to make.
// `req.protocol` correctly reflects the real scheme even behind a reverse
// proxy once TRUST_PROXY is set, same as everywhere else in this file that
// relies on Express's trust-proxy resolution. Only one real URL exists here
// - this is a single-page app - so a full sitemap protocol library would be
// overkill for one <url> entry.
app.get("/sitemap.xml", (req, res) => {
  // The Host header is client-supplied, not just server config - a raw
  // request (unlike a real crawler resolving the real domain via DNS)
  // could send anything, including XML special characters. Escaping here
  // costs nothing and keeps the output well-formed regardless, matching
  // how every other client-derived value reflected back to a caller
  // elsewhere in this app is treated.
  const escapeXml = (s) => s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
  }[c]));
  const base = escapeXml(`${req.protocol}://${req.get("host")}`);
  res.type("application/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `  <url><loc>${base}/</loc></url>\n` +
    `</urlset>\n`
  );
});

// Small reusable per-IP rate limiter for plain HTTP routes - the socket-level
// limiters further down cover socket.io events; this is for Express routes
// that do real work per request (QR rendering isn't free, and unlike a
// socket handler, this one doesn't even require an existing room to hit).
function httpRateLimit({ limit, windowMs }) {
  const hits = new Map(); // ip -> [timestamps]

  // Self-contained cleanup so every use of this factory is automatically
  // safe for a long-running process, without relying on whoever adds the
  // next route to remember to wire it into some external sweep too.
  setInterval(() => {
    const now = Date.now();
    for (const [ip, list] of hits) {
      const fresh = list.filter((t) => now - t < windowMs);
      if (fresh.length) hits.set(ip, fresh);
      else hits.delete(ip);
    }
  }, 5 * 60 * 1000).unref();

  return (req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(ip, list);
    if (list.length > limit) {
      res.status(429).end();
      return;
    }
    next();
  };
}

// Renders a scannable invite QR code for a room's join link - kept as a tiny
// server-rendered PNG so the client stays a plain <img>, no client-side QR
// library or build step needed. Only ever encodes our own /?room=CODE URLs
// (built server-side from the request itself, never client-supplied text),
// so this can't be turned into an open QR-encoding proxy.
app.get("/api/qr/:roomCode", httpRateLimit({ limit: 30, windowMs: 60 * 1000 }), async (req, res) => {
  const roomCode = (req.params.roomCode || "").toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(roomCode)) {
    res.status(400).end();
    return;
  }
  const origin = `${req.protocol}://${req.get("host")}`;
  const url = `${origin}/?room=${roomCode}`;
  try {
    const png = await QRCode.toBuffer(url, {
      type: "png",
      margin: 1,
      width: 240,
      color: { dark: "#121014", light: "#F5F2ED" }
    });
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store");
    res.send(png);
  } catch (e) {
    res.status(500).end();
  }
});

// Anything else extension-less (e.g. a stray deep link) still gets the app
// shell instead of a bare "Cannot GET" - the app's own routing is just the
// ?room= query param, read client-side, so serving index.html is enough.
// A genuinely missing static asset (has a file extension) still 404s normally.
app.get(/^\/(?!api\/|socket\.io\/).*/, (req, res, next) => {
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Express's own default error handler - the one that runs when no custom
// one exists, exactly this app's situation until now - includes the full
// stack trace (real filesystem paths, internal call chain, line numbers)
// in the actual HTTP response whenever `NODE_ENV` isn't "production".
// Confirmed live, not assumed: none of this app's real documented
// deployment paths (Render/Railway/Fly.io, a bare VPS + pm2) ever set
// NODE_ENV at all - only the Dockerfile path happens to. So on every
// deployment but that one, any future unhandled error in any Express
// route (none exist today - the one async route already self-catches -
// but nothing stops a later change from introducing one) would currently
// hand a stranger on the public internet a working map of the server's
// own source layout. Registered last, as Express requires for an error
// handler to actually catch errors from every route above it. Mirrors
// the same "log the real thing server-side, tell the client nothing
// sensitive" split already used for every Socket.IO handler.
app.use((err, req, res, next) => {
  console.error("Unhandled Express error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Something went wrong." });
});

// socketId -> { roomCode, token }
const sessions = new Map();

function currentRoomAndPlayer(socket) {
  const s = sessions.get(socket.id);
  if (!s) return {};
  const room = R.getRoom(s.roomCode);
  if (!room) return {};
  const player = room.players.get(s.token);
  return { room, player, token: s.token };
}

// Every "submit-answer"/"submit-vote" handler below already checks "has
// everyone finished?" right after a player acts, so the round can advance
// early instead of always waiting out the phase timer. A player leaving
// mid-round (kicked, or disconnecting) can just as easily be the one thing
// a round is still waiting on - without this, everyone else left just sits
// through the full timer for someone who's already gone. This mirrors each
// of those same checks, only triggered from departure instead of an action.
function checkPhaseAdvanceAfterDeparture(room, io) {
  if (!room || !room.game || !room.players.size) return;
  const g = room.game;
  const cg = room.currentGame;

  if (cg === "promptbattle") {
    if (g.phase === "answering" && R.promptBattleAllAnswered(room)) {
      R.promptBattleGoToVoting(room);
      if (room.game && room.game.phase === "voting") R.promptBattleBeginVotingTimer(room, io);
    } else if (g.phase === "voting" && R.promptBattleAllVoted(room)) {
      R.promptBattleGoToResults(room);
    }
  } else if (cg && R.ROUND_GAME_TYPES.includes(cg) && g.kind === "roundgame") {
    if (g.phase === "answering" && R.roundGameAllAnswered(room)) {
      R.roundGameGoToResults(room);
    }
  } else if (cg === "fib") {
    if (g.phase === "answering" && R.fibAllAnswered(room)) {
      R.fibGoToVoting(room);
      if (room.game && room.game.phase === "voting") R.fibBeginVotingTimer(room, io);
    } else if (g.phase === "voting" && R.fibAllVoted(room)) {
      R.fibGoToResults(room);
    }
  } else if (cg === "triviasurvival") {
    if (g.phase === "answering" && R.triviaSurvivalAllAnswered(room)) {
      R.triviaSurvivalGoToResults(room);
    }
  } else if (cg === "drawit") {
    if (g.phase === "drawing" && R.drawItAllSubmitted(room)) {
      R.drawItGoToVoting(room);
      R.drawItBeginVotingTimer(room, io);
    } else if (g.phase === "voting" && R.drawItAllVoted(room)) {
      R.drawItGoToResults(room);
    }
  } else if (cg === "twotruths") {
    if (g.phase === "writing" && R.twoTruthsAllWritten(room)) {
      R.twoTruthsGoToGuessing(room);
      if (room.game && room.game.phase === "guessing") R.twoTruthsBeginGuessingTimer(room, io);
    } else if (g.phase === "guessing" && R.twoTruthsAllGuessed(room)) {
      R.twoTruthsGoToReveal(room);
    }
  } else if (cg === "doodle") {
    if (g.phase === "drawing") {
      if (!room.players.has(g.artistToken)) {
        // The artist left - nobody left to draw, so guessers would
        // otherwise just stare at a blank/frozen canvas for the rest of
        // the turn's timer. End it now instead of making them wait it out.
        R.doodleEndTurn(room);
      } else if (R.doodleAllGuessed(room)) {
        R.doodleEndTurn(room);
      }
    }
  } else if (cg === "headsup") {
    // "ready" phase has no timer at all - it just waits for the performer
    // to tap "Start My Turn," and (unlike every other phase in the game)
    // the client never renders a host skip control here, only in
    // "summary". If the performer departs before starting, nothing else
    // will ever move this turn along - advance it immediately instead of
    // leaving the room permanently stuck with no recovery but abandoning
    // the game. ("active" phase already has its own countdown timer that
    // ends the turn regardless of whether the performer is still around,
    // so no fix is needed there.)
    if (g.phase === "ready" && !room.players.has(g.performerToken)) {
      R.headsUpNextTurn(room);
    }
  } else if (cg === "wordbomb") {
    // Word Bomb isn't a "wait for everyone" game, it's a turn rotation, so
    // a departure needs two different checks: did losing that player just
    // decide the winner (down to one alive), and if not, were they the one
    // currently on the clock (nothing else will ever advance their turn).
    if (g.phase === "active" && !R.wordBombFinishIfOneRemains(room)) {
      if (!room.players.has(R.wordBombCurrentToken(room))) {
        R.wordBombFailTurn(room);
        if (room.game && room.game.phase === "active") {
          R.wordBombBeginTimer(room, io);
        }
      }
    }
  }
}

function startCurrentGame(room, io) {
  const g = room.currentGame;
  if (g === "headsup") {
    R.startHeadsUp(room);
  } else if (g === "promptbattle") {
    R.startPromptBattle(room);
    R.promptBattleBeginAnsweringTimer(room, io);
  } else if (g === "wordbomb") {
    R.startWordBomb(room);
    R.wordBombBeginTimer(room, io);
  } else if (g === "fib") {
    R.startFib(room);
    R.fibBeginAnsweringTimer(room, io);
  } else if (g === "triviasurvival") {
    R.startTriviaSurvival(room);
    R.triviaSurvivalStartTimer(room, io);
  } else if (g === "doodle") {
    R.startDoodle(room);
    R.doodleBeginTimer(room, io);
  } else if (g === "twotruths") {
    R.startTwoTruths(room);
    R.twoTruthsBeginWritingTimer(room, io);
  } else if (g === "drawit") {
    R.startDrawIt(room);
    R.drawItBeginDrawingTimer(room, io);
  } else if (R.ROUND_GAME_TYPES.includes(g)) {
    R.startRoundGame(room, g);
    R.startRoundGameTimer(room, io);
  } else {
    return false;
  }
  return true;
}

// A sane hard cap so nobody can script one room into thousands of players -
// no real party needs more than this, and it keeps a single room's memory
// and broadcast size bounded.
const MAX_PLAYERS_PER_ROOM = 24;

// Simple in-memory rate limit on room creation, keyed by IP - generous
// enough that no real host would ever notice it, just enough to stop one
// visitor from spamming rooms into memory. Not meant to survive a restart;
// a process restart clearing it is fine for what this guards against.
const ROOM_CREATE_LIMIT = 8;
const ROOM_CREATE_WINDOW_MS = 60 * 1000;
const createTimestamps = new Map(); // ip -> [timestamps]

function isRateLimited(ip) {
  const now = Date.now();
  const list = (createTimestamps.get(ip) || []).filter((t) => now - t < ROOM_CREATE_WINDOW_MS);
  list.push(now);
  createTimestamps.set(ip, list);
  return list.length > ROOM_CREATE_LIMIT;
}

// Same idea, but for wrong room-password guesses - without this, a room's
// password could be brute-forced with unlimited rapid join-room attempts,
// since guessing wrong otherwise costs nothing. Only failed guesses count
// against the limit, so it never gets in a legitimate player's way.
const PASSWORD_ATTEMPT_LIMIT = 10;
const PASSWORD_ATTEMPT_WINDOW_MS = 60 * 1000;
const passwordAttempts = new Map(); // ip -> [timestamps of failed guesses]

function isPasswordRateLimited(ip) {
  const now = Date.now();
  const list = (passwordAttempts.get(ip) || []).filter((t) => now - t < PASSWORD_ATTEMPT_WINDOW_MS);
  passwordAttempts.set(ip, list);
  return list.length >= PASSWORD_ATTEMPT_LIMIT;
}

function recordFailedPasswordAttempt(ip) {
  const now = Date.now();
  const list = (passwordAttempts.get(ip) || []).filter((t) => now - t < PASSWORD_ATTEMPT_WINDOW_MS);
  list.push(now);
  passwordAttempts.set(ip, list);
}

// Same idea again, one level earlier - guessing a WRONG room code entirely
// (not just a wrong password on a real one) had no rate limit at all, only
// discovered as a real gap once "anyone on the public internet, not just
// people a host actually told the code to" became the real threat model.
// Room codes are a 4-character code from a 32-character alphabet (picked
// for "easy to read aloud to a friend," not for keyspace) - ~1M possible
// codes, small enough that unlimited free guessing at speed could
// realistically enumerate which few are currently active and let a
// stranger drop into someone else's unrelated, passwordless game. Same
// shape and same limit as the password guess-limiter above: only failed
// ("room doesn't exist") lookups count against it, so a legitimate player
// re-typing a code they got right on the first real try never notices.
const ROOM_CODE_GUESS_LIMIT = 10;
const ROOM_CODE_GUESS_WINDOW_MS = 60 * 1000;
const roomCodeGuesses = new Map(); // ip -> [timestamps of failed lookups]

function isRoomCodeGuessRateLimited(ip) {
  const now = Date.now();
  const list = (roomCodeGuesses.get(ip) || []).filter((t) => now - t < ROOM_CODE_GUESS_WINDOW_MS);
  return list.length >= ROOM_CODE_GUESS_LIMIT;
}

function recordFailedRoomCodeGuess(ip) {
  const now = Date.now();
  const list = (roomCodeGuesses.get(ip) || []).filter((t) => now - t < ROOM_CODE_GUESS_WINDOW_MS);
  list.push(now);
  roomCodeGuesses.set(ip, list);
}

io.on("connection", (socket) => {
  // Wrap socket.on so every handler registered below is automatically safe
  // against malformed payloads. Every handler here expects its first
  // argument to be a plain object (destructured, often with a `= {}`
  // default) - but that default only covers a genuinely missing argument.
  // A client sending null, a string, a number, or an array as the payload
  // (accidentally or not) sails right past it and throws inside the
  // destructure, which - uncaught - takes down the ENTIRE process and every
  // room on it. Normalizing here fixes that at the root for every handler
  // at once, and the try/catch is a second layer against any other
  // unforeseen throw, so one bad message from one client can never end
  // everyone else's games.
  // Per-socket, per-event-name rate limit - every "submit"-style handler
  // below unconditionally calls broadcastRoom() on each invocation (even a
  // repeat/no-op one), so nothing was stopping a single connected client
  // (not necessarily malicious - could just be a scripted/broken client)
  // from calling an event far faster than any real user interaction ever
  // would and flooding everyone else in their room with broadcasts. 30/sec
  // is generous headroom above anything a real click/tap/keystroke/drawing
  // gesture produces (verified: doodle:stroke, the highest-frequency
  // legitimate event, only fires once per completed pointer gesture, not
  // per pointermove) while still meaningfully bounding a flood. Keyed per
  // event name so a burst on one event can't starve a different one.
  const eventTimestamps = new Map();
  const rawOn = socket.on.bind(socket);
  socket.on = (event, handler) => rawOn(event, (...args) => {
    if (args.length && (args[0] === null || typeof args[0] !== "object" || Array.isArray(args[0]))) {
      args[0] = {};
    }
    const now = Date.now();
    const recent = (eventTimestamps.get(event) || []).filter((t) => now - t < 1000);
    recent.push(now);
    eventTimestamps.set(event, recent);
    if (recent.length > 30) {
      // If the caller passed an ack callback, it still needs a response -
      // silently dropping it would leave a client-side "joining..."/
      // "submitting..." flag stuck true forever with no error and no
      // recovery short of a reload, which is worse than just refusing.
      const maybeCb = args[args.length - 1];
      if (typeof maybeCb === "function") maybeCb({ ok: false, error: "Too many requests - slow down a bit." });
      return;
    }
    try {
      handler(...args);
    } catch (e) {
      console.error(`Error handling socket event "${event}":`, e);
    }
  });

  socket.on("create-room", ({ name, token, gameId, settings, roomSettings } = {}, cb) => {
    if (isRateLimited(getClientIp(socket))) {
      cb && cb({ ok: false, error: "Too many rooms created from here - try again in a minute." });
      return;
    }
    const room = R.createRoom();
    if (R.GAME_IDS.includes(gameId)) room.currentGame = gameId;
    if (settings) R.applySettings(room, settings);
    if (roomSettings) R.applyRoomSettings(room, roomSettings);
    const player = R.addPlayer(room, name, token);
    player.socketId = socket.id;
    sessions.set(socket.id, { roomCode: room.code, token: player.token });
    socket.join(room.code);
    cb && cb({ ok: true, roomCode: room.code, token: player.token, secret: player.secret });
    R.broadcastRoom(io, room);
  });

  socket.on("join-room", ({ roomCode, name, token, secret, password } = {}, cb) => {
    const room = R.getRoom(roomCode);
    if (!room) {
      if (isRoomCodeGuessRateLimited(getClientIp(socket))) {
        cb && cb({ ok: false, error: "Too many attempts from here - try again in a minute." });
        return;
      }
      recordFailedRoomCodeGuess(getClientIp(socket));
      cb && cb({ ok: false, error: "That room code doesn't exist." });
      return;
    }

    let player = token ? room.players.get(token) : null;

    // `token` alone is never enough to reclaim a player - see the `secret`
    // comment on addPlayer(). A mismatch (including a pre-fix client that
    // never had a secret at all) is rejected outright rather than silently
    // falling through to "treat as a new player", since `token` being
    // present at all signals a reconnect attempt.
    if (player && player.secret !== secret) {
      cb && cb({ ok: false, error: "Invalid session - please rejoin." });
      return;
    }

    // A token that was explicitly kicked must never be treated as "just a
    // new player" below, even once the game returns to the lobby - a
    // player who was disconnected at the moment they got kicked never saw
    // the "kicked" event (that only reaches an actively-connected socket),
    // so their device can still hold this exact token and would otherwise
    // silently rejoin as a "new" player once back online, undoing the kick.
    if (token && room.kickedTokens.has(token)) {
      cb && cb({ ok: false, error: "You were removed from this room." });
      return;
    }

    if (!player && room.state !== "lobby") {
      cb && cb({ ok: false, error: "This game has already started." });
      return;
    }

    // Only a brand-new join needs the password - a reconnect already proved
    // membership via its token, so it isn't gated again.
    if (!player && room.password) {
      if (isPasswordRateLimited(getClientIp(socket))) {
        cb && cb({ ok: false, error: "Too many attempts from here - try again in a minute." });
        return;
      }
      if (!R.checkRoomPassword(room, password)) {
        recordFailedPasswordAttempt(getClientIp(socket));
        cb && cb({ ok: false, error: "Incorrect password.", needsPassword: true });
        return;
      }
    }

    if (!player && room.players.size >= MAX_PLAYERS_PER_ROOM) {
      cb && cb({ ok: false, error: "This room is full." });
      return;
    }

    if (!player) {
      player = R.addPlayer(room, name, null);
    }

    // Reaching here means either a brand-new player, or a reconnect that
    // already passed the token+secret check above - so this is never an
    // impersonation. The force-disconnect-the-previous-socket handling below
    // predates the secret fix (kept as-is): it covers the ordinary case of a
    // player's own second tab/device reconnecting with their own valid
    // credential, which should still take over the "live" socket cleanly
    // rather than leaving two sockets attached to one player.
    const previousSocketId = player.socketId;
    player.connected = true;
    player.disconnectedAt = null;
    player.socketId = socket.id;
    if (name && !room.players.has(token)) player.name = R.sanitizeName(name);

    if (previousSocketId && previousSocketId !== socket.id) {
      const previousSocket = io.sockets.sockets.get(previousSocketId);
      if (previousSocket) {
        sessions.delete(previousSocketId);
        previousSocket.emit("session-taken-over");
        previousSocket.leave(room.code);
        previousSocket.disconnect(true);
      }
    }

    sessions.set(socket.id, { roomCode: room.code, token: player.token });
    socket.join(room.code);
    cb && cb({ ok: true, roomCode: room.code, token: player.token, secret: player.secret });
    R.broadcastRoom(io, room);
  });

  socket.on("update-name", ({ name } = {}) => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player) return;
    player.name = R.sanitizeName(name);
    R.broadcastRoom(io, room);
  });

  socket.on("select-game", ({ gameId } = {}) => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player || player.token !== room.hostToken) return;
    if (!R.GAME_IDS.includes(gameId)) return;
    room.currentGame = gameId;
    R.broadcastRoom(io, room);
  });

  socket.on("update-settings", (payload = {}) => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player || player.token !== room.hostToken) return;
    R.applySettings(room, payload);
    R.broadcastRoom(io, room);
  });

  socket.on("kick-player", ({ token } = {}) => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player || player.token !== room.hostToken) return;
    if (!token || token === room.hostToken) return; // can't kick yourself
    const target = room.players.get(token);
    if (!target) return;

    const targetSocket = target.socketId ? io.sockets.sockets.get(target.socketId) : null;
    room.players.delete(token);
    room.kickedTokens.add(token);
    R.reassignHostIfMissing(room);

    if (targetSocket) {
      sessions.delete(targetSocket.id);
      targetSocket.emit("kicked");
      targetSocket.leave(room.code);
      targetSocket.disconnect(true);
    }

    checkPhaseAdvanceAfterDeparture(room, io);
    R.removeEmptyRoomIfNeeded(room);
    R.broadcastRoom(io, room);
  });

  socket.on("transfer-host", ({ token } = {}) => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player || player.token !== room.hostToken) return;
    if (!token || token === room.hostToken) return;
    const target = room.players.get(token);
    if (!target || !target.connected) return;
    room.hostToken = token;
    R.broadcastRoom(io, room);
  });

  socket.on("update-room-settings", (payload = {}) => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player || player.token !== room.hostToken) return;
    R.applyRoomSettings(room, payload);
    R.broadcastRoom(io, room);
  });

  socket.on("start-game", () => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player || player.token !== room.hostToken) return;
    // Same double-click gap as the *NextRound/*NextTurn functions (see
    // headsUpNextTurn's comment in room.js) - the "Start Game" button has
    // no debounce either, and every start* function unconditionally
    // re-runs resetScores() and re-randomizes turn order/prompts, so a
    // rapid double-click would silently re-initialize the just-started
    // game a moment later instead of just being a harmless no-op.
    if (room.state !== "lobby") return;
    if (room.players.size < 2) return;
    if (!startCurrentGame(room, io)) return;
    R.broadcastRoom(io, room);
  });

  socket.on("return-to-lobby", () => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player || player.token !== room.hostToken) return;
    R.clearTimer(room);
    room.state = "lobby";
    room.currentGame = null;
    room.game = null;
    R.broadcastRoom(io, room);
  });

  socket.on("play-again", () => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player || player.token !== room.hostToken) return;
    // Same reasoning as "start-game" above - only valid from the finished
    // screen, and the button there has no debounce either.
    if (room.state !== "finished") return;
    R.clearTimer(room);
    startCurrentGame(room, io);
    R.broadcastRoom(io, room);
  });

  // ----- Heads Up -----
  socket.on("headsup:start-turn", () => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player) return;
    if (room.game && player.token === room.game.performerToken) {
      R.headsUpStartTurn(room, io);
      R.broadcastRoom(io, room);
    }
  });

  socket.on("headsup:answer", ({ correct } = {}) => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player) return;
    R.headsUpAnswer(room, player.token, !!correct);
    R.broadcastRoom(io, room);
  });

  socket.on("headsup:next-turn", () => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player || player.token !== room.hostToken) return;
    // Guard lives here, not inside R.headsUpNextTurn itself - see that
    // function's own comment for why (it has a second, legitimate caller
    // that needs to run from a different phase). Without this, a rapid
    // double-click on "Next Turn" (no debounce client-side, nothing else
    // stopping a second event landing before the first broadcast re-renders
    // the button away) would silently skip an extra turn for the room.
    if (!room.game || room.game.phase !== "summary") return;
    R.headsUpNextTurn(room);
    R.broadcastRoom(io, room);
  });

  // ----- Prompt Battle -----
  socket.on("promptbattle:submit-answer", ({ text } = {}) => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player) return;
    R.promptBattleSubmitAnswer(room, player.token, text);
    if (R.promptBattleAllAnswered(room)) {
      R.promptBattleGoToVoting(room);
      R.promptBattleBeginVotingTimer(room, io);
    }
    R.broadcastRoom(io, room);
  });

  socket.on("promptbattle:submit-vote", ({ authorToken } = {}) => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player) return;
    R.promptBattleSubmitVote(room, player.token, authorToken);
    if (R.promptBattleAllVoted(room)) {
      R.promptBattleGoToResults(room);
    }
    R.broadcastRoom(io, room);
  });

  socket.on("promptbattle:next-round", () => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player || player.token !== room.hostToken) return;
    R.promptBattleNextRound(room);
    if (room.game && room.game.phase === "answering") {
      R.promptBattleBeginAnsweringTimer(room, io);
    }
    R.broadcastRoom(io, room);
  });

  // ----- Word Bomb -----
  socket.on("wordbomb:submit-word", ({ text } = {}) => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player) return;
    R.wordBombSubmit(room, player.token, text);
    if (room.game && room.game.phase === "active") {
      R.wordBombBeginTimer(room, io);
    }
    R.broadcastRoom(io, room);
  });

  // ----- Generic round games (trivia, would-you-rather, most-likely-to, emoji, category) -----
  socket.on("roundgame:submit-answer", (payload = {}) => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player) return;
    R.roundGameSubmitAnswer(room, player.token, payload);
    if (R.roundGameAllAnswered(room)) {
      R.roundGameGoToResults(room);
    }
    R.broadcastRoom(io, room);
  });

  socket.on("roundgame:next-round", () => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player || player.token !== room.hostToken) return;
    R.roundGameNextRound(room);
    if (room.game && room.game.phase === "answering") {
      R.startRoundGameTimer(room, io);
    }
    R.broadcastRoom(io, room);
  });

  // ----- Fib or Fact -----
  socket.on("fib:submit-lie", ({ text } = {}) => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player) return;
    R.fibSubmitLie(room, player.token, text);
    if (R.fibAllAnswered(room)) {
      R.fibGoToVoting(room);
      R.fibBeginVotingTimer(room, io);
    }
    R.broadcastRoom(io, room);
  });

  socket.on("fib:submit-vote", ({ optionId } = {}) => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player) return;
    R.fibSubmitVote(room, player.token, optionId);
    if (R.fibAllVoted(room)) {
      R.fibGoToResults(room);
    }
    R.broadcastRoom(io, room);
  });

  socket.on("fib:next-round", () => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player || player.token !== room.hostToken) return;
    R.fibNextRound(room);
    if (room.game && room.game.phase === "answering") {
      R.fibBeginAnsweringTimer(room, io);
    }
    R.broadcastRoom(io, room);
  });

  // ----- Trivia Survival -----
  socket.on("triviasurvival:submit-answer", ({ choice } = {}) => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player) return;
    R.triviaSurvivalSubmitAnswer(room, player.token, choice);
    if (R.triviaSurvivalAllAnswered(room)) {
      R.triviaSurvivalGoToResults(room);
    }
    R.broadcastRoom(io, room);
  });

  socket.on("triviasurvival:next-round", () => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player || player.token !== room.hostToken) return;
    R.triviaSurvivalNextRound(room);
    if (room.game && room.game.phase === "answering") {
      R.triviaSurvivalStartTimer(room, io);
    }
    R.broadcastRoom(io, room);
  });

  // ----- Doodle Guess -----
  socket.on("doodle:stroke", ({ points } = {}) => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player) return;
    if (!R.doodleAddStroke(room, player.token, points)) return;
    socket.to(room.code).emit("doodle:stroke", { points: room.game.strokes[room.game.strokes.length - 1].points });
  });

  socket.on("doodle:clear", () => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player) return;
    if (!R.doodleClear(room, player.token)) return;
    socket.to(room.code).emit("doodle:clear");
  });

  socket.on("doodle:submit-guess", ({ text } = {}) => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player) return;
    R.doodleSubmitGuess(room, player.token, text);
    if (R.doodleAllGuessed(room)) {
      R.doodleEndTurn(room);
    }
    R.broadcastRoom(io, room);
  });

  socket.on("doodle:next-turn", () => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player || player.token !== room.hostToken) return;
    R.doodleNextTurn(room);
    if (room.game && room.game.phase === "drawing") {
      R.doodleBeginTimer(room, io);
    }
    R.broadcastRoom(io, room);
  });

  // ----- Two Truths and a Lie -----
  socket.on("twotruths:submit-statements", ({ texts, lieIndex } = {}) => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player) return;
    R.twoTruthsSubmitStatements(room, player.token, texts, lieIndex);
    if (R.twoTruthsAllWritten(room)) {
      R.twoTruthsGoToGuessing(room);
      if (room.game && room.game.phase === "guessing") {
        R.twoTruthsBeginGuessingTimer(room, io);
      }
    }
    R.broadcastRoom(io, room);
  });

  socket.on("twotruths:submit-guess", ({ guessIndex } = {}) => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player) return;
    R.twoTruthsSubmitGuess(room, player.token, guessIndex);
    if (R.twoTruthsAllGuessed(room)) {
      R.twoTruthsGoToReveal(room);
    }
    R.broadcastRoom(io, room);
  });

  socket.on("twotruths:next", () => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player || player.token !== room.hostToken) return;
    R.twoTruthsNextSpotlight(room);
    if (room.game && room.game.phase === "guessing") {
      R.twoTruthsBeginGuessingTimer(room, io);
    }
    R.broadcastRoom(io, room);
  });

  // ----- Draw It! -----
  socket.on("drawit:submit", ({ strokes } = {}) => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player) return;
    R.drawItSubmit(room, player.token, strokes);
    if (R.drawItAllSubmitted(room)) {
      R.drawItGoToVoting(room);
      R.drawItBeginVotingTimer(room, io);
    }
    R.broadcastRoom(io, room);
  });

  socket.on("drawit:submit-vote", ({ authorToken } = {}) => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player) return;
    R.drawItSubmitVote(room, player.token, authorToken);
    if (R.drawItAllVoted(room)) {
      R.drawItGoToResults(room);
    }
    R.broadcastRoom(io, room);
  });

  socket.on("drawit:next-round", () => {
    const { room, player } = currentRoomAndPlayer(socket);
    if (!room || !player || player.token !== room.hostToken) return;
    R.drawItNextRound(room);
    if (room.game && room.game.phase === "drawing") {
      R.drawItBeginDrawingTimer(room, io);
    }
    R.broadcastRoom(io, room);
  });

  socket.on("leave-room", () => handleDisconnect(socket, true));
  socket.on("disconnect", () => handleDisconnect(socket, false));
});

function handleDisconnect(socket, explicit) {
  const s = sessions.get(socket.id);
  sessions.delete(socket.id);
  if (!s) return;
  const room = R.getRoom(s.roomCode);
  if (!room) return;
  const player = room.players.get(s.token);
  if (player) {
    if (explicit) {
      room.players.delete(s.token);
      R.reassignHostIfMissing(room);
    } else {
      player.connected = false;
      player.disconnectedAt = Date.now();
      player.socketId = null;
    }
  }
  checkPhaseAdvanceAfterDeparture(room, io);
  R.removeEmptyRoomIfNeeded(room);
  R.broadcastRoom(io, room);
}

setInterval(() => R.sweepEmptyRooms(io), 30 * 1000).unref();

// Keeps createTimestamps, passwordAttempts, and roomCodeGuesses from growing
// forever across a long-running process as distinct visitor IPs come and go
// - each is a permanent Map entry per unique IP ever seen until swept, since
// isRoomCodeGuessRateLimited/etc. only ever filter+set, never delete on
// their own. roomCodeGuesses was added after this sweep already existed and
// was missed here on the first pass - the exact same "revisit a shared
// helper's other call sites" gap as elsewhere this session, just against a
// setInterval instead of a function.
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of createTimestamps) {
    const fresh = list.filter((t) => now - t < ROOM_CREATE_WINDOW_MS);
    if (fresh.length) createTimestamps.set(ip, fresh);
    else createTimestamps.delete(ip);
  }
  for (const [ip, list] of passwordAttempts) {
    const fresh = list.filter((t) => now - t < PASSWORD_ATTEMPT_WINDOW_MS);
    if (fresh.length) passwordAttempts.set(ip, fresh);
    else passwordAttempts.delete(ip);
  }
  for (const [ip, list] of roomCodeGuesses) {
    const fresh = list.filter((t) => now - t < ROOM_CODE_GUESS_WINDOW_MS);
    if (fresh.length) roomCodeGuesses.set(ip, fresh);
    else roomCodeGuesses.delete(ip);
  }
}, 5 * 60 * 1000).unref();

function lanAddresses() {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const ifaceList of Object.values(nets)) {
    for (const iface of ifaceList || []) {
      if (iface.family === "IPv4" && !iface.internal) addresses.push(iface.address);
    }
  }
  return addresses;
}

const PORT = process.env.PORT || 3000;

// Without this, a listen()-time failure is an *unhandled* 'error' event on
// `server` (nothing was listening for it yet - the uncaughtException net
// below only gets registered inside the success callback, deliberately, so
// it can't mask this) - Node's default behavior for that is a raw,
// confusing stack trace. Confirmed the actual failure mode this specifically
// helps with: PORT set to a non-numeric string (a deployer typo/misconfig)
// doesn't fail with anything mentioning "PORT" at all - net.Server.listen()
// treats a non-numeric first argument as a named-pipe path instead of a
// port number, so the real error is a bare "EACCES: permission denied
// <value>" with no indication PORT is even the problem.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use - stop whatever else is using it, or set PORT to something else.`);
  } else if (err.code === "EACCES" && !/^\d+$/.test(String(PORT))) {
    console.error(`Couldn't start on PORT="${PORT}" - that's not a valid port number. PORT should be a plain number (e.g. PORT=3000).`);
  } else {
    console.error(`Failed to start the server: ${err.message}`);
  }
  process.exit(1);
});

// A PORT that *looks* numeric but is out of the valid 0-65535 range (e.g. a
// typo like PORT=99999999) doesn't reach the 'error' handler above at all -
// net.Server.listen() validates the port and throws a RangeError
// synchronously, before the listen attempt (and its async 'error' event)
// even begins. Checked here, before calling listen(), for the same
// "clear message instead of a raw crash" reason as the handler above.
if (/^\d+$/.test(String(PORT)) && Number(PORT) > 65535) {
  console.error(`Couldn't start on PORT="${PORT}" - port numbers must be 0-65535.`);
  process.exit(1);
}

server.listen(PORT, () => {
  // Read back the actual bound port rather than trusting PORT verbatim -
  // they differ whenever PORT=0, which asks the OS to auto-assign any free
  // port (a legitimate pattern, e.g. some test/CI setups use it) - printing
  // the literal "0" back would give a deployer a useless, wrong URL for
  // where the server actually ended up listening.
  const boundPort = server.address().port;
  console.log(`Party Games server running at http://localhost:${boundPort}`);
  const lan = lanAddresses();
  if (lan.length) {
    console.log("Friends on the same wifi can join at:");
    lan.forEach((addr) => console.log(`  http://${addr}:${boundPort}`));
  }

  // Last-resort safety net for anything outside the per-socket handlers
  // (a setInterval sweep, an Express route) - logs and keeps running instead
  // of taking down every active room over one unexpected throw. Registered
  // only now, after a successful listen, so a genuine startup failure (like
  // the port already being in use) still crashes normally and visibly -
  // catching it here would otherwise leave a non-functional zombie process
  // that never actually served anything, confusing any process manager
  // watching for a real exit code.
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception (server kept running):", err);
  });
  process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection (server kept running):", err);
  });
});

// Close sockets and the HTTP server cleanly on a deploy/restart (pm2,
// Docker, Ctrl+C) instead of just dying mid-request - clients briefly see a
// "Reconnecting…" toast and reconnect once the new process is up, rather
// than a hard connection reset.
function shutdown(signal) {
  // Force-exit if something's still hanging after a few seconds - started
  // immediately, not after the log write below, so a slow/blocked write
  // can't itself delay the fallback.
  setTimeout(() => process.exit(1), 5000).unref();

  // A plain console.log() here isn't guaranteed to actually reach the log
  // before `process.exit()` runs a few lines down - console.log doesn't
  // report back when (or whether) its write actually completed, and a
  // stdout redirected to a file can be genuinely asynchronous (confirmed
  // live: this message was reliably missing from the log after a real
  // SIGTERM, even though the shutdown itself completed correctly - fast
  // exit, connected clients cleanly disconnected). `process.stdout.write`'s
  // callback fires once the write is actually flushed, so starting the
  // real shutdown sequence from inside it guarantees the message is never
  // silently dropped, at the cost of a negligible (sub-millisecond in
  // practice) delay before things start closing.
  process.stdout.write(`\n${signal} received, shutting down...\n`, () => {
    io.close(() => {
      server.close(() => process.exit(0));
    });
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
