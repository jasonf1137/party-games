// Spins up fake players that join a room and play automatically, so you can
// test multiplayer flows solo instead of recruiting friends every time.
//
// Usage:
//   node scripts/simulate-players.js <ROOM_CODE> [count] [serverUrl]
//   npm run simulate -- <ROOM_CODE> [count]
//
// Example:
//   node scripts/simulate-players.js ABCD 3

const { io } = require("socket.io-client");

const [roomCodeArg, countArg, urlArg] = process.argv.slice(2);

if (!roomCodeArg) {
  console.error("Usage: node scripts/simulate-players.js <ROOM_CODE> [count] [serverUrl]");
  process.exit(1);
}

const roomCode = roomCodeArg.toUpperCase();
const count = Math.max(1, parseInt(countArg, 10) || 3);
const url = urlArg || process.env.PARTY_GAMES_URL || "http://localhost:3000";

const NAME_POOL = [
  "Bot Ada", "Bot Alan", "Bot Grace", "Bot Nova", "Bot Zeta",
  "Bot Comet", "Bot Pixel", "Bot Sage", "Bot Echo", "Bot Fizz",
  "Bot Waffle", "Bot Turbo"
];

const SILLY_ANSWERS = [
  "A haunted vending machine",
  "Three raccoons in a trenchcoat",
  "My uncle's conspiracy podcast",
  "An extremely judgmental houseplant",
  "The sound a printer makes at 2am",
  "A minivan full of clowns",
  "Whatever's in the office fridge",
  "A wizard who only does taxes",
  "Static electricity and bad decisions",
  "The last slice of pizza, obviously"
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickName(used) {
  const available = NAME_POOL.filter((n) => !used.has(n));
  const base = available.length ? randomFrom(available) : randomFrom(NAME_POOL);
  const name = used.has(base) ? `${base} ${used.size}` : base;
  used.add(name);
  return name;
}

class Bot {
  constructor(name) {
    this.name = name;
    this.actedKey = null;
    this.latestPB = null;
    this.socket = io(url, { reconnection: true });

    this.socket.on("connect", () => {
      this.socket.emit("join-room", { roomCode, name: this.name }, (res) => {
        if (!res || !res.ok) {
          console.error(`[${this.name}] couldn't join: ${res && res.error}`);
          this.socket.close();
          return;
        }
        console.log(`[${this.name}] joined room ${roomCode}`);
      });
    });

    this.socket.on("room-update", (room) => this.onUpdate(room));
    this.socket.on("connect_error", (err) => {
      console.error(`[${this.name}] connection error: ${err.message}`);
    });
  }

  onUpdate(room) {
    if (room.currentGame === "headsup" && room.headsUp) this.playHeadsUp(room.headsUp);
    if (room.currentGame === "promptbattle" && room.promptBattle) {
      this.latestPB = room.promptBattle;
      this.playPromptBattle(room.promptBattle);
    }
  }

  playHeadsUp(h) {
    const key = `${h.phase}:${h.turnNumber}:${h.word || ""}`;
    if (key === this.actedKey) return;

    if (h.isPerformer && h.phase === "ready") {
      this.actedKey = key;
      setTimeout(() => {
        console.log(`[${this.name}] starting their turn`);
        this.socket.emit("headsup:start-turn");
      }, 600 + Math.random() * 800);
    } else if (!h.isPerformer && h.phase === "active" && h.word) {
      this.actedKey = key;
      const correct = Math.random() < 0.75;
      setTimeout(() => {
        this.socket.emit("headsup:answer", { correct });
      }, 1000 + Math.random() * 1800);
    }
  }

  playPromptBattle(p) {
    const answerKey = `answer:${p.round}`;
    if (p.phase === "answering" && !p.hasAnswered && this.actedKey !== answerKey) {
      this.actedKey = answerKey;
      const text = randomFrom(SILLY_ANSWERS);
      setTimeout(() => {
        console.log(`[${this.name}] answering: "${text}"`);
        this.socket.emit("promptbattle:submit-answer", { text });
      }, 500 + Math.random() * 2500);
      return;
    }

    const voteKey = `vote:${p.round}`;
    if (p.phase === "voting" && !p.hasVoted && this.actedKey !== voteKey) {
      this.actedKey = voteKey;
      setTimeout(() => {
        const answers = (this.latestPB && this.latestPB.answers) || [];
        const choices = answers.filter((a) => !a.isYours);
        if (!choices.length || this.latestPB.phase !== "voting" || this.latestPB.hasVoted) return;
        const pick = randomFrom(choices);
        console.log(`[${this.name}] voting for "${pick.text}"`);
        this.socket.emit("promptbattle:submit-vote", { authorToken: pick.token });
      }, 500 + Math.random() * 1500);
    }
  }

  leave() {
    this.socket.emit("leave-room");
    this.socket.close();
  }
}

console.log(`Spawning ${count} bot(s) into room ${roomCode} at ${url}`);
console.log("They'll auto-play Heads Up turns and Prompt Battle answers/votes.");
console.log("The host still needs to pick the game and click Start/Next from a real browser tab.");
console.log("Press Ctrl+C to remove the bots.\n");

const used = new Set();
const bots = Array.from({ length: count }, () => new Bot(pickName(used)));

process.on("SIGINT", () => {
  console.log("\nRemoving bots...");
  bots.forEach((b) => b.leave());
  setTimeout(() => process.exit(0), 300);
});
