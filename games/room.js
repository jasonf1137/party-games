const { customAlphabet } = require("nanoid");
const headsUpData = require("./headsup-data");
const promptBattleData = require("./promptbattle-data");
const wordBombData = require("./wordbomb-data");
const triviaData = require("./trivia-data");
const wouldYouRatherData = require("./wouldyourather-data");
const mostLikelyToData = require("./mostlikelyto-data");
const emojiData = require("./emoji-data");
const categoryData = require("./category-data");
const fibData = require("./fib-data");
const pollGuessData = require("./pollguess-data");
const doodleData = require("./doodle-data");
const anagramData = require("./anagram-data");
const oddOneOutData = require("./oddoneout-data");
const quickMathData = require("./quickmath-data");
const neverHaveIEverData = require("./neverhaveiever-data");
const riddleData = require("./riddle-data");
const guessTheYearData = require("./guesstheyear-data");
const trueFalseData = require("./truefalse-data");
const rankItData = require("./rankit-data");

// Avoid ambiguous characters (0/O, 1/I) in room codes.
const genCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 4);
const genToken = customAlphabet(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  16
);

const GAME_IDS = [
  "headsup", "promptbattle", "wordbomb",
  "trivia", "wouldyourather", "category", "mostlikelyto", "emoji", "pollguess",
  "fib", "triviasurvival", "doodle",
  "anagram", "oddoneout", "quickmath", "twotruths",
  "neverhaveiever", "riddle", "countdownletters", "drawit",
  "guesstheyear", "truefalse", "rankit"
];

