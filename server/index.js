'use strict';

require('dotenv').config();

const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { loadQuestions, QuestionsError } = require('./questions');
const { Game, PHASES } = require('./game');
const { isBlocked } = require('./profanity');

const PORT = parseInt(process.env.PORT, 10) || 3000;

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
        return net.address;
      }
    }
  }
  return 'localhost';
}
const LOCAL_IP = getLocalIP();

function getPublicBaseUrl() {
  // Priority: explicit env (for Render / custom deploys) -> LAN IP (for local testing) -> localhost.
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  return `http://${LOCAL_IP}:${PORT}`;
}

// ---------------- Load questions (fail fast) ----------------
let questions;
try {
  questions = loadQuestions(path.join(__dirname, '..', 'data', 'questions.json'));
  console.log(`Loaded ${questions.length} questions.`);
} catch (e) {
  if (e instanceof QuestionsError) {
    console.error(`\n[questions.json] ${e.message}\n`);
  } else {
    console.error(e);
  }
  process.exit(1);
}

const game = new Game(questions);

// ---------------- Express ----------------
const app = express();
const publicDir = path.join(__dirname, '..', 'public');
const assetsDir = path.join(__dirname, '..', 'assets');

app.use(express.static(publicDir));
app.use('/assets', express.static(assetsDir));

app.get('/', (_req, res) => res.redirect('/join.html'));
app.get('/join', (_req, res) => res.sendFile(path.join(publicDir, 'join.html')));
app.get('/play', (_req, res) => res.sendFile(path.join(publicDir, 'player.html')));
app.get('/host', (_req, res) => res.sendFile(path.join(publicDir, 'host.html')));
app.get('/healthz', (_req, res) => res.json({ ok: true, phase: game.phase, players: game.players.size }));

app.get('/config', (_req, res) => {
  const base = getPublicBaseUrl();
  res.json({ joinUrl: `${base}/join` });
});

