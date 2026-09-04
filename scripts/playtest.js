// Automated end-to-end playtest: drives full games (host actions + player
// actions) over real socket connections, no browser/manual clicking involved.
// Run with the server already up: node scripts/playtest.js
//
// Exits 0 and prints a summary on success, exits 1 and prints what broke
// on failure (a hang, a server error, or a sanity-check violation).

const { io } = require("socket.io-client");

const url = process.argv[2] || process.env.PARTY_GAMES_URL || "http://localhost:3000";
const ROUND_GAME_TYPES = [
  "trivia", "wouldyourather", "mostlikelyto", "emoji", "category", "pollguess",
  "anagram", "oddoneout", "quickmath",
  "neverhaveiever", "riddle", "countdownletters",
  "guesstheyear", "truefalse", "rankit"
];
const ISSUES = [];

function log(...args) {
  console.log(...args);
}

function fail(msg) {
  ISSUES.push(msg);
  console.error("ISSUE:", msg);
}

function connect() {
  return new Promise((resolve, reject) => {
    const s = io(url, { reconnection: false, timeout: 5000 });
    s.on("connect", () => resolve(s));
    s.on("connect_error", (e) => reject(e));
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timed out`)), 5000);
    socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

function waitFor(getter, { timeoutMs = 20000, intervalMs = 150, desc = "condition" } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = getter();
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for: ${desc}`));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

const SILLY_ANSWERS = [
  "A haunted vending machine", "Three raccoons in a trenchcoat",
  "My uncle's conspiracy podcast", "An extremely judgmental houseplant",
  "The sound a printer makes at 2am", "A minivan full of clowns"
];
function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

class Client {
  constructor(socket, name) {
    this.socket = socket;
    this.name = name;
    this.state = null;
    this.actedKey = null;
    this.errors = [];
    socket.on("room-update", (d) => { this.state = d; });
    socket.on("error", (e) => this.errors.push(String(e)));
  }

  // Plays whatever action the current room state calls for - both the
  // "am I the performer / do I need to answer or vote" player logic and,
  // if this client currently holds host, the "advance the game" logic.
  tick() {
    const r = this.state;
    if (!r) return;

    if (r.isHost) {
      if (r.state === "lobby" && r.currentGame && r.players.length >= 2 && this.actedKey !== `start:${r.currentGame}`) {
        this.actedKey = `start:${r.currentGame}`;
        this.socket.emit("start-game");
      }
      if (r.currentGame === "headsup" && r.headsUp && r.headsUp.phase === "summary") {
        const key = `next-turn:${r.headsUp.turnNumber}`;
        if (this.actedKey !== key) { this.actedKey = key; this.socket.emit("headsup:next-turn"); }
      }
      if (r.currentGame === "promptbattle" && r.promptBattle && r.promptBattle.phase === "results") {
        const key = `next-round:${r.promptBattle.round}`;
        if (this.actedKey !== key) { this.actedKey = key; this.socket.emit("promptbattle:next-round"); }
      }
      if (ROUND_GAME_TYPES.includes(r.currentGame) && r.roundGame && r.roundGame.phase === "results") {
        const key = `rg-next:${r.roundGame.round}`;
        if (this.actedKey !== key) { this.actedKey = key; this.socket.emit("roundgame:next-round"); }
      }
      if (r.currentGame === "fib" && r.fib && r.fib.phase === "results") {
        const key = `fib-next:${r.fib.round}`;
        if (this.actedKey !== key) { this.actedKey = key; this.socket.emit("fib:next-round"); }
      }
      if (r.currentGame === "triviasurvival" && r.triviaSurvival && r.triviaSurvival.phase === "results" && r.state !== "finished") {
        const key = `tsurv-next:${r.triviaSurvival.round}`;
        if (this.actedKey !== key) { this.actedKey = key; this.socket.emit("triviasurvival:next-round"); }
      }
      if (r.currentGame === "doodle" && r.doodle && r.doodle.phase === "summary") {
        const key = `doodle-next:${r.doodle.turnNumber}`;
        if (this.actedKey !== key) { this.actedKey = key; this.socket.emit("doodle:next-turn"); }
      }
      if (r.currentGame === "twotruths" && r.twoTruths && r.twoTruths.phase === "reveal") {
        const key = `tt-next:${r.twoTruths.spotlightNumber}`;
        if (this.actedKey !== key) { this.actedKey = key; this.socket.emit("twotruths:next"); }
      }
      if (r.currentGame === "drawit" && r.drawIt && r.drawIt.phase === "results") {
        const key = `drawit-next:${r.drawIt.round}`;
        if (this.actedKey !== key) { this.actedKey = key; this.socket.emit("drawit:next-round"); }
      }
    }

    if (r.currentGame === "headsup" && r.headsUp) {
      const h = r.headsUp;
      const key = `hu:${h.phase}:${h.turnNumber}:${h.word || ""}`;
      if (h.isPerformer && h.phase === "ready" && this.actedKey !== key) {
        this.actedKey = key;
        this.socket.emit("headsup:start-turn");
      } else if (!h.isPerformer && h.phase === "active" && h.word && this.actedKey !== key) {
        this.actedKey = key;
        this.socket.emit("headsup:answer", { correct: Math.random() < 0.75 });
      }
    }

    if (r.currentGame === "promptbattle" && r.promptBattle) {
      const p = r.promptBattle;
      const aKey = `pb-a:${p.round}`;
      if (p.phase === "answering" && !p.hasAnswered && this.actedKey !== aKey) {
        this.actedKey = aKey;
        this.socket.emit("promptbattle:submit-answer", { text: randomFrom(SILLY_ANSWERS) });
      }
      const vKey = `pb-v:${p.round}`;
      if (p.phase === "voting" && !p.hasVoted && this.actedKey !== vKey) {
        const choices = (p.answers || []).filter((a) => !a.isYours);
        if (choices.length) {
          this.actedKey = vKey;
          this.socket.emit("promptbattle:submit-vote", { authorToken: randomFrom(choices).token });
        }
      }
    }

    if (r.currentGame === "wordbomb" && r.wordBomb) {
      const w = r.wordBomb;
      const key = `wb:${w.currentToken}:${w.fragment}`;
      if (w.isYourTurn && this.actedKey !== key) {
        this.actedKey = key;
        // Deliberately whiff sometimes so lives actually drain and the
        // game can reach a winner instead of everyone succeeding forever.
        const word = Math.random() < 0.75 ? "x" + w.fragment + Math.floor(Math.random() * 100000) : "zz";
        this.socket.emit("wordbomb:submit-word", { text: word });
      }
    }

    if (ROUND_GAME_TYPES.includes(r.currentGame) && r.roundGame) {
      const g = r.roundGame;
      const aKey = `rg-a:${g.round}`;
      if (g.phase === "answering" && !g.hasAnswered && this.actedKey !== aKey) {
        this.actedKey = aKey;
        this.socket.emit("roundgame:submit-answer", this.buildRoundGameAnswer(r, g));
      }
    }

    if (r.currentGame === "fib" && r.fib) {
      const f = r.fib;
      const aKey = `fib-a:${f.round}`;
      if (f.phase === "answering" && !f.hasAnswered && this.actedKey !== aKey) {
        this.actedKey = aKey;
        this.socket.emit("fib:submit-lie", {
          text: randomFrom(["A giant rubber duck", "Exactly 42", "Because gravity said so", "Nobody actually knows"])
        });
      }
      const vKey = `fib-v:${f.round}`;
      if (f.phase === "voting" && !f.hasVoted && this.actedKey !== vKey) {
        const choices = (f.options || []).filter((o) => !o.isYours);
        if (choices.length) {
          this.actedKey = vKey;
          this.socket.emit("fib:submit-vote", { optionId: randomFrom(choices).id });
        }
      }
    }

    if (r.currentGame === "triviasurvival" && r.triviaSurvival) {
      const t = r.triviaSurvival;
      const key = `tsurv:${t.round}`;
      if (t.phase === "answering" && !t.isEliminated && !t.hasAnswered && this.actedKey !== key) {
        this.actedKey = key;
        const n = (t.prompt && t.prompt.options && t.prompt.options.length) || 4;
        this.socket.emit("triviasurvival:submit-answer", { choice: Math.floor(Math.random() * n) });
      }
    }

    if (r.currentGame === "doodle" && r.doodle) {
      const d = r.doodle;
      const key = `doodle-g:${d.turnNumber}`;
      if (d.phase === "drawing" && !d.isArtist && !d.hasGuessedCorrectly && this.actedKey !== key) {
        this.actedKey = key;
        // Non-artists can't see the secret word (same as a real player) -
        // this just exercises the guess path; the round resolves via timeout.
        this.socket.emit("doodle:submit-guess", { text: randomFrom(["a house", "a dog", "not sure", "pizza?"]) });
      }
      if (d.phase === "drawing" && d.isArtist && this.actedKey !== `doodle-draw:${d.turnNumber}`) {
        this.actedKey = `doodle-draw:${d.turnNumber}`;
        // Send a trivial stroke so the "artist draws" path gets exercised too.
        this.socket.emit("doodle:stroke", { points: [{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.8, y: 0.3 }] });
      }
    }

    if (r.currentGame === "twotruths" && r.twoTruths) {
      const t = r.twoTruths;
      if (t.phase === "writing" && !t.hasWritten && this.actedKey !== "tt-write") {
        this.actedKey = "tt-write";
        this.socket.emit("twotruths:submit-statements", {
          texts: [`${this.name} likes hiking`, `${this.name} once met a celebrity`, `${this.name} can juggle`],
          lieIndex: Math.floor(Math.random() * 3)
        });
      }
      if (t.phase === "guessing" && !t.isSpotlight && !t.hasGuessed) {
        const key = `tt-guess:${t.spotlightNumber}`;
        if (this.actedKey !== key) {
          this.actedKey = key;
          this.socket.emit("twotruths:submit-guess", { guessIndex: Math.floor(Math.random() * 3) });
        }
      }
    }

    if (r.currentGame === "drawit" && r.drawIt) {
      const d = r.drawIt;
      const key = `drawit-a:${d.round}`;
      if (d.phase === "drawing" && !d.hasSubmitted && this.actedKey !== key) {
        this.actedKey = key;
        this.socket.emit("drawit:submit", {
          strokes: [{ points: [{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.8, y: 0.3 }] }]
        });
      }
      const vKey = `drawit-v:${d.round}`;
      if (d.phase === "voting" && !d.hasVoted && this.actedKey !== vKey) {
        const choices = (d.gallery || []).filter((e) => !e.isYours);
        if (choices.length) {
          this.actedKey = vKey;
          this.socket.emit("drawit:submit-vote", { authorToken: randomFrom(choices).token });
        }
      }
    }
  }

  buildRoundGameAnswer(r, g) {
    if (g.gameType === "trivia") {
      return { choice: Math.floor(Math.random() * g.prompt.options.length) };
    }
    if (g.gameType === "wouldyourather") {
      return { choice: Math.random() < 0.5 ? "A" : "B" };
    }
    if (g.gameType === "mostlikelyto") {
      const others = r.players.filter((p) => p.token !== r.youToken);
      return { votedFor: others.length ? randomFrom(others).token : null };
    }
    if (g.gameType === "emoji") {
      return { text: randomFrom(["a guess", "some movie", "no idea", "the answer"]) };
    }
    if (g.gameType === "category") {
      const letter = g.prompt.letter;
      return {
        words: g.prompt.categories.map((_, idx) => `${letter}word${idx}${Math.random() < 0.4 ? "" : Math.floor(Math.random() * 3)}`)
      };
    }
    if (g.gameType === "pollguess") {
      return { guess: Math.floor(Math.random() * 101) };
    }
    if (g.gameType === "anagram") {
      // The real word is hidden from clients until results, same as a real
      // player - bots just guess blind, same as "emoji" below.
      return { text: randomFrom(["not it", "no clue", "guessing"]) };
    }
    if (g.gameType === "oddoneout") {
      return { choice: Math.floor(Math.random() * g.prompt.items.length) };
    }
    if (g.gameType === "quickmath") {
      return { guess: Math.floor(Math.random() * 100) };
    }
    if (g.gameType === "neverhaveiever") {
      return { haveDone: Math.random() < 0.5 };
    }
    if (g.gameType === "riddle") {
      return { text: randomFrom(["not sure", "a mystery", "no idea"]) };
    }
    if (g.gameType === "countdownletters") {
      // Build a short valid word from the given letters so the "valid"
      // scoring path gets exercised, not just the invalid one.
      const letters = (g.prompt.letters || "").toUpperCase().split("");
      const vowel = letters.find((c) => "AEIOU".includes(c));
      const consonants = letters.filter((c) => c !== vowel).slice(0, 2);
      const word = vowel ? [consonants[0], vowel, consonants[1]].filter(Boolean).join("") : "";
      return { text: word.length >= 3 ? word : "cat" };
    }
    if (g.gameType === "guesstheyear") {
      return { guess: 1900 + Math.floor(Math.random() * 125) };
    }
    if (g.gameType === "truefalse") {
      return { guess: Math.random() < 0.5 };
    }
    if (g.gameType === "rankit") {
      // The correct order is hidden from clients until results, same as
      // anagram/riddle bots above - just submit a random permutation.
      const order = [...Array(g.prompt.items.length).keys()];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      return { order };
    }
    return {};
  }
}

const SCORE_DIVISOR = {
  headsup: 100, promptbattle: 500, wordbomb: 50,
  trivia: 500, wouldyourather: 200, mostlikelyto: 100, emoji: 500, category: 50,
  pollguess: 100, fib: 500, triviasurvival: 500, doodle: 100,
  anagram: 500, oddoneout: 500, quickmath: 500, twotruths: 100,
  neverhaveiever: 300, riddle: 500, countdownletters: 10, drawit: 400,
  guesstheyear: 100, truefalse: 400, rankit: 100
};

async function runGame(gameId, clients, host, settings) {
  log(`\n--- Playing ${gameId} with ${clients.length} players ---`);
  host.actedKey = null;
  clients.forEach((c) => { c.actedKey = null; });
  host.socket.emit("select-game", { gameId });
  await waitFor(() => host.state && host.state.currentGame === gameId, { desc: "game selected" });
  host.socket.emit("update-settings", settings);
  const settingsKey = Object.keys(settings)[0];
  const [checkField, checkValue] = Object.entries(settings[settingsKey])[0];
  await waitFor(
    () => host.state.settings[settingsKey][checkField] === checkValue,
    { desc: "settings applied" }
  );

  let timeoutMs;
  if (gameId === "headsup") {
    timeoutMs = Math.max(30000, settings.headsup.roundsPerPlayer * settings.headsup.turnDuration * clients.length * 1000 * 1.5);
  } else if (gameId === "promptbattle") {
    timeoutMs = Math.max(30000, settings.promptbattle.rounds * (75 + 30) * 1000 * 1.5);
  } else if (gameId === "wordbomb") {
    // Bounded loosely by total starting lives at a ~25% per-turn failure rate.
    timeoutMs = Math.max(30000, clients.length * settings.wordbomb.startingLives * settings.wordbomb.turnTimeSeconds * 1000 * 8);
  } else if (gameId === "fib") {
    timeoutMs = Math.max(30000, settings.fib.rounds * (settings.fib.answerTime + settings.fib.voteTime) * 1000 * 1.5);
  } else if (gameId === "triviasurvival") {
    timeoutMs = Math.max(30000, settings.triviasurvival.maxRounds * settings.triviasurvival.answerTime * 1000 * 2);
  } else if (gameId === "doodle") {
    timeoutMs = Math.max(30000, clients.length * settings.doodle.roundsPerPlayer * settings.doodle.drawSeconds * 1000 * 1.5);
  } else if (gameId === "twotruths") {
    timeoutMs = Math.max(30000, settings.twotruths.writeSeconds * 1000 + clients.length * settings.twotruths.guessSeconds * 1000 * 1.5);
  } else if (gameId === "drawit") {
    timeoutMs = Math.max(30000, settings.drawit.rounds * (settings.drawit.drawSeconds + settings.drawit.voteSeconds) * 1000 * 1.5);
  } else {
    const s = settings[gameId];
    timeoutMs = Math.max(30000, s.rounds * s.answerTime * 1000 * 1.5);
  }

  let lastProgress = "";
  const ticker = setInterval(() => {
    clients.forEach((c) => c.tick());
    const r = host.state;
    let progress = null;
    if (gameId === "headsup" && r.headsUp) progress = `turn ${r.headsUp.turnNumber}/${r.headsUp.totalTurns} (${r.headsUp.phase})`;
    else if (gameId === "promptbattle" && r.promptBattle) progress = `round ${r.promptBattle.round}/${r.promptBattle.totalRounds} (${r.promptBattle.phase})`;
    else if (gameId === "wordbomb" && r.wordBomb) {
      const alive = Object.values(r.wordBomb.lives).filter((l) => l > 0).length;
      progress = `fragment "${r.wordBomb.fragment}" (${alive} alive)`;
    } else if (gameId === "fib" && r.fib) {
      progress = `round ${r.fib.round}/${r.fib.totalRounds} (${r.fib.phase})`;
    } else if (gameId === "triviasurvival" && r.triviaSurvival) {
      progress = `round ${r.triviaSurvival.round}/${r.triviaSurvival.maxRounds} (${r.triviaSurvival.phase})`;
    } else if (gameId === "doodle" && r.doodle) {
      progress = `turn ${r.doodle.turnNumber}/${r.doodle.totalTurns} (${r.doodle.phase})`;
    } else if (gameId === "twotruths" && r.twoTruths) {
      progress = r.twoTruths.phase === "writing"
        ? `writing (${r.twoTruths.writtenCount}/${r.twoTruths.totalPlayers})`
        : `spotlight ${r.twoTruths.spotlightNumber}/${r.twoTruths.totalSpotlights} (${r.twoTruths.phase})`;
    } else if (gameId === "drawit" && r.drawIt) {
      progress = `round ${r.drawIt.round}/${r.drawIt.totalRounds} (${r.drawIt.phase})`;
    } else if (r.roundGame) {
      progress = `round ${r.roundGame.round}/${r.roundGame.totalRounds} (${r.roundGame.phase})`;
    }
    if (progress && progress !== lastProgress) {
      lastProgress = progress;
      log(`  [${gameId}] ${progress}`);
    }
  }, 200);
  try {
    await waitFor(() => host.state && host.state.state === "finished", {
      timeoutMs,
      desc: `${gameId} to reach finished state`
    });
  } finally {
    clearInterval(ticker);
  }

  const final = host.state;
  log(`${gameId} finished. Scores:`, final.players.map((p) => `${p.name}=${p.score}`).join(", "));

  const totalScore = final.players.reduce((sum, p) => sum + p.score, 0);
  const divisor = SCORE_DIVISOR[gameId];
  if (divisor && totalScore % divisor !== 0) {
    fail(`${gameId} total score ${totalScore} isn't a multiple of ${divisor}`);
  }
  for (const p of final.players) {
    if (p.score < 0) fail(`${p.name} has negative score ${p.score} in ${gameId}`);
  }

  clients.forEach((c) => {
    if (c.errors.length) fail(`${c.name} received socket errors: ${c.errors.join("; ")}`);
  });
}

async function main() {
  log(`Connecting to ${url} ...`);

  const hostSocket = await connect();
  const host = new Client(hostSocket, "HostPlayer");
  const createRes = await emitAck(hostSocket, "create-room", { name: "HostPlayer", gameId: "headsup" });
  if (!createRes.ok) { fail(`create-room failed: ${createRes.error}`); return; }
  await waitFor(() => host.state, { desc: "initial room state" });
  const roomCode = host.state.code;
  log(`Room created: ${roomCode}`);

  const botCount = parseInt(process.argv[3], 10) || 3;
  const botClients = [];
  for (let i = 0; i < botCount; i++) {
    const s = await connect();
    const c = new Client(s, `TestBot${i + 1}`);
    const res = await emitAck(s, "join-room", { roomCode, name: c.name });
    if (!res.ok) { fail(`${c.name} failed to join: ${res.error}`); return; }
    botClients.push(c);
  }

  const all = [host, ...botClients];
  await waitFor(() => host.state && host.state.players.length === all.length, { desc: "all players joined" });
  log(`${all.length} players in room.`);

  await runGame("headsup", all, host, {
    headsup: { turnDuration: 15, roundsPerPlayer: 1, categories: ["Animals", "Food & Drink"] }
  });

  host.socket.emit("return-to-lobby");
  await waitFor(() => host.state && host.state.state === "lobby", { desc: "back in lobby" });

  await runGame("promptbattle", all, host, {
    promptbattle: { rounds: 2 }
  });

  const backToLobby = async (n) => {
    host.socket.emit("return-to-lobby");
    await waitFor(() => host.state && host.state.state === "lobby", { desc: `back in lobby (${n})` });
  };

  await backToLobby("wordbomb");
  await runGame("wordbomb", all, host, {
    wordbomb: { turnTimeSeconds: 8, startingLives: 2 }
  });

  await backToLobby("trivia");
  await runGame("trivia", all, host, {
    trivia: { rounds: 3, answerTime: 10 }
  });

  await backToLobby("wouldyourather");
  await runGame("wouldyourather", all, host, {
    wouldyourather: { rounds: 3, answerTime: 10 }
  });

  await backToLobby("mostlikelyto");
  await runGame("mostlikelyto", all, host, {
    mostlikelyto: { rounds: 3, answerTime: 10 }
  });

  await backToLobby("emoji");
  await runGame("emoji", all, host, {
    emoji: { rounds: 3, answerTime: 10 }
  });

  await backToLobby("category");
  await runGame("category", all, host, {
    category: { rounds: 2, answerTime: 15 }
  });

  await backToLobby("pollguess");
  await runGame("pollguess", all, host, {
    pollguess: { rounds: 3, answerTime: 10 }
  });

  await backToLobby("fib");
  await runGame("fib", all, host, {
    fib: { rounds: 2, answerTime: 15, voteTime: 10 }
  });

  await backToLobby("triviasurvival");
  await runGame("triviasurvival", all, host, {
    triviasurvival: { startingLives: 2, answerTime: 8, maxRounds: 6 }
  });

  await backToLobby("doodle");
  await runGame("doodle", all, host, {
    doodle: { roundsPerPlayer: 1, drawSeconds: 30 }
  });

  await backToLobby("anagram");
  await runGame("anagram", all, host, {
    anagram: { rounds: 3, answerTime: 10 }
  });

  await backToLobby("oddoneout");
  await runGame("oddoneout", all, host, {
    oddoneout: { rounds: 3, answerTime: 10 }
  });

  await backToLobby("quickmath");
  await runGame("quickmath", all, host, {
    quickmath: { rounds: 4, answerTime: 8 }
  });

  await backToLobby("twotruths");
  await runGame("twotruths", all, host, {
    twotruths: { writeSeconds: 30, guessSeconds: 10 }
  });

  await backToLobby("neverhaveiever");
  await runGame("neverhaveiever", all, host, {
    neverhaveiever: { rounds: 3, answerTime: 8 }
  });

  await backToLobby("riddle");
  await runGame("riddle", all, host, {
    riddle: { rounds: 3, answerTime: 10 }
  });

  await backToLobby("countdownletters");
  await runGame("countdownletters", all, host, {
    countdownletters: { rounds: 2, answerTime: 10 }
  });

  await backToLobby("drawit");
  await runGame("drawit", all, host, {
    drawit: { rounds: 2, drawSeconds: 30, voteSeconds: 10 }
  });

  await backToLobby("guesstheyear");
  await runGame("guesstheyear", all, host, {
    guesstheyear: { rounds: 3, answerTime: 10 }
  });

  await backToLobby("truefalse");
  await runGame("truefalse", all, host, {
    truefalse: { rounds: 4, answerTime: 8 }
  });

  await backToLobby("rankit");
  await runGame("rankit", all, host, {
    rankit: { rounds: 3, answerTime: 15 }
  });

  log("\n--- Testing mid-game disconnect resilience ---");
  host.socket.emit("return-to-lobby");
  await waitFor(() => host.state && host.state.state === "lobby", { desc: "back in lobby (2)" });
  all.forEach((c) => (c.actedKey = null));
  host.socket.emit("select-game", { gameId: "promptbattle" });
  await waitFor(() => host.state && host.state.currentGame === "promptbattle", { desc: "game re-selected" });
  host.socket.emit("update-settings", { promptbattle: { rounds: 1 } });
  await waitFor(() => host.state.settings.promptbattle.rounds === 1, { desc: "rounds set to 1" });
  host.socket.emit("start-game");

  await waitFor(() => host.state && host.state.promptBattle && host.state.promptBattle.phase === "answering", {
    desc: "answering phase started"
  });

  // One bot vanishes mid-round without submitting an answer - the round
  // should still advance once the remaining connected players finish.
  const vanished = botClients[botClients.length - 1];
  vanished.socket.close();
  log(`${vanished.name} disconnected mid-answer.`);

  const remaining = all.filter((c) => c !== vanished);
  const ticker2 = setInterval(() => remaining.forEach((c) => c.tick()), 200);
  try {
    await waitFor(() => host.state && host.state.promptBattle && host.state.promptBattle.phase === "voting", {
      timeoutMs: 15000,
      desc: "round advanced to voting despite a disconnected player"
    });
    log("Round correctly advanced to voting without waiting on the disconnected player.");
  } catch (e) {
    fail(`Round did not advance after a player disconnected: ${e.message}`);
  } finally {
    clearInterval(ticker2);
  }

  log("\n--- Testing voting-phase timeout (a connected player who never votes) ---");
  host.socket.emit("return-to-lobby");
  await waitFor(() => host.state && host.state.state === "lobby", { desc: "back in lobby (3)" });
  const active = all.filter((c) => c.socket.connected);
  active.forEach((c) => (c.actedKey = null));
  host.socket.emit("select-game", { gameId: "promptbattle" });
  await waitFor(() => host.state && host.state.currentGame === "promptbattle", { desc: "game re-selected (2)" });
  host.socket.emit("update-settings", { promptbattle: { rounds: 1 } });
  await waitFor(() => host.state.settings.promptbattle.rounds === 1, { desc: "rounds set to 1 (2)" });
  host.socket.emit("start-game");

  // Everyone still connected answers, but the holdout deliberately never
  // votes (without disconnecting) - the round must still time out into
  // results on its own rather than hanging forever.
  const holdout = active[active.length - 1];
  const voters = active.filter((c) => c !== holdout);
  const holdoutAnswered = () => holdout.state && holdout.state.promptBattle && holdout.state.promptBattle.hasAnswered;

  const ticker3 = setInterval(() => {
    active.forEach((c) => c.tick());
  }, 200);
  try {
    await waitFor(() => holdoutAnswered(), { desc: "holdout submitted an answer" });
    // Once everyone's answered, stop ticking the holdout so it never votes.
    // `voters` includes `host` (always `all[0]`, never the holdout, which is
    // always the *last* element of `active`) - host is the one client whose
    // tick()-driven "results -> click next round" auto-advance (needed
    // elsewhere, for bots playing a full game) actually succeeds
    // server-side. Left unguarded, this ticker calling tick() on host right
    // through the moment "results" appears below can race the very
    // `waitFor` watching for it - exactly the bug found and fixed in the
    // round-game version of this pattern further down (see CHANGELOG).
    // Fixed the same way in spirit: once every voter has voted, there's no
    // more legitimate work for tick() to do until "results" appears, so
    // stop calling it entirely rather than leaving the auto-advance armed.
    const votingTicker = setInterval(() => {
      if (voters.every((c) => c.state.promptBattle && c.state.promptBattle.hasVoted)) {
        clearInterval(votingTicker);
        return;
      }
      voters.forEach((c) => c.tick());
    }, 200);
    try {
      await waitFor(() => host.state.promptBattle.phase === "results", {
        timeoutMs: 90000,
        desc: "voting phase to time out into results on its own"
      });
      log("Voting phase correctly timed out into results despite one player never voting.");
    } finally {
      clearInterval(votingTicker);
    }
  } catch (e) {
    fail(`Voting phase never resolved with a non-voting connected player: ${e.message}`);
  } finally {
    clearInterval(ticker3);
  }

  log("\n--- Testing a round-game player who never answers (stays connected) ---");
  host.socket.emit("return-to-lobby");
  await waitFor(() => host.state && host.state.state === "lobby", { desc: "back in lobby (3)" });
  const active2 = all.filter((c) => c.socket.connected);
  active2.forEach((c) => (c.actedKey = null));
  host.socket.emit("select-game", { gameId: "trivia" });
  await waitFor(() => host.state && host.state.currentGame === "trivia", { desc: "trivia selected" });
  host.socket.emit("update-settings", { trivia: { rounds: 1, answerTime: 10 } });
  await waitFor(() => host.state.settings.trivia.answerTime === 10, { desc: "answerTime set to 10" });
  host.socket.emit("start-game");

  // Every connected player except one silent holdout answers normally; the
  // holdout is deliberately never ticked during "answering," so the round
  // has to time out on its own with them present but unanswered. Regression
  // test for the "non-answering player vanishes from results entirely"
  // bug (see CHANGELOG) - the holdout must still appear in resultsData with
  // no choice, not be silently absent.
  //
  // Answerers submit exactly once via a *direct* emit, not their normal
  // tick() - tick() also auto-clicks "next round" the instant it sees
  // "results" (needed for the main game loop above, where every bot plays a
  // full game start to finish). One of `answerers` here is `host`, whose
  // "next round" click actually succeeds (a non-host's would be silently
  // rejected server-side) - reusing tick() raced that auto-advance against
  // this test's own "wait for results, then inspect it" check, occasionally
  // skipping straight past "results" to "finished" before the wait ever
  // observed it. Confirmed via temporary diagnostic logging that the app
  // itself was never at fault: the round/results/finished sequencing was
  // always exactly correct, just faster than this test was designed for.
  const holdout2 = active2[active2.length - 1];
  const answerers = active2.filter((c) => c !== holdout2);
  await waitFor(() => host.state.roundGame && host.state.roundGame.phase === "answering", {
    desc: "round reached answering phase"
  });
  for (const c of answerers) {
    c.socket.emit("roundgame:submit-answer", c.buildRoundGameAnswer(c.state, c.state.roundGame));
  }
  try {
    await waitFor(() => host.state.roundGame && host.state.roundGame.phase === "results", {
      timeoutMs: 30000,
      desc: "round to time out into results with one silent player"
    });
    const results = host.state.roundGame.resultsData.results;
    const holdoutToken = holdout2.state.youToken;
    const holdoutEntry = results.find((r) => r.token === holdoutToken);
    if (!holdoutEntry) {
      fail(`Non-answering player ${holdout2.name} is missing from roundGame results entirely (should show as "no answer")`);
    } else if (holdoutEntry.choice !== undefined) {
      fail(`Non-answering player ${holdout2.name} unexpectedly has a choice in results: ${JSON.stringify(holdoutEntry)}`);
    } else {
      log(`Non-answering player ${holdout2.name} correctly present in results with no choice.`);
    }
    for (const c of answerers) {
      const entry = results.find((r) => r.token === c.state.youToken);
      if (!entry || entry.choice === undefined) {
        fail(`Answering player ${c.name} is missing their choice in results`);
      }
    }
  } catch (e) {
    fail(`Round with a silent connected player never resolved into results: ${e.message}`);
  }

  all.forEach((c) => c.socket.connected && c.socket.close());

  log("\n=== Playtest summary ===");
  if (ISSUES.length === 0) {
    log("No issues found.");
    process.exit(0);
  } else {
    log(`${ISSUES.length} issue(s) found:`);
    ISSUES.forEach((i) => log(" - " + i));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Playtest crashed:", e);
  process.exit(1);
});