// These all share the same "everyone answers, then see results, then
// next round" shape - only the prompt data and scoring rule differ.
const ROUND_GAME_TYPES = [
  "trivia", "wouldyourather", "mostlikelyto", "emoji", "category", "pollguess",
  "anagram", "oddoneout", "quickmath",
  "neverhaveiever", "riddle", "countdownletters",
  "guesstheyear", "truefalse", "rankit"
];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function clamp(v, lo, hi, fallback) {
  const n = Number(v);
  if (Number.isNaN(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

// Same as clamp(), but rounds to a whole number first - for every setting
// that's a count or a duration in seconds (rounds, answerTime, lives, ...).
// clamp() alone only bounds the *range*, not the *shape* of the value: a
// scripted client sending e.g. `rounds: 3.7` would sail straight through
// clamp(3.7, 1, 10, ...) unchanged and get stored as-is, then rendered
// verbatim in the UI ("Round 1 of 3.7") and used as a countdown starting
// point (ticking 45.5, 44.5, ...) - a real, player-visible glitch, not just
// a theoretical one, since none of these fields go through parseInt/Math.
// round anywhere else on this path. Deliberately a separate function from
// clamp() rather than rounding inside it - clamp() is also used for stroke
// point coordinates (x/y in [0, 1]) where fractional values are the whole
// point, and rounding those would collapse every drawn point to a corner.
function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (Number.isNaN(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

// "x || ''" alone still lets a truthy non-string (a number, object, array,
// boolean) straight through to a string method call, which throws - a
// client can send any JSON value for a field that's supposed to be text.
// Used everywhere client input gets treated as a string.
function asString(x) {
  return typeof x === "string" ? x : "";
}

// Truncates by grapheme cluster (what a person would call one "character"),
// not by JS string length - `str.slice(0, n)` counts UTF-16 code units, so
// a plain emoji (a surrogate pair, 2 units) sitting right on the boundary
// gets sliced in half, leaving a lone unpaired surrogate at the end. That's
// not just theoretical: an unpaired surrogate isn't valid UTF-16 on its own,
// so it renders as a broken/replacement-character glyph wherever the
// truncated text shows up (this app's own text is never round-tripped
// through anything stricter than JSON, which tolerates it, so it doesn't
// crash - it just looks broken). Intl.Segmenter with grapheme granularity
// also correctly keeps multi-codepoint sequences intact (flag emoji made of
// two regional-indicator symbols, ZWJ family emoji, skin-tone modifiers),
// not just plain surrogate pairs.
const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
// Segmentation itself is O(input length) - without a cheap pre-cap, a
// near-1MB raw string (Socket.IO's default transport ceiling) still costs
// full-length segmentation work before truncation ever discards anything
// (confirmed empirically: ~150ms for a single 900KB call). That's cheap
// enough to look harmless once, but it's repeatable on every submission to
// any handler that calls this, and Node is single-threaded - a client
// spamming near-max-size payloads turns a "should be instant" text field
// into a sustained, real event-loop-blocking cost. Pre-slicing to a hard
// UTF-16-unit ceiling (plain `.slice()`, O(1)) before segmenting bounds the
// worst case regardless of content.
//
// A "generous units-per-grapheme" margin instead of a hard cap would NOT
// be safe here: Unicode's grapheme-cluster rule for ZWJ has no enforced
// per-cluster length limit (confirmed: chaining emoji with ZWJ keeps
// producing a single grapheme no matter how many are joined) - a crafted
// input could be one giant "character" by grapheme-counting rules, which
// would silently defeat any margin sized per-expected-grapheme and let the
// full untruncated string back out. A flat unit ceiling has no such gap:
// it bounds the segmentation input (and therefore the output) regardless
// of how many codepoints any one cluster tries to claim.
//
// 10,000 units, chosen empirically, not guessed: measured real multi-
// person/skin-tone emoji clusters at up to 17 UTF-16 units each (a naive
// "generous margin per character" guess of ~20-24 units/grapheme, tried
// first, turned out to be dangerously too tight against 140 *legitimate*
// complex-emoji characters - the largest maxLen used anywhere in this
// file needs up to 140x17=2380 units just for real content, not even
// pathological input). Verified 10,000 correctly preserves all 140
// graphemes for 140 realistic complex-emoji characters with room to
// spare, while cutting a 900KB adversarial payload's cost from ~150ms
// (the pre-fix, no-cap number) down to ~2ms.
const TRUNCATE_RAW_CAP = 10000;
function truncateText(str, maxLen) {
  const capped = str.length > TRUNCATE_RAW_CAP ? str.slice(0, TRUNCATE_RAW_CAP) : str;
  const graphemes = [...graphemeSegmenter.segment(capped)];
  if (graphemes.length <= maxLen && capped === str) return str;
  return graphemes.slice(0, maxLen).map((g) => g.segment).join("");
}

// Trims first so a whitespace-only (or empty) name falls back to "Player"
// instead of displaying as a blank-looking row in the player list.
function sanitizeName(name) {
  const trimmed = truncateText(asString(name).trim(), 20);
  return trimmed || "Player";
}

// Countdown Letters: checks a word can be spelled using only the letters in
// pool, each used at most as many times as it appears (a multiset subset
// check) - no dictionary lookup, honor system like Word Bomb.
function wordFitsLetters(word, pool) {
  const counts = {};
  for (const c of pool) counts[c] = (counts[c] || 0) + 1;
  for (const c of word) {
    if (!counts[c]) return false;
    counts[c] -= 1;
  }
  return true;
}

const rooms = new Map();

function createRoom() {
  let code;
  do {
    code = genCode();
  } while (rooms.has(code));

  const room = {
    code,
    players: new Map(), // token -> player
    // A kicked player's own client can't clear its stored session the way
    // a voluntary "leave" does (bindLeave() clears it client-side
    // immediately) - the "kicked" event that would trigger that only
    // reaches an *actively connected* socket, so someone kicked while
    // disconnected never gets it. Without tracking this, their device
    // would auto-reconnect with its old token once back online and
    // join-room's "not found -> add as new player" fallback would let
    // them silently back in, undoing the kick entirely. Room-scoped and
    // cleaned up along with the room itself (no separate cleanup needed).
    kickedTokens: new Set(),
    hostToken: null,
    state: "lobby", // lobby | playing | finished
    currentGame: null,
    settings: {
      headsup: {
        turnDuration: 60,
        roundsPerPlayer: 1,
        categories: Object.keys(headsUpData).slice(0, 3)
      },
      promptbattle: {
        rounds: 3,
        answerTime: 75,
        voteTime: 30
      },
      wordbomb: {
        turnTimeSeconds: 10,
        startingLives: 3
      },
      trivia: { rounds: 5, answerTime: 20 },
      wouldyourather: { rounds: 5, answerTime: 15 },
      mostlikelyto: { rounds: 5, answerTime: 15 },
      emoji: { rounds: 5, answerTime: 20 },
      category: { rounds: 3, answerTime: 45 },
      pollguess: { rounds: 5, answerTime: 20 },
      fib: { rounds: 3, answerTime: 60, voteTime: 25 },
      triviasurvival: { startingLives: 3, answerTime: 15, maxRounds: 8 },
      doodle: { roundsPerPlayer: 1, drawSeconds: 70 },
      anagram: { rounds: 5, answerTime: 25 },
      oddoneout: { rounds: 5, answerTime: 15 },
      quickmath: { rounds: 6, answerTime: 12 },
      twotruths: { writeSeconds: 60, guessSeconds: 20 },
      neverhaveiever: { rounds: 6, answerTime: 12 },
      riddle: { rounds: 5, answerTime: 30 },
      countdownletters: { rounds: 3, answerTime: 30 },
      drawit: { rounds: 3, drawSeconds: 60, voteSeconds: 25 },
      guesstheyear: { rounds: 5, answerTime: 20 },
      truefalse: { rounds: 6, answerTime: 12 },
      rankit: { rounds: 4, answerTime: 30 }
    },
    game: null,
    timer: null,
    createdAt: Date.now(),
    emptySince: null,
    password: null, // plaintext in memory only - a room-code gate, not an auth system
    streamerMode: false
  };
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(asString(code).toUpperCase());
}

function getCatalog() {
  return {
    headsUpCategories: Object.keys(headsUpData),
    headsUpCategoryCounts: Object.fromEntries(
      Object.entries(headsUpData).map(([k, v]) => [k, v.length])
    ),
    categoryPool: categoryData
  };
}

// Shared by create-room (optional up-front settings) and update-settings.
// Room-level settings (not tied to any one mini-game) - streamer mode and
// the optional join password, shown on their own "Room Settings" tab.
function applyRoomSettings(room, payload = {}) {
  if (typeof payload.streamerMode === "boolean") {
    room.streamerMode = payload.streamerMode;
  }
  if (typeof payload.password === "string") {
    const trimmed = payload.password.trim().slice(0, 40);
    room.password = trimmed || null;
  }
}

function checkRoomPassword(room, password) {
  if (!room.password) return true;
  return typeof password === "string" && password === room.password;
}

function applySettings(room, payload = {}) {
  if (payload.headsup) {
    const h = payload.headsup;
    if (h.turnDuration) room.settings.headsup.turnDuration = clampInt(h.turnDuration, 15, 120, room.settings.headsup.turnDuration);
    if (h.roundsPerPlayer) room.settings.headsup.roundsPerPlayer = clampInt(h.roundsPerPlayer, 1, 5, room.settings.headsup.roundsPerPlayer);
    if (Array.isArray(h.categories)) {
      // Only ever accept real category names - an unrecognized one (or a
      // completely bogus list) would otherwise leave the word pool empty
      // once the game starts, not just reject cleanly.
      //
      // Deduping (not just filtering) matters here in a way it doesn't for
      // the other settings fields: every element individually passes this
      // check as long as it's *a* real category name, so a client sending
      // the same valid name repeated e.g. a million times sails straight
      // through with no single obviously-invalid element to reject. That
      // array becomes `g.categories` in refillDeckIfNeeded, which does
      // `for (const cat of g.categories) { for (const w of
      // headsUpData[cat] ...) pool.push(w) }` - a million duplicate
      // categories means a million redundant passes appending the *same*
      // category's words each time, a pool array potentially tens of
      // millions of entries long built in one synchronous loop. Node is
      // single-threaded - that doesn't just bloat this one room's state,
      // it blocks the entire event loop and freezes the server for every
      // player in every room until it finishes.
      const valid = [...new Set(
        h.categories.filter((c) => typeof c === "string" && Object.prototype.hasOwnProperty.call(headsUpData, c))
      )];
      if (valid.length) room.settings.headsup.categories = valid;
    }
  }
  if (payload.promptbattle && payload.promptbattle.rounds) {
    room.settings.promptbattle.rounds = clampInt(payload.promptbattle.rounds, 1, 10, room.settings.promptbattle.rounds);
  }
  if (payload.wordbomb) {
    const w = payload.wordbomb;
    if (w.turnTimeSeconds) room.settings.wordbomb.turnTimeSeconds = clampInt(w.turnTimeSeconds, 5, 30, room.settings.wordbomb.turnTimeSeconds);
    if (w.startingLives) room.settings.wordbomb.startingLives = clampInt(w.startingLives, 1, 5, room.settings.wordbomb.startingLives);
  }
  for (const gt of ROUND_GAME_TYPES) {
    if (payload[gt]) {
      const s = room.settings[gt];
      if (payload[gt].rounds) s.rounds = clampInt(payload[gt].rounds, 1, 10, s.rounds);
      if (payload[gt].answerTime) s.answerTime = clampInt(payload[gt].answerTime, 8, 90, s.answerTime);
    }
  }
  if (payload.fib) {
    const f = payload.fib;
    const s = room.settings.fib;
    if (f.rounds) s.rounds = clampInt(f.rounds, 1, 8, s.rounds);
    if (f.answerTime) s.answerTime = clampInt(f.answerTime, 15, 90, s.answerTime);
    if (f.voteTime) s.voteTime = clampInt(f.voteTime, 10, 60, s.voteTime);
  }
  if (payload.triviasurvival) {
    const t = payload.triviasurvival;
    const s = room.settings.triviasurvival;
    if (t.startingLives) s.startingLives = clampInt(t.startingLives, 1, 5, s.startingLives);
    if (t.answerTime) s.answerTime = clampInt(t.answerTime, 8, 60, s.answerTime);
    if (t.maxRounds) s.maxRounds = clampInt(t.maxRounds, 3, 20, s.maxRounds);
  }
  if (payload.doodle) {
    const d = payload.doodle;
    const s = room.settings.doodle;
    if (d.roundsPerPlayer) s.roundsPerPlayer = clampInt(d.roundsPerPlayer, 1, 3, s.roundsPerPlayer);
    if (d.drawSeconds) s.drawSeconds = clampInt(d.drawSeconds, 30, 120, s.drawSeconds);
  }
  if (payload.twotruths) {
    const t = payload.twotruths;
    const s = room.settings.twotruths;
    if (t.writeSeconds) s.writeSeconds = clampInt(t.writeSeconds, 30, 120, s.writeSeconds);
    if (t.guessSeconds) s.guessSeconds = clampInt(t.guessSeconds, 10, 45, s.guessSeconds);
  }
  if (payload.drawit) {
    const d = payload.drawit;
    const s = room.settings.drawit;
    if (d.rounds) s.rounds = clampInt(d.rounds, 1, 8, s.rounds);
    if (d.drawSeconds) s.drawSeconds = clampInt(d.drawSeconds, 30, 120, s.drawSeconds);
    if (d.voteSeconds) s.voteSeconds = clampInt(d.voteSeconds, 10, 45, s.voteSeconds);
  }
}

function addPlayer(room, name, token) {
  token = token || genToken();
  const player = {
    token,
    // A player's `token` is broadcast to everyone else in the room in plain
    // sight (playerList() sends it for every entry, needed so the client can
    // target votes/kicks at a specific player) - so it can never double as a
    // private reconnection credential. `secret` is that credential instead:
    // generated server-side only, returned once via create-room/join-room's
    // own callback (never included in any room-update broadcast), and
    // required alongside `token` to reclaim this identity. Always generated
    // fresh here regardless of what a client sends, since a client-suppliable
    // secret would defeat the whole point.
    secret: genToken(),
    name: sanitizeName(name),
    score: 0,
    connected: true,
    socketId: null,
    disconnectedAt: null
  };
  room.players.set(token, player);
  if (!room.hostToken) room.hostToken = token;
  return player;
}

const EMPTY_ROOM_GRACE_MS = 3 * 60 * 1000;
const HOST_RECLAIM_GRACE_MS = 45 * 1000;

// Marks when a room had its last connected player leave, rather than
// deleting immediately - a reconnecting host (tab backgrounded, phone
// locked, brief wifi drop) shouldn't come back to a vanished room.
function removeEmptyRoomIfNeeded(room) {
  const anyConnected = [...room.players.values()].some((p) => p.connected);
  if (anyConnected) {
    room.emptySince = null;
    return false;
  }
  if (!room.emptySince) room.emptySince = Date.now();
  return false;
}

// Only hand host to someone else once the original host has been gone
// for a while - a momentary disconnect (tab backgrounded, brief wifi
// drop) shouldn't silently transfer host control to whoever else is online.
function sweepEmptyRooms(io) {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.emptySince && now - room.emptySince > EMPTY_ROOM_GRACE_MS) {
      clearTimer(room);
      rooms.delete(room.code);
      continue;
    }
    const host = room.players.get(room.hostToken);
    if (
      host &&
      !host.connected &&
      host.disconnectedAt &&
      now - host.disconnectedAt > HOST_RECLAIM_GRACE_MS
    ) {
      const nextHost = [...room.players.values()].find((p) => p.connected);
      if (nextHost) {
        room.hostToken = nextHost.token;
        if (io) broadcastRoom(io, room);
      }
    }
  }
}

// Called only when a player is fully removed from the room (explicit leave),
// not on a mere disconnect - see sweepEmptyRooms for the grace-period path.
function reassignHostIfMissing(room) {
  if (room.players.has(room.hostToken)) return;
  const nextHost =
    [...room.players.values()].find((p) => p.connected) ||
    [...room.players.values()][0];
  room.hostToken = nextHost ? nextHost.token : null;
}

function clearTimer(room) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

function resetScores(room) {
  for (const player of room.players.values()) player.score = 0;
}

// Generic countdown helper: ticks room.game.timeLeft down once a second,
// broadcasting each tick, and calls onExpire when it hits zero.
function startPhaseTimer(room, io, seconds, onExpire) {
  clearTimer(room);
  room.game.timeLeft = seconds;
  if (!io) return;
  room.timer = setInterval(() => {
    room.game.timeLeft -= 1;
    if (room.game.timeLeft <= 0) {
      onExpire();
    }
    broadcastRoom(io, room);
  }, 1000);
}

// ---------- Heads Up ----------

function startHeadsUp(room) {
  resetScores(room);
  const settings = room.settings.headsup;
  const categories = settings.categories.length
    ? settings.categories
    : Object.keys(headsUpData).slice(0, 3);

  const order = shuffle([...room.players.keys()]);
  const turns = [];
  for (let r = 0; r < settings.roundsPerPlayer; r++) {
    for (const token of order) turns.push(token);
  }

  room.currentGame = "headsup";
  room.state = "playing";
  room.game = {
    categories,
    deck: [],
    turns,
    turnIndex: 0,
    phase: "ready", // ready | active | summary | finished
    performerToken: turns[0],
    word: null,
    timeLeft: settings.turnDuration,
    correctWords: [],
    passedWords: [],
    lockedThisWord: false
  };
  refillDeckIfNeeded(room);
  pickNextWord(room);
}

function refillDeckIfNeeded(room) {
  const g = room.game;
  if (g.deck.length > 0) return;
  const pool = [];
  for (const cat of g.categories) {
    for (const w of headsUpData[cat] || []) pool.push(w);
  }
  g.deck = shuffle(pool);
}

function pickNextWord(room) {
  const g = room.game;
  refillDeckIfNeeded(room);
  g.word = g.deck.shift();
  g.lockedThisWord = false;
}

function headsUpStartTurn(room, io) {
  const g = room.game;
  if (!g || g.phase !== "ready") return;
  g.phase = "active";
  g.timeLeft = room.settings.headsup.turnDuration;
  g.correctWords = [];
  g.passedWords = [];
  pickNextWord(room);

  clearTimer(room);
  room.timer = setInterval(() => {
    g.timeLeft -= 1;
    if (g.timeLeft <= 0) {
      headsUpEndTurn(room);
    }
    broadcastRoom(io, room);
  }, 1000);
}

function headsUpEndTurn(room) {
  clearTimer(room);
  const g = room.game;
  g.phase = "summary";
}

function headsUpAnswer(room, playerToken, correct) {
  const g = room.game;
  if (!g || g.phase !== "active") return;
  if (playerToken === g.performerToken) return; // performer can't answer
  if (g.lockedThisWord) return;
  g.lockedThisWord = true;

  if (correct) g.correctWords.push(g.word);
  else g.passedWords.push(g.word);

  const performer = room.players.get(g.performerToken);
  if (correct && performer) performer.score += 100;

  pickNextWord(room);
}

// Deliberately has NO phase guard of its own, unlike every other
// *NextRound/*NextTurn function in this file - this one is called from two
// different phases for two different legitimate reasons: the host clicking
// "next turn" from "summary", AND the departure-recovery path in server.js
// (checkPhaseAdvanceAfterDeparture) advancing a "ready"-phase turn whose
// performer left before starting. A single `g.phase !== "summary"` guard
// here would silently break that recovery path. The double-fire protection
// for the host-click case instead lives in the "headsup:next-turn" socket
// handler itself, where it can require "summary" specifically without
// touching this shared function's other caller.
function headsUpNextTurn(room) {
  const g = room.game;
  if (!g) return;
  g.turnIndex += 1;
  if (g.turnIndex >= g.turns.length) {
    g.phase = "finished";
    room.state = "finished";
    clearTimer(room);
    return;
  }
  g.performerToken = g.turns[g.turnIndex];
  g.phase = "ready";
  g.word = null;
}

// ---------- Prompt Battle ----------

function startPromptBattle(room) {
  resetScores(room);
  const settings = room.settings.promptbattle;
  const prompts = shuffle(promptBattleData).slice(
    0,
    Math.max(1, settings.rounds)
  );

  room.currentGame = "promptbattle";
  room.state = "playing";
  room.game = {
    prompts,
    round: 0,
    phase: "answering", // answering | voting | results | finished
    timeLeft: settings.answerTime,
    answers: new Map(), // token -> text
    votes: new Map() // voterToken -> answerAuthorToken
  };
  promptBattleBeginAnsweringTimer(room, null);
}

function promptBattleCurrentPrompt(room) {
  return room.game.prompts[room.game.round];
}

function promptBattleBeginAnsweringTimer(room, io) {
  const g = room.game;
  clearTimer(room);
  if (io) {
    room.timer = setInterval(() => {
      g.timeLeft -= 1;
      if (g.timeLeft <= 0) {
        promptBattleGoToVoting(room);
        promptBattleBeginVotingTimer(room, io);
      }
      broadcastRoom(io, room);
    }, 1000);
  }
}

function promptBattleBeginVotingTimer(room, io) {
  const g = room.game;
  clearTimer(room);
  if (io) {
    room.timer = setInterval(() => {
      g.timeLeft -= 1;
      if (g.timeLeft <= 0) {
        promptBattleGoToResults(room);
      }
      broadcastRoom(io, room);
    }, 1000);
  }
}

function promptBattleSubmitAnswer(room, token, text) {
  const g = room.game;
  if (!g || g.phase !== "answering") return;
  text = truncateText(asString(text).trim(), 140);
  if (!text) return;
  g.answers.set(token, text);
}

function promptBattleAllAnswered(room) {
  const g = room.game;
  if (!g) return false;
  const connected = [...room.players.values()].filter((p) => p.connected);
  return connected.every((p) => g.answers.has(p.token));
}

function promptBattleGoToVoting(room) {
  clearTimer(room);
  const g = room.game;
  g.phase = "voting";
  g.timeLeft = room.settings.promptbattle.voteTime;
  g.votingOrder = shuffle([...g.answers.keys()]);
}

function promptBattleSubmitVote(room, voterToken, authorToken) {
  const g = room.game;
  if (!g || g.phase !== "voting") return;
  if (authorToken === voterToken) return;
  if (!g.answers.has(authorToken)) return;
  g.votes.set(voterToken, authorToken);
}

function promptBattleAllVoted(room) {
  const g = room.game;
  if (!g) return false;
  const connected = [...room.players.values()].filter(
    (p) => p.connected && g.answers.has(p.token)
  );
  return connected.every((p) => g.votes.has(p.token));
}

function promptBattleGoToResults(room) {
  clearTimer(room);
  const g = room.game;
  g.phase = "results";

  const voteCounts = new Map();
  for (const author of g.votes.values()) {
    voteCounts.set(author, (voteCounts.get(author) || 0) + 1);
  }
  for (const [token, count] of voteCounts.entries()) {
    const player = room.players.get(token);
    if (player) player.score += count * 500;
  }
  g.lastVoteCounts = voteCounts;
}

function promptBattleNextRound(room) {
  const g = room.game;
  // See headsUpNextTurn for why this phase guard matters - without it, a
  // double-fired "next round" click silently skips an entire round.
  if (!g || g.phase !== "results") return;
  g.round += 1;
  if (g.round >= g.prompts.length) {
    g.phase = "finished";
    room.state = "finished";
    clearTimer(room);
    return;
  }
  g.phase = "answering";
  g.timeLeft = room.settings.promptbattle.answerTime;
  g.answers = new Map();
  g.votes = new Map();
  g.lastVoteCounts = null;
}

// ---------- Word Bomb ----------

function startWordBomb(room) {
  resetScores(room);
  const settings = room.settings.wordbomb;
  const order = shuffle([...room.players.keys()]);

  room.currentGame = "wordbomb";
  room.state = "playing";
  room.game = {
    order,
    turnIndex: 0,
    lives: new Map(order.map((t) => [t, settings.startingLives])),
    usedWords: new Set(),
    fragment: randomFrom(wordBombData),
    timeLeft: settings.turnTimeSeconds,
    turnSeconds: settings.turnTimeSeconds,
    phase: "active", // active | finished
    lastResult: null,
    winnerToken: null
  };
}

function wordBombCurrentToken(room) {
  const g = room.game;
  return g.order[g.turnIndex];
}

function wordBombAlivePlayers(room) {
  const g = room.game;
  // A kicked/left player keeps their `g.lives` entry (the map is built once
  // at game start from the original turn order), so without the
  // `room.players.has` check they'd still count as "alive" for the win
  // condition and still get cycled through for a full timeout every turn,
  // forever - room.players is the source of truth for who's actually here.
  return g.order.filter((t) => g.lives.get(t) > 0 && room.players.has(t));
}

// Split out of wordBombAdvanceTurn so a player's departure can trigger the
// same "did that end the game?" check without also force-advancing the
// turn of whoever's still actively playing.
function wordBombFinishIfOneRemains(room) {
  const g = room.game;
  if (!g || g.phase !== "active") return false;
  const alive = wordBombAlivePlayers(room);
  if (alive.length > 1) return false;
  g.phase = "finished";
  room.state = "finished";
  g.winnerToken = alive[0] || null;
  clearTimer(room);
  if (alive[0]) {
    const p = room.players.get(alive[0]);
    if (p) p.score += 500;
  }
  return true;
}

function wordBombAdvanceTurn(room) {
  const g = room.game;
  if (wordBombFinishIfOneRemains(room)) return;
  let next = g.turnIndex;
  do {
    next = (next + 1) % g.order.length;
  } while (g.lives.get(g.order[next]) <= 0 || !room.players.has(g.order[next]));
  g.turnIndex = next;
  g.fragment = randomFrom(wordBombData);
  g.timeLeft = g.turnSeconds;
}

function wordBombFailTurn(room) {
  const g = room.game;
  const token = wordBombCurrentToken(room);
  g.lives.set(token, Math.max(0, g.lives.get(token) - 1));
  wordBombAdvanceTurn(room);
}

function wordBombSubmit(room, token, text) {
  const g = room.game;
  if (!g || g.phase !== "active") return;
  if (token !== wordBombCurrentToken(room)) return;
  // Matches the client's own <input maxlength="40"> - without this, a
  // crafted word (padding + the required fragment) with no length limit
  // at all would go straight into g.usedWords, which - unlike a round-
  // game's per-round g.answers.set() overwrite - accumulates for the
  // entire game, not just one round, so a misbehaving client repeatedly
  // submitting oversized-but-technically-valid words could grow it
  // unbounded over a long game, not just bloat one broadcast.
  text = truncateText(asString(text).trim(), 40);
  const word = text.toLowerCase();
  const valid =
    word.length >= 3 &&
    word.includes(g.fragment.toLowerCase()) &&
    !g.usedWords.has(word);

  g.lastResult = { token, word: text, valid };

  if (valid) {
    g.usedWords.add(word);
    const p = room.players.get(token);
    if (p) p.score += 50;
    wordBombAdvanceTurn(room);
  } else {
    wordBombFailTurn(room);
  }
}

function wordBombBeginTimer(room, io) {
  clearTimer(room);
  const g = room.game;
  if (!io) return;
  room.timer = setInterval(() => {
    g.timeLeft -= 1;
    if (g.timeLeft <= 0) {
      const token = wordBombCurrentToken(room);
      g.lastResult = { token, word: "", valid: false, timedOut: true };
      wordBombFailTurn(room);
    }
    broadcastRoom(io, room);
  }, 1000);
}

// ---------- Generic round games (trivia, would-you-rather, most-likely-to, emoji, category) ----------

// Picks a random item from `pool` while avoiding a repeat within the same
// game session (tracked via `usedIndices`, a Set of pool indices already
// shown this game). Without this, a blind `randomFrom` every round gave
// even a 20-entry pool roughly a 40%+ chance of repeating some question
// within one default-length game (and near-certain at max rounds) - reads
// as a real bug to players ("didn't we just get this one?"), not "the
// content pool is a bit small." Falls back to allowing a repeat only once
// every entry in the pool has actually been shown this game already -
// nothing better to do at that point, and it's rare in practice (needs
// rounds >= pool size).
function pickUnusedFrom(pool, usedIndices) {
  let available = pool.map((_, i) => i).filter((i) => !usedIndices.has(i));
  if (!available.length) {
    usedIndices.clear();
    available = pool.map((_, i) => i);
  }
  const idx = available[Math.floor(Math.random() * available.length)];
  usedIndices.add(idx);
  return pool[idx];
}

function generateRoundPrompt(gameType, room) {
  const used = room.game.usedPromptIndices;
  switch (gameType) {
    case "trivia":
      return { ...pickUnusedFrom(triviaData, used) };
    case "wouldyourather":
      return { ...pickUnusedFrom(wouldYouRatherData, used) };
    case "mostlikelyto":
      return { text: pickUnusedFrom(mostLikelyToData, used) };
    case "emoji":
      return { ...pickUnusedFrom(emojiData, used) };
    case "category": {
      const letters = "ABCDEFGHIJKLMNOPRSTW".split("");
      const letter = randomFrom(letters);
      const cats = shuffle(categoryData).slice(0, 3);
      return { letter, categories: cats };
    }
    case "pollguess":
      return { ...pickUnusedFrom(pollGuessData, used) };
    case "anagram": {
      const word = pickUnusedFrom(anagramData, used);
      let scrambled;
      do {
        scrambled = shuffle(word.split("")).join("");
      } while (scrambled === word);
      return { word, scrambled };
    }
    case "oddoneout":
      return { ...pickUnusedFrom(oddOneOutData, used) };
    case "quickmath": {
      const op = randomFrom(quickMathData.operators);
      const range = quickMathData.ranges[op];
      let a = Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
      let b = Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
      if (op === "-" && b > a) { const t = a; a = b; b = t; }
      const answer = op === "+" ? a + b : op === "-" ? a - b : a * b;
      return { question: `${a} ${op} ${b}`, answer };
    }
    case "neverhaveiever":
      return { statement: pickUnusedFrom(neverHaveIEverData, used) };
    case "riddle":
      return { ...pickUnusedFrom(riddleData, used) };
    case "countdownletters": {
      const pool = "AAAAAAAAABBCCDDDDEEEEEEEEEEEEFFGGGHHIIIIIIIIIJKLLLLMMNNNNNNOOOOOOOOPPQRRRRRRSSSSTTTTTTUUUUVVWWXYYZ";
      const chars = pool.split("");
      const letters = [];
      for (let i = 0; i < 9; i++) letters.push(randomFrom(chars));
      return { letters: letters.join("") };
    }
    case "guesstheyear":
      return { ...pickUnusedFrom(guessTheYearData, used) };
    case "truefalse":
      return { ...pickUnusedFrom(trueFalseData, used) };
    case "rankit": {
      const entry = pickUnusedFrom(rankItData, used);
      // entry.items[i] has correct rank i (0 = first/smallest). Shuffle for
      // display, but keep each item's true rank alongside it so scoring can
      // work out the correct display-order later.
      const pool = entry.items.map((name, rank) => ({ name, rank }));
      const displayPool = shuffle(pool);
      const correctOrder = displayPool
        .map((_, displayIndex) => displayIndex)
        .sort((a, b) => displayPool[a].rank - displayPool[b].rank);
      return { title: entry.title, items: displayPool.map((p) => p.name), correctOrder };
    }
    default:
      return {};
  }
}

function startRoundGame(room, gameType) {
  resetScores(room);
  const settings = room.settings[gameType];
  room.currentGame = gameType;
  room.state = "playing";
  room.game = {
    kind: "roundgame",
    gameType,
    round: 0,
    totalRounds: Math.max(1, settings.rounds),
    phase: "answering", // answering | results | finished
    timeLeft: settings.answerTime,
    answerTimeSecs: settings.answerTime,
    // Indices already shown this game (per data pool the prompts are drawn
    // from) - generateRoundPrompt uses this to avoid repeating a question
    // within the same session (see pickUnusedFrom). Has to exist before the
    // first generateRoundPrompt call below, so `prompt` is set separately
    // rather than inline in this object literal.
    usedPromptIndices: new Set(),
    prompt: null,
    answers: new Map(), // token -> payload (shape depends on gameType)
    resultsData: null
  };
  room.game.prompt = generateRoundPrompt(gameType, room);
}

function startRoundGameTimer(room, io) {
  startPhaseTimer(room, io, room.game.timeLeft, () => roundGameGoToResults(room));
}

// Per-gameType free-text fields, capped to match the client's own <input
// maxlength> for that field - this generic handler is shared by every
// round-game type, and scoreRoundGame() only ever runs asString() on these
// (a type coercion, not a size limit) before storing/displaying them.
// Without a cap here, a scripted client could submit e.g. a multi-KB
// "guess" - Socket.IO's own transport cap (1MB/message) is the only thing
// stopping an actually enormous payload, but even a few KB is already way
// past anything a real answer looks like, and it gets stored, broadcast to
// every player's `room-update`, and rendered - a single misbehaving client
// could visibly wreck the results screen for the whole room, not just
// themselves.
const ROUND_GAME_TEXT_LIMITS = { emoji: 60, anagram: 20, riddle: 60, countdownletters: 20 };

function roundGameSubmitAnswer(room, token, payload) {
  const g = room.game;
  if (!g || g.kind !== "roundgame" || g.phase !== "answering") return;
  const clean = { ...payload };
  const textLimit = ROUND_GAME_TEXT_LIMITS[g.gameType];
  if (textLimit) clean.text = truncateText(asString(payload && payload.text), textLimit);
  if (g.gameType === "category" && Array.isArray(payload && payload.words)) {
    clean.words = payload.words.slice(0, 3).map((w) => truncateText(asString(w), 30));
  }
  // Same "no length cap at all" gap as the text fields above, just array-
  // shaped instead of string-shaped - missed on the first pass because
  // that fix was scoped to free-text fields, not to every unbounded
  // payload shape. A legitimate rankit order is always exactly
  // g.prompt.correctOrder.length (4 today) elements, but nothing enforced
  // that - an oversized array, or one with a few huge string/object
  // elements instead of plain numbers, would fail scoring harmlessly
  // (`guessOrder[pos] === idx` just evaluates false) but was still stored
  // and broadcast to every player raw. Coercing non-numbers to -1 (can
  // never match a real index) keeps the same "just fails to score"
  // behavior while eliminating the size risk.
  if (g.gameType === "rankit" && Array.isArray(payload && payload.order)) {
    clean.order = payload.order.slice(0, 20).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : -1));
  }
  // Same root gap again, in a third shape: trivia/oddoneout/wouldyourather's
  // `choice` and mostlikelyto's `votedFor` are meant to be a tiny scalar (an
  // index, "A"/"B", or another player's token) and scoreRoundGame() only
  // ever does a strict `===`/Map-key comparison on them - never a size
  // check - so an unvalidated value here is stored as-is and reflected raw
  // into every player's `results[]` on every `room-update`, same
  // whole-room-visible risk as the text/array fields above. A garbage value
  // already failed to match/score correctly (harmless), so coercing it to
  // `null` preserves that exact behavior while removing the size risk.
  if (g.gameType === "trivia" || g.gameType === "oddoneout") {
    clean.choice = typeof (payload && payload.choice) === "number" && Number.isFinite(payload.choice) ? payload.choice : null;
  }
  if (g.gameType === "wouldyourather") {
    const c = payload && payload.choice;
    clean.choice = c === "A" || c === "B" ? c : null;
  }
  if (g.gameType === "mostlikelyto") {
    const v = payload && payload.votedFor;
    clean.votedFor = typeof v === "string" && room.players.has(v) ? v : null;
  }
  // g.timeLeft at the moment of submission - only trivia/quickmath actually
  // use this for a speed bonus (see scoreRoundGame), but it's harmless and
  // cheap to record for every round-game type uniformly here rather than
  // branching by gameType in two places.
  g.answers.set(token, { ...clean, timeLeftAtSubmit: g.timeLeft });
}

function roundGameAllAnswered(room) {
  const g = room.game;
  if (!g) return false;
  const connected = [...room.players.values()].filter((p) => p.connected);
  return connected.every((p) => g.answers.has(p.token));
}

function roundGameGoToResults(room) {
  clearTimer(room);
  const g = room.game;
  g.phase = "results";
  g.resultsData = scoreRoundGame(room);
}

function roundGameNextRound(room) {
  const g = room.game;
  // See headsUpNextTurn for why this phase guard matters - without it, a
  // double-fired "next round" click silently skips an entire round.
  if (!g || g.phase !== "results") return;
  g.round += 1;
  if (g.round >= g.totalRounds) {
    g.phase = "finished";
    room.state = "finished";
    clearTimer(room);
    return;
  }
  g.phase = "answering";
  g.timeLeft = g.answerTimeSecs;
  g.prompt = generateRoundPrompt(g.gameType, room);
  g.answers = new Map();
  g.resultsData = null;
}

function nameOf(room, token) {
  const p = room.players.get(token);
  return p ? p.name : "?";
}

// Trivia and Quick Math both bill themselves as "faster than your friends" /
// "as fast as you can" (see GAME_META in main.js) - this is what actually
// makes that true, rather than every correct answer paying the same flat
// amount regardless of when it came in during the round. Same max total as
// before either game had this (500), just split into a fixed base plus a
// bonus that decays linearly from full to 0 as the round timer runs out, so
// an answer landing right at the buzzer still earns a meaningful chunk.
function speedBonusPoints(g, payload, base, maxBonus) {
  const total = g.answerTimeSecs || 1;
  const timeLeft = typeof (payload && payload.timeLeftAtSubmit) === "number" ? payload.timeLeftAtSubmit : 0;
  const fraction = Math.max(0, Math.min(1, timeLeft / total));
  return base + Math.round(fraction * maxBonus);
}

// Every branch below built its results list by iterating `g.answers` - a
// Map that only ever gets an entry when a player actually submits. A
// player who's still connected and present for the whole round but simply
// never got around to answering before the timer ran out (an ordinary,
// frequent real-world case - not a rare edge case) doesn't show up as "no
// answer"; they're missing from the results list entirely, even though the
// client's own rendering (`res.choice != null ? ... : "no answer"`) reads
// like it was written expecting exactly that case to be representable.
// Iterating every player still in the room instead - `payload` is
// `undefined` where they didn't submit - makes every branch's existing
// null-safe `payload && payload.x` checks do the right thing automatically,
// no other change needed in most branches. (Confirmed via a real live
// playthrough, not playtest.js - its bots always answer within the time
// limit, so this path was never exercised by the automated regression.)
function allAnswerEntries(room) {
  return [...room.players.keys()].map((token) => [token, room.game.answers.get(token)]);
}

function scoreRoundGame(room) {
  const g = room.game;

  if (g.gameType === "trivia") {
    const correctIndex = g.prompt.correctIndex;
    const results = [];
    for (const [token, payload] of allAnswerEntries(room)) {
      const correct = payload && payload.choice === correctIndex;
      if (correct) {
        const p = room.players.get(token);
        if (p) p.score += speedBonusPoints(g, payload, 300, 200);
      }
      results.push({ token, name: nameOf(room, token), choice: payload && payload.choice, correct });
    }
    return { correctIndex, results };
  }

  if (g.gameType === "wouldyourather") {
    let countA = 0, countB = 0;
    for (const payload of g.answers.values()) {
      if (payload && payload.choice === "A") countA++;
      else countB++;
    }
    const majority = countA >= countB ? "A" : "B";
    const results = [];
    for (const [token, payload] of allAnswerEntries(room)) {
      const matched = payload && payload.choice === majority;
      if (matched) {
        const p = room.players.get(token);
        if (p) p.score += 200;
      }
      results.push({ token, name: nameOf(room, token), choice: payload && payload.choice, matched });
    }
    return { countA, countB, majority, results };
  }

  if (g.gameType === "mostlikelyto") {
    const voteCounts = new Map();
    for (const payload of g.answers.values()) {
      if (!payload || !payload.votedFor) continue;
      voteCounts.set(payload.votedFor, (voteCounts.get(payload.votedFor) || 0) + 1);
    }
    // A tie for most votes is a completely normal outcome, not a rare edge
    // case, in a small group voting for one of a handful of friends - a
    // single `winner` via strict `>` comparison silently gave the whole
    // 300-point bonus to whoever happened to be encountered first in Map
    // iteration order, and completely skipped crediting anyone who voted
    // for the *other* tied player(s). Track every token tied for the max
    // instead.
    let max = -1;
    for (const count of voteCounts.values()) if (count > max) max = count;
    const winners = max > 0 ? [...voteCounts.entries()].filter(([, c]) => c === max).map(([t]) => t) : [];
    const winnerSet = new Set(winners);
    for (const token of winners) {
      const p = room.players.get(token);
      if (p) p.score += 300;
    }
    const results = [];
    for (const [token, payload] of allAnswerEntries(room)) {
      const matched = !!(payload && payload.votedFor && winnerSet.has(payload.votedFor));
      if (matched && !winnerSet.has(token)) {
        const p = room.players.get(token);
        if (p) p.score += 100;
      }
      results.push({ token, name: nameOf(room, token), votedFor: payload && payload.votedFor, matched });
    }
    return {
      winners,
      winnerNames: winners.map((t) => nameOf(room, t)),
      voteCounts: Object.fromEntries([...voteCounts.entries()].map(([t, c]) => [t, c])),
      results
    };
  }

  if (g.gameType === "emoji") {
    const acceptable = g.prompt.answers.map((a) => a.toLowerCase().trim());
    const results = [];
    for (const [token, payload] of allAnswerEntries(room)) {
      const guess = asString(payload && payload.text).toLowerCase().trim();
      const correct = acceptable.includes(guess);
      if (correct) {
        const p = room.players.get(token);
        if (p) p.score += 500;
      }
      results.push({ token, name: nameOf(room, token), text: payload && payload.text, correct });
    }
    return { answer: g.prompt.answers[0], results };
  }

  if (g.gameType === "category") {
    const letter = g.prompt.letter.toLowerCase();
    const perCategory = g.prompt.categories.map((cat, idx) => {
      const submissions = [];
      for (const [token, payload] of allAnswerEntries(room)) {
        const raw = asString(payload && payload.words && payload.words[idx]);
        submissions.push({ token, name: nameOf(room, token), word: raw.trim() });
      }
      const counts = new Map();
      for (const s of submissions) {
        const key = s.word.toLowerCase();
        if (!key || key[0] !== letter) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      for (const s of submissions) {
        const key = s.word.toLowerCase();
        let pts = 0;
        if (key && key[0] === letter) {
          pts = counts.get(key) === 1 ? 100 : 50;
        }
        s.points = pts;
        const p = room.players.get(s.token);
        if (p) p.score += pts;
      }
      return { category: cat, submissions };
    });
    return { letter: g.prompt.letter, perCategory };
  }

  if (g.gameType === "pollguess") {
    const actual = g.prompt.answer;
    const withGuesses = [...g.answers.entries()]
      .map(([token, payload]) => ({
        token,
        guess: payload && typeof payload.guess === "number" ? payload.guess : null
      }))
      .filter((e) => e.guess !== null)
      .sort((a, b) => Math.abs(a.guess - actual) - Math.abs(b.guess - actual));
    // Simple podium scoring; ties are broken by submission order, which is
    // a fine trade-off for a casual party game rather than splitting points.
    const podium = [500, 300, 100];
    const results = [];
    for (const [token, payload] of allAnswerEntries(room)) {
      const guess = payload && typeof payload.guess === "number" ? payload.guess : null;
      let points = 0;
      if (guess !== null) {
        const rank = withGuesses.findIndex((e) => e.token === token);
        if (rank >= 0 && rank < podium.length) points = podium[rank];
      }
      if (points > 0) {
        const p = room.players.get(token);
        if (p) p.score += points;
      }
      results.push({
        token,
        name: nameOf(room, token),
        guess,
        points,
        distance: guess !== null ? Math.abs(guess - actual) : null
      });
    }
    results.sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));
    return { answer: actual, results };
  }

  if (g.gameType === "anagram") {
    const results = [];
    for (const [token, payload] of allAnswerEntries(room)) {
      const guess = asString(payload && payload.text).trim().toUpperCase();
      const correct = guess === g.prompt.word;
      if (correct) {
        const p = room.players.get(token);
        if (p) p.score += 500;
      }
      results.push({ token, name: nameOf(room, token), text: payload && payload.text, correct });
    }
    return { answer: g.prompt.word, results };
  }

  if (g.gameType === "oddoneout") {
    const results = [];
    for (const [token, payload] of allAnswerEntries(room)) {
      const correct = payload && payload.choice === g.prompt.oddIndex;
      if (correct) {
        const p = room.players.get(token);
        if (p) p.score += 500;
      }
      results.push({ token, name: nameOf(room, token), choice: payload && payload.choice, correct });
    }
    return { oddIndex: g.prompt.oddIndex, results };
  }

  if (g.gameType === "quickmath") {
    const results = [];
    for (const [token, payload] of allAnswerEntries(room)) {
      const guess = payload && typeof payload.guess === "number" ? payload.guess : null;
      const correct = guess === g.prompt.answer;
      if (correct) {
        const p = room.players.get(token);
        if (p) p.score += speedBonusPoints(g, payload, 300, 200);
      }
      results.push({ token, name: nameOf(room, token), guess, correct });
    }
    return { answer: g.prompt.answer, results };
  }

  if (g.gameType === "neverhaveiever") {
    let haveCount = 0, haventCount = 0;
    for (const payload of g.answers.values()) {
      if (payload && payload.haveDone) haveCount++;
      else haventCount++;
    }
    const minority = haveCount < haventCount ? "have" : haveCount > haventCount ? "havent" : null;
    const results = [];
    for (const [token, payload] of allAnswerEntries(room)) {
      const haveDone = !!(payload && payload.haveDone);
      const inMinority = minority === "have" ? haveDone : minority === "havent" ? !haveDone : false;
      if (inMinority) {
        const p = room.players.get(token);
        if (p) p.score += 300;
      }
      results.push({ token, name: nameOf(room, token), haveDone, inMinority });
    }
    return { haveCount, haventCount, results };
  }

  if (g.gameType === "riddle") {
    const acceptable = g.prompt.answers.map((a) => a.toLowerCase().trim());
    const results = [];
    for (const [token, payload] of allAnswerEntries(room)) {
      const guess = asString(payload && payload.text).toLowerCase().trim();
      const correct = acceptable.includes(guess);
      if (correct) {
        const p = room.players.get(token);
        if (p) p.score += 500;
      }
      results.push({ token, name: nameOf(room, token), text: payload && payload.text, correct });
    }
    return { answer: g.prompt.answers[0], results };
  }

  if (g.gameType === "countdownletters") {
    const pool = g.prompt.letters.toUpperCase();
    const results = [];
    // Scoring itself already correctly rewards every valid word by its own
    // length independently (no single-winner logic below) - this is purely
    // the "fun fact" display of the round's best word(s), but a strict `>`
    // comparison still silently dropped a second word tied for longest,
    // the same "ties are a normal outcome, not a rare edge case" pattern
    // fixed elsewhere this session. Track every unique word tied for the
    // max length instead of just the first one seen.
    let longestWords = [];
    for (const [token, payload] of allAnswerEntries(room)) {
      const word = asString(payload && payload.text).trim().toUpperCase();
      const valid = word.length >= 3 && wordFitsLetters(word, pool);
      let points = 0;
      if (valid) {
        points = word.length * 10 + (word.length === pool.length ? 50 : 0);
        const p = room.players.get(token);
        if (p) p.score += points;
        if (!longestWords.length || word.length > longestWords[0].length) {
          longestWords = [word];
        } else if (word.length === longestWords[0].length && !longestWords.includes(word)) {
          longestWords.push(word);
        }
      }
      results.push({ token, name: nameOf(room, token), text: payload && payload.text, valid, points });
    }
    return { letters: g.prompt.letters, results, longestWords };
  }

  if (g.gameType === "guesstheyear") {
    const actual = g.prompt.year;
    const withGuesses = [...g.answers.entries()]
      .map(([token, payload]) => ({
        token,
        guess: payload && typeof payload.guess === "number" ? payload.guess : null
      }))
      .filter((e) => e.guess !== null)
      .sort((a, b) => Math.abs(a.guess - actual) - Math.abs(b.guess - actual));
    // Same podium scoring as Guess the Crowd - closest guess wins, ties
    // broken by submission order.
    const podium = [500, 300, 100];
    const results = [];
    for (const [token, payload] of allAnswerEntries(room)) {
      const guess = payload && typeof payload.guess === "number" ? payload.guess : null;
      let points = 0;
      if (guess !== null) {
        const rank = withGuesses.findIndex((e) => e.token === token);
        if (rank >= 0 && rank < podium.length) points = podium[rank];
      }
      if (points > 0) {
        const p = room.players.get(token);
        if (p) p.score += points;
      }
      results.push({
        token,
        name: nameOf(room, token),
        guess,
        points,
        distance: guess !== null ? Math.abs(guess - actual) : null
      });
    }
    results.sort((a, b) => (a.distance ?? 9999) - (b.distance ?? 9999));
    return { answer: actual, results };
  }

  if (g.gameType === "truefalse") {
    const results = [];
    for (const [token, payload] of allAnswerEntries(room)) {
      const guess = payload && typeof payload.guess === "boolean" ? payload.guess : null;
      const correct = guess !== null && guess === g.prompt.isTrue;
      if (correct) {
        const p = room.players.get(token);
        if (p) p.score += 400;
      }
      results.push({ token, name: nameOf(room, token), guess, correct });
    }
    return { isTrue: g.prompt.isTrue, results };
  }

  if (g.gameType === "rankit") {
    const correctOrder = g.prompt.correctOrder;
    const results = [];
    for (const [token, payload] of allAnswerEntries(room)) {
      const guessOrder = Array.isArray(payload && payload.order) ? payload.order : null;
      let correctPositions = 0;
      if (guessOrder && guessOrder.length === correctOrder.length) {
        correctOrder.forEach((idx, pos) => { if (guessOrder[pos] === idx) correctPositions++; });
      }
      const perfect = guessOrder ? correctPositions === correctOrder.length : false;
      const points = guessOrder ? correctPositions * 100 + (perfect ? 200 : 0) : 0;
      if (points > 0) {
        const p = room.players.get(token);
        if (p) p.score += points;
      }
      results.push({ token, name: nameOf(room, token), order: guessOrder, correctPositions, perfect, points });
    }
    return { correctOrder, items: g.prompt.items, results };
  }

  return {};
}