app.get('/qr', async (req, res) => {
  const url = String(req.query.url || '');
  if (!url || url.length > 500) return res.status(400).send('bad url');
  try {
    const svg = await QRCode.toString(url, {
      type: 'svg',
      margin: 1,
      width: 640,
      color: { dark: '#1F2A24', light: '#FFFFFF' },
    });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-store');
    res.send(svg);
  } catch (e) {
    res.status(500).send('qr error');
  }
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---------------- Broadcast helpers ----------------
const HOST_ROOM = 'hosts';

// Reactions (floating emojis from players to the host page).
const REACTION_COUNT = 6; // must match the player UI palette length
const REACTION_COOLDOWN_MS = 10 * 1000;
const lastReactionAt = new Map(); // playerId -> ms timestamp of last reaction
// When true, the host has temporarily muted all player reactions. Persists
// across phase transitions until the host toggles it back on.
let reactionsMuted = false;

function broadcastLobby() {
  io.emit('state:lobby', {
    phase: game.phase,
    players: game.getLobbyPlayers(),
    total: game.players.size,
    questionsTotal: questions.length,
    announcementMode: game.announcementMode,
  });
}

function broadcastQuestion() {
  const q = game.getQuestionPublic();
  if (!q) return;
  io.emit('state:question', q);
}

function broadcastIntro() {
  const intro = game.getIntroPublic();
  io.emit('state:intro', intro);
}

function broadcastPrompt() {
  const p = game.getPromptPublic();
  if (!p) return;
  io.emit('state:prompt', p);
}

function broadcastReveal() {
  const q = game.getCurrentQuestion();
  if (!q) return;
  // `getLeaderboardTop` returns both the capped rows AND the count of
  // additional players tied at the last shown rank (cut off by the cap).
  // The host renders an "…and N more tied at rank X" line from that
  // count so genuinely tied players aren't silently hidden by the
  // alphabetical display tiebreaker.
  const top = game.getLeaderboardTop(5);
  const payload = {
    questionId: q.id,
    index: game.currentIndex,
    total: questions.length,
    correctIndex: q.correctIndex,
    distribution: game.getAnswerDistribution(),
    leaderboardTop5: top.rows,
    leaderboardTop5MoreTied: top.moreTiedAtLastRank,
    isLastQuestion: game.currentIndex === questions.length - 1,
    // 'timeout' | 'all-answered' | 'host' — drives the brief sting copy on
    // the host page ("Time's up!" vs. "Let's see the answers!").
    endReason: game.lastEndReason || 'host',
  };
  io.emit('state:reveal', payload);
  // Per-player results
  for (const p of game.players.values()) {
    if (!p.socketId) continue;
    const result = game.getPlayerResult(p.id);
    if (result) io.to(p.socketId).emit('player:result', result);
  }
}

function broadcastFinal() {
  // Use the tier-annotated leaderboard so each row carries
  // `podiumTier` ∈ {1,2,3,null}. Player phones key off that (not raw
  // rank) to pick the medal copy — keeps host podium and phones
  // aligned when ties push the bronze tier down below rank 3.
  const lb = game.getLeaderboardWithPodiumTier();
  io.emit('state:final', {
    // `podium` (top 3 rows) kept for back-compat. The host now drives
    // the podium reveal off `podiumGroups`, which buckets players by
    // DISTINCT rank so every tied player at a top-3 rank gets shown
    // (not just the first 3 by alphabetical order).
    podium: lb.slice(0, 3),
    podiumGroups: game.getPodiumGroups(),
    fullLeaderboard: lb,
    // Tells player phones whether the host has already finished its
    // podium reveal. While false, phones hold back the rank card so
    // they don't spoil the standings before the room sees them.
    podiumRevealed: game.podiumRevealed,
  });
}

function broadcastAnswerCount() {
  io.to(HOST_ROOM).emit('host:answerCount', {
    answered: game.answeredCount(),
    total: game.players.size,
  });
}

// When server-side timer expires (or all-answered), advance to reveal.
game.onQuestionTimeout = () => broadcastReveal();
// When the "Get ready" splash finishes, broadcast the first question's prompt.
game.onIntroEnd = () => broadcastPrompt();
// When the prompt lead-in finishes, broadcast the answer choices + start timer.
game.onPromptEnd = () => broadcastQuestion();

// ---------------- Socket handlers ----------------
io.on('connection', (socket) => {
  let role = null; // 'player' | 'host'
  let playerId = null;

  // ---- Player flows ----
  socket.on('player:join', ({ playerId: pid, name }, ack) => {
    if (!pid || typeof pid !== 'string') {
      return ack && ack({ ok: false, reason: 'bad-player-id' });
    }
    if (isBlocked(name)) {
      return ack && ack({ ok: false, reason: 'name-blocked' });
    }
    const res = game.addPlayer({ playerId: pid, name, socketId: socket.id });
    if (!res.ok) return ack && ack(res);
    role = 'player';
    playerId = pid;
    socket.join('players');
    ack && ack({ ok: true, player: { id: res.player.id, name: res.player.name }, reactionsMuted, announcementMode: game.announcementMode });
    broadcastLobby();
  });

  socket.on('player:reconnect', ({ playerId: pid }, ack) => {
    if (!pid) return ack && ack({ ok: false, reason: 'bad-player-id' });
    const res = game.reconnectPlayer({ playerId: pid, socketId: socket.id });
    if (!res.ok) return ack && ack(res);
    role = 'player';
    playerId = pid;
    socket.join('players');
    const payload = {
      ok: true,
      player: { id: res.player.id, name: res.player.name, score: res.player.score },
      phase: game.phase,
      reactionsMuted,
      announcementMode: game.announcementMode,
    };
    if (game.phase === PHASES.INTRO) {
      payload.intro = game.getIntroPublic();
    } else if (game.phase === PHASES.PROMPT) {
      payload.prompt = game.getPromptPublic();
    } else if (game.phase === PHASES.QUESTION) {
      payload.question = game.getQuestionPublic();
      // If this player already locked in an answer for the current question
      // (they refreshed mid-question after answering), tell the client so it
      // can show the "Answer locked in!" view instead of fresh tiles.
      // Also subtract any points earned for the in-flight question from the
      // displayed score, so it doesn't reveal correctness before everyone
      // sees the reveal screen.
      const q = game.getCurrentQuestion();
      if (q) {
        const ans = res.player.answers && res.player.answers.find((a) => a.questionId === q.id);
        if (ans) {
          payload.myChoiceIndex = ans.choiceIndex;
          payload.player.score = Math.max(0, (res.player.score || 0) - (ans.points || 0));
        }
      }
    } else if (game.phase === PHASES.REVEAL) {
      // On refresh during the reveal, restore the same per-player result
      // card the player saw before refreshing (correct/wrong, +XYZ points,
      // rank) instead of falling back to a generic "Hold tight..." view.
      payload.myResult = game.getPlayerResult(pid);
    } else if (game.phase === PHASES.FINAL) {
      // On refresh during the final, give the phone enough state to render
      // either the "Thanks for playing" placeholder (while the host is
      // still mid-podium-reveal) or the rank-reveal card (if the host
      // already signaled `host:podiumDone`). `podiumRevealed` is the
      // gate; player code chooses which to render based on that flag.
      // Tier-annotated rows let the phone show the correct medal even
      // when the silver/bronze tier is at a non-2/3 rank.
      const lb = game.getLeaderboardWithPodiumTier();
      payload.final = {
        fullLeaderboard: lb,
        podiumRevealed: game.podiumRevealed,
      };
    }
    ack && ack(payload);
    broadcastLobby();
  });

  // Lightweight lobby-open probe used by the /join page so it can show
  // a "quiz already in progress" notice up front instead of letting a
  // late-arriving guest type a name and only then learn the lobby is
  // closed. The page also listens for state:lobby broadcasts (already
  // fired on host:start and host:reset) to live-flip when the host
  // starts the quiz or resets back to LOBBY.
  socket.on('lobby:status', (_p, ack) => {
    if (typeof ack !== 'function') return;
    ack({ phase: game.phase, open: game.phase === PHASES.LOBBY });
  });

  socket.on('player:answer', ({ questionId, choiceIndex }, ack) => {
    if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
    const res = game.submitAnswer({ playerId, questionId, choiceIndex });
    if (!res.ok) return ack && ack(res);
    ack && ack({ ok: true, locked: true });
    broadcastAnswerCount();
    // NOTE: do NOT call broadcastReveal() here even if answering caused
    // an early end. game._endQuestion() already fires the
    // `onQuestionTimeout` callback (see line 183), which is wired to
    // broadcastReveal(). Adding a manual call here double-emits
    // state:reveal — the host then schedules two stings and the chime
    // plays twice (i.e. the "2 dings on reveal" bug). The callback is
    // the single source of truth for QUESTION -> REVEAL transitions.
  });

  // ---- Reactions (player -> host floating emojis) ----
  // Allowed during LOBBY, REVEAL, and FINAL phases (NOT during a live
  // question, so reactions don't distract from the answer choices).
  // Per-player cooldown of 10 seconds enforced server-side.
  socket.on('player:reaction', ({ index }, ack) => {
    if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
    if (typeof index !== 'number' || index < 0 || index >= REACTION_COUNT) {
      return ack && ack({ ok: false, reason: 'bad-index' });
    }
    // Reactions allowed in LOBBY / REVEAL / FINAL only — not during a live
    // question (would distract from the choices) and not during INTRO /
    // PROMPT lead-ins (would clutter the "get ready" / read-the-question
    // moment with floating emojis).
    if (
      game.phase === PHASES.QUESTION ||
      game.phase === PHASES.INTRO ||
      game.phase === PHASES.PROMPT
    ) {
      return ack && ack({ ok: false, reason: 'phase-closed' });
    }
    if (reactionsMuted) {
      return ack && ack({ ok: false, reason: 'muted' });
    }
    const now = Date.now();
    const last = lastReactionAt.get(playerId) || 0;
    if (now - last < REACTION_COOLDOWN_MS) {
      return ack && ack({
        ok: false,
        reason: 'cooldown',
        retryInMs: REACTION_COOLDOWN_MS - (now - last),
      });
    }
    lastReactionAt.set(playerId, now);
    ack && ack({ ok: true });
    // Broadcast to host page(s) only — players don't need to see other players' reactions.
    io.to(HOST_ROOM).emit('host:reaction', { index: index });
  });

  // ---- Host flows ----
  socket.on('host:auth', (_p, ack) => {
    role = 'host';
    socket.join(HOST_ROOM);
    ack && ack({
      ok: true,
      phase: game.phase,
      players: game.getLobbyPlayers(),
      questionsTotal: questions.length,
      currentIndex: game.currentIndex,
      reactionsMuted,
      announcementMode: game.announcementMode,
    });
    // Replay current state so a refreshed host page resumes exactly where it was.
    if (game.phase === PHASES.INTRO) {
      socket.emit('state:intro', game.getIntroPublic());
    } else if (game.phase === PHASES.PROMPT) {
      const p = game.getPromptPublic();
      if (p) socket.emit('state:prompt', p);
    } else if (game.phase === PHASES.QUESTION) {
      const q = game.getQuestionPublic();
      if (q) socket.emit('state:question', q);
      socket.emit('host:answerCount', {
        answered: game.answeredCount(),
        total: game.players.size,
      });
    } else if (game.phase === PHASES.REVEAL) {
      const q = game.getCurrentQuestion();
      const pub = game.getQuestionPublic();
      if (q && pub) {
        // Send the question first so the host has currentQ populated
        // (needed to render choice text in the distribution rows).
        socket.emit('state:question', pub);
        const top = game.getLeaderboardTop(5);
        socket.emit('state:reveal', {
          questionId: q.id,
          index: game.currentIndex,
          total: questions.length,
          correctIndex: q.correctIndex,
          distribution: game.getAnswerDistribution(),
          leaderboardTop5: top.rows,
          leaderboardTop5MoreTied: top.moreTiedAtLastRank,
          isLastQuestion: game.currentIndex === questions.length - 1,
          // On host refresh we don't replay the sting — they're past it.
          endReason: 'replay',
        });
      }
    } else if (game.phase === PHASES.FINAL) {
      const lb = game.getLeaderboardWithPodiumTier();
      socket.emit('state:final', {
        podium: lb.slice(0, 3),
        podiumGroups: game.getPodiumGroups(),
        fullLeaderboard: lb,
        podiumRevealed: game.podiumRevealed,
      });
    }
  });

  function requireHost(ack) {
    if (role !== 'host') {
      ack && ack({ ok: false, reason: 'not-host' });
      return false;
    }
    return true;
  }

  socket.on('host:start', (_p, ack) => {
    if (!requireHost(ack)) return;
    const res = game.start();
    if (!res.ok) return ack && ack(res);
    ack && ack({ ok: true });
    broadcastLobby();
    // Game now in INTRO phase — show the "Get ready..." splash to everyone.
    broadcastIntro();
  });

  socket.on('host:next', (_p, ack) => {
    if (!requireHost(ack)) return;
    // advance() routes itself based on the current phase: skip intro,
    // skip prompt, force-end question, or move from reveal to next prompt /
    // final. We just have to broadcast whatever new phase we landed in.
    const res = game.advance();
    if (!res.ok) return ack && ack(res);
    if (res.phase === PHASES.PROMPT) {
      broadcastPrompt();
      ack && ack({ ok: true, advanced: 'prompt' });
    } else if (res.phase === PHASES.QUESTION) {
      broadcastQuestion();
      ack && ack({ ok: true, advanced: 'question' });
    } else if (res.phase === PHASES.REVEAL) {
      // Do NOT call broadcastReveal() here. When advance() lands on
      // REVEAL it's because game._endQuestion('host') ran, which has
      // already fired the `onQuestionTimeout` callback → broadcastReveal.
      // Calling it again would double-emit state:reveal (same "2 dings"
      // class of bug as the player:answer handler above).
      ack && ack({ ok: true, advanced: 'reveal' });
    } else if (res.phase === PHASES.FINAL) {
      broadcastFinal();
      ack && ack({ ok: true, advanced: 'final' });
    } else {
      ack && ack({ ok: true });
    }
  });

  socket.on('host:kick', ({ playerId: pid }, ack) => {
    if (!requireHost(ack)) return;
    const p = game.removePlayer(pid);
    if (!p) return ack && ack({ ok: false, reason: 'unknown-player' });
    if (p.socketId) {
      io.to(p.socketId).emit('player:rejected', { reason: 'kicked' });
    }
    ack && ack({ ok: true });
    broadcastLobby();
  });

  // Host signals that its podium reveal animation has finished playing.
  // We flip the FINAL-phase gate and broadcast `state:rankReveal` so all
  // player phones flip from "Thanks for playing" to their personal rank
  // card in unison. The broadcast fires only on the FIRST flip — if the
  // host page is refreshed and re-runs its reveal animation, a second
  // `host:podiumDone` is acknowledged but doesn't re-blast clients with
  // a duplicate signal. Only honored while we're actually in FINAL;
  // out-of-phase calls would otherwise stamp the flag during the next
  // round's INTRO and spoil the new game.
  socket.on('host:podiumDone', (_p, ack) => {
    if (!requireHost(ack)) return;
    if (game.phase !== PHASES.FINAL) {
      return ack && ack({ ok: false, reason: 'not-final' });
    }
    const wasAlreadyRevealed = game.podiumRevealed;
    game.podiumRevealed = true;
    if (!wasAlreadyRevealed) {
      io.emit('state:rankReveal');
    }
    ack && ack({ ok: true, alreadyRevealed: wasAlreadyRevealed });
  });

  // Host requests the full per-player results dump for CSV export. Read-only
  // (getExportData() never mutates state). Only honored in FINAL so the
  // operator can't pull a half-finished game's data, and host-gated so a
  // player socket can't scrape everyone's answers.
  socket.on('host:exportResults', (_p, ack) => {
    if (!requireHost(ack)) return;
    if (game.phase !== PHASES.FINAL) {
      return ack && ack({ ok: false, reason: 'not-final' });
    }
    const data = game.getExportData();
    ack && ack({ ok: true, questions: data.questions, rows: data.rows });
  });

  socket.on('host:reset', (_p, ack) => {
    if (!requireHost(ack)) return;
    game.reset();
    ack && ack({ ok: true });
    io.emit('state:reset');
    broadcastLobby();
  });

  socket.on('host:setReactionsMuted', ({ muted } = {}, ack) => {
    if (!requireHost(ack)) return;
    reactionsMuted = !!muted;
    ack && ack({ ok: true, reactionsMuted });
    // Broadcast to everyone (players gray out their bar; other host pages
    // sync their button state).
    io.emit('state:reactionsMuted', { muted: reactionsMuted });
  });

  // Announcement Mode toggle. Only honored while in LOBBY — the game
  // method enforces this. The flag affects PROMPT phase timing on the
  // server (no auto-advance) and a number of host/player rendering
  // decisions on the client, so we broadcast `state:announcementMode`
  // to keep every connected client in sync.
  socket.on('host:setAnnouncementMode', ({ on } = {}, ack) => {
    if (!requireHost(ack)) return;
    const res = game.setAnnouncementMode(!!on);
    if (!res.ok) {
      // Echo the current truth so the host UI can revert its toggle.
      return ack && ack({ ok: false, reason: res.reason, announcementMode: game.announcementMode });
    }
    ack && ack({ ok: true, announcementMode: game.announcementMode });
    io.emit('state:announcementMode', { on: game.announcementMode });
  });

  // Announcement Mode: host clicks "Start answering →" after the DJ has
  // finished reading the question + choices aloud. Advances PROMPT →
  // QUESTION immediately (the auto-timer is intentionally NOT armed in
  // this mode — see `Game._enterPrompt`). The game method is
  // phase-guarded so a stray duplicate click is harmlessly rejected.
  socket.on('host:startAnswering', (_p, ack) => {
    if (!requireHost(ack)) return;
    const res = game.startAnsweringNow();
    if (!res.ok) return ack && ack(res);
    // Mirror what the prompt-end timer callback would have done in the
    // default flow: broadcast the question payload so clients flip into
    // the answering view with the timer running.
    broadcastQuestion();
    ack && ack({ ok: true });
  });

  // ---- Disconnect ----
  socket.on('disconnect', () => {
    if (role === 'player') {
      game.markDisconnected(socket.id);
      broadcastLobby();
    }
  });
});

// ---------------- Boot ----------------
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n===========================================');
  console.log('  Liu Wedding Quiz Server');
  console.log('===========================================');
  if (process.env.RENDER_EXTERNAL_URL) {
    console.log(`  Live at:      ${process.env.RENDER_EXTERNAL_URL}`);
    console.log(`  Host page:    ${process.env.RENDER_EXTERNAL_URL}/host`);
  } else {
    console.log(`  Host (you):   http://localhost:${PORT}/host`);
    console.log(`  Phones join:  http://${LOCAL_IP}:${PORT}/join`);
  }
  console.log('===========================================\n');
});
