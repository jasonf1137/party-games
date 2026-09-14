(() => {
  const socket = io();
  const app = document.getElementById("app");
  const toastEl = document.getElementById("toast");
  const screenAnnouncerEl = document.getElementById("screenAnnouncer");

  const ROUND_GAME_TYPES = [
    "trivia", "wouldyourather", "mostlikelyto", "emoji", "category", "pollguess",
    "anagram", "oddoneout", "quickmath",
    "neverhaveiever", "riddle", "countdownletters",
    "guesstheyear", "truefalse", "rankit"
  ];

  let session = {
    token: localStorage.getItem("pg_token") || null,
    secret: localStorage.getItem("pg_secret") || null,
    roomCode: localStorage.getItem("pg_room") || null,
    name: localStorage.getItem("pg_name") || ""
  };
  let room = null;
  let joining = false;
  let draftName = session.name || "";
  let prefillCode = "";
  let catalog = { headsUpCategories: [], categoryPool: [] };

  // Home screen local navigation (no room exists yet, so nothing here is synced).
  let homeStep = "landing"; // 'landing' | 'join' | 'browse' | 'configure'
  let showHowItWorks = false;
  let homeConfigGame = null;
  let homePendingSettings = defaultSettings();
  // Persists across re-renders of the game-picker (browse screen or the
  // lobby's "change game" view) so going "‹ Back" from a game's settings
  // doesn't lose what was typed - filtering itself is done by hand in
  // bindGameSearch() rather than through render(), since 23 rows is cheap
  // to show/hide directly and this avoids re-running the whole render()
  // pipeline (and its "preserve focus" logic) on every keystroke.
  let gameSearchQuery = "";
  // Module-scoped (not local to bindGameSearch) so a real screen-change
  // render() can cancel a still-pending debounced search announcement -
  // otherwise clicking a game row right after typing a query leaves the
  // debounce timer alive, and it can fire ~400ms later and clobber the
  // screen-transition heading it just announced with a stale "N games
  // match" message from the screen the player already left.
  let searchAnnounceTimer = null;

  function closeHowItWorksModal() {
    showHowItWorks = false;
    render();
    // render() just rebuilt the whole screen from a fresh HTML string, so
    // the trigger button element captured on open no longer exists in the
    // document - re-find it by id rather than calling .focus() on what's
    // now a detached, silently-inert node.
    const trigger = document.getElementById("howItWorksBtn");
    if (trigger) trigger.focus();
  }
  // Draft room-level settings (streamer mode + password) picked before the
  // room even exists - sent along with create-room, same as game settings.
  let homeRoomSettings = { streamerMode: false, password: "" };

  // Lobby local navigation override (host only) - room.currentGame already
  // drives which step to show; this just lets "Change game" force the list
  // back open even though a game is still selected server-side.
  let lobbyForceBrowse = false;
  // Which lobby tab the host is looking at - the mini-game settings, or the
  // room-level ones (streamer mode, join password).
  let lobbyTab = "game"; // 'game' | 'room'
  // Streamer mode click-to-peek: true for a few seconds after tapping the
  // blurred room code, then it re-hides itself.
  let roomCodeRevealed = false;
  let revealTimer = null;

  // Host kick control: tapping ✕ arms a 3-second "Kick?" confirm state on
  // that one button rather than a native confirm() dialog - tap again within
  // the window to actually kick, otherwise it quietly reverts.
  let pendingKickToken = null;
  let pendingKickTimer = null;
  // Same two-tap confirm pattern for handing host control to someone else.
  let pendingHostToken = null;
  let pendingHostTimer = null;

  // Rank It: the display-indices the player has tapped so far, in the order
  // tapped. Not part of room state (only submitted once complete), so it's
  // tracked locally and reset whenever a fresh round's prompt shows up.
  let rankItOrder = [];
  let rankItRoundKey = null;
  function resetRankItOrderIfNewRound(g) {
    const key = `${g.round}:${g.prompt.items.join("|")}`;
    if (key !== rankItRoundKey) {
      rankItRoundKey = key;
      rankItOrder = [];
    }
  }

  // Category Countdown: same problem as Rank It above (a multi-field answer
  // form, wiped every second by the round's own timer broadcast unless kept
  // client-side), so the same fix - draft words kept outside the DOM,
  // reset whenever a genuinely new prompt shows up.
  let catDraftWords = ["", "", ""];
  let catDraftKey = null;
  function resetCatDraftIfNewRound(g) {
    const key = `${g.round}:${g.prompt.letter}:${g.prompt.categories.join("|")}`;
    if (key !== catDraftKey) {
      catDraftKey = key;
      catDraftWords = ["", "", ""];
    }
  }

  // Two Truths and a Lie: draft statement text + which one is marked the
  // lie, kept client-side and separate from the DOM. The writing phase
  // rebroadcasts every second like any active timer (see
  // twoTruthsBeginWritingTimer in room.js) - a single-input field survives
  // that via the generic "preserve the focused element by id" logic in
  // render(), but a 3-field form can't: only the currently-focused field
  // would be preserved, and the other two (plus the lie radio selection)
  // would silently blank out on every tick without this. Reset explicitly
  // wherever a fresh game actually starts, rather than trying to infer it
  // from room state.
  let ttDraftStatements = ["", "", ""];
  let ttDraftLieIndex = 0;
  function resetTTDraft() {
    ttDraftStatements = ["", "", ""];
    ttDraftLieIndex = 0;
  }

  function defaultSettings() {
    return {
      headsup: { turnDuration: 60, roundsPerPlayer: 1, categories: [] },
      promptbattle: { rounds: 3 },
      wordbomb: { turnTimeSeconds: 10, startingLives: 3 },
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
    };
  }

  const GAME_META = {
    headsup: { icon: "🤳", title: "Heads Up!", desc: "Guess the word before time runs out — everyone else can see it, you can't." },
    promptbattle: { icon: "😂", title: "Prompt Battle", desc: "Answer a silly prompt, then vote for the funniest response in the room." },
    wordbomb: { icon: "💣", title: "Word Bomb", desc: "Say a word with the given letters before the bomb goes off, or lose a life." },
    trivia: { icon: "🧠", title: "Trivia Blitz", desc: "Answer multiple-choice trivia questions faster than your friends." },
    wouldyourather: { icon: "🤔", title: "Would You Rather", desc: "Pick a side on impossible choices and see how the room voted." },
    category: { icon: "🔤", title: "Category Countdown", desc: "Name something in each category starting with the given letter." },
    mostlikelyto: { icon: "👉", title: "Most Likely To", desc: "Vote for the friend who best fits each hilarious prompt." },
    emoji: { icon: "🧩", title: "Emoji Decode", desc: "Crack the movie or phrase hidden behind a string of emoji." },
    pollguess: { icon: "📊", title: "Guess the Crowd", desc: "Guess what percent of people agree — closest to the real number wins." },
    fib: { icon: "🤥", title: "Fib or Fact", desc: "Write a convincing lie, then find the truth hiding among everyone else's." },
    triviasurvival: { icon: "💀", title: "Quiz or Die", desc: "Answer trivia or lose a life — run out of lives and you're eliminated." },
    doodle: { icon: "🎨", title: "Doodle Guess", desc: "One player draws a secret word live while everyone else races to guess it." },
    anagram: { icon: "🔀", title: "Anagram Blitz", desc: "Unscramble the shuffled letters before time runs out." },
    oddoneout: { icon: "🔍", title: "Odd One Out", desc: "Spot which of the four things doesn't belong with the rest." },
    quickmath: { icon: "➗", title: "Quick Math", desc: "Solve simple arithmetic as fast as you can." },
    twotruths: { icon: "🕵️", title: "Two Truths and a Lie", desc: "Write two truths and a lie about yourself — can your friends spot the fib?" },
    neverhaveiever: { icon: "🙋", title: "Never Have I Ever", desc: "Say whether you've done it — the minority gets the points." },
    riddle: { icon: "🗝️", title: "Riddle Me This", desc: "Solve classic riddles before time runs out." },
    countdownletters: { icon: "🔡", title: "Countdown Letters", desc: "Build the longest word you can from 9 random letters." },
    drawit: { icon: "🖌️", title: "Draw It!", desc: "Everyone draws the same secret word at once — vote for the best doodle." },
    guesstheyear: { icon: "📅", title: "Guess the Year", desc: "Guess the year a famous event happened — closest guess takes the round." },
    truefalse: { icon: "❓", title: "True or False", desc: "Is it fact or fiction? Lock in your answer before time runs out." },
    rankit: { icon: "🔢", title: "Rank It", desc: "Put four things in the right order — the more spots you nail, the more you score." }
  };

  fetch("/api/catalog")
    .then((r) => r.json())
    .then((data) => {
      catalog = data;
      if (!homePendingSettings.headsup.categories.length) {
        homePendingSettings.headsup.categories = catalog.headsUpCategories.slice(0, 3);
      }
      render();
    })
    .catch(() => {});

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // Lets Enter submit a form-like input instead of only a tap/click on its
  // button - most in-game answer inputs already do this; this is for the
  // handful of home-screen/lobby text fields that didn't.
  function onEnter(el, fn) {
    if (el) el.addEventListener("keydown", (e) => { if (e.key === "Enter") fn(); });
  }

  // A small pulsing typing-indicator, dropped in wherever copy says
  // "waiting for..." so those moments don't just sit there looking stuck.
  const WAIT_DOTS = '<span class="wait-dots"><span></span><span></span><span></span></span>';

  // `persistent: true` skips the auto-hide - for a message that describes an
  // ongoing state (only "Reconnecting…" today) rather than a one-off event.
  // Without this, the "Reconnecting…" toast disappeared after its fixed
  // 3.2s regardless of whether the connection had actually come back - any
  // real-world disconnect longer than that (a phone losing signal, a few
  // seconds of wifi hiccup, a server restart) left the player staring at a
  // frozen, stale screen with zero indication anything was wrong, since
  // nothing else in the UI reflects connection state. Confirmed this
  // concretely by watching a real disconnected session: the toast text was
  // still "Reconnecting…" but already hidden while the socket was still
  // genuinely down.
  function showToast(msg, type = "error", persistent = false) {
    toastEl.textContent = msg;
    toastEl.className = `toast toast-${type}`;
    clearTimeout(showToast._t);
    if (!persistent) {
      showToast._t = setTimeout(() => toastEl.classList.add("hidden"), 3200);
    }
  }

  function saveSession() {
    if (session.token) localStorage.setItem("pg_token", session.token);
    if (session.secret) localStorage.setItem("pg_secret", session.secret);
    if (session.roomCode) localStorage.setItem("pg_room", session.roomCode);
    if (session.name) localStorage.setItem("pg_name", session.name);
  }

  function clearSession() {
    session = { token: null, secret: null, roomCode: null, name: session.name };
    localStorage.removeItem("pg_token");
    localStorage.removeItem("pg_secret");
    localStorage.removeItem("pg_room");
    room = null;
    homeStep = "landing";
    homeConfigGame = null;
    lobbyForceBrowse = false;
    lobbyTab = "game";
    roomCodeRevealed = false;
    clearTimeout(revealTimer);
    waitingTip = null;
    previousScores.clear();
    resetTTDraft();
    catDraftWords = ["", "", ""];
    catDraftKey = null;
    // These two were missing from this reset (unlike the two drafts above),
    // each keyed loosely enough that a new room's game could accidentally
    // match a stale key left over from the room just left: Rank It's key
    // includes the round number and prompt text (needs both to coincide -
    // possible but not likely), Draw It's is a bare round number (matches
    // on round alone, so more easily hit if a player leaves mid-drawing,
    // before submitting, then lands back on the same round number in a
    // fresh room) - either way, without this, the player could see a
    // previous room's leftover ranking order or in-progress drawing bleed
    // into a completely different room's game.
    rankItOrder = [];
    rankItRoundKey = null;
    drawItLocalStrokes = [];
    drawItLocalStrokesRound = null;
    render();
  }

  // The "Reconnecting…" toast below auto-hides after ~3s regardless of
  // whether the reconnect actually finished by then - on a slower
  // reconnect, that leaves the screen resuming with no visible
  // confirmation it actually worked. Track whether this is the very first
  // connect (nothing to confirm, it's just the initial page load) versus a
  // genuine reconnect after a real disconnect, and only show "Reconnected!"
  // for the latter, and only once the rejoin itself actually succeeded.
  let hasConnectedBefore = false;
  socket.on("connect", () => {
    const wasReconnect = hasConnectedBefore;
    hasConnectedBefore = true;
    const params = new URLSearchParams(location.search);
    const urlRoom = params.get("room");
    // Consume the ?room= param once and strip it from the visible URL right
    // away - its only job was getting the code into `urlRoom` above. Left
    // in place, it'd silently re-prefill this same tab's join screen with
    // an increasingly stale room code on every future refresh, long after
    // the player has joined, left, and moved on - a QR-code/invite-link tab
    // that stays open (or gets reopened from history) for days would keep
    // pointing at a room that's since ended.
    if (urlRoom) {
      history.replaceState(null, "", location.pathname);
    }
    if (session.token && session.roomCode) {
      socket.emit("join-room", { roomCode: session.roomCode, token: session.token, secret: session.secret }, (res) => {
        if (!res || !res.ok) {
          // This used to fail silently - the user would just find themselves
          // back on the landing page with zero explanation for why their
          // room is gone. Now a genuinely common reason: they were kicked
          // while offline, and never saw the "kicked" toast because that
          // only reaches an actively-connected socket.
          showToast((res && res.error) || "Couldn't rejoin your room.");
          clearSession();
          if (urlRoom) {
            prefillCode = urlRoom.toUpperCase();
            homeStep = "join";
          }
          render();
        } else if (wasReconnect) {
          showToast("Reconnected!", "success");
        }
      });
    } else if (urlRoom) {
      prefillCode = urlRoom.toUpperCase();
      homeStep = "join";
      render();
    }
  });

  socket.on("room-update", (data) => {
    room = data;
    render();
  });

  // The server emits this right before force-disconnecting a kicked player,
  // so it always arrives just ahead of the "disconnect" event below - the
  // flag stops that handler from showing a misleading "Reconnecting…" toast.
  let wasKicked = false;
  socket.on("kicked", () => {
    wasKicked = true;
    clearSession();
    showToast("You were removed from the room by the host.");
  });

  // The server emits this right before force-disconnecting this tab when
  // someone else has reconnected using this same player's token - same
  // "notify, don't leave them silently guessing" pattern as "kicked" above,
  // for the case where a *different* device claimed this identity rather
  // than the host removing it. This tab's own session is now stale (someone
  // else is that player), so it's cleared the same way a kick clears it,
  // rather than quietly reconnecting right back and re-triggering this loop.
  let wasSessionTakenOver = false;
  socket.on("session-taken-over", () => {
    wasSessionTakenOver = true;
    clearSession();
    showToast("This session was opened somewhere else, so you were disconnected here.");
  });

  socket.on("disconnect", () => {
    if (wasKicked) { wasKicked = false; return; }
    if (wasSessionTakenOver) { wasSessionTakenOver = false; return; }
    showToast("Reconnecting…", "error", true);
  });

  // Real-time doodle strokes arrive outside the normal room-update cycle
  // (which only ticks once a second) so spectators see drawing live. They
  // no-op harmlessly if the canvas isn't the current screen.
  socket.on("doodle:stroke", ({ points } = {}) => {
    const canvas = document.getElementById("doodleCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.strokeStyle = "#222";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    drawStrokeOnCanvas(ctx, canvas, points);
  });

  socket.on("doodle:clear", () => {
    const canvas = document.getElementById("doodleCanvas");
    if (!canvas) return;
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  });

  // Room updates arrive every second while a timer counts down (server
  // rebroadcasts the whole room each tick), and each one replaces
  // #app's innerHTML - which would otherwise destroy and recreate any
  // <input> the player is actively typing into, losing focus and text
  // mid-keystroke. Snapshot the focused field and restore it after render.
  // Maps room.currentGame -> the sub-state field serializeFor() attaches it as.
  const GAME_STATE_KEY = {
    headsup: "headsUp", promptbattle: "promptBattle", wordbomb: "wordBomb",
    fib: "fib", triviasurvival: "triviaSurvival", doodle: "doodle",
    twotruths: "twoTruths", drawit: "drawIt"
  };

  // A string identifying "which screen the player is looking at" - stable
  // across the once-a-second timer re-renders (same phase/round), but
  // different whenever the phase, round, or route actually changes. Used to
  // gate the screen-enter animation so it plays on real transitions only.
  function computeScreenKey() {
    if (!room) return `home:${homeStep}:${homeConfigGame || ""}`;
    if (room.state === "finished") return "finished";
    if (room.state === "lobby") return `lobby:${room.currentGame || ""}:${lobbyShowingBrowse(room)}`;
    const field = GAME_STATE_KEY[room.currentGame] || "roundGame";
    const g = room[field];
    if (!g) return room.currentGame || "unknown";
    const progress = g.round ?? g.turnNumber ?? g.spotlightNumber ?? "";
    return `${room.currentGame}:${g.phase}:${progress}`;
  }

  let lastScreenKey = null;

  // ---------------- Sound effects (Web Audio, no asset files) ----------------
  // A handful of tasteful, procedurally-generated tones for a few real
  // moments (joining a room, a round revealing, the timer running low,
  // winning/losing) - not a click sound on every button, which gets old fast.

  let audioCtx = null;
  let soundOn = localStorage.getItem("pg_sound") !== "off";

  function getAudioCtx() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === "suspended") audioCtx.resume();
      return audioCtx;
    } catch (e) {
      // Autoplay restrictions, no audio hardware, a closed context, etc. -
      // sound is a nice-to-have, never worth breaking a render over.
      return null;
    }
  }

  function playTone(freq, { duration = 0.12, type = "sine", gain = 0.08, delay = 0 } = {}) {
    if (!soundOn) return;
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const t0 = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    } catch (e) {
      // ignore - see getAudioCtx
    }
  }

  function playChime(notes, opts = {}) {
    const gap = opts.gap ?? 0.09;
    notes.forEach((freq, i) => playTone(freq, { ...opts, delay: (opts.delay || 0) + i * gap }));
  }

  // Rides on the same on/off toggle as sound - both are "sensory feedback",
  // and one switch is friendlier than two for something this minor.
  function vibrate(pattern) {
    if (!soundOn) return;
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (e) {
      // ignore - not every device/browser supports it
    }
  }

  const SFX = {
    join: () => playChime([523.25, 659.25, 783.99], { duration: 0.18, gain: 0.06 }), // C5 E5 G5
    reveal: () => playTone(440, { duration: 0.1, gain: 0.05, type: "triangle" }),
    tick: () => { playTone(880, { duration: 0.06, gain: 0.04, type: "square" }); vibrate(15); },
    win: () => { playChime([523.25, 659.25, 783.99, 1046.5], { duration: 0.22, gain: 0.07, gap: 0.11 }); vibrate([0, 60, 40, 60, 40, 120]); },
    gameOver: () => { playTone(220, { duration: 0.3, gain: 0.05, type: "sine" }); vibrate(40); }
  };

  function setSoundOn(on) {
    soundOn = on;
    localStorage.setItem("pg_sound", on ? "on" : "off");
    const btn = document.getElementById("soundToggle");
    if (btn) {
      btn.textContent = soundOn ? "🔊" : "🔇";
      btn.setAttribute("aria-label", soundOn ? "Mute sound effects" : "Unmute sound effects");
    }
  }

  function initSoundToggle() {
    const btn = document.getElementById("soundToggle");
    if (!btn) return;
    setSoundOn(soundOn);
    btn.addEventListener("click", () => {
      setSoundOn(!soundOn);
      if (soundOn) playTone(659.25, { duration: 0.08, gain: 0.05 });
    });
  }

  // A handful of interactive rows (the game picker, votable answer cards)
  // are <div>s rather than real <button> elements, for layout reasons - this
  // makes Enter/Space activate them like a real button would, for keyboard
  // and screen-reader users. Delegated once at the document level rather
  // than rebound on every render, since #app's content is fully replaced
  // each time.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = e.target.closest('[role="button"]');
    if (!el) return;
    e.preventDefault();
    el.click();
  });

  // Returns the currently-open modal's backdrop element, or null - both
  // Escape-to-close and the Tab-trap below need this same "which modal (if
  // any) is open right now" check, so it's factored out rather than
  // duplicated.
  function openModalBackdrop() {
    if (showHowItWorks) return document.getElementById("howItWorksBackdrop");
    const gameHelpBackdrop = document.getElementById("gameHelpBackdrop");
    if (gameHelpBackdrop && !gameHelpBackdrop.classList.contains("hidden")) return gameHelpBackdrop;
    return null;
  }

  // Standard modal keyboard behavior - close on Escape, and trap Tab/
  // Shift+Tab inside the modal while it's open (delegated, since the "How
  // it works" modal is only ever conditionally in the DOM and gets rebuilt
  // on every render like everything else here). Both modals are plain
  // `<div>`s, not the native `<dialog>` element, which is what would
  // otherwise give this for free - without this, a keyboard-only user
  // tabbing through an open modal eventually tabs straight out of it into
  // whatever's next in the underlying page, defeating the point of a modal.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (showHowItWorks) closeHowItWorksModal();
      const gameHelpBackdrop = document.getElementById("gameHelpBackdrop");
      if (gameHelpBackdrop && !gameHelpBackdrop.classList.contains("hidden")) hideGameHelp();
      return;
    }
    if (e.key !== "Tab") return;
    const modal = openModalBackdrop();
    if (!modal) return;
    const focusable = [...modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) {
      // The `!focusable.includes(...)` branch covers focus still sitting on
      // the modal card itself (its initial `tabindex="-1"` focus target on
      // open, excluded from `focusable` on purpose) - Shift+Tab from there
      // needs to wrap to `last` same as from `first`, or it would escape
      // the trap on the very first backward tab.
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  // Some browsers (Safari especially) only allow AudioContext to actually
  // start running inside a handler synchronously tied to a user gesture -
  // by the time the first SFX call happens (e.g. after a socket round-trip
  // on create-room), that link can already be too indirect. Priming it on
  // the very first tap/click anywhere sidesteps that entirely.
  document.addEventListener("pointerdown", getAudioCtx, { once: true });
  document.addEventListener("keydown", getAudioCtx, { once: true });

  // Maps the once-per-second server-driven timeLeft on whatever screen is
  // currently active, regardless of which game it is - reused by the tick
  // sound below (same lookup shape as GAME_STATE_KEY / computeScreenKey).
  function currentTimeLeft() {
    if (!room || room.state !== "playing") return null;
    const field = GAME_STATE_KEY[room.currentGame] || "roundGame";
    const g = room[field];
    return g && typeof g.timeLeft === "number" ? g.timeLeft : null;
  }

  let lastTickValue = null;

  function playScreenTransitionSound(key, prevKey) {
    if (prevKey === null) return; // nothing on first load
    if (key === "finished") {
      const players = (room && room.players) || [];
      const topScore = players.length ? Math.max(...players.map((p) => p.score)) : 0;
      // Compare the viewing player's own score against the top score
      // (shared by everyone tied for first), not "are they specifically
      // first in the sorted array" - a tie shouldn't mean only whoever
      // joined first hears the win sound while an equally-scoring
      // player hears "game over" instead.
      const me = session.token && players.find((p) => p.token === session.token);
      const isWinner = me && topScore > 0 && me.score === topScore;
      if (isWinner) SFX.win(); else SFX.gameOver();
      return;
    }
    if (room && room.state === "lobby" && prevKey.startsWith("home:")) {
      SFX.join();
      return;
    }
    if (key.includes(":results:")) {
      SFX.reveal();
    }
  }

  // ---------------- Backgrounded-tab title flash ----------------
  // Same idea as a chat app's "(1) New message" tab title - only fires while
  // the tab is actually hidden, and clears itself the moment it regains
  // focus, so it never lingers as a stale title.

  const BASE_TITLE = document.title;
  let titleFlashing = false;

  function flashTitle(text) {
    if (!document.hidden) return;
    titleFlashing = true;
    document.title = text;
  }

  // Mobile browsers routinely suspend a backgrounded tab's JS entirely
  // (switching apps, locking the screen) - the underlying connection can
  // die silently during that gap (the OS reclaiming it, or Engine.IO's own
  // ~45s ping-timeout elapsing while nothing was running to notice), and
  // `socket.connected` can still read `true` afterward since the 'disconnect'
  // event that would flip it never got a chance to run either. A plain
  // `socket.connect()` is a safe no-op whenever `connected` is already
  // `true` - which does nothing for exactly this "looks connected but isn't"
  // case. Only worth acting on for a *meaningfully* long hide, though - a
  // quick app-switch-and-back is the common case, and forcing a reconnect
  // cycle every time would show a spurious "Reconnecting…" flash for
  // something that was never actually broken. 60s (a little past Engine.IO's
  // own ~45s worst-case dead-connection detection window) is long enough
  // that a real interruption plausibly happened and short enough to still
  // catch it reasonably promptly.
  let hiddenSince = null;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenSince = Date.now();
      return;
    }
    if (titleFlashing) {
      titleFlashing = false;
      document.title = BASE_TITLE;
    }
    if (hiddenSince && Date.now() - hiddenSince > 60000) {
      socket.disconnect();
      socket.connect();
    }
    hiddenSince = null;
  });

  // Distinct from the visibility case above - here the tab's JS never
  // stopped running, so a real network drop (airplane mode, losing signal)
  // already reaches Socket.IO's own disconnect detection and its existing
  // exponential-backoff reconnection (1-5s, jittered) promptly on its own;
  // nothing is actually broken without this. This just tightens the last
  // mile: the moment the browser reports connectivity is back, attempt
  // reconnecting immediately rather than waiting out whatever's left of the
  // current backoff delay - `connect()` is a documented no-op if already
  // connected, so there's no downside to calling it eagerly here.
  window.addEventListener("online", () => socket.connect());

  function maybeFlashTitle(key) {
    if (!room || room.state !== "playing") return;
    flashTitle(key.includes(":results:") ? "🏆 Results are in! — Party Games" : "🎮 Your turn! — Party Games");
  }

  function spawnConfetti() {
    const colors = ["#FF4B3E", "#FFC53D", "#2FD98A", "#4FC8E8", "#F5F2ED"];
    const container = document.createDocumentFragment();
    const pieces = [];
    for (let i = 0; i < 46; i++) {
      const piece = document.createElement("div");
      piece.className = "confetti-piece";
      piece.style.left = Math.random() * 100 + "vw";
      piece.style.background = colors[i % colors.length];
      const duration = 2.4 + Math.random() * 1.6;
      piece.style.animationDuration = duration + "s";
      piece.style.animationDelay = Math.random() * 0.4 + "s";
      piece.style.transform = `rotate(${Math.random() * 360}deg)`;
      container.appendChild(piece);
      pieces.push(piece);
    }
    document.body.appendChild(container);
    setTimeout(() => pieces.forEach((p) => p.remove()), 4500);
  }

  function render() {
    const active = document.activeElement;
    const isEditable =
      active && app.contains(active) && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
    const preserved = isEditable && active.id
      ? {
          id: active.id,
          value: active.value,
          selStart: active.selectionStart,
          selEnd: active.selectionEnd
        }
      : null;

    const key = computeScreenKey();
    const isNewScreen = key !== lastScreenKey;
    const prevKey = lastScreenKey;
    if (isNewScreen && key === "finished" && prevKey !== null) spawnConfetti();
    if (isNewScreen) {
      playScreenTransitionSound(key, prevKey);
      maybeFlashTitle(key);
    }
    lastScreenKey = key;

    const timeLeft = currentTimeLeft();
    if (timeLeft !== null && timeLeft > 0 && timeLeft <= 3 && timeLeft !== lastTickValue) SFX.tick();
    lastTickValue = timeLeft;

    try {
      renderScreen();
    } catch (e) {
      // Whatever just broke, leaving the previous (now stale) screen up
      // forever would be worse than an honest "something went wrong" - this
      // is the client-side equivalent of the try/catch around every socket
      // handler on the server, for the same reason: one bad render
      // shouldn't strand the player with no way forward but to notice and
      // manually refresh.
      console.error("Render failed:", e);
      app.innerHTML = `
        <div class="brand" style="margin:40px 0 16px;"><div class="mark">😵</div></div>
        <div class="card center">
          <h3>Something went wrong</h3>
          <p class="hint">This screen hit a snag. Reloading should pick up right where you left off.</p>
          <button id="reloadAfterErrorBtn" class="btn-primary btn-block btn-lg" style="margin-top:10px;">🔄 Reload</button>
        </div>
      `;
      const btn = document.getElementById("reloadAfterErrorBtn");
      if (btn) btn.addEventListener("click", () => location.reload());
      return;
    }

    if (isNewScreen) {
      app.classList.remove("screen-pop");
      void app.offsetWidth; // force reflow so re-adding the class restarts the animation
      app.classList.add("screen-pop");

      // Screen reader announcement for what sighted players see instantly
      // (a new round, results, "your turn") - reuses whichever heading the
      // new screen already rendered rather than hand-writing separate copy
      // per game/phase, which would be a lot of surface area to keep in
      // sync. Skipped on the once-a-second timer re-renders (isNewScreen
      // gates that already) so it doesn't get re-announced every tick.
      if (screenAnnouncerEl) {
        // Cancel any pending debounced search-result announcement (see
        // bindGameSearch) - without this, leaving the search screen right
        // after typing lets that stale message fire after this heading and
        // overwrite it.
        clearTimeout(searchAnnounceTimer);
        const heading = app.querySelector("h1, h2, h3");
        screenAnnouncerEl.textContent = heading ? heading.textContent.trim() : "";
      }
    } else {
      app.classList.remove("screen-pop");
    }

    if (preserved) {
      const el = document.getElementById(preserved.id);
      if (el) {
        el.value = preserved.value;
        el.focus();
        if (typeof el.setSelectionRange === "function") {
          try {
            el.setSelectionRange(preserved.selStart, preserved.selEnd);
          } catch (e) {
            // ignore - some input types don't support selection ranges
          }
        }
      }
    }

    updateGameHelpButton();
  }

  // Shows the ❓ game-help button only while a game is actually being
  // played - it wouldn't make sense on the landing page (that's what "How
  // does this work?" is for) or in the lobby (no specific game rules to
  // show yet if nothing's started).
  function updateGameHelpButton() {
    const btn = document.getElementById("gameHelpBtn");
    if (!btn) return;
    const active = !!(room && room.state === "playing" && GAME_META[room.currentGame]);
    btn.classList.toggle("hidden", !active);
    // If the game ended (or the room changed under them) while the help
    // modal was open, force it closed rather than leaving it showing stale
    // rules over a screen that's moved on - also avoids Escape/close trying
    // to restore focus to a trigger button that just became display:none
    // (a silent no-op, not a crash, but focus would go nowhere useful).
    const backdrop = document.getElementById("gameHelpBackdrop");
    if (!active && backdrop && !backdrop.classList.contains("hidden")) {
      backdrop.classList.add("hidden");
    }
  }

  function showGameHelp() {
    if (!room || !room.currentGame) return;
    const meta = GAME_META[room.currentGame];
    if (!meta) return;
    document.getElementById("gameHelpIcon").textContent = meta.icon;
    document.getElementById("gameHelpTitle").textContent = meta.title;
    document.getElementById("gameHelpDesc").textContent = meta.desc;
    document.getElementById("gameHelpBackdrop").classList.remove("hidden");
    const card = document.querySelector("#gameHelpBackdrop .modal-card");
    if (card) card.focus();
  }

  function hideGameHelp() {
    document.getElementById("gameHelpBackdrop").classList.add("hidden");
    const trigger = document.getElementById("gameHelpBtn");
    if (trigger) trigger.focus();
  }

  // Bound once - these are static elements outside #app that never get
  // destroyed/recreated by render(), unlike everything inside #app.
  function initGameHelp() {
    const btn = document.getElementById("gameHelpBtn");
    const closeBtn = document.getElementById("closeGameHelpBtn");
    const backdrop = document.getElementById("gameHelpBackdrop");
    if (btn) btn.addEventListener("click", showGameHelp);
    if (closeBtn) closeBtn.addEventListener("click", hideGameHelp);
    if (backdrop) backdrop.addEventListener("click", (e) => { if (e.target === backdrop) hideGameHelp(); });
  }

  function renderScreen() {
    if (!room) {
      app.innerHTML = homeScreen();
      bindHome();
      return;
    }
    if (room.state === "lobby") {
      app.innerHTML = lobbyScreen(room);
      bindLobby();
      return;
    }
    if (room.currentGame === "headsup") {
      app.innerHTML = headsUpScreen(room);
      bindHeadsUp();
      return;
    }
    if (room.currentGame === "promptbattle") {
      app.innerHTML = promptBattleScreen(room);
      bindPromptBattle();
      return;
    }
    if (room.currentGame === "wordbomb") {
      app.innerHTML = wordBombScreen(room);
      bindWordBomb();
      return;
    }
    if (room.currentGame === "fib") {
      app.innerHTML = fibScreen(room);
      bindFib();
      return;
    }
    if (room.currentGame === "triviasurvival") {
      app.innerHTML = triviaSurvivalScreen(room);
      bindTriviaSurvival();
      return;
    }
    if (room.currentGame === "doodle") {
      app.innerHTML = doodleScreen(room);
      bindDoodle();
      return;
    }
    if (room.currentGame === "twotruths") {
      app.innerHTML = twoTruthsScreen(room);
      bindTwoTruths();
      return;
    }
    if (room.currentGame === "drawit") {
      app.innerHTML = drawItScreen(room);
      bindDrawIt();
      return;
    }
    if (room.currentGame && ROUND_GAME_TYPES.includes(room.currentGame)) {
      app.innerHTML = roundGameScreen(room);
      bindRoundGame();
      return;
    }
    app.innerHTML = lobbyScreen(room);
    bindLobby();
  }

  // ---------------- Shared: game list + settings fields ----------------

  function gameListHtml(dataAttr) {
    return `
      <input type="text" id="gameSearchInput" class="game-search-input"
        placeholder="🔍 Search ${Object.keys(GAME_META).length} games…" autocomplete="off"
        aria-label="Search games" />
      <div class="game-list">
        ${Object.entries(GAME_META).map(([id, meta]) => `
          <div class="game-row" ${dataAttr}="${id}" role="button" tabindex="0" aria-label="${meta.title}: ${meta.desc}">
            <span class="icon">${meta.icon}</span>
            <div class="game-row-text">
              <strong>${meta.title}</strong>
              <div class="hint">${meta.desc}</div>
            </div>
            <span class="chevron">›</span>
          </div>
        `).join("")}
      </div>
      <p class="hint game-search-empty" id="gameSearchEmpty" style="display:none;">
        No games match your search.
      </p>
    `;
  }

  // Shared by the "browse" screen and the lobby's "change game" view - both
  // render gameListHtml(), so both need the same live filter wired up.
  // Filters by hand (show/hide rows on 'input') rather than re-rendering
  // the screen on every keystroke.
  function bindGameSearch() {
    const input = document.getElementById("gameSearchInput");
    if (!input) return;
    const rows = [...document.querySelectorAll(".game-row")];
    const emptyMsg = document.getElementById("gameSearchEmpty");
    input.value = gameSearchQuery;
    // Screen readers get nothing from the show/hide-rows filtering above on
    // their own - a sighted player sees the list shrink instantly, but
    // nothing here is announced, so a screen reader user typing a query has
    // no way to know how many (if any) games still match without manually
    // re-navigating the whole list after every keystroke. Reuses the same
    // shared live region the screen-transition announcer above uses -
    // debounced so it announces once after the user pauses typing, not once
    // per keystroke. searchAnnounceTimer is module-scoped, not local: if the
    // user clicks a game row before the debounce fires, render()'s own
    // isNewScreen branch cancels this timer, so a stale "N games match"
    // callback can't fire ~400ms later and clobber the screen-transition
    // heading it just announced.
    const applyFilter = () => {
      gameSearchQuery = input.value;
      const q = gameSearchQuery.trim().toLowerCase();
      let matchCount = 0;
      rows.forEach((row) => {
        const matches = !q || row.textContent.toLowerCase().includes(q);
        row.style.display = matches ? "" : "none";
        if (matches) matchCount += 1;
      });
      if (emptyMsg) emptyMsg.style.display = matchCount ? "none" : "";
      if (screenAnnouncerEl) {
        clearTimeout(searchAnnounceTimer);
        searchAnnounceTimer = setTimeout(() => {
          screenAnnouncerEl.textContent = q
            ? matchCount
              ? `${matchCount} game${matchCount === 1 ? " matches" : "s match"} "${gameSearchQuery.trim()}"`
              : `No games match "${gameSearchQuery.trim()}"`
            : "";
        }, 400);
      }
    };
    input.addEventListener("input", applyFilter);
    if (gameSearchQuery) applyFilter(); // re-apply a query carried over from before
  }

  function settingsFieldsHtml(gameId, s, idPrefix) {
    if (gameId === "headsup") {
      return `
        <div class="row wrap" style="margin-bottom:14px;">
          <div style="flex:1;min-width:140px;">
            <label class="hint" style="display:block;margin-bottom:6px;" for="${idPrefix}Duration">Turn length</label>
            <select id="${idPrefix}Duration">
              ${[30, 45, 60, 90].map((v) => `<option value="${v}" ${s.turnDuration === v ? "selected" : ""}>${v} sec</option>`).join("")}
            </select>
          </div>
          <div style="flex:1;min-width:140px;">
            <label class="hint" style="display:block;margin-bottom:6px;" for="${idPrefix}Rounds">Turns per player</label>
            <select id="${idPrefix}Rounds">
              ${[1, 2, 3].map((v) => `<option value="${v}" ${s.roundsPerPlayer === v ? "selected" : ""}>${v}</option>`).join("")}
            </select>
          </div>
        </div>
        <p class="hint" style="margin-bottom:8px;">Categories</p>
        <div class="category-grid">
          ${catalog.headsUpCategories.map((c) => {
            const count = catalog.headsUpCategoryCounts && catalog.headsUpCategoryCounts[c];
            return `
            <label>
              <input type="checkbox" class="${idPrefix}Cat" value="${escapeHtml(c)}" ${s.categories.includes(c) ? "checked" : ""} />
              ${escapeHtml(c)}${count ? ` <span class="hint">(${count})</span>` : ""}
            </label>
          `;
          }).join("")}
        </div>
      `;
    }
    if (gameId === "promptbattle") {
      return `
        <label class="hint" style="display:block;margin-bottom:6px;" for="${idPrefix}Rounds">Number of rounds</label>
        <select id="${idPrefix}Rounds">
          ${[2, 3, 4, 5, 6].map((v) => `<option value="${v}" ${s.rounds === v ? "selected" : ""}>${v}</option>`).join("")}
        </select>
      `;
    }
    if (gameId === "wordbomb") {
      return `
        <div class="row wrap">
          <div style="flex:1;min-width:140px;">
            <label class="hint" style="display:block;margin-bottom:6px;" for="${idPrefix}TurnTime">Turn time</label>
            <select id="${idPrefix}TurnTime">
              ${[7, 10, 15, 20].map((v) => `<option value="${v}" ${s.turnTimeSeconds === v ? "selected" : ""}>${v} sec</option>`).join("")}
            </select>
          </div>
          <div style="flex:1;min-width:140px;">
            <label class="hint" style="display:block;margin-bottom:6px;" for="${idPrefix}Lives">Starting lives</label>
            <select id="${idPrefix}Lives">
              ${[1, 2, 3, 4].map((v) => `<option value="${v}" ${s.startingLives === v ? "selected" : ""}>${v}</option>`).join("")}
            </select>
          </div>
        </div>
      `;
    }
    if (gameId === "fib") {
      return `
        <div class="row wrap">
          <div style="flex:1;min-width:140px;">
            <label class="hint" style="display:block;margin-bottom:6px;" for="${idPrefix}Rounds">Rounds</label>
            <select id="${idPrefix}Rounds">
              ${[2, 3, 4, 5, 6].map((v) => `<option value="${v}" ${s.rounds === v ? "selected" : ""}>${v}</option>`).join("")}
            </select>
          </div>
          <div style="flex:1;min-width:140px;">
            <label class="hint" style="display:block;margin-bottom:6px;" for="${idPrefix}Time">Time to lie</label>
            <select id="${idPrefix}Time">
              ${[30, 45, 60, 75, 90].map((v) => `<option value="${v}" ${s.answerTime === v ? "selected" : ""}>${v} sec</option>`).join("")}
            </select>
          </div>
        </div>
      `;
    }
    if (gameId === "triviasurvival") {
      return `
        <div class="row wrap">
          <div style="flex:1;min-width:140px;">
            <label class="hint" style="display:block;margin-bottom:6px;" for="${idPrefix}Lives">Starting lives</label>
            <select id="${idPrefix}Lives">
              ${[1, 2, 3, 4].map((v) => `<option value="${v}" ${s.startingLives === v ? "selected" : ""}>${v}</option>`).join("")}
            </select>
          </div>
          <div style="flex:1;min-width:140px;">
            <label class="hint" style="display:block;margin-bottom:6px;" for="${idPrefix}Time">Time per question</label>
            <select id="${idPrefix}Time">
              ${[10, 15, 20, 30].map((v) => `<option value="${v}" ${s.answerTime === v ? "selected" : ""}>${v} sec</option>`).join("")}
            </select>
          </div>
        </div>
      `;
    }
    if (gameId === "doodle") {
      return `
        <div class="row wrap">
          <div style="flex:1;min-width:140px;">
            <label class="hint" style="display:block;margin-bottom:6px;" for="${idPrefix}Rounds">Turns per player</label>
            <select id="${idPrefix}Rounds">
              ${[1, 2].map((v) => `<option value="${v}" ${s.roundsPerPlayer === v ? "selected" : ""}>${v}</option>`).join("")}
            </select>
          </div>
          <div style="flex:1;min-width:140px;">
            <label class="hint" style="display:block;margin-bottom:6px;" for="${idPrefix}DrawTime">Drawing time</label>
            <select id="${idPrefix}DrawTime">
              ${[45, 60, 70, 90, 120].map((v) => `<option value="${v}" ${s.drawSeconds === v ? "selected" : ""}>${v} sec</option>`).join("")}
            </select>
          </div>
        </div>
      `;
    }
    if (gameId === "twotruths") {
      return `
        <div class="row wrap">
          <div style="flex:1;min-width:140px;">
            <label class="hint" style="display:block;margin-bottom:6px;" for="${idPrefix}WriteTime">Time to write</label>
            <select id="${idPrefix}WriteTime">
              ${[30, 45, 60, 90, 120].map((v) => `<option value="${v}" ${s.writeSeconds === v ? "selected" : ""}>${v} sec</option>`).join("")}
            </select>
          </div>
          <div style="flex:1;min-width:140px;">
            <label class="hint" style="display:block;margin-bottom:6px;" for="${idPrefix}GuessTime">Time to guess</label>
            <select id="${idPrefix}GuessTime">
              ${[10, 15, 20, 30, 45].map((v) => `<option value="${v}" ${s.guessSeconds === v ? "selected" : ""}>${v} sec</option>`).join("")}
            </select>
          </div>
        </div>
      `;
    }
    if (gameId === "drawit") {
      return `
        <div class="row wrap">
          <div style="flex:1;min-width:140px;">
            <label class="hint" style="display:block;margin-bottom:6px;" for="${idPrefix}Rounds">Rounds</label>
            <select id="${idPrefix}Rounds">
              ${[2, 3, 4, 5].map((v) => `<option value="${v}" ${s.rounds === v ? "selected" : ""}>${v}</option>`).join("")}
            </select>
          </div>
          <div style="flex:1;min-width:140px;">
            <label class="hint" style="display:block;margin-bottom:6px;" for="${idPrefix}DrawTime">Drawing time</label>
            <select id="${idPrefix}DrawTime">
              ${[30, 45, 60, 90, 120].map((v) => `<option value="${v}" ${s.drawSeconds === v ? "selected" : ""}>${v} sec</option>`).join("")}
            </select>
          </div>
          <div style="flex:1;min-width:140px;">
            <label class="hint" style="display:block;margin-bottom:6px;" for="${idPrefix}VoteTime">Voting time</label>
            <select id="${idPrefix}VoteTime">
              ${[10, 15, 25, 30, 45].map((v) => `<option value="${v}" ${s.voteSeconds === v ? "selected" : ""}>${v} sec</option>`).join("")}
            </select>
          </div>
        </div>
      `;
    }
    // trivia, wouldyourather, mostlikelyto, emoji, category, pollguess, anagram, oddoneout,
    // quickmath, neverhaveiever, riddle, countdownletters share rounds+answerTime
    return `
      <div class="row wrap">
        <div style="flex:1;min-width:140px;">
          <label class="hint" style="display:block;margin-bottom:6px;" for="${idPrefix}Rounds">Rounds</label>
          <select id="${idPrefix}Rounds">
            ${[3, 4, 5, 6, 8, 10].map((v) => `<option value="${v}" ${s.rounds === v ? "selected" : ""}>${v}</option>`).join("")}
          </select>
        </div>
        <div style="flex:1;min-width:140px;">
          <label class="hint" style="display:block;margin-bottom:6px;" for="${idPrefix}Time">Time per round</label>
          <select id="${idPrefix}Time">
            ${[10, 15, 20, 30, 45, 60].map((v) => `<option value="${v}" ${s.answerTime === v ? "selected" : ""}>${v} sec</option>`).join("")}
          </select>
        </div>
      </div>
    `;
  }

  function bindSettingsFields(gameId, idPrefix, apply) {
    if (gameId === "headsup") {
      const dur = document.getElementById(idPrefix + "Duration");
      if (dur) dur.addEventListener("change", () => apply({ turnDuration: Number(dur.value) }));
      const rounds = document.getElementById(idPrefix + "Rounds");
      if (rounds) rounds.addEventListener("change", () => apply({ roundsPerPlayer: Number(rounds.value) }));
      document.querySelectorAll("." + idPrefix + "Cat").forEach((cb) => {
        cb.addEventListener("change", () => {
          const checked = [...document.querySelectorAll("." + idPrefix + "Cat:checked")].map((c) => c.value);
          if (!checked.length) {
            cb.checked = true;
            showToast("Keep at least one category.");
            return;
          }
          apply({ categories: checked });
        });
      });
      return;
    }
    if (gameId === "promptbattle") {
      const rounds = document.getElementById(idPrefix + "Rounds");
      if (rounds) rounds.addEventListener("change", () => apply({ rounds: Number(rounds.value) }));
      return;
    }
    if (gameId === "wordbomb") {
      const tt = document.getElementById(idPrefix + "TurnTime");
      if (tt) tt.addEventListener("change", () => apply({ turnTimeSeconds: Number(tt.value) }));
      const lv = document.getElementById(idPrefix + "Lives");
      if (lv) lv.addEventListener("change", () => apply({ startingLives: Number(lv.value) }));
      return;
    }
    if (gameId === "triviasurvival") {
      const lv = document.getElementById(idPrefix + "Lives");
      if (lv) lv.addEventListener("change", () => apply({ startingLives: Number(lv.value) }));
      const time = document.getElementById(idPrefix + "Time");
      if (time) time.addEventListener("change", () => apply({ answerTime: Number(time.value) }));
      return;
    }
    if (gameId === "doodle") {
      const rounds = document.getElementById(idPrefix + "Rounds");
      if (rounds) rounds.addEventListener("change", () => apply({ roundsPerPlayer: Number(rounds.value) }));
      const dt = document.getElementById(idPrefix + "DrawTime");
      if (dt) dt.addEventListener("change", () => apply({ drawSeconds: Number(dt.value) }));
      return;
    }
    if (gameId === "twotruths") {
      const wt = document.getElementById(idPrefix + "WriteTime");
      if (wt) wt.addEventListener("change", () => apply({ writeSeconds: Number(wt.value) }));
      const gt = document.getElementById(idPrefix + "GuessTime");
      if (gt) gt.addEventListener("change", () => apply({ guessSeconds: Number(gt.value) }));
      return;
    }
    if (gameId === "drawit") {
      const rounds = document.getElementById(idPrefix + "Rounds");
      if (rounds) rounds.addEventListener("change", () => apply({ rounds: Number(rounds.value) }));
      const dt = document.getElementById(idPrefix + "DrawTime");
      if (dt) dt.addEventListener("change", () => apply({ drawSeconds: Number(dt.value) }));
      const vt = document.getElementById(idPrefix + "VoteTime");
      if (vt) vt.addEventListener("change", () => apply({ voteSeconds: Number(vt.value) }));
      return;
    }
    // fib, and the shared trivia/wouldyourather/mostlikelyto/emoji/category/pollguess/anagram/oddoneout/quickmath shape
    const rounds = document.getElementById(idPrefix + "Rounds");
    if (rounds) rounds.addEventListener("change", () => apply({ rounds: Number(rounds.value) }));
    const time = document.getElementById(idPrefix + "Time");
    if (time) time.addEventListener("change", () => apply({ answerTime: Number(time.value) }));
  }

  // ---------------- Home ----------------

  function homeScreen() {
    if (homeStep === "configure" && homeConfigGame) return homeConfigureScreen(homeConfigGame);
    if (homeStep === "browse") return homeBrowseScreen();
    if (homeStep === "join") return homeJoinScreen();
    return homeLandingScreen();
  }

  function homeLandingScreen() {
    return `
      <div class="brand">
        <div class="mark">🎲</div>
        <h1>Party Games</h1>
        <p>The party doesn't need an app — just a link.</p>
        <span class="pill">${Object.keys(GAME_META).length} games and counting</span>
      </div>
      <div class="card">
        <label class="hint" style="text-align:left;display:block;margin-bottom:6px;">Your name</label>
        <input id="nameInput" type="text" placeholder="e.g. Sam" maxlength="20" value="${escapeHtml(draftName)}" />
      </div>
      <div class="stack">
        <button id="goCreateBtn" class="btn-primary btn-block btn-lg">🎮 Create Room</button>
        <button id="goJoinBtn" class="btn-success btn-block btn-lg">🚪 Join Room</button>
      </div>
      <p class="hint">Works great with friends on their phones — one link, no app to install.</p>
      <button id="howItWorksBtn" class="btn-ghost" style="margin: 4px auto 0;">❓ How does this work?</button>
      ${showHowItWorks ? howItWorksModal() : ""}
    `;
  }

  function howItWorksModal() {
    const steps = [
      ["🙋", "One person hosts", "They tap Create Room, pick a game, and land in a lobby with a room code."],
      ["📱", "Everyone else joins", "Type the code (or scan the QR code / tap the link) on your own phone — no app, no install."],
      ["🎮", "Play together", "Everyone answers, draws, or votes from their own screen while the shared game plays out."],
      ["🏆", "See who wins", "Scores tally up after every round, with a final leaderboard at the end."]
    ];
    return `
      <div class="modal-backdrop" id="howItWorksBackdrop">
        <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="howItWorksTitle" tabindex="-1">
          <button id="closeHowItWorksBtn" class="btn-ghost modal-close" aria-label="Close">✕</button>
          <h2 id="howItWorksTitle" style="margin-bottom:14px;">How it works</h2>
          <div class="stack">
            ${steps.map(([icon, title, desc]) => `
              <div class="row" style="align-items:flex-start;gap:14px;">
                <div style="font-size:26px;line-height:1;">${icon}</div>
                <div>
                  <strong style="display:block;margin-bottom:2px;font-family:'Space Grotesk',sans-serif;">${title}</strong>
                  <span class="hint" style="text-align:left;display:block;margin:0;">${desc}</span>
                </div>
              </div>
            `).join("")}
          </div>
          <button id="gotItBtn" class="btn-primary btn-block" style="margin-top:18px;">Got it!</button>
        </div>
      </div>
    `;
  }

  function homeJoinScreen() {
    return `
      <div class="brand" style="margin:8px 0 16px;">
        <div class="mark">🚪</div>
        <h1>Join a Room</h1>
      </div>
      <div class="card">
        <button id="backToLandingBtn" class="btn-ghost" style="margin-bottom:10px;">‹ Back</button>
        <label class="hint" style="text-align:left;display:block;margin-bottom:6px;">Your name</label>
        <input id="nameInput" type="text" placeholder="e.g. Sam" maxlength="20" value="${escapeHtml(draftName)}" />
      </div>
      <div class="card stack">
        <label class="hint" style="text-align:left;display:block;margin-bottom:-4px;">Room code</label>
        <input id="codeInput" type="text" placeholder="ROOM CODE" maxlength="4" style="text-transform:uppercase;letter-spacing:4px;text-align:center;font-weight:700;" value="${escapeHtml(prefillCode)}" />
        <label class="hint" style="text-align:left;display:block;margin:2px 0 -4px;">Password <span style="color:var(--text-faint);">(only if the host set one)</span></label>
        <input id="joinPasswordInput" type="password" placeholder="Leave blank if none" maxlength="40" />
        <button id="joinBtn" class="btn-success btn-block btn-lg">🚪 Join Room</button>
      </div>
    `;
  }

  function homeBrowseScreen() {
    return `
      <div class="brand" style="margin:8px 0 16px;">
        <div class="mark">🎮</div>
        <h1>Create a Room</h1>
      </div>
      <div class="card">
        <button id="backToLandingBtn" class="btn-ghost" style="margin-bottom:10px;">‹ Back</button>
        <h3>Choose a game</h3>
        <p class="hint" style="text-align:left;">Tap a game to see how it's played and pick your settings.</p>
        ${gameListHtml("data-browse-game")}
      </div>
    `;
  }

  function homeConfigureScreen(gameId) {
    const meta = GAME_META[gameId];
    const s = homePendingSettings[gameId];
    return `
      <div class="card">
        <button id="backToGamesBtn" class="btn-ghost" style="margin-bottom:10px;">‹ Back to games</button>
        <div style="font-size:40px;">${meta.icon}</div>
        <h2>${meta.title}</h2>
        <p style="text-align:left;">${meta.desc}</p>
      </div>
      <div class="card">
        <h3>Settings</h3>
        ${settingsFieldsHtml(gameId, s, "home")}
      </div>
      <div class="card">
        <div class="switch-row">
          <div class="switch-text">
            <strong>🕶️ Streamer Mode</strong>
            <p class="hint">Blurs the room code on screen so stream viewers can't read it and join. Toggle anytime from the lobby.</p>
          </div>
          <label class="switch">
            <input type="checkbox" id="homeStreamerToggle" ${homeRoomSettings.streamerMode ? "checked" : ""} />
            <span class="slider"></span>
          </label>
        </div>
      </div>
      <div class="card">
        <h3>🔒 Join Password <span class="pill">optional</span></h3>
        <p class="hint" style="text-align:left;margin-top:-4px;">Require a password to join this room. Leave blank for none.</p>
        <input id="homePasswordInput" type="password" placeholder="No password" maxlength="40" value="${escapeHtml(homeRoomSettings.password)}" />
      </div>
      <button id="createBtn" class="btn-primary btn-block btn-lg">🏠 Create Room & Host</button>
    `;
  }

  function bindHome() {
    if (homeStep === "configure" && homeConfigGame) bindHomeConfigure(homeConfigGame);
    else if (homeStep === "browse") bindHomeBrowse();
    else if (homeStep === "join") bindHomeJoin();
    else bindHomeLanding();
  }

  function bindHomeLanding() {
    const nameInput = document.getElementById("nameInput");
    nameInput.addEventListener("input", () => { draftName = nameInput.value; });

    document.getElementById("goCreateBtn").addEventListener("click", () => {
      draftName = nameInput.value || draftName;
      homeStep = "browse";
      render();
    });
    document.getElementById("goJoinBtn").addEventListener("click", () => {
      draftName = nameInput.value || draftName;
      homeStep = "join";
      render();
    });

    document.getElementById("howItWorksBtn").addEventListener("click", () => {
      showHowItWorks = true;
      render();
      const card = document.querySelector("#howItWorksBackdrop .modal-card");
      if (card) card.focus();
    });

    const backdrop = document.getElementById("howItWorksBackdrop");
    if (backdrop) {
      document.getElementById("closeHowItWorksBtn").addEventListener("click", closeHowItWorksModal);
      document.getElementById("gotItBtn").addEventListener("click", closeHowItWorksModal);
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeHowItWorksModal(); });
    }
  }

  function bindHomeJoin() {
    const nameInput = document.getElementById("nameInput");
    nameInput.addEventListener("input", () => { draftName = nameInput.value; });
    const codeInput = document.getElementById("codeInput");
    codeInput.addEventListener("input", () => {
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    });

    document.getElementById("backToLandingBtn").addEventListener("click", () => {
      draftName = nameInput.value || draftName;
      homeStep = "landing";
      render();
    });

    const passwordInput = document.getElementById("joinPasswordInput");

    const doJoin = () => {
      const name = nameInput.value.trim() || "Player";
      const code = codeInput.value.trim().toUpperCase();
      const password = passwordInput.value;
      if (code.length !== 4) {
        showToast("Enter a 4-letter room code.");
        return;
      }
      draftName = name;
      session.name = name;
      if (joining) return;
      joining = true;
      socket.emit("join-room", { roomCode: code, name, password }, (res) => {
        joining = false;
        if (res && res.ok) {
          session.token = res.token;
          session.secret = res.secret;
          session.roomCode = res.roomCode;
          saveSession();
        } else {
          showToast((res && res.error) || "Couldn't join room.");
          if (res && res.needsPassword) {
            passwordInput.focus();
          }
        }
      });
    };

    document.getElementById("joinBtn").addEventListener("click", doJoin);
    onEnter(nameInput, doJoin);
    onEnter(codeInput, doJoin);
    onEnter(passwordInput, doJoin);
  }

  function bindHomeBrowse() {
    document.getElementById("backToLandingBtn").addEventListener("click", () => {
      homeStep = "landing";
      render();
    });

    document.querySelectorAll("[data-browse-game]").forEach((el) => {
      el.addEventListener("click", () => {
        homeConfigGame = el.dataset.browseGame;
        homeStep = "configure";
        render();
      });
    });
    bindGameSearch();
  }

  function bindHomeConfigure(gameId) {
    document.getElementById("backToGamesBtn").addEventListener("click", () => {
      homeStep = "browse";
      render();
    });

    bindSettingsFields(gameId, "home", (patch) => {
      Object.assign(homePendingSettings[gameId], patch);
    });

    const streamerToggle = document.getElementById("homeStreamerToggle");
    streamerToggle.addEventListener("change", () => {
      homeRoomSettings.streamerMode = streamerToggle.checked;
    });
    const passwordInput = document.getElementById("homePasswordInput");
    passwordInput.addEventListener("input", () => {
      homeRoomSettings.password = passwordInput.value;
    });
    onEnter(passwordInput, () => document.getElementById("createBtn").click());

    document.getElementById("createBtn").addEventListener("click", () => {
      const name = (draftName || "").trim() || "Player";
      draftName = name;
      session.name = name;
      if (joining) return;
      joining = true;
      socket.emit(
        "create-room",
        {
          name,
          gameId,
          settings: { [gameId]: homePendingSettings[gameId] },
          roomSettings: { streamerMode: homeRoomSettings.streamerMode, password: homeRoomSettings.password }
        },
        (res) => {
          joining = false;
          if (res && res.ok) {
            session.token = res.token;
            session.secret = res.secret;
            session.roomCode = res.roomCode;
            saveSession();
          } else {
            showToast((res && res.error) || "Couldn't create room.");
          }
        }
      );
    });
  }

  // ---------------- Lobby ----------------

  // Tracks each player's last-seen score so a fresh increase can get a
  // little "bump" highlight instead of just silently updating the number.
  let previousScores = new Map();

  // A stable-but-arbitrary color per player, purely visual (never sent to or
  // read from the server) - just makes the player list a little easier to
  // scan at a glance, no avatar-picker UI required.
  const AVATAR_COLORS = ["#FF4B3E", "#FFC53D", "#2FD98A", "#4FC8E8", "#B084F0", "#FF7EB6", "#66D9C2", "#F2994A"];
  function avatarColor(token) {
    let hash = 0;
    for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[hash % AVATAR_COLORS.length];
  }

  function playerListHtml(players, { hostControls = false } = {}) {
    const html = `
      <ul class="player-list">
        ${players.map((p) => {
          const prev = previousScores.get(p.token);
          const bumped = typeof prev === "number" && p.score > prev;
          const initial = (p.name || "?").trim().charAt(0).toUpperCase() || "?";
          return `
          <li class="${bumped ? "score-bumped" : ""}">
            <span class="avatar" style="background:${avatarColor(p.token)}">${escapeHtml(initial)}</span>
            <span class="dot ${p.connected ? "" : "off"}"></span>
            <span class="name">${escapeHtml(p.name)}</span>
            ${p.isHost ? '<span class="badge-host">HOST</span>' : ""}
            <span class="spacer"></span>
            <span class="score">${p.score}${bumped ? `<span class="score-delta">+${p.score - prev}</span>` : ""}</span>
            ${hostControls && !p.isHost ? `
              <button class="kick-btn host-btn ${pendingHostToken === p.token ? "confirm" : ""}" data-make-host="${p.token}" title="Make ${escapeHtml(p.name)} host" aria-label="Make ${escapeHtml(p.name)} host" ${p.connected ? "" : "disabled"}>
                ${pendingHostToken === p.token ? "Sure?" : "👑"}
              </button>
              <button class="kick-btn ${pendingKickToken === p.token ? "confirm" : ""}" data-kick="${p.token}" title="Kick ${escapeHtml(p.name)}" aria-label="Kick ${escapeHtml(p.name)}">
                ${pendingKickToken === p.token ? "Kick?" : "✕"}
              </button>
            ` : ""}
          </li>
        `;
        }).join("")}
      </ul>
    `;
    players.forEach((p) => previousScores.set(p.token, p.score));
    return html;
  }

  function lobbyScreen(room) {
    const codeClasses = ["room-code"];
    if (room.streamerMode) codeClasses.push("blurred");
    if (room.streamerMode && roomCodeRevealed) codeClasses.push("revealed");
    return `
      <div class="brand" style="margin:8px 0 16px;">
        <div class="mark">🎲</div>
      </div>
      <div class="card center">
        <p class="hint" style="margin-bottom:2px;">ROOM CODE</p>
        <div class="${codeClasses.join(" ")}" id="roomCodeText" title="${room.streamerMode ? "" : "Tap to copy"}">${room.code}</div>
        ${room.streamerMode ? `<p class="streamer-hint">🕶️ Streamer mode is on — tap the code to peek</p>` : `
          <img class="qr-code" src="/api/qr/${room.code}" width="120" height="120" alt="QR code to join this room" />
        `}
        <button id="copyBtn" class="btn-ghost">${navigator.share ? "📤 Share invite link" : "🔗 Copy invite link"}</button>
      </div>
      <div class="card">
        <h3>Players (${room.players.length})</h3>
        ${playerListHtml(room.players, { hostControls: room.isHost })}
      </div>
      ${room.isHost ? `
        <div class="tab-bar">
          <button class="tab-btn ${lobbyTab === "game" ? "active" : ""}" data-lobby-tab="game">🎮 Game</button>
          <button class="tab-btn ${lobbyTab === "room" ? "active" : ""}" data-lobby-tab="room">⚙️ Room Settings</button>
        </div>
        ${lobbyTab === "room" ? roomSettingsPanel(room) : hostGameFlow(room)}
      ` : guestWaiting(room)}
      ${leaveFooter()}
    `;
  }

  function roomSettingsPanel(room) {
    return `
      <div class="card">
        <div class="switch-row">
          <div class="switch-text">
            <strong>🕶️ Streamer Mode</strong>
            <p class="hint">Blurs the room code above so viewers watching your stream can't read it and join. Tap the code to peek at it yourself.</p>
          </div>
          <label class="switch">
            <input type="checkbox" id="streamerToggle" ${room.streamerMode ? "checked" : ""} />
            <span class="slider"></span>
          </label>
        </div>
      </div>
      <div class="card">
        <h3>🔒 Join Password</h3>
        <p class="password-status ${room.hasPassword ? "" : "off"}">${room.hasPassword ? "A password is set — new players must enter it to join." : "No password — anyone with the room code can join."}</p>
        <input id="roomPasswordInput" type="password" placeholder="${room.hasPassword ? "Enter a new password to change it" : "Leave blank for no password"}" maxlength="40" />
        <div class="row" style="margin-top:10px;">
          <button id="saveRoomPasswordBtn" class="btn-primary btn-block">Save Password</button>
          ${room.hasPassword ? '<button id="clearRoomPasswordBtn" class="btn-ghost">Clear</button>' : ""}
        </div>
      </div>
    `;
  }

  function lobbyShowingBrowse(room) {
    return lobbyForceBrowse || !room.currentGame;
  }

  function hostGameFlow(room) {
    if (lobbyShowingBrowse(room)) {
      return `
        <div class="card">
          <h3>Choose a game</h3>
          <p class="hint" style="text-align:left;">Tap a game to see how it's played and pick your settings.</p>
          ${gameListHtml("data-lobby-game")}
        </div>
      `;
    }
    return hostGameConfigure(room, room.currentGame);
  }

  function hostGameConfigure(room, gameId) {
    const meta = GAME_META[gameId];
    const s = room.settings[gameId];
    return `
      <div class="card">
        <button id="changeGameBtn" class="btn-ghost" style="margin-bottom:10px;">‹ Change game</button>
        <div style="font-size:36px;">${meta.icon}</div>
        <h3>${meta.title}</h3>
        <p class="hint" style="text-align:left;">${meta.desc}</p>
      </div>
      <div class="card">
        <h3>Settings</h3>
        ${settingsFieldsHtml(gameId, s, "lobby")}
      </div>
      <button id="startBtn" class="btn-primary btn-block btn-lg" ${room.players.length < 2 ? "disabled" : ""}>
        ▶ Start Game
      </button>
      ${room.players.length < 2 ? '<p class="hint">Need at least 2 players to start.</p>' : ""}
    `;
  }

  // A random tip picked once per room visit (not re-rolled on every render,
  // which would just be during routine player-list updates) so waiting
  // around for the host doesn't feel completely static.
  const WAITING_TIPS = [
    "Streamer mode blurs the room code on screen so viewers can't sneak in and join.",
    "Tap the room code to copy it, or scan the QR code to join instantly.",
    "The host can hand off control anytime with the 👑 button in the player list.",
    "Hosts can set a join password from Room Settings if it's a private group.",
    "You can mute sound and vibration anytime with the speaker icon in the corner.",
    "Everyone plays from their own phone's browser — nothing to download.",
    "This installs to a phone's home screen too, if you want it one tap away.",
    "Stuck on the rules mid-game? Tap the ❓ button for a quick reminder.",
    "23 games and counting — search the list to jump straight to one you know.",
    "If someone drops out mid-round, the game keeps going instead of leaving everyone waiting on them."
  ];
  let waitingTip = null;
  function pickWaitingTip() {
    if (!waitingTip) waitingTip = WAITING_TIPS[Math.floor(Math.random() * WAITING_TIPS.length)];
    return waitingTip;
  }

  function guestWaiting(room) {
    const g = room.currentGame;
    return `
      <div class="card center">
        ${g ? `
          <p>Host picked <strong>${GAME_META[g].title}</strong> ${GAME_META[g].icon}</p>
          <p class="hint">Waiting for host to start the game${WAIT_DOTS}</p>
        ` : `<p class="hint">Waiting for the host to choose a game${WAIT_DOTS}</p>`}
      </div>
      <p class="hint">💡 ${escapeHtml(pickWaitingTip())}</p>
    `;
  }

  function leaveFooter() {
    return `<footer class="leave"><button id="leaveBtn" class="btn-ghost">Leave room</button></footer>`;
  }

  function bindLeave() {
    const btn = document.getElementById("leaveBtn");
    if (btn) btn.addEventListener("click", () => {
      socket.emit("leave-room");
      clearSession();
    });
  }

  function bindLobby() {
    bindLeave();
    document.getElementById("copyBtn").addEventListener("click", () => {
      const shareUrl = `${location.origin}${location.pathname}?room=${room.code}`;
      if (navigator.share) {
        navigator.share({
          title: "Join my Party Games room!",
          text: `Room code: ${room.code}`,
          url: shareUrl
        }).catch(() => {
          // User dismissed the share sheet, or it's not actually supported
          // here despite feature-detecting true - fall back silently.
        });
        return;
      }
      const fallback = () => showToast(`Room code: ${room.code}`);
      if (navigator.clipboard) {
        navigator.clipboard.writeText(shareUrl).then(
          () => showToast("Invite link copied!", "success"),
          fallback
        );
      } else {
        // No share sheet, no clipboard API at all (e.g. not a secure
        // context) - same silent-tap problem as the room-code button below,
        // same fix: at least surface the code so there's a way to get it.
        fallback();
      }
    });

    const codeEl = document.getElementById("roomCodeText");
    if (room.streamerMode) {
      codeEl.addEventListener("click", () => {
        clearTimeout(revealTimer);
        if (roomCodeRevealed) {
          // Already showing - a second tap hides it again immediately,
          // rather than just restarting the same 4s auto-hide countdown.
          roomCodeRevealed = false;
          render();
          return;
        }
        roomCodeRevealed = true;
        render();
        revealTimer = setTimeout(() => {
          roomCodeRevealed = false;
          render();
        }, 4000);
      });
    } else {
      codeEl.addEventListener("click", () => {
        // Unlike the invite-link button above, this had a silent no-op on
        // failure (empty rejection handler) - a tap that visibly does
        // nothing looks broken, not "already copied". Same fallback as
        // the invite link: show the code itself so there's still a way to
        // get it, whether writeText rejected or navigator.clipboard isn't
        // available at all (e.g. no secure context).
        const fallback = () => showToast(`Room code: ${room.code}`);
        if (navigator.clipboard) {
          navigator.clipboard.writeText(room.code).then(
            () => showToast("Room code copied!", "success"),
            fallback
          );
        } else {
          fallback();
        }
      });
    }

    document.querySelectorAll("[data-kick]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const token = el.dataset.kick;
        if (pendingKickToken === token) {
          clearTimeout(pendingKickTimer);
          pendingKickToken = null;
          socket.emit("kick-player", { token });
        } else {
          pendingKickToken = token;
          render();
          clearTimeout(pendingKickTimer);
          pendingKickTimer = setTimeout(() => { pendingKickToken = null; render(); }, 3000);
        }
      });
    });

    document.querySelectorAll("[data-make-host]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const token = el.dataset.makeHost;
        if (pendingHostToken === token) {
          clearTimeout(pendingHostTimer);
          pendingHostToken = null;
          socket.emit("transfer-host", { token });
        } else {
          pendingHostToken = token;
          render();
          clearTimeout(pendingHostTimer);
          pendingHostTimer = setTimeout(() => { pendingHostToken = null; render(); }, 3000);
        }
      });
    });

    if (!room.isHost) return;

    document.querySelectorAll("[data-lobby-tab]").forEach((el) => {
      el.addEventListener("click", () => {
        lobbyTab = el.dataset.lobbyTab;
        render();
      });
    });

    if (lobbyTab === "room") {
      const streamerToggle = document.getElementById("streamerToggle");
      streamerToggle.addEventListener("change", () => {
        socket.emit("update-room-settings", { streamerMode: streamerToggle.checked });
      });

      const savePassword = () => {
        const val = document.getElementById("roomPasswordInput").value;
        socket.emit("update-room-settings", { password: val });
        showToast(val.trim() ? "Password set!" : "Password cleared!", "success");
      };
      document.getElementById("saveRoomPasswordBtn").addEventListener("click", savePassword);
      onEnter(document.getElementById("roomPasswordInput"), savePassword);

      const clearBtn = document.getElementById("clearRoomPasswordBtn");
      if (clearBtn) clearBtn.addEventListener("click", () => {
        socket.emit("update-room-settings", { password: "" });
        showToast("Password cleared!", "success");
      });
      return;
    }

    if (lobbyShowingBrowse(room)) {
      document.querySelectorAll("[data-lobby-game]").forEach((el) => {
        el.addEventListener("click", () => {
          lobbyForceBrowse = false;
          socket.emit("select-game", { gameId: el.dataset.lobbyGame });
        });
      });
      bindGameSearch();
      return;
    }

    document.getElementById("changeGameBtn").addEventListener("click", () => {
      lobbyForceBrowse = true;
      render();
    });

    const startBtn = document.getElementById("startBtn");
    if (startBtn) startBtn.addEventListener("click", () => socket.emit("start-game"));

    bindSettingsFields(room.currentGame, "lobby", (patch) => {
      socket.emit("update-settings", { [room.currentGame]: patch });
    });
  }

  // ---------------- Shared: finished screen + score strip ----------------

  function finishedScreen(room) {
    const sorted = room.players; // already sorted by score server-side (playerList())
    const maxScore = Math.max(1, ...sorted.map((p) => p.score));
    const medals = ["🥇", "🥈", "🥉"];
    // A stable sort preserves join order for tied scores, so "whoever's
    // first in the array" isn't "the winner" - it's just whoever joined
    // first. Standard competition ranking instead: tied players share a
    // rank, and the next distinct score skips accordingly (1st, 1st, 3rd -
    // not 1st, 2nd, 3rd), so every tied player gets the same medal *and*
    // the gold "is-winner" treatment, not just whichever one sorted first.
    let rank = 0;
    return `
      <div class="brand" style="margin:8px 0 16px;"><div class="mark gold">🏆</div><h1>Final Scores</h1></div>
      <div class="card">
        <div class="leaderboard">
          ${sorted.map((p, i) => {
            if (i === 0 || p.score !== sorted[i - 1].score) rank = i;
            const isTopScore = p.score === maxScore && p.score > 0;
            return `
            <div class="leaderboard-row ${isTopScore ? "is-winner" : ""}">
              <span class="lb-rank">${medals[rank] || `#${rank + 1}`}</span>
              <div class="lb-main">
                <div class="lb-name">${escapeHtml(p.name)}</div>
                <div class="lb-bar-track"><div class="lb-bar" style="width:${Math.max(6, Math.round((p.score / maxScore) * 100))}%"></div></div>
              </div>
              <span class="lb-score">${p.score}</span>
            </div>
          `;
          }).join("")}
        </div>
      </div>
      ${room.isHost ? `
        <div class="row">
          <button id="playAgainBtn" class="btn-success btn-block">🔁 Play Again</button>
          <button id="newGameBtn" class="btn-primary btn-block">🎲 New Game</button>
        </div>
      ` : `<div class="card center"><p class="hint">Waiting for host${WAIT_DOTS}</p></div>`}
      ${leaveFooter()}
    `;
  }

  function bindFinished() {
    bindLeave();
    const pa = document.getElementById("playAgainBtn");
    if (pa) pa.addEventListener("click", () => { resetTTDraft(); socket.emit("play-again"); });
    const ng = document.getElementById("newGameBtn");
    if (ng) ng.addEventListener("click", () => { resetTTDraft(); socket.emit("return-to-lobby"); });
  }

  function scoreStrip(room) {
    return `
      <div class="card">
        <h3 style="margin-bottom:6px;">Scores</h3>
        ${playerListHtml(room.players)}
      </div>
    `;
  }

  // ---------------- Heads Up ----------------

  function headsUpScreen(room) {
    if (room.state === "finished") return finishedScreen(room);
    const h = room.headsUp;
    const timerClass = h.timeLeft <= 10 ? "timer low" : "timer";

    let body = "";
    if (h.phase === "ready") {
      body = h.isPerformer ? `
        <div class="card center">
          <h2>You're up! 🙈</h2>
          <p>Hand your device to someone else to hold, or turn your screen away. When you're ready, tap start — you won't see the word.</p>
          <button id="startTurnBtn" class="btn-primary btn-block btn-lg">Start My Turn</button>
        </div>
      ` : `
        <div class="card center">
          <h2>${escapeHtml(h.performerName)} is up next</h2>
          <p class="hint">Get ready to give clues once they start!</p>
        </div>
      `;
    } else if (h.phase === "active") {
      body = h.isPerformer ? `
        <div class="${timerClass}">${h.timeLeft}</div>
        <div class="word-card">🙈 Don't peek!<br/>Listen for clues</div>
        <p class="center hint">Correct so far: ${h.correctCount}</p>
      ` : `
        <div class="${timerClass}">${h.timeLeft}</div>
        <p class="center hint">${escapeHtml(h.performerName)} is guessing — give them clues!</p>
        <div class="word-card">${escapeHtml(h.word || "")}</div>
        <div class="row">
          <button id="skipBtn" class="btn-danger btn-block btn-lg">⏭ Skip</button>
          <button id="correctBtn" class="btn-success btn-block btn-lg">✅ Got it!</button>
        </div>
        <p class="center hint">Correct so far: ${h.correctCount}</p>
      `;
    } else if (h.phase === "summary") {
      body = `
        <div class="card">
          <h2>${escapeHtml(h.performerName)}'s turn: +${h.correctCount * 100} pts</h2>
          <p class="hint">✅ Correct (${h.correctWords.length})</p>
          <p>${h.correctWords.map((w) => escapeHtml(w)).join(", ") || "—"}</p>
          <p class="hint">⏭ Skipped (${h.passedWords.length})</p>
          <p>${h.passedWords.map((w) => escapeHtml(w)).join(", ") || "—"}</p>
        </div>
        ${room.isHost ? `<button id="nextTurnBtn" class="btn-primary btn-block btn-lg">Next Turn ▶</button>` : `<p class="hint center">Waiting for host to continue${WAIT_DOTS}</p>`}
      `;
    }

    return `
      <div class="center hint" style="margin-bottom:6px;">Turn ${h.turnNumber} of ${h.totalTurns}</div>
      ${body}
      ${scoreStrip(room)}
      ${leaveFooter()}
    `;
  }

  function bindHeadsUp() {
    if (room.state === "finished") return bindFinished();
    bindLeave();
    const start = document.getElementById("startTurnBtn");
    if (start) start.addEventListener("click", () => socket.emit("headsup:start-turn"));
    const correct = document.getElementById("correctBtn");
    if (correct) correct.addEventListener("click", () => socket.emit("headsup:answer", { correct: true }));
    const skip = document.getElementById("skipBtn");
    if (skip) skip.addEventListener("click", () => socket.emit("headsup:answer", { correct: false }));
    const next = document.getElementById("nextTurnBtn");
    if (next) next.addEventListener("click", () => socket.emit("headsup:next-turn"));
  }

  // ---------------- Prompt Battle ----------------

  function promptBattleScreen(room) {
    if (room.state === "finished") return finishedScreen(room);
    const p = room.promptBattle;
    const timerClass = p.timeLeft <= 10 ? "timer low" : "timer";
    let body = "";

    if (p.phase === "answering") {
      body = `
        <div class="${timerClass}">${p.timeLeft}</div>
        <div class="card">
          <p class="hint">PROMPT</p>
          <h2>${escapeHtml(p.prompt)}</h2>
        </div>
        ${p.hasAnswered ? `
          <div class="card center">
            <p>✅ Answer submitted!</p>
            <p class="hint">${p.answeredCount}/${p.totalPlayers} answered</p>
          </div>
        ` : `
          <div class="card stack">
            <input id="answerInput" type="text" maxlength="140" placeholder="Type your funniest answer…" />
            <button id="submitAnswerBtn" class="btn-primary btn-block btn-lg">Submit Answer</button>
          </div>
        `}
      `;
    } else if (p.phase === "voting") {
      body = `
        <div class="${timerClass}">${p.timeLeft}</div>
        <div class="card">
          <p class="hint">PROMPT</p>
          <h2>${escapeHtml(p.prompt)}</h2>
        </div>
        ${p.hasVoted ? `<div class="card center"><p>🗳 Vote submitted! Waiting for others${WAIT_DOTS}</p></div>` : `<p class="hint center">Tap your favorite answer</p>`}
        ${(p.answers || []).map((a) => {
          const clickable = !a.isYours && !p.hasVoted;
          return `
          <div class="answer-card ${a.isYours ? "mine" : ""}" ${clickable ? `data-vote="${a.token}" role="button" tabindex="0" aria-label="Vote for: ${escapeHtml(a.text)}"` : ""}>
            ${escapeHtml(a.text)}
            ${a.isYours ? '<div class="author">(yours)</div>' : ""}
          </div>
        `;
        }).join("")}
      `;
    } else if (p.phase === "results") {
      const sorted = (p.answers || []).slice().sort((a, b) => (b.votes || 0) - (a.votes || 0));
      body = `
        <div class="card">
          <p class="hint">PROMPT</p>
          <h2>${escapeHtml(p.prompt)}</h2>
        </div>
        ${sorted.map((a) => `
          <div class="answer-card">
            ${escapeHtml(a.text)}
            <div class="author">— ${escapeHtml(a.authorName || "?")}</div>
            <div class="votes">${a.votes || 0} vote${a.votes === 1 ? "" : "s"}</div>
          </div>
        `).join("")}
        ${room.isHost ? `<button id="nextRoundBtn" class="btn-primary btn-block btn-lg">${p.round >= p.totalRounds ? "See Final Results 🏆" : "Next Round ▶"}</button>` : `<p class="hint center">Waiting for host to continue${WAIT_DOTS}</p>`}
      `;
    }

    return `
      <div class="center hint" style="margin-bottom:6px;">Round ${p.round} of ${p.totalRounds}</div>
      ${body}
      ${scoreStrip(room)}
      ${leaveFooter()}
    `;
  }

  function bindPromptBattle() {
    if (room.state === "finished") return bindFinished();
    bindLeave();
    const submitBtn = document.getElementById("submitAnswerBtn");
    if (submitBtn) {
      const input = document.getElementById("answerInput");
      const submit = () => {
        const text = input.value.trim();
        if (!text) return;
        socket.emit("promptbattle:submit-answer", { text });
      };
      submitBtn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    }
    document.querySelectorAll("[data-vote]").forEach((el) => {
      el.addEventListener("click", () => {
        socket.emit("promptbattle:submit-vote", { authorToken: el.dataset.vote });
      });
    });
    const nextRound = document.getElementById("nextRoundBtn");
    if (nextRound) nextRound.addEventListener("click", () => socket.emit("promptbattle:next-round"));
  }

  // ---------------- Word Bomb ----------------

  function wordBombScreen(room) {
    if (room.state === "finished") return finishedScreen(room);
    const w = room.wordBomb;
    const timerClass = w.timeLeft <= 3 ? "timer low" : "timer";

    const playersWithLives = room.players.map((p) => ({
      ...p,
      lives: w.lives[p.token] ?? 0,
      isTurn: p.token === w.currentToken
    }));

    const lastResultHtml = w.lastResult ? `
      <p class="center hint">
        ${escapeHtml(w.lastResult.name)}: "${escapeHtml(w.lastResult.word || "(no answer)")}" ${w.lastResult.valid ? "✅" : "❌"}
      </p>
    ` : "";

    const currentName = escapeHtml((room.players.find((p) => p.token === w.currentToken) || {}).name || "…");

    return `
      <div class="center hint" style="margin-bottom:6px;">💣 Word Bomb</div>
      ${lastResultHtml}
      <div class="${timerClass}">${w.timeLeft}</div>
      <div class="card center">
        <p class="hint">Say a word containing:</p>
        <div class="word-card" style="font-size:40px;letter-spacing:4px;">${escapeHtml(w.fragment.toUpperCase())}</div>
      </div>
      ${w.isYourTurn ? `
        <div class="card stack">
          <input id="wordInput" type="text" maxlength="40" placeholder="Type a word…" autocomplete="off" />
          <button id="submitWordBtn" class="btn-primary btn-block btn-lg">Submit</button>
        </div>
      ` : `
        <div class="card center">
          <p class="hint">Waiting on ${currentName}…</p>
        </div>
      `}
      <div class="card">
        <h3 style="margin-bottom:6px;">Players</h3>
        <ul class="player-list">
          ${playersWithLives.map((p) => `
            <li>
              <span class="dot ${p.connected ? "" : "off"}"></span>
              <span class="name">${p.isTurn ? "👉 " : ""}${escapeHtml(p.name)}</span>
              <span class="spacer"></span>
              <span>${"❤️".repeat(p.lives)}${p.lives === 0 ? "💀" : ""}</span>
            </li>
          `).join("")}
        </ul>
      </div>
      ${leaveFooter()}
    `;
  }

  function bindWordBomb() {
    if (room.state === "finished") return bindFinished();
    bindLeave();
    const btn = document.getElementById("submitWordBtn");
    if (btn) {
      const input = document.getElementById("wordInput");
      const submit = () => {
        const text = input.value.trim();
        if (!text) return;
        socket.emit("wordbomb:submit-word", { text });
      };
      btn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    }
  }

  // ---------------- Round Games (Trivia, Would You Rather, Most Likely To, Emoji, Category) ----------------

  function roundGameScreen(room) {
    if (room.state === "finished") return finishedScreen(room);
    const g = room.roundGame;
    const timerClass = g.timeLeft <= 5 ? "timer low" : "timer";
    const meta = GAME_META[g.gameType];

    let body = "";
    if (g.phase === "answering") {
      body = `
        <div class="${timerClass}">${g.timeLeft}</div>
        ${roundGamePromptCard(g)}
        ${g.hasAnswered ? `
          <div class="card center">
            <p>✅ Answer locked in!</p>
            <p class="hint">${g.answeredCount}/${g.totalPlayers} answered</p>
          </div>
        ` : roundGameAnswerForm(room, g)}
      `;
    } else if (g.phase === "results") {
      body = `
        ${roundGamePromptCard(g)}
        ${roundGameResultsBody(room, g)}
        ${room.isHost ? `<button id="roundNextBtn" class="btn-primary btn-block btn-lg">${g.round >= g.totalRounds ? "See Final Results 🏆" : "Next Round ▶"}</button>` : `<p class="hint center">Waiting for host to continue${WAIT_DOTS}</p>`}
      `;
    }

    return `
      <div class="center hint" style="margin-bottom:6px;">${meta.icon} ${meta.title} — Round ${g.round} of ${g.totalRounds}</div>
      ${body}
      ${scoreStrip(room)}
      ${leaveFooter()}
    `;
  }

  function roundGamePromptCard(g) {
    if (g.gameType === "trivia") {
      return `<div class="card"><p class="hint">QUESTION</p><h2>${escapeHtml(g.prompt.question)}</h2></div>`;
    }
    if (g.gameType === "wouldyourather") {
      return `<div class="card center"><p class="hint">WOULD YOU RATHER…</p></div>`;
    }
    if (g.gameType === "mostlikelyto") {
      return `<div class="card"><p class="hint">PROMPT</p><h2>${escapeHtml(g.prompt.text)}</h2></div>`;
    }
    if (g.gameType === "emoji") {
      return `<div class="card center"><p class="hint">GUESS THE MOVIE OR PHRASE</p><div class="word-card" style="font-size:48px;">${g.prompt.emoji}</div></div>`;
    }
    if (g.gameType === "category") {
      return `<div class="card center"><p class="hint">NAME SOMETHING FOR EACH CATEGORY STARTING WITH</p><div class="room-code" style="font-size:48px;">${escapeHtml(g.prompt.letter)}</div></div>`;
    }
    if (g.gameType === "pollguess") {
      return `<div class="card"><p class="hint">GUESS THE PERCENTAGE</p><h2>${escapeHtml(g.prompt.question)}</h2></div>`;
    }
    if (g.gameType === "anagram") {
      return `<div class="card center"><p class="hint">UNSCRAMBLE THE WORD</p><div class="word-card" style="font-size:38px;letter-spacing:4px;">${escapeHtml(g.prompt.scrambled)}</div></div>`;
    }
    if (g.gameType === "oddoneout") {
      return `<div class="card center"><p class="hint">WHICH ONE DOESN'T BELONG?</p></div>`;
    }
    if (g.gameType === "quickmath") {
      return `<div class="card center"><p class="hint">SOLVE IT</p><div class="word-card" style="font-size:42px;">${escapeHtml(g.prompt.question)} = ?</div></div>`;
    }
    if (g.gameType === "neverhaveiever") {
      return `<div class="card"><p class="hint">NEVER HAVE I EVER…</p><h2>${escapeHtml(g.prompt.statement.replace(/^Never have I ever /i, ""))}</h2></div>`;
    }
    if (g.gameType === "riddle") {
      return `<div class="card"><p class="hint">SOLVE THE RIDDLE</p><h2>${escapeHtml(g.prompt.riddle)}</h2></div>`;
    }
    if (g.gameType === "countdownletters") {
      return `<div class="card center"><p class="hint">BUILD THE LONGEST WORD YOU CAN</p><div class="word-card" style="font-size:34px;letter-spacing:6px;">${escapeHtml(g.prompt.letters)}</div></div>`;
    }
    if (g.gameType === "guesstheyear") {
      return `<div class="card"><p class="hint">WHAT YEAR DID THIS HAPPEN?</p><h2>${escapeHtml(g.prompt.text)}</h2></div>`;
    }
    if (g.gameType === "truefalse") {
      return `<div class="card"><p class="hint">TRUE OR FALSE?</p><h2>${escapeHtml(g.prompt.statement)}</h2></div>`;
    }
    if (g.gameType === "rankit") {
      return `<div class="card center"><p class="hint">TAP THEM IN ORDER</p><h2>${escapeHtml(g.prompt.title)}</h2></div>`;
    }
    return "";
  }

  function roundGameAnswerForm(room, g) {
    if (g.gameType === "trivia") {
      return `
        <div class="stack">
          ${g.prompt.options.map((opt, idx) => `
            <button class="btn-block" data-trivia-choice="${idx}" style="text-align:left;padding:16px;">${escapeHtml(opt)}</button>
          `).join("")}
        </div>
      `;
    }
    if (g.gameType === "wouldyourather") {
      return `
        <div class="stack">
          <button class="btn-primary btn-block btn-lg" data-wyr-choice="A">${escapeHtml(g.prompt.optionA)}</button>
          <button class="btn-primary btn-block btn-lg" data-wyr-choice="B">${escapeHtml(g.prompt.optionB)}</button>
        </div>
      `;
    }
    if (g.gameType === "mostlikelyto") {
      const others = room.players.filter((p) => p.token !== room.youToken);
      return `
        <div class="stack">
          ${others.map((p) => `
            <button class="btn-block" data-mlt-choice="${p.token}" style="text-align:left;padding:16px;">${escapeHtml(p.name)}</button>
          `).join("")}
        </div>
      `;
    }
    if (g.gameType === "emoji") {
      return `
        <div class="card stack">
          <input id="emojiGuessInput" type="text" maxlength="60" placeholder="Type your guess…" autocomplete="off" />
          <button id="emojiSubmitBtn" class="btn-primary btn-block btn-lg">Submit Guess</button>
        </div>
      `;
    }
    if (g.gameType === "category") {
      resetCatDraftIfNewRound(g);
      return `
        <div class="card stack">
          ${g.prompt.categories.map((cat, idx) => `
            <div>
              <label class="hint" style="display:block;margin-bottom:4px;" for="catWord${idx}">${escapeHtml(cat)}</label>
              <input id="catWord${idx}" class="catWordInput" data-cat-idx="${idx}" type="text" maxlength="30" placeholder="Starts with ${escapeHtml(g.prompt.letter)}…" autocomplete="off" value="${escapeHtml(catDraftWords[idx])}" />
            </div>
          `).join("")}
          <button id="catSubmitBtn" class="btn-primary btn-block btn-lg">Submit Answers</button>
        </div>
      `;
    }
    if (g.gameType === "pollguess") {
      return `
        <div class="card stack">
          <input id="pollGuessInput" type="number" min="0" max="100" placeholder="0-100" inputmode="numeric" style="text-align:center;font-size:28px;font-weight:700;" />
          <button id="pollGuessSubmitBtn" class="btn-primary btn-block btn-lg">Submit Guess</button>
        </div>
      `;
    }
    if (g.gameType === "anagram") {
      return `
        <div class="card stack">
          <input id="anagramInput" type="text" maxlength="20" placeholder="Type the word…" autocomplete="off" style="text-align:center;font-size:22px;font-weight:700;text-transform:uppercase;" />
          <button id="anagramSubmitBtn" class="btn-primary btn-block btn-lg">Submit</button>
        </div>
      `;
    }
    if (g.gameType === "oddoneout") {
      return `
        <div class="stack">
          ${g.prompt.items.map((item, idx) => `
            <button class="btn-block" data-odd-choice="${idx}" style="text-align:left;padding:16px;">${escapeHtml(item)}</button>
          `).join("")}
        </div>
      `;
    }
    if (g.gameType === "quickmath") {
      return `
        <div class="card stack">
          <input id="quickMathInput" type="number" placeholder="Your answer" inputmode="numeric" style="text-align:center;font-size:28px;font-weight:700;" />
          <button id="quickMathSubmitBtn" class="btn-primary btn-block btn-lg">Submit</button>
        </div>
      `;
    }
    if (g.gameType === "neverhaveiever") {
      return `
        <div class="stack">
          <button class="btn-danger btn-block btn-lg" data-nhie-choice="true">🙋 I HAVE</button>
          <button class="btn-success btn-block btn-lg" data-nhie-choice="false">🙅 I haven't</button>
        </div>
      `;
    }
    if (g.gameType === "riddle") {
      return `
        <div class="card stack">
          <input id="riddleInput" type="text" maxlength="60" placeholder="Type your answer…" autocomplete="off" />
          <button id="riddleSubmitBtn" class="btn-primary btn-block btn-lg">Submit</button>
        </div>
      `;
    }
    if (g.gameType === "countdownletters") {
      return `
        <div class="card stack">
          <input id="letterWordInput" type="text" maxlength="20" placeholder="Type your word…" autocomplete="off" style="text-align:center;font-size:22px;font-weight:700;text-transform:uppercase;" />
          <button id="letterWordSubmitBtn" class="btn-primary btn-block btn-lg">Submit</button>
        </div>
      `;
    }
    if (g.gameType === "guesstheyear") {
      return `
        <div class="card stack">
          <input id="yearGuessInput" type="number" placeholder="e.g. 1994" inputmode="numeric" style="text-align:center;font-size:28px;font-weight:700;" />
          <button id="yearGuessSubmitBtn" class="btn-primary btn-block btn-lg">Submit Guess</button>
        </div>
      `;
    }
    if (g.gameType === "truefalse") {
      return `
        <div class="stack">
          <button class="btn-success btn-block btn-lg" data-tf-choice="true">✅ TRUE</button>
          <button class="btn-danger btn-block btn-lg" data-tf-choice="false">❌ FALSE</button>
        </div>
      `;
    }
    if (g.gameType === "rankit") {
      resetRankItOrderIfNewRound(g);
      const done = rankItOrder.length === g.prompt.items.length;
      return `
        <div class="card">
          <p class="hint" style="margin-bottom:10px;">Tap them from first to last. Tap again in the order box to undo.</p>
          <div class="stack">
            ${g.prompt.items.map((item, idx) => {
              const pos = rankItOrder.indexOf(idx);
              const picked = pos !== -1;
              return `
                <button class="btn-block ${picked ? "btn-success" : ""}" data-rank-idx="${idx}" style="text-align:left;padding:16px;">
                  ${picked ? `${pos + 1}. ` : ""}${escapeHtml(item)}
                </button>
              `;
            }).join("")}
          </div>
          <div class="row" style="margin-top:14px;">
            <button id="rankItResetBtn" class="btn-ghost btn-block">↺ Reset</button>
            <button id="rankItSubmitBtn" class="btn-primary btn-block" ${done ? "" : "disabled"}>Submit Order</button>
          </div>
        </div>
      `;
    }
    return "";
  }

  function roundGameResultsBody(room, g) {
    const r = g.resultsData || {};
    if (g.gameType === "trivia") {
      return `
        <div class="card">
          <p class="hint">Correct answer: <strong>${escapeHtml(g.prompt.options[r.correctIndex])}</strong></p>
        </div>
        <div class="card">
          <ul class="player-list">
            ${(r.results || []).map((res) => `
              <li>
                <span class="name">${res.correct ? "✅" : "❌"} ${escapeHtml(res.name)}</span>
                <span class="spacer"></span>
                <span class="hint">${res.choice != null ? escapeHtml(g.prompt.options[res.choice] || "") : "no answer"}</span>
              </li>
            `).join("")}
          </ul>
        </div>
      `;
    }
    if (g.gameType === "wouldyourather") {
      const total = (r.countA || 0) + (r.countB || 0) || 1;
      return `
        <div class="card">
          <p class="hint">${escapeHtml(g.prompt.optionA)}: ${r.countA || 0} (${Math.round(((r.countA || 0) / total) * 100)}%)</p>
          <p class="hint">${escapeHtml(g.prompt.optionB)}: ${r.countB || 0} (${Math.round(((r.countB || 0) / total) * 100)}%)</p>
          <p>Majority picked: <strong>${r.majority === "A" ? escapeHtml(g.prompt.optionA) : escapeHtml(g.prompt.optionB)}</strong></p>
        </div>
      `;
    }
    if (g.gameType === "mostlikelyto") {
      const names = r.winnerNames || [];
      // A tie for most votes is a normal outcome here (voting for one of a
      // handful of friends), not a rare edge case - everyone tied for the
      // most votes actually won the round and scored, so the label needs
      // to reflect all of them, not just one.
      const label = names.length === 0 ? "No votes"
        : names.length === 1 ? names[0]
        : names.slice(0, -1).join(", ") + " & " + names[names.length - 1];
      return `
        <div class="card center">
          <p>${names.length > 1 ? "Winners" : "Winner"}: <strong>${escapeHtml(label)}</strong></p>
        </div>
      `;
    }
    if (g.gameType === "emoji") {
      return `
        <div class="card">
          <p class="hint">Answer: <strong>${escapeHtml(r.answer || "")}</strong></p>
          <ul class="player-list">
            ${(r.results || []).map((res) => `
              <li>
                <span class="name">${res.correct ? "✅" : "❌"} ${escapeHtml(res.name)}</span>
                <span class="spacer"></span>
                <span class="hint">${escapeHtml(res.text || "no answer")}</span>
              </li>
            `).join("")}
          </ul>
        </div>
      `;
    }
    if (g.gameType === "category") {
      return `
        ${(r.perCategory || []).map((c) => `
          <div class="card">
            <h3 style="margin-bottom:6px;">${escapeHtml(c.category)}</h3>
            <ul class="player-list">
              ${c.submissions.map((s) => `
                <li>
                  <span class="name">${escapeHtml(s.name)}</span>
                  <span class="spacer"></span>
                  <span class="hint">${escapeHtml(s.word || "—")}</span>
                  <span class="score">+${s.points}</span>
                </li>
              `).join("")}
            </ul>
          </div>
        `).join("")}
      `;
    }
    if (g.gameType === "pollguess") {
      const sorted = (r.results || []).slice().sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));
      return `
        <div class="card">
          <p class="hint">Actual answer: <strong>${r.answer}%</strong></p>
        </div>
        <div class="card">
          <ul class="player-list">
            ${sorted.map((res) => `
              <li>
                <span class="name">${escapeHtml(res.name)}</span>
                <span class="spacer"></span>
                <span class="hint">${res.guess != null ? res.guess + "%" : "no answer"}</span>
                <span class="score">${res.points ? "+" + res.points : ""}</span>
              </li>
            `).join("")}
          </ul>
        </div>
      `;
    }
    if (g.gameType === "anagram") {
      return `
        <div class="card">
          <p class="hint">Answer: <strong>${escapeHtml(r.answer || "")}</strong></p>
          <ul class="player-list">
            ${(r.results || []).map((res) => `
              <li>
                <span class="name">${res.correct ? "✅" : "❌"} ${escapeHtml(res.name)}</span>
                <span class="spacer"></span>
                <span class="hint">${escapeHtml(res.text || "no answer")}</span>
              </li>
            `).join("")}
          </ul>
        </div>
      `;
    }
    if (g.gameType === "oddoneout") {
      return `
        <div class="card">
          <p class="hint">Odd one out: <strong>${escapeHtml(g.prompt.items[r.oddIndex])}</strong></p>
          <ul class="player-list">
            ${(r.results || []).map((res) => `
              <li>
                <span class="name">${res.correct ? "✅" : "❌"} ${escapeHtml(res.name)}</span>
                <span class="spacer"></span>
                <span class="hint">${res.choice != null ? escapeHtml(g.prompt.items[res.choice] || "") : "no answer"}</span>
              </li>
            `).join("")}
          </ul>
        </div>
      `;
    }
    if (g.gameType === "quickmath") {
      return `
        <div class="card">
          <p class="hint">Answer: <strong>${r.answer}</strong></p>
          <ul class="player-list">
            ${(r.results || []).map((res) => `
              <li>
                <span class="name">${res.correct ? "✅" : "❌"} ${escapeHtml(res.name)}</span>
                <span class="spacer"></span>
                <span class="hint">${res.guess != null ? res.guess : "no answer"}</span>
              </li>
            `).join("")}
          </ul>
        </div>
      `;
    }
    if (g.gameType === "neverhaveiever") {
      return `
        <div class="card">
          <p class="hint">🙋 Have: ${r.haveCount || 0} — 🙅 Haven't: ${r.haventCount || 0}</p>
          <ul class="player-list">
            ${(r.results || []).map((res) => `
              <li>
                <span class="name">${res.inMinority ? "⭐" : ""} ${escapeHtml(res.name)}</span>
                <span class="spacer"></span>
                <span class="hint">${res.haveDone ? "I have" : "I haven't"}</span>
              </li>
            `).join("")}
          </ul>
        </div>
      `;
    }
    if (g.gameType === "riddle") {
      return `
        <div class="card">
          <p class="hint">Answer: <strong>${escapeHtml(r.answer || "")}</strong></p>
          <ul class="player-list">
            ${(r.results || []).map((res) => `
              <li>
                <span class="name">${res.correct ? "✅" : "❌"} ${escapeHtml(res.name)}</span>
                <span class="spacer"></span>
                <span class="hint">${escapeHtml(res.text || "no answer")}</span>
              </li>
            `).join("")}
          </ul>
        </div>
      `;
    }
    if (g.gameType === "countdownletters") {
      const sorted = (r.results || []).slice().sort((a, b) => (b.points || 0) - (a.points || 0));
      return `
        <div class="card">
          ${(r.longestWords || []).length ? `<p class="hint">Longest word${r.longestWords.length > 1 ? "s" : ""}: <strong>${escapeHtml(r.longestWords.join(", "))}</strong></p>` : ""}
          <ul class="player-list">
            ${sorted.map((res) => `
              <li>
                <span class="name">${res.valid ? "✅" : "❌"} ${escapeHtml(res.name)}</span>
                <span class="spacer"></span>
                <span class="hint">${escapeHtml(res.text || "no answer")}</span>
                <span class="score">${res.points ? "+" + res.points : ""}</span>
              </li>
            `).join("")}
          </ul>
        </div>
      `;
    }
    if (g.gameType === "guesstheyear") {
      const sorted = (r.results || []).slice().sort((a, b) => (a.distance ?? 9999) - (b.distance ?? 9999));
      return `
        <div class="card">
          <p class="hint">It happened in: <strong>${r.answer}</strong></p>
        </div>
        <div class="card">
          <ul class="player-list">
            ${sorted.map((res) => `
              <li>
                <span class="name">${escapeHtml(res.name)}</span>
                <span class="spacer"></span>
                <span class="hint">${res.guess != null ? res.guess : "no answer"}</span>
                <span class="score">${res.points ? "+" + res.points : ""}</span>
              </li>
            `).join("")}
          </ul>
        </div>
      `;
    }
    if (g.gameType === "truefalse") {
      return `
        <div class="card">
          <p class="hint">The statement was: <strong>${r.isTrue ? "TRUE ✅" : "FALSE ❌"}</strong></p>
          <ul class="player-list">
            ${(r.results || []).map((res) => `
              <li>
                <span class="name">${res.correct ? "✅" : "❌"} ${escapeHtml(res.name)}</span>
                <span class="spacer"></span>
                <span class="hint">${res.guess == null ? "no answer" : res.guess ? "said TRUE" : "said FALSE"}</span>
              </li>
            `).join("")}
          </ul>
        </div>
      `;
    }
    if (g.gameType === "rankit") {
      const sorted = (r.results || []).slice().sort((a, b) => (b.points || 0) - (a.points || 0));
      return `
        <div class="card">
          <p class="hint" style="margin-bottom:8px;">Correct order</p>
          <ol style="margin:0;padding-left:20px;">
            ${r.correctOrder.map((idx) => `<li style="margin-bottom:4px;">${escapeHtml(r.items[idx])}</li>`).join("")}
          </ol>
        </div>
        <div class="card">
          <ul class="player-list">
            ${sorted.map((res) => `
              <li>
                <span class="name">${res.perfect ? "🏆" : ""} ${escapeHtml(res.name)}</span>
                <span class="spacer"></span>
                <span class="hint">${res.order ? `${res.correctPositions}/${r.correctOrder.length} correct` : "no answer"}</span>
                <span class="score">${res.points ? "+" + res.points : ""}</span>
              </li>
            `).join("")}
          </ul>
        </div>
      `;
    }
    return "";
  }

  function bindRoundGame() {
    if (room.state === "finished") return bindFinished();
    bindLeave();

    document.querySelectorAll("[data-trivia-choice]").forEach((el) => {
      el.addEventListener("click", () => socket.emit("roundgame:submit-answer", { choice: Number(el.dataset.triviaChoice) }));
    });
    document.querySelectorAll("[data-wyr-choice]").forEach((el) => {
      el.addEventListener("click", () => socket.emit("roundgame:submit-answer", { choice: el.dataset.wyrChoice }));
    });
    document.querySelectorAll("[data-mlt-choice]").forEach((el) => {
      el.addEventListener("click", () => socket.emit("roundgame:submit-answer", { votedFor: el.dataset.mltChoice }));
    });

    const emojiBtn = document.getElementById("emojiSubmitBtn");
    if (emojiBtn) {
      const input = document.getElementById("emojiGuessInput");
      const submit = () => {
        const text = input.value.trim();
        if (!text) return;
        socket.emit("roundgame:submit-answer", { text });
      };
      emojiBtn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    }

    const catBtn = document.getElementById("catSubmitBtn");
    if (catBtn) {
      const catInputs = [...document.querySelectorAll(".catWordInput")].sort(
        (a, b) => Number(a.dataset.catIdx) - Number(b.dataset.catIdx)
      );
      // Same reasoning as Two Truths' listeners above - the round's own
      // per-second timer broadcast fully re-renders this form, so every
      // keystroke needs to land in catDraftWords or it gets wiped.
      catInputs.forEach((input, idx) => {
        input.addEventListener("input", () => { catDraftWords[idx] = input.value; });
      });
      catBtn.addEventListener("click", () => {
        const words = catInputs.map((i) => i.value.trim());
        socket.emit("roundgame:submit-answer", { words });
      });
    }

    const pollBtn = document.getElementById("pollGuessSubmitBtn");
    if (pollBtn) {
      const input = document.getElementById("pollGuessInput");
      const submit = () => {
        const guess = Number(input.value);
        if (input.value === "" || Number.isNaN(guess)) return;
        socket.emit("roundgame:submit-answer", { guess: Math.max(0, Math.min(100, guess)) });
      };
      pollBtn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    }

    const anagramBtn = document.getElementById("anagramSubmitBtn");
    if (anagramBtn) {
      const input = document.getElementById("anagramInput");
      const submit = () => {
        const text = input.value.trim();
        if (!text) return;
        socket.emit("roundgame:submit-answer", { text });
      };
      anagramBtn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    }

    document.querySelectorAll("[data-odd-choice]").forEach((el) => {
      el.addEventListener("click", () => socket.emit("roundgame:submit-answer", { choice: Number(el.dataset.oddChoice) }));
    });

    const quickMathBtn = document.getElementById("quickMathSubmitBtn");
    if (quickMathBtn) {
      const input = document.getElementById("quickMathInput");
      const submit = () => {
        if (input.value === "") return;
        const guess = Number(input.value);
        if (Number.isNaN(guess)) return;
        socket.emit("roundgame:submit-answer", { guess });
      };
      quickMathBtn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    }

    document.querySelectorAll("[data-nhie-choice]").forEach((el) => {
      el.addEventListener("click", () => socket.emit("roundgame:submit-answer", { haveDone: el.dataset.nhieChoice === "true" }));
    });

    const riddleBtn = document.getElementById("riddleSubmitBtn");
    if (riddleBtn) {
      const input = document.getElementById("riddleInput");
      const submit = () => {
        const text = input.value.trim();
        if (!text) return;
        socket.emit("roundgame:submit-answer", { text });
      };
      riddleBtn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    }

    const letterBtn = document.getElementById("letterWordSubmitBtn");
    if (letterBtn) {
      const input = document.getElementById("letterWordInput");
      const submit = () => {
        const text = input.value.trim();
        if (!text) return;
        socket.emit("roundgame:submit-answer", { text });
      };
      letterBtn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    }

    const yearBtn = document.getElementById("yearGuessSubmitBtn");
    if (yearBtn) {
      const input = document.getElementById("yearGuessInput");
      const submit = () => {
        if (input.value === "") return;
        const guess = Number(input.value);
        if (Number.isNaN(guess)) return;
        socket.emit("roundgame:submit-answer", { guess });
      };
      yearBtn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    }

    document.querySelectorAll("[data-tf-choice]").forEach((el) => {
      el.addEventListener("click", () => socket.emit("roundgame:submit-answer", { guess: el.dataset.tfChoice === "true" }));
    });

    document.querySelectorAll("[data-rank-idx]").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = Number(el.dataset.rankIdx);
        const pos = rankItOrder.indexOf(idx);
        if (pos === -1) rankItOrder.push(idx);
        else rankItOrder.splice(pos, 1);
        render();
      });
    });
    const rankResetBtn = document.getElementById("rankItResetBtn");
    if (rankResetBtn) rankResetBtn.addEventListener("click", () => { rankItOrder = []; render(); });
    const rankSubmitBtn = document.getElementById("rankItSubmitBtn");
    if (rankSubmitBtn) rankSubmitBtn.addEventListener("click", () => {
      socket.emit("roundgame:submit-answer", { order: rankItOrder.slice() });
    });

    const next = document.getElementById("roundNextBtn");
    if (next) next.addEventListener("click", () => socket.emit("roundgame:next-round"));
  }

  // ---------------- Fib or Fact ----------------

  function fibScreen(room) {
    if (room.state === "finished") return finishedScreen(room);
    const f = room.fib;
    const timerClass = f.timeLeft <= 10 ? "timer low" : "timer";
    let body = "";

    if (f.phase === "answering") {
      body = `
        <div class="${timerClass}">${f.timeLeft}</div>
        <div class="card">
          <p class="hint">FILL IN THE BLANK</p>
          <h2>${escapeHtml(f.prompt)}</h2>
        </div>
        ${f.hasAnswered ? `
          <div class="card center">
            <p>✅ Lie submitted!</p>
            <p class="hint">${f.answeredCount}/${f.totalPlayers} answered</p>
          </div>
        ` : `
          <div class="card stack">
            <input id="fibLieInput" type="text" maxlength="100" placeholder="Write a believable lie…" />
            <button id="fibSubmitLieBtn" class="btn-primary btn-block btn-lg">Submit Lie</button>
          </div>
        `}
      `;
    } else if (f.phase === "voting") {
      body = `
        <div class="${timerClass}">${f.timeLeft}</div>
        <div class="card">
          <p class="hint">FILL IN THE BLANK</p>
          <h2>${escapeHtml(f.prompt)}</h2>
        </div>
        ${f.hasVoted ? `<div class="card center"><p>🗳 Vote submitted! Waiting for others${WAIT_DOTS}</p></div>` : `<p class="hint center">Which one is the TRUE answer?</p>`}
        ${(f.options || []).map((o) => {
          const clickable = !o.isYours && !f.hasVoted;
          return `
          <div class="answer-card ${o.isYours ? "mine" : ""}" ${clickable ? `data-fib-vote="${o.id}" role="button" tabindex="0" aria-label="Vote: ${escapeHtml(o.text)}"` : ""}>
            ${escapeHtml(o.text)}
            ${o.isYours ? '<div class="author">(your lie)</div>' : ""}
          </div>
        `;
        }).join("")}
      `;
    } else if (f.phase === "results") {
      const sorted = (f.options || []).slice().sort((a, b) => (b.votes || 0) - (a.votes || 0));
      body = `
        <div class="card">
          <p class="hint">FILL IN THE BLANK</p>
          <h2>${escapeHtml(f.prompt)}</h2>
        </div>
        ${sorted.map((o) => `
          <div class="answer-card">
            ${escapeHtml(o.text)}
            <div class="author">${o.isTruth ? "✅ The truth" : `— ${escapeHtml(o.authorName || "?")}'s lie`}</div>
            <div class="votes">${o.votes || 0} vote${o.votes === 1 ? "" : "s"}</div>
          </div>
        `).join("")}
        ${room.isHost ? `<button id="fibNextRoundBtn" class="btn-primary btn-block btn-lg">${f.round >= f.totalRounds ? "See Final Results 🏆" : "Next Round ▶"}</button>` : `<p class="hint center">Waiting for host to continue${WAIT_DOTS}</p>`}
      `;
    }

    return `
      <div class="center hint" style="margin-bottom:6px;">🤥 Fib or Fact — Round ${f.round} of ${f.totalRounds}</div>
      ${body}
      ${scoreStrip(room)}
      ${leaveFooter()}
    `;
  }

  function bindFib() {
    if (room.state === "finished") return bindFinished();
    bindLeave();
    const submitBtn = document.getElementById("fibSubmitLieBtn");
    if (submitBtn) {
      const input = document.getElementById("fibLieInput");
      const submit = () => {
        const text = input.value.trim();
        if (!text) return;
        socket.emit("fib:submit-lie", { text });
      };
      submitBtn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    }
    document.querySelectorAll("[data-fib-vote]").forEach((el) => {
      el.addEventListener("click", () => {
        socket.emit("fib:submit-vote", { optionId: el.dataset.fibVote });
      });
    });
    const nextRound = document.getElementById("fibNextRoundBtn");
    if (nextRound) nextRound.addEventListener("click", () => socket.emit("fib:next-round"));
  }

  // ---------------- Trivia Survival (Quiz or Die) ----------------

  function triviaSurvivalScreen(room) {
    if (room.state === "finished") return finishedScreen(room);
    const t = room.triviaSurvival;
    const timerClass = t.timeLeft <= 5 ? "timer low" : "timer";
    let body = "";

    if (t.phase === "answering") {
      body = t.isEliminated ? `
        <div class="card center"><p>💀 You've been eliminated — spectating the rest of the round.</p></div>
      ` : `
        <div class="${timerClass}">${t.timeLeft}</div>
        <div class="card"><p class="hint">QUESTION</p><h2>${escapeHtml(t.prompt.question)}</h2></div>
        ${t.hasAnswered ? `<div class="card center"><p>✅ Answer locked in!</p></div>` : `
          <div class="stack">
            ${t.prompt.options.map((opt, idx) => `
              <button class="btn-block" data-tsurvival-choice="${idx}" style="text-align:left;padding:16px;">${escapeHtml(opt)}</button>
            `).join("")}
          </div>
        `}
      `;
    } else if (t.phase === "results") {
      const r = t.resultsData || {};
      body = `
        <div class="card">
          <p class="hint">Correct answer: <strong>${escapeHtml(t.prompt.options[r.correctIndex])}</strong></p>
        </div>
        ${r.eliminatedThisRound && r.eliminatedThisRound.length ? `
          <div class="card center"><p>💀 Eliminated: ${r.eliminatedThisRound.map(escapeHtml).join(", ")}</p></div>
        ` : ""}
        <div class="card">
          <ul class="player-list">
            ${(r.results || []).map((res) => `
              <li>
                <span class="name">${res.correct ? "✅" : "❌"} ${escapeHtml(res.name)}</span>
                <span class="spacer"></span>
                <span class="hint">${res.choice != null ? escapeHtml(t.prompt.options[res.choice] || "") : "no answer"}</span>
              </li>
            `).join("")}
          </ul>
        </div>
        ${room.isHost ? `<button id="tsurvivalNextBtn" class="btn-primary btn-block btn-lg">Next Question ▶</button>` : `<p class="hint center">Waiting for host to continue${WAIT_DOTS}</p>`}
      `;
    }

    const survivors = room.players.map((p) => ({
      ...p,
      isAlive: (t.lives[p.token] ?? 0) > 0,
      lives: t.lives[p.token] ?? 0
    }));

    return `
      <div class="center hint" style="margin-bottom:6px;">💀 Quiz or Die — Round ${t.round} of ${t.maxRounds}</div>
      ${body}
      <div class="card">
        <h3 style="margin-bottom:6px;">Survivors</h3>
        <ul class="player-list">
          ${survivors.map((p) => `
            <li>
              <span class="dot ${p.connected ? "" : "off"}"></span>
              <span class="name">${p.isAlive ? "" : "💀 "}${escapeHtml(p.name)}</span>
              <span class="spacer"></span>
              <span>${"❤️".repeat(p.lives)}</span>
              <span class="score" style="margin-left:8px;">${p.score}</span>
            </li>
          `).join("")}
        </ul>
      </div>
      ${leaveFooter()}
    `;
  }

  function bindTriviaSurvival() {
    if (room.state === "finished") return bindFinished();
    bindLeave();
    document.querySelectorAll("[data-tsurvival-choice]").forEach((el) => {
      el.addEventListener("click", () => socket.emit("triviasurvival:submit-answer", { choice: Number(el.dataset.tsurvivalChoice) }));
    });
    const next = document.getElementById("tsurvivalNextBtn");
    if (next) next.addEventListener("click", () => socket.emit("triviasurvival:next-round"));
  }

  // ---------------- Doodle Guess ----------------

  function drawStrokeOnCanvas(ctx, canvas, points) {
    if (!points || points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x * canvas.width, points[0].y * canvas.height);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x * canvas.width, points[i].y * canvas.height);
    }
    ctx.stroke();
  }

  function doodleScreen(room) {
    if (room.state === "finished") return finishedScreen(room);
    const d = room.doodle;
    const timerClass = d.timeLeft <= 10 ? "timer low" : "timer";
    let body = "";

    if (d.phase === "drawing") {
      body = `
        <div class="center hint" style="margin-bottom:4px;">${d.isArtist ? "Your turn to draw!" : `${escapeHtml(d.artistName)} is drawing…`}</div>
        <div class="${timerClass}">${d.timeLeft}</div>
        <div class="card">
          <canvas id="doodleCanvas" width="600" height="450" style="width:100%;height:auto;background:#fff;border-radius:12px;touch-action:none;display:block;"></canvas>
          ${d.isArtist ? `
            <div class="row" style="margin-top:10px;">
              <button id="doodleClearBtn" class="btn-danger btn-block">Clear</button>
            </div>
            <p class="hint center" style="margin-top:8px;">Draw: <strong>${escapeHtml(d.word)}</strong></p>
          ` : ""}
        </div>
        ${!d.isArtist ? (
          d.hasGuessedCorrectly ? `<div class="card center"><p>✅ You got it!</p></div>` : `
            <div class="card stack">
              <input id="doodleGuessInput" type="text" maxlength="40" placeholder="Type your guess…" autocomplete="off" />
              <button id="doodleGuessBtn" class="btn-primary btn-block btn-lg">Guess</button>
            </div>
          `
        ) : `<p class="hint center">${d.correctGuessCount} guessed correctly so far</p>`}
      `;
    } else if (d.phase === "summary") {
      body = `
        <div class="card center">
          <h2>The word was: ${escapeHtml(d.word)}</h2>
        </div>
        <div class="card">
          <ul class="player-list">
            ${(d.guesses || []).map((g) => `
              <li>
                <span class="name">${g.correct ? "✅" : "❌"} ${escapeHtml(g.name)}</span>
                <span class="spacer"></span>
                <span class="hint">${escapeHtml(g.text)}</span>
              </li>
            `).join("")}
          </ul>
        </div>
        ${room.isHost ? `<button id="doodleNextTurnBtn" class="btn-primary btn-block btn-lg">Next Turn ▶</button>` : `<p class="hint center">Waiting for host to continue${WAIT_DOTS}</p>`}
      `;
    }

    return `
      <div class="center hint" style="margin-bottom:6px;">🎨 Doodle Guess — Turn ${d.turnNumber} of ${d.totalTurns}</div>
      ${body}
      ${scoreStrip(room)}
      ${leaveFooter()}
    `;
  }

  function bindDoodle() {
    if (room.state === "finished") return bindFinished();
    bindLeave();
    const d = room.doodle;

    const canvas = document.getElementById("doodleCanvas");
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx.strokeStyle = "#222";
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      (d.strokes || []).forEach((stroke) => drawStrokeOnCanvas(ctx, canvas, stroke.points));

      if (d.isArtist) {
        let drawingNow = false;
        let currentPoints = [];

        const toRelative = (evt) => {
          const rect = canvas.getBoundingClientRect();
          return {
            x: Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width)),
            y: Math.max(0, Math.min(1, (evt.clientY - rect.top) / rect.height))
          };
        };

        canvas.addEventListener("pointerdown", (evt) => {
          drawingNow = true;
          currentPoints = [toRelative(evt)];
          canvas.setPointerCapture(evt.pointerId);
        });
        canvas.addEventListener("pointermove", (evt) => {
          if (!drawingNow) return;
          const pt = toRelative(evt);
          const prev = currentPoints[currentPoints.length - 1];
          currentPoints.push(pt);
          drawStrokeOnCanvas(ctx, canvas, [prev, pt]);
        });
        const finish = () => {
          if (!drawingNow) return;
          drawingNow = false;
          if (currentPoints.length > 1) {
            socket.emit("doodle:stroke", { points: currentPoints });
          }
          currentPoints = [];
        };
        canvas.addEventListener("pointerup", finish);
        canvas.addEventListener("pointerleave", finish);
        canvas.addEventListener("pointercancel", finish);

        const clearBtn = document.getElementById("doodleClearBtn");
        if (clearBtn) clearBtn.addEventListener("click", () => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          socket.emit("doodle:clear");
        });
      }
    }

    const guessBtn = document.getElementById("doodleGuessBtn");
    if (guessBtn) {
      const input = document.getElementById("doodleGuessInput");
      const submit = () => {
        const text = input.value.trim();
        if (!text) return;
        socket.emit("doodle:submit-guess", { text });
      };
      guessBtn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    }

    const nextBtn = document.getElementById("doodleNextTurnBtn");
    if (nextBtn) nextBtn.addEventListener("click", () => socket.emit("doodle:next-turn"));
  }

  // ---------------- Two Truths and a Lie ----------------

  function twoTruthsScreen(room) {
    if (room.state === "finished") return finishedScreen(room);
    const t = room.twoTruths;
    const timerClass = t.timeLeft <= 10 ? "timer low" : "timer";
    let body = "";

    if (t.phase === "writing") {
      body = `
        <div class="${timerClass}">${t.timeLeft}</div>
        ${t.hasWritten ? `
          <div class="card center">
            <p>✅ Submitted! Waiting for others${WAIT_DOTS}</p>
            <p class="hint">${t.writtenCount}/${t.totalPlayers} submitted</p>
          </div>
        ` : `
          <div class="card">
            <p class="hint" style="text-align:left;">Write 2 TRUE statements and 1 LIE about yourself. Mark which one is the lie.</p>
            <div class="stack">
              ${[0, 1, 2].map((i) => `
                <div class="row" style="align-items:center;">
                  <input id="ttStatement${i}" class="ttStatement" data-idx="${i}" type="text" maxlength="80" placeholder="Statement ${i + 1}…" style="flex:1;" value="${escapeHtml(ttDraftStatements[i])}" />
                  <label style="display:flex;align-items:center;gap:4px;white-space:nowrap;">
                    <input type="radio" name="ttLie" class="ttLieRadio" data-idx="${i}" ${ttDraftLieIndex === i ? "checked" : ""} /> lie
                  </label>
                </div>
              `).join("")}
              <button id="ttSubmitBtn" class="btn-primary btn-block btn-lg">Submit</button>
            </div>
          </div>
        `}
      `;
    } else if (t.phase === "guessing") {
      body = `
        <div class="center hint" style="margin-bottom:6px;">Spotlight ${t.spotlightNumber} of ${t.totalSpotlights}</div>
        <div class="${timerClass}">${t.timeLeft}</div>
        ${t.isSpotlight ? `
          <div class="card center">
            <h2>Everyone is guessing about you!</h2>
            <p class="hint">Sit tight while the room decides which one is your lie.</p>
          </div>
          <div class="stack">
            ${t.texts.map((txt) => `<div class="answer-card mine">${escapeHtml(txt)}</div>`).join("")}
          </div>
        ` : `
          <div class="card center"><h2>Which of ${escapeHtml(t.spotlightName)}'s statements is the LIE?</h2></div>
          ${t.hasGuessed ? `<div class="card center"><p>🗳 Guess submitted! Waiting…</p></div>` : `
            <div class="stack">
              ${t.texts.map((txt, i) => `<button class="btn-block" data-tt-guess="${i}" style="text-align:left;padding:16px;">${escapeHtml(txt)}</button>`).join("")}
            </div>
          `}
        `}
      `;
    } else if (t.phase === "reveal") {
      const r = t.reveal || {};
      body = `
        <div class="center hint" style="margin-bottom:6px;">Spotlight ${t.spotlightNumber} of ${t.totalSpotlights}</div>
        <div class="card center"><h2>${escapeHtml(r.spotlightName)}'s lie was:</h2></div>
        <div class="stack">
          ${(r.texts || []).map((txt, i) => `
            <div class="answer-card ${i === r.lieIndex ? "" : "mine"}">
              ${escapeHtml(txt)}
              ${i === r.lieIndex ? '<div class="author">🤥 The lie</div>' : '<div class="author">✅ True</div>'}
            </div>
          `).join("")}
        </div>
        <div class="card">
          <p class="hint">${escapeHtml(r.spotlightName)} fooled ${r.fooled || 0} player${r.fooled === 1 ? "" : "s"}</p>
          <ul class="player-list">
            ${(r.guessResults || []).map((res) => `
              <li>
                <span class="name">${res.guessed ? (res.correct ? "✅" : "❌") : "⏱️"} ${escapeHtml(res.name)}</span>
                <span class="spacer"></span>
                <span class="hint">${res.guessed ? (res.correct ? "found the lie" : "got fooled") : "didn't guess"}</span>
              </li>
            `).join("")}
          </ul>
        </div>
        ${room.isHost ? `<button id="ttNextBtn" class="btn-primary btn-block btn-lg">${t.spotlightNumber >= t.totalSpotlights ? "See Final Results 🏆" : "Next Player ▶"}</button>` : `<p class="hint center">Waiting for host to continue${WAIT_DOTS}</p>`}
      `;
    }

    return `
      <div class="center hint" style="margin-bottom:6px;">🕵️ Two Truths and a Lie</div>
      ${body}
      ${scoreStrip(room)}
      ${leaveFooter()}
    `;
  }

  function bindTwoTruths() {
    if (room.state === "finished") return bindFinished();
    bindLeave();

    const submitBtn = document.getElementById("ttSubmitBtn");
    if (submitBtn) {
      const statementInputs = [...document.querySelectorAll(".ttStatement")].sort(
        (a, b) => Number(a.dataset.idx) - Number(b.dataset.idx)
      );
      // The writing-phase timer rebroadcasts every second (see
      // twoTruthsBeginWritingTimer in room.js), which fully re-renders this
      // form - track every keystroke/selection into ttDraft* so the values
      // written back into the template on the next render are current, not
      // blank. (A single focused field surviving via render()'s generic
      // "preserve by id" logic wouldn't be enough here - the other two
      // fields, and the radio choice, still need this.)
      statementInputs.forEach((input, idx) => {
        input.addEventListener("input", () => { ttDraftStatements[idx] = input.value; });
      });
      document.querySelectorAll(".ttLieRadio").forEach((radio) => {
        radio.addEventListener("change", () => {
          if (radio.checked) ttDraftLieIndex = Number(radio.dataset.idx);
        });
      });

      submitBtn.addEventListener("click", () => {
        const texts = statementInputs.map((i) => i.value.trim());
        if (texts.some((t) => !t)) {
          showToast("Fill in all three statements.");
          return;
        }
        const checked = document.querySelector(".ttLieRadio:checked");
        const lieIndex = checked ? Number(checked.dataset.idx) : 0;
        socket.emit("twotruths:submit-statements", { texts, lieIndex });
      });
      // Enter moves to the next statement field like Tab, rather than
      // submitting a half-filled form (unlike the app's other single-input
      // answer forms, this one has three fields to fill before it's ready).
      statementInputs.forEach((input, idx) => {
        input.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const next = statementInputs[idx + 1];
          if (next) next.focus();
          else submitBtn.click();
        });
      });
    }

    document.querySelectorAll("[data-tt-guess]").forEach((el) => {
      el.addEventListener("click", () => {
        socket.emit("twotruths:submit-guess", { guessIndex: Number(el.dataset.ttGuess) });
      });
    });

    const nextBtn = document.getElementById("ttNextBtn");
    if (nextBtn) nextBtn.addEventListener("click", () => socket.emit("twotruths:next"));
  }

  // ---------------- Draw It! ----------------

  let drawItLocalStrokes = [];
  let drawItLocalStrokesRound = null;

  function drawItScreen(room) {
    if (room.state === "finished") return finishedScreen(room);
    const d = room.drawIt;
    const timerClass = d.timeLeft <= 10 ? "timer low" : "timer";
    let body = "";

    if (d.phase === "drawing") {
      body = `
        <div class="${timerClass}">${d.timeLeft}</div>
        <div class="card center">
          <p class="hint">Draw: <strong>${escapeHtml(d.word)}</strong></p>
        </div>
        ${d.hasSubmitted ? `
          <div class="card center">
            <p>✅ Submitted! Waiting for others${WAIT_DOTS}</p>
            <p class="hint">${d.submittedCount}/${d.totalPlayers} submitted</p>
          </div>
        ` : `
          <div class="card">
            <canvas id="drawItCanvas" width="600" height="450" style="width:100%;height:auto;background:#fff;border-radius:12px;touch-action:none;display:block;"></canvas>
            <div class="row" style="margin-top:10px;">
              <button id="drawItClearBtn" class="btn-danger btn-block">Clear</button>
              <button id="drawItSubmitBtn" class="btn-primary btn-block">Submit Drawing</button>
            </div>
          </div>
        `}
      `;
    } else if (d.phase === "voting") {
      body = `
        <div class="${timerClass}">${d.timeLeft}</div>
        <div class="card center"><p class="hint">Word was: <strong>${escapeHtml(d.word)}</strong></p></div>
        ${d.hasVoted ? `<div class="card center"><p>🗳 Vote submitted! Waiting for others${WAIT_DOTS}</p></div>` : `<p class="hint center">Tap your favorite drawing</p>`}
        <div class="stack">
          ${(d.gallery || []).map((entry) => `
            <div class="card">
              <canvas class="drawItGalleryCanvas" data-token="${entry.token}" width="600" height="450" style="width:100%;height:auto;background:#fff;border-radius:12px;display:block;"></canvas>
              ${entry.isYours
                ? '<p class="hint center" style="margin-top:8px;">(yours)</p>'
                : `<button class="btn-primary btn-block" style="margin-top:8px;" ${d.hasVoted ? "disabled" : ""} data-drawit-vote="${entry.token}">Vote for this</button>`
              }
            </div>
          `).join("")}
        </div>
      `;
    } else if (d.phase === "results") {
      const sorted = (d.gallery || []).slice().sort((a, b) => (b.votes || 0) - (a.votes || 0));
      body = `
        <div class="card center"><p class="hint">Word was: <strong>${escapeHtml(d.word)}</strong></p></div>
        <div class="stack">
          ${sorted.map((entry) => `
            <div class="card">
              <canvas class="drawItGalleryCanvas" data-token="${entry.token}" width="600" height="450" style="width:100%;height:auto;background:#fff;border-radius:12px;display:block;"></canvas>
              <p class="hint center" style="margin-top:8px;">— ${escapeHtml(entry.authorName || "?")} · ${entry.votes || 0} vote${entry.votes === 1 ? "" : "s"}</p>
            </div>
          `).join("")}
        </div>
        ${room.isHost ? `<button id="drawItNextBtn" class="btn-primary btn-block btn-lg">${d.round >= d.totalRounds ? "See Final Results 🏆" : "Next Round ▶"}</button>` : `<p class="hint center">Waiting for host to continue${WAIT_DOTS}</p>`}
      `;
    }

    return `
      <div class="center hint" style="margin-bottom:6px;">🖌️ Draw It! — Round ${d.round} of ${d.totalRounds}</div>
      ${body}
      ${scoreStrip(room)}
      ${leaveFooter()}
    `;
  }

  function bindDrawIt() {
    if (room.state === "finished") return bindFinished();
    bindLeave();
    const d = room.drawIt;

    // A round that ended via timeout (not an explicit Submit click) never
    // cleared the in-progress strokes - do it here so they don't bleed
    // into the next round's blank canvas.
    if (drawItLocalStrokesRound !== d.round) {
      drawItLocalStrokesRound = d.round;
      drawItLocalStrokes = [];
    }

    const canvas = document.getElementById("drawItCanvas");
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx.strokeStyle = "#222";
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      drawItLocalStrokes.forEach((stroke) => drawStrokeOnCanvas(ctx, canvas, stroke.points));

      let drawingNow = false;
      let currentPoints = [];
      const toRelative = (evt) => {
        const rect = canvas.getBoundingClientRect();
        return {
          x: Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width)),
          y: Math.max(0, Math.min(1, (evt.clientY - rect.top) / rect.height))
        };
      };
      canvas.addEventListener("pointerdown", (evt) => {
        drawingNow = true;
        currentPoints = [toRelative(evt)];
        canvas.setPointerCapture(evt.pointerId);
      });
      canvas.addEventListener("pointermove", (evt) => {
        if (!drawingNow) return;
        const pt = toRelative(evt);
        const prev = currentPoints[currentPoints.length - 1];
        currentPoints.push(pt);
        drawStrokeOnCanvas(ctx, canvas, [prev, pt]);
      });
      const finish = () => {
        if (!drawingNow) return;
        drawingNow = false;
        if (currentPoints.length > 1) {
          drawItLocalStrokes.push({ points: currentPoints });
        }
        currentPoints = [];
      };
      canvas.addEventListener("pointerup", finish);
      canvas.addEventListener("pointerleave", finish);
      canvas.addEventListener("pointercancel", finish);

      const clearBtn = document.getElementById("drawItClearBtn");
      if (clearBtn) clearBtn.addEventListener("click", () => {
        drawItLocalStrokes = [];
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      });

      const submitBtn = document.getElementById("drawItSubmitBtn");
      if (submitBtn) submitBtn.addEventListener("click", () => {
        socket.emit("drawit:submit", { strokes: drawItLocalStrokes });
        drawItLocalStrokes = [];
      });
    }

    document.querySelectorAll(".drawItGalleryCanvas").forEach((canvasEl) => {
      const ctx = canvasEl.getContext("2d");
      ctx.strokeStyle = "#222";
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const entry = (d.gallery || []).find((e) => e.token === canvasEl.dataset.token);
      (entry ? entry.strokes : []).forEach((stroke) => drawStrokeOnCanvas(ctx, canvasEl, stroke.points));
    });

    document.querySelectorAll("[data-drawit-vote]").forEach((el) => {
      el.addEventListener("click", () => socket.emit("drawit:submit-vote", { authorToken: el.dataset.drawitVote }));
    });

    const nextBtn = document.getElementById("drawItNextBtn");
    if (nextBtn) nextBtn.addEventListener("click", () => socket.emit("drawit:next-round"));
  }

  initSoundToggle();
  initGameHelp();
  render();

  // Purely for install-prompt eligibility on Chrome/Android - see sw.js for
  // why it does nothing else. Feature-detected and best-effort: a browser
  // without support (or one that rejects it for any other reason) just
  // doesn't get the automatic install prompt, no functional loss either way.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
})();