function sanitizedPrompt(gameType, prompt, phase) {
  if (!prompt) return prompt;
  if (gameType === "trivia" && phase !== "results") {
    const { correctIndex, ...rest } = prompt;
    return rest;
  }
  if (gameType === "emoji" && phase !== "results") {
    const { answers, ...rest } = prompt;
    return rest;
  }
  if (gameType === "pollguess" && phase !== "results") {
    const { answer, ...rest } = prompt;
    return rest;
  }
  if (gameType === "anagram" && phase !== "results") {
    const { word, ...rest } = prompt;
    return rest;
  }
  if (gameType === "oddoneout" && phase !== "results") {
    const { oddIndex, ...rest } = prompt;
    return rest;
  }
  if (gameType === "quickmath" && phase !== "results") {
    const { answer, ...rest } = prompt;
    return rest;
  }
  if (gameType === "riddle" && phase !== "results") {
    const { answers, ...rest } = prompt;
    return rest;
  }
  if (gameType === "guesstheyear" && phase !== "results") {
    const { year, ...rest } = prompt;
    return rest;
  }
  if (gameType === "truefalse" && phase !== "results") {
    const { isTrue, ...rest } = prompt;
    return rest;
  }
  if (gameType === "rankit" && phase !== "results") {
    const { correctOrder, ...rest } = prompt;
    return rest;
  }
  return prompt;
}

// ---------- Fib or Fact ----------

function startFib(room) {
  resetScores(room);
  const settings = room.settings.fib;
  const prompts = shuffle(fibData).slice(0, Math.max(1, settings.rounds));

  room.currentGame = "fib";
  room.state = "playing";
  room.game = {
    prompts,
    round: 0,
    phase: "answering", // answering | voting | results | finished
    timeLeft: settings.answerTime,
    lies: new Map(), // token -> lie text
    votes: new Map(), // voterToken -> optionId ('truth' or a lie-author's token)
    votingOrder: [], // [{id, text}]
    lastVoteCounts: null
  };
  fibBeginAnsweringTimer(room, null);
}

function fibCurrentPrompt(room) {
  return room.game.prompts[room.game.round];
}

function fibBeginAnsweringTimer(room, io) {
  const g = room.game;
  clearTimer(room);
  if (io) {
    room.timer = setInterval(() => {
      g.timeLeft -= 1;
      if (g.timeLeft <= 0) {
        fibGoToVoting(room);
        fibBeginVotingTimer(room, io);
      }
      broadcastRoom(io, room);
    }, 1000);
  }
}

function fibBeginVotingTimer(room, io) {
  const g = room.game;
  clearTimer(room);
  if (io) {
    room.timer = setInterval(() => {
      g.timeLeft -= 1;
      if (g.timeLeft <= 0) {
        fibGoToResults(room);
      }
      broadcastRoom(io, room);
    }, 1000);
  }
}

function fibSubmitLie(room, token, text) {
  const g = room.game;
  if (!g || g.phase !== "answering") return;
  text = truncateText(asString(text).trim(), 100);
  if (!text) return;
  g.lies.set(token, text);
}

function fibAllAnswered(room) {
  const g = room.game;
  if (!g) return false;
  const connected = [...room.players.values()].filter((p) => p.connected);
  return connected.every((p) => g.lies.has(p.token));
}

function fibGoToVoting(room) {
  clearTimer(room);
  const g = room.game;
  g.phase = "voting";
  g.timeLeft = room.settings.fib.voteTime;
  const options = [{ id: "truth", text: fibCurrentPrompt(room).answer }];
  for (const [token, text] of g.lies.entries()) {
    options.push({ id: token, text });
  }
  g.votingOrder = shuffle(options);
}

function fibSubmitVote(room, voterToken, optionId) {
  const g = room.game;
  if (!g || g.phase !== "voting") return;
  if (optionId === voterToken) return; // can't vote for your own lie
  const valid = g.votingOrder.some((o) => o.id === optionId);
  if (!valid) return;
  g.votes.set(voterToken, optionId);
}

function fibAllVoted(room) {
  const g = room.game;
  if (!g) return false;
  const connected = [...room.players.values()].filter((p) => p.connected);
  return connected.every((p) => g.votes.has(p.token));
}

function fibGoToResults(room) {
  clearTimer(room);
  const g = room.game;
  g.phase = "results";

  const voteCounts = new Map();
  for (const choice of g.votes.values()) {
    voteCounts.set(choice, (voteCounts.get(choice) || 0) + 1);
  }
  for (const [voterToken, choice] of g.votes.entries()) {
    if (choice === "truth") {
      const p = room.players.get(voterToken);
      if (p) p.score += 1000;
    }
  }
  for (const token of g.lies.keys()) {
    const count = voteCounts.get(token) || 0;
    if (count > 0) {
      const p = room.players.get(token);
      if (p) p.score += count * 500;
    }
  }
  g.lastVoteCounts = voteCounts;
}

function fibNextRound(room) {
  const g = room.game;
  // See headsUpNextTurn for why this phase guard matters - without it, a
  // double-fired "next round" click silently skips an entire round.
  if (!g || g.phase !== "results") return;
  g.round += 1;
  if (g.round >= g.prompts.length) {
    g.phase = "finished";
    room.state = "finished";
    clearTimer(room);
    return;
  }
  g.phase = "answering";
  g.timeLeft = room.settings.fib.answerTime;
  g.lies = new Map();
  g.votes = new Map();
  g.votingOrder = [];
  g.lastVoteCounts = null;
}

// ---------- Trivia Survival ----------
// Trivia Murder Party-inspired: everyone answers simultaneously, a wrong
// or missing answer costs a life, and the last one standing gets a bonus.

function startTriviaSurvival(room) {
  resetScores(room);
  const settings = room.settings.triviasurvival;
  const order = [...room.players.keys()];

  room.currentGame = "triviasurvival";
  room.state = "playing";
  room.game = {
    round: 0,
    maxRounds: Math.max(1, settings.maxRounds),
    phase: "answering", // answering | results | finished
    timeLeft: settings.answerTime,
    answerTimeSecs: settings.answerTime,
    // Same repeat-prevention as the generic round-game engine (see
    // pickUnusedFrom) - this used its own separate randomFrom(triviaData)
    // call, so fixing that one didn't cover this one too.
    usedPromptIndices: new Set(),
    prompt: null,
    answers: new Map(), // token -> choiceIndex
    lives: new Map(order.map((t) => [t, settings.startingLives])),
    resultsData: null
  };
  room.game.prompt = pickUnusedFrom(triviaData, room.game.usedPromptIndices);
}

function triviaSurvivalAlivePlayers(room) {
  const g = room.game;
  return [...room.players.keys()].filter((t) => (g.lives.get(t) || 0) > 0);
}

function triviaSurvivalStartTimer(room, io) {
  startPhaseTimer(room, io, room.game.timeLeft, () => triviaSurvivalGoToResults(room));
}

function triviaSurvivalSubmitAnswer(room, token, choice) {
  const g = room.game;
  if (!g || g.phase !== "answering") return;
  if ((g.lives.get(token) || 0) <= 0) return; // eliminated players can't answer
  g.answers.set(token, choice);
}

function triviaSurvivalAllAnswered(room) {
  const g = room.game;
  if (!g) return false;
  const aliveConnected = [...room.players.values()].filter(
    (p) => p.connected && (g.lives.get(p.token) || 0) > 0
  );
  return aliveConnected.every((p) => g.answers.has(p.token));
}

function triviaSurvivalGoToResults(room) {
  clearTimer(room);
  const g = room.game;
  g.phase = "results";

  const correctIndex = g.prompt.correctIndex;
  const results = [];
  const eliminatedThisRound = [];
  for (const token of [...room.players.keys()]) {
    if ((g.lives.get(token) || 0) <= 0) continue; // already eliminated earlier
    const choice = g.answers.has(token) ? g.answers.get(token) : null;
    const correct = choice === correctIndex;
    if (correct) {
      const p = room.players.get(token);
      if (p) p.score += 500;
    } else {
      g.lives.set(token, Math.max(0, (g.lives.get(token) || 0) - 1));
      if (g.lives.get(token) === 0) eliminatedThisRound.push(nameOf(room, token));
    }
    results.push({ token, name: nameOf(room, token), choice, correct });
  }

  const alive = triviaSurvivalAlivePlayers(room);
  g.resultsData = { correctIndex, results, eliminatedThisRound, aliveCount: alive.length };

  if (alive.length <= 1 || g.round + 1 >= g.maxRounds) {
    if (alive.length === 1) {
      const p = room.players.get(alive[0]);
      if (p) p.score += 1000;
    }
    g.phase = "finished";
    room.state = "finished";
    clearTimer(room);
  }
}

function triviaSurvivalNextRound(room) {
  const g = room.game;
  // See headsUpNextTurn for why this phase guard matters - the previous
  // `!== "finished"` check only stopped re-advancing after the game had
  // already ended, not a double-fire while still mid-"answering", which
  // would silently skip an entire round the same way.
  if (!g || g.phase !== "results") return;
  g.round += 1;
  g.phase = "answering";
  g.timeLeft = g.answerTimeSecs;
  g.prompt = pickUnusedFrom(triviaData, g.usedPromptIndices);
  g.answers = new Map();
  g.resultsData = null;
}

// ---------- Doodle Guess ----------
// Drawful-inspired: one player draws a secret word each turn while
// everyone else watches live and races to guess it.

function startDoodle(room) {
  resetScores(room);
  const settings = room.settings.doodle;
  const order = shuffle([...room.players.keys()]);
  const turns = [];
  for (let r = 0; r < settings.roundsPerPlayer; r++) {
    for (const token of order) turns.push(token);
  }

  room.currentGame = "doodle";
  room.state = "playing";
  room.game = {
    turns,
    turnIndex: 0,
    artistToken: turns[0],
    // Same repeat-prevention as the round-game engine - with up to 24
    // players (or roundsPerPlayer > 1 multiplying total turns further)
    // drawing from a 30-word pool, a blind pick per turn was quite likely
    // to repeat a word within one game. Set has to exist before the word
    // is picked below, so word is assigned after this object exists.
    usedWordIndices: new Set(),
    word: null,
    strokes: [], // [{points:[{x,y},...]}] - x/y normalized 0..1
    guesses: new Map(), // token -> {text, correct}
    phase: "drawing", // drawing | summary | finished
    timeLeft: settings.drawSeconds,
    drawSeconds: settings.drawSeconds
  };
  room.game.word = pickUnusedFrom(doodleData, room.game.usedWordIndices);
}

// Found auditing this function against drawit's equivalent (drawItSubmit,
// below) - that one caps a submission at 60 strokes, but this streaming
// version (one doodle:stroke call per completed pointer gesture, unlike
// drawit's single final batch) never capped how many strokes could
// accumulate in g.strokes over one turn. Each individual stroke is capped
// to 300 points, but nothing stopped a scripted client from calling this
// repeatedly for the entire draw duration - the generic per-socket rate
// limiter in server.js (30/sec) bounds the *rate*, not the cumulative
// total, so a sustained script could still push thousands of strokes
// before the timer runs out. That matters more than a one-off oversized
// message would: g.strokes is broadcast in full on every room-update, so
// each additional stroke doesn't just cost once, it makes every
// subsequent broadcast for the rest of the turn bigger too. 500 is
// comfortably above anything a real person could produce (even drawing
// very quickly with many small pen-lifts) while bounding the worst case.
function doodleAddStroke(room, token, points) {
  const g = room.game;
  if (!g || g.phase !== "drawing") return false;
  if (token !== g.artistToken) return false;
  if (!Array.isArray(points) || !points.length) return false;
  if (g.strokes.length >= 500) return false;
  const clean = points.slice(0, 300).map((p) => ({
    x: clamp(p && p.x, 0, 1, 0),
    y: clamp(p && p.y, 0, 1, 0)
  }));
  g.strokes.push({ points: clean });
  return true;
}

function doodleClear(room, token) {
  const g = room.game;
  if (!g || g.phase !== "drawing") return false;
  if (token !== g.artistToken) return false;
  g.strokes = [];
  return true;
}

function doodleSubmitGuess(room, token, text) {
  const g = room.game;
  if (!g || g.phase !== "drawing") return;
  if (token === g.artistToken) return;
  const existing = g.guesses.get(token);
  if (existing && existing.correct) return; // already got it
  const guess = truncateText(asString(text).trim(), 40);
  if (!guess) return;
  const correct = guess.toLowerCase() === g.word.toLowerCase();
  g.guesses.set(token, { text: guess, correct });
  if (correct) {
    const p = room.players.get(token);
    if (p) p.score += 500;
    const artist = room.players.get(g.artistToken);
    if (artist) artist.score += 100;
  }
}

function doodleAllGuessed(room) {
  const g = room.game;
  if (!g) return false;
  const connectedGuessers = [...room.players.values()].filter(
    (p) => p.connected && p.token !== g.artistToken
  );
  if (!connectedGuessers.length) return false;
  return connectedGuessers.every((p) => {
    const guess = g.guesses.get(p.token);
    return guess && guess.correct;
  });
}

function doodleEndTurn(room) {
  clearTimer(room);
  const g = room.game;
  g.phase = "summary";
}

function doodleBeginTimer(room, io) {
  clearTimer(room);
  const g = room.game;
  if (!io) return;
  room.timer = setInterval(() => {
    g.timeLeft -= 1;
    if (g.timeLeft <= 0) {
      doodleEndTurn(room);
    }
    broadcastRoom(io, room);
  }, 1000);
}

function doodleNextTurn(room) {
  const g = room.game;
  // See headsUpNextTurn for why this phase guard matters - without it, a
  // double-fired "next turn" click silently skips an entire extra turn.
  if (!g || g.phase !== "summary") return;
  g.turnIndex += 1;
  if (g.turnIndex >= g.turns.length) {
    g.phase = "finished";
    room.state = "finished";
    clearTimer(room);
    return;
  }
  g.artistToken = g.turns[g.turnIndex];
  g.word = pickUnusedFrom(doodleData, g.usedWordIndices);
  g.strokes = [];
  g.guesses = new Map();
  g.phase = "drawing";
  g.timeLeft = g.drawSeconds;
}

// ---------- Two Truths and a Lie ----------
// Everyone privately writes 2 truths + 1 lie about themselves, then each
// player takes a turn in the spotlight while everyone else guesses which
// of their three statements is the lie.

function startTwoTruths(room) {
  resetScores(room);
  const settings = room.settings.twotruths;
  room.currentGame = "twotruths";
  room.state = "playing";
  room.game = {
    kind: "twotruths",
    phase: "writing", // writing | guessing | reveal | finished
    timeLeft: settings.writeSeconds,
    writeSeconds: settings.writeSeconds,
    guessSeconds: settings.guessSeconds,
    statements: new Map(), // token -> { texts: [s0,s1,s2], lieIndex }
    order: [], // spotlight order, built once writing ends
    spotlightIndex: -1,
    guesses: new Map(), // voterToken -> guessedIndex, reset per spotlight
    lastReveal: null
  };
}

function twoTruthsBeginWritingTimer(room, io) {
  const g = room.game;
  clearTimer(room);
  if (!io) return;
  room.timer = setInterval(() => {
    g.timeLeft -= 1;
    if (g.timeLeft <= 0) {
      twoTruthsGoToGuessing(room);
      if (g.phase === "guessing") twoTruthsBeginGuessingTimer(room, io);
    }
    broadcastRoom(io, room);
  }, 1000);
}

function twoTruthsSubmitStatements(room, token, texts, lieIndex) {
  const g = room.game;
  if (!g || g.phase !== "writing") return;
  if (!Array.isArray(texts) || texts.length !== 3) return;
  const clean = texts.map((t) => truncateText(asString(t).trim(), 80));
  if (clean.some((t) => !t)) return;
  const li = Number(lieIndex);
  if (![0, 1, 2].includes(li)) return;
  g.statements.set(token, { texts: clean, lieIndex: li });
}

function twoTruthsAllWritten(room) {
  const g = room.game;
  if (!g) return false;
  const connected = [...room.players.values()].filter((p) => p.connected);
  return connected.every((p) => g.statements.has(p.token));
}

function twoTruthsGoToGuessing(room) {
  clearTimer(room);
  const g = room.game;
  g.order = [...g.statements.keys()];
  if (!g.order.length) {
    g.phase = "finished";
    room.state = "finished";
    return;
  }
  g.spotlightIndex = 0;
  g.phase = "guessing";
  g.timeLeft = g.guessSeconds;
  g.guesses = new Map();
}

function twoTruthsBeginGuessingTimer(room, io) {
  const g = room.game;
  clearTimer(room);
  if (!io) return;
  room.timer = setInterval(() => {
    g.timeLeft -= 1;
    if (g.timeLeft <= 0) {
      twoTruthsGoToReveal(room);
    }
    broadcastRoom(io, room);
  }, 1000);
}

function twoTruthsCurrentSpotlight(room) {
  return room.game.order[room.game.spotlightIndex];
}

function twoTruthsSubmitGuess(room, voterToken, guessIndex) {
  const g = room.game;
  if (!g || g.phase !== "guessing") return;
  const spotlight = twoTruthsCurrentSpotlight(room);
  if (voterToken === spotlight) return; // can't guess your own statements
  const gi = Number(guessIndex);
  if (![0, 1, 2].includes(gi)) return;
  g.guesses.set(voterToken, gi);
}

function twoTruthsAllGuessed(room) {
  const g = room.game;
  if (!g) return false;
  const spotlight = twoTruthsCurrentSpotlight(room);
  const connected = [...room.players.values()].filter(
    (p) => p.connected && p.token !== spotlight
  );
  if (!connected.length) return true;
  return connected.every((p) => g.guesses.has(p.token));
}

function twoTruthsGoToReveal(room) {
  clearTimer(room);
  const g = room.game;
  g.phase = "reveal";
  const spotlight = twoTruthsCurrentSpotlight(room);
  const entry = g.statements.get(spotlight);
  const lieIndex = entry.lieIndex;

  // Same "vanishes from results" gap as the round-game engine (see
  // allAnswerEntries) - `g.guesses` only has an entry for players who
  // actually guessed, so a still-present player who ran out the clock
  // without guessing was simply missing from `guessResults`, not shown as
  // "didn't guess." Fixed by iterating every player instead - but unlike
  // the round-game fix, this can't just widen the same loop as-is: `fooled`
  // (which also sets the spotlight player's own score, `fooled * 100`
  // below) and each guesser's 200-point award both need to stay scoped to
  // people who *actually* guessed wrong, not everyone who simply didn't
  // guess - so the "did they guess at all" check has to gate scoring
  // separately from just building the display row. The spotlight player
  // themselves is excluded - they never guess their own lie.
  let fooled = 0;
  const guessResults = [];
  for (const token of [...room.players.keys()]) {
    if (token === spotlight) continue;
    const guessed = g.guesses.has(token);
    const guess = guessed ? g.guesses.get(token) : null;
    const correct = guessed && guess === lieIndex;
    if (guessed) {
      if (correct) {
        const p = room.players.get(token);
        if (p) p.score += 200;
      } else {
        fooled += 1;
      }
    }
    guessResults.push({ token, name: nameOf(room, token), guess, guessed, correct });
  }
  const spotlightPlayer = room.players.get(spotlight);
  if (spotlightPlayer) spotlightPlayer.score += fooled * 100;

  g.lastReveal = {
    spotlight,
    spotlightName: nameOf(room, spotlight),
    lieIndex,
    texts: entry.texts,
    guessResults,
    fooled
  };
}

function twoTruthsNextSpotlight(room) {
  const g = room.game;
  // See headsUpNextTurn for why this phase guard matters - without it, a
  // double-fired "next" click silently skips an entire spotlight.
  if (!g || g.phase !== "reveal") return;
  g.spotlightIndex += 1;
  if (g.spotlightIndex >= g.order.length) {
    g.phase = "finished";
    room.state = "finished";
    clearTimer(room);
    return;
  }
  g.phase = "guessing";
  g.timeLeft = g.guessSeconds;
  g.guesses = new Map();
  g.lastReveal = null;
}

// ---------- Draw It! ----------
// Everyone draws the same secret word at once on their own canvas (unlike
// Doodle Guess's one-artist-at-a-time), then the room votes for their
// favorite drawing.

function startDrawIt(room) {
  resetScores(room);
  const settings = room.settings.drawit;
  room.currentGame = "drawit";
  room.state = "playing";
  room.game = {
    kind: "drawit",
    round: 0,
    totalRounds: Math.max(1, settings.rounds),
    phase: "drawing", // drawing | voting | results | finished
    timeLeft: settings.drawSeconds,
    drawSeconds: settings.drawSeconds,
    voteSeconds: settings.voteSeconds,
    // Own independent repeat-tracking (Draw It has its own room.game
    // session, separate from Doodle Guess, even though they share the same
    // doodleData word pool) - set before word is picked below.
    usedWordIndices: new Set(),
    word: null,
    drawings: new Map(), // token -> [{points:[{x,y}...]}]
    submitted: new Set(),
    votes: new Map(), // voterToken -> authorToken
    votingOrder: [],
    lastVoteCounts: null
  };
  room.game.word = pickUnusedFrom(doodleData, room.game.usedWordIndices);
}

function drawItBeginDrawingTimer(room, io) {
  const g = room.game;
  clearTimer(room);
  if (!io) return;
  room.timer = setInterval(() => {
    g.timeLeft -= 1;
    if (g.timeLeft <= 0) {
      drawItGoToVoting(room);
      drawItBeginVotingTimer(room, io);
    }
    broadcastRoom(io, room);
  }, 1000);
}

function drawItSubmit(room, token, strokes) {
  const g = room.game;
  if (!g || g.phase !== "drawing") return;
  if (Array.isArray(strokes)) {
    const clean = strokes.slice(0, 60).map((s) => ({
      points: ((s && s.points) || []).slice(0, 300).map((p) => ({
        x: clamp(p && p.x, 0, 1, 0),
        y: clamp(p && p.y, 0, 1, 0)
      }))
    }));
    g.drawings.set(token, clean);
  }
  g.submitted.add(token);
}

function drawItAllSubmitted(room) {
  const g = room.game;
  if (!g) return false;
  const connected = [...room.players.values()].filter((p) => p.connected);
  return connected.every((p) => g.submitted.has(p.token));
}

function drawItGoToVoting(room) {
  clearTimer(room);
  const g = room.game;
  g.phase = "voting";
  g.timeLeft = g.voteSeconds;
  const connected = [...room.players.values()].filter((p) => p.connected).map((p) => p.token);
  g.votingOrder = shuffle(connected);
}

function drawItBeginVotingTimer(room, io) {
  const g = room.game;
  clearTimer(room);
  if (!io) return;
  room.timer = setInterval(() => {
    g.timeLeft -= 1;
    if (g.timeLeft <= 0) {
      drawItGoToResults(room);
    }
    broadcastRoom(io, room);
  }, 1000);
}

function drawItSubmitVote(room, voterToken, authorToken) {
  const g = room.game;
  if (!g || g.phase !== "voting") return;
  if (authorToken === voterToken) return;
  if (!g.votingOrder.includes(authorToken)) return;
  g.votes.set(voterToken, authorToken);
}

function drawItAllVoted(room) {
  const g = room.game;
  if (!g) return false;
  const connected = [...room.players.values()].filter((p) => p.connected);
  return connected.every((p) => g.votes.has(p.token));
}

function drawItGoToResults(room) {
  clearTimer(room);
  const g = room.game;
  g.phase = "results";
  const voteCounts = new Map();
  for (const author of g.votes.values()) {
    voteCounts.set(author, (voteCounts.get(author) || 0) + 1);
  }
  for (const [token, count] of voteCounts.entries()) {
    const p = room.players.get(token);
    if (p) p.score += count * 400;
  }
  g.lastVoteCounts = voteCounts;
}

function drawItNextRound(room) {
  const g = room.game;
  // See headsUpNextTurn for why this phase guard matters - without it, a
  // double-fired "next round" click silently skips an entire round.
  if (!g || g.phase !== "results") return;
  g.round += 1;
  if (g.round >= g.totalRounds) {
    g.phase = "finished";
    room.state = "finished";
    clearTimer(room);
    return;
  }
  g.phase = "drawing";
  g.timeLeft = g.drawSeconds;
  g.word = pickUnusedFrom(doodleData, g.usedWordIndices);
  g.drawings = new Map();
  g.submitted = new Set();
  g.votes = new Map();
  g.votingOrder = [];
  g.lastVoteCounts = null;
}

// ---------- Serialization ----------

function playerList(room) {
  return [...room.players.values()]
    .sort((a, b) => b.score - a.score)
    .map((p) => ({
      token: p.token,
      name: p.name,
      score: p.score,
      connected: p.connected,
      isHost: p.token === room.hostToken
    }));
}

function serializeFor(room, viewerToken) {
  const base = {
    code: room.code,
    state: room.state,
    currentGame: room.currentGame,
    settings: room.settings,
    players: playerList(room),
    isHost: viewerToken === room.hostToken,
    youToken: viewerToken,
    hasPassword: !!room.password,
    streamerMode: room.streamerMode
  };

  if (room.currentGame === "headsup" && room.game) {
    const g = room.game;
    const performer = room.players.get(g.performerToken);
    const isPerformer = viewerToken === g.performerToken;
    base.headsUp = {
      phase: g.phase,
      performerName: performer ? performer.name : "?",
      isPerformer,
      timeLeft: g.timeLeft,
      word: g.phase === "active" && !isPerformer ? g.word : null,
      correctCount: g.correctWords.length,
      correctWords: g.phase === "summary" ? g.correctWords : [],
      passedWords: g.phase === "summary" ? g.passedWords : [],
      turnNumber: g.turnIndex + 1,
      totalTurns: g.turns.length
    };
  }

  if (room.currentGame === "promptbattle" && room.game) {
    const g = room.game;
    const you = viewerToken;
    base.promptBattle = {
      phase: g.phase,
      round: g.round + 1,
      totalRounds: g.prompts.length,
      prompt: promptBattleCurrentPrompt(room),
      timeLeft: g.timeLeft,
      hasAnswered: g.answers.has(you),
      answeredCount: g.answers.size,
      totalPlayers: [...room.players.values()].filter((p) => p.connected)
        .length,
      hasVoted: g.votes.has(you)
    };

    if (g.phase === "voting" || g.phase === "results") {
      base.promptBattle.answers = (g.votingOrder || []).map((token) => ({
        token,
        text: g.answers.get(token),
        isYours: token === you,
        votes:
          g.phase === "results"
            ? g.lastVoteCounts && g.lastVoteCounts.get(token)
              ? g.lastVoteCounts.get(token)
              : 0
            : undefined,
        authorName:
          g.phase === "results"
            ? (room.players.get(token) || {}).name
            : undefined
      }));
    }
  }

  if (room.currentGame === "wordbomb" && room.game) {
    const g = room.game;
    base.wordBomb = {
      fragment: g.fragment,
      timeLeft: g.timeLeft,
      currentToken: g.phase === "active" ? wordBombCurrentToken(room) : null,
      isYourTurn: g.phase === "active" && wordBombCurrentToken(room) === viewerToken,
      lives: Object.fromEntries(g.order.map((t) => [t, g.lives.get(t)])),
      lastResult: g.lastResult
        ? { ...g.lastResult, name: nameOf(room, g.lastResult.token) }
        : null
    };
  }

  if (room.currentGame && ROUND_GAME_TYPES.includes(room.currentGame) && room.game && room.game.kind === "roundgame") {
    const g = room.game;
    base.roundGame = {
      gameType: g.gameType,
      round: g.round + 1,
      totalRounds: g.totalRounds,
      phase: g.phase,
      timeLeft: g.timeLeft,
      prompt: sanitizedPrompt(g.gameType, g.prompt, g.phase),
      hasAnswered: g.answers.has(viewerToken),
      answeredCount: g.answers.size,
      totalPlayers: [...room.players.values()].filter((p) => p.connected).length,
      resultsData: g.phase === "results" ? g.resultsData : null
    };
  }

  if (room.currentGame === "fib" && room.game) {
    const g = room.game;
    const you = viewerToken;
    base.fib = {
      phase: g.phase,
      round: Math.min(g.round + 1, g.prompts.length),
      totalRounds: g.prompts.length,
      // g.round can run one past the last prompt right as the game ends.
      prompt: g.phase !== "finished" ? fibCurrentPrompt(room).prompt : null,
      timeLeft: g.timeLeft,
      hasAnswered: g.lies.has(you),
      answeredCount: g.lies.size,
      totalPlayers: [...room.players.values()].filter((p) => p.connected).length,
      hasVoted: g.votes.has(you)
    };
    if (g.phase === "voting" || g.phase === "results") {
      base.fib.options = (g.votingOrder || []).map((o) => ({
        id: o.id,
        text: o.text,
        isYours: o.id === you,
        votes: g.phase === "results" ? (g.lastVoteCounts && g.lastVoteCounts.get(o.id)) || 0 : undefined,
        isTruth: g.phase === "results" ? o.id === "truth" : undefined,
        authorName: g.phase === "results" && o.id !== "truth" ? nameOf(room, o.id) : undefined
      }));
    }
  }

  if (room.currentGame === "triviasurvival" && room.game) {
    const g = room.game;
    base.triviaSurvival = {
      phase: g.phase,
      round: g.round + 1,
      maxRounds: g.maxRounds,
      timeLeft: g.timeLeft,
      prompt: g.phase === "results" ? g.prompt : { question: g.prompt.question, options: g.prompt.options },
      hasAnswered: g.answers.has(viewerToken),
      isEliminated: (g.lives.get(viewerToken) || 0) <= 0,
      lives: Object.fromEntries([...room.players.keys()].map((t) => [t, g.lives.get(t) || 0])),
      resultsData: g.phase === "results" ? g.resultsData : null
    };
  }

  if (room.currentGame === "doodle" && room.game) {
    const g = room.game;
    const isArtist = viewerToken === g.artistToken;
    base.doodle = {
      phase: g.phase,
      turnNumber: g.turnIndex + 1,
      totalTurns: g.turns.length,
      artistName: nameOf(room, g.artistToken),
      isArtist,
      timeLeft: g.timeLeft,
      word: isArtist || g.phase === "summary" ? g.word : null,
      strokes: g.strokes,
      hasGuessedCorrectly: !!(g.guesses.get(viewerToken) && g.guesses.get(viewerToken).correct),
      correctGuessCount: [...g.guesses.values()].filter((x) => x.correct).length,
      guesses: g.phase === "summary"
        ? [...g.guesses.entries()].map(([token, gu]) => ({ token, name: nameOf(room, token), text: gu.text, correct: gu.correct }))
        : []
    };
  }

  if (room.currentGame === "twotruths" && room.game) {
    const g = room.game;
    const you = viewerToken;
    base.twoTruths = {
      phase: g.phase,
      timeLeft: g.timeLeft,
      hasWritten: g.statements.has(you),
      writtenCount: g.statements.size,
      totalPlayers: [...room.players.values()].filter((p) => p.connected).length
    };
    if (g.phase === "guessing" || g.phase === "reveal") {
      const spotlight = twoTruthsCurrentSpotlight(room);
      const entry = g.statements.get(spotlight);
      base.twoTruths.spotlightName = nameOf(room, spotlight);
      base.twoTruths.isSpotlight = spotlight === you;
      base.twoTruths.texts = entry ? entry.texts : [];
      base.twoTruths.hasGuessed = g.guesses.has(you);
      base.twoTruths.spotlightNumber = g.spotlightIndex + 1;
      base.twoTruths.totalSpotlights = g.order.length;
    }
    if (g.phase === "reveal") {
      base.twoTruths.reveal = g.lastReveal;
    }
  }

  if (room.currentGame === "drawit" && room.game) {
    const g = room.game;
    const you = viewerToken;
    base.drawIt = {
      phase: g.phase,
      round: g.round + 1,
      totalRounds: g.totalRounds,
      timeLeft: g.timeLeft,
      word: g.word,
      hasSubmitted: g.submitted.has(you),
      submittedCount: g.submitted.size,
      totalPlayers: [...room.players.values()].filter((p) => p.connected).length,
      hasVoted: g.votes.has(you)
    };
    if (g.phase === "voting" || g.phase === "results") {
      base.drawIt.gallery = (g.votingOrder || []).map((token) => ({
        token,
        strokes: g.drawings.get(token) || [],
        isYours: token === you,
        votes: g.phase === "results" ? (g.lastVoteCounts && g.lastVoteCounts.get(token)) || 0 : undefined,
        authorName: g.phase === "results" ? nameOf(room, token) : undefined
      }));
    }
  }

  return base;
}

function broadcastRoom(io, room) {
  for (const player of room.players.values()) {
    if (player.socketId) {
      io.to(player.socketId).emit(
        "room-update",
        serializeFor(room, player.token)
      );
    }
  }
}

module.exports = {
  rooms,
  GAME_IDS,
  ROUND_GAME_TYPES,
  createRoom,
  getRoom,
  getCatalog,
  applySettings,
  applyRoomSettings,
  checkRoomPassword,
  sanitizeName,
  addPlayer,
  removeEmptyRoomIfNeeded,
  sweepEmptyRooms,
  reassignHostIfMissing,
  clearTimer,
  broadcastRoom,
  serializeFor,
  startHeadsUp,
  headsUpStartTurn,
  headsUpEndTurn,
  headsUpAnswer,
  headsUpNextTurn,
  startPromptBattle,
  promptBattleBeginAnsweringTimer,
  promptBattleBeginVotingTimer,
  promptBattleSubmitAnswer,
  promptBattleAllAnswered,
  promptBattleGoToVoting,
  promptBattleSubmitVote,
  promptBattleAllVoted,
  promptBattleGoToResults,
  promptBattleNextRound,
  startWordBomb,
  wordBombSubmit,
  wordBombBeginTimer,
  wordBombCurrentToken,
  wordBombFailTurn,
  wordBombFinishIfOneRemains,
  startRoundGame,
  startRoundGameTimer,
  roundGameSubmitAnswer,
  roundGameAllAnswered,
  roundGameGoToResults,
  roundGameNextRound,
  startFib,
  fibBeginAnsweringTimer,
  fibBeginVotingTimer,
  fibSubmitLie,
  fibAllAnswered,
  fibGoToVoting,
  fibSubmitVote,
  fibAllVoted,
  fibGoToResults,
  fibNextRound,
  startTriviaSurvival,
  triviaSurvivalStartTimer,
  triviaSurvivalSubmitAnswer,
  triviaSurvivalAllAnswered,
  triviaSurvivalGoToResults,
  triviaSurvivalNextRound,
  startDoodle,
  doodleAddStroke,
  doodleClear,
  doodleSubmitGuess,
  doodleAllGuessed,
  doodleEndTurn,
  doodleBeginTimer,
  doodleNextTurn,
  startTwoTruths,
  twoTruthsBeginWritingTimer,
  twoTruthsSubmitStatements,
  twoTruthsAllWritten,
  twoTruthsGoToGuessing,
  twoTruthsBeginGuessingTimer,
  twoTruthsSubmitGuess,
  twoTruthsAllGuessed,
  twoTruthsGoToReveal,
  twoTruthsNextSpotlight,
  startDrawIt,
  drawItBeginDrawingTimer,
  drawItSubmit,
  drawItAllSubmitted,
  drawItGoToVoting,
  drawItBeginVotingTimer,
  drawItSubmitVote,
  drawItAllVoted,
  drawItGoToResults,
  drawItNextRound
};
