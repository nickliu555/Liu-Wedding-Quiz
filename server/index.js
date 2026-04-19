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
      width: 320,
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

function broadcastLobby() {
  io.emit('state:lobby', {
    phase: game.phase,
    players: game.getLobbyPlayers(),
    total: game.players.size,
    questionsTotal: questions.length,
  });
}

function broadcastQuestion() {
  const q = game.getQuestionPublic();
  if (!q) return;
  io.emit('state:question', q);
}

function broadcastReveal() {
  const q = game.getCurrentQuestion();
  if (!q) return;
  const payload = {
    questionId: q.id,
    index: game.currentIndex,
    total: questions.length,
    correctIndex: q.correctIndex,
    distribution: game.getAnswerDistribution(),
    leaderboardTop5: game.getLeaderboard(5),
    isLastQuestion: game.currentIndex === questions.length - 1,
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
  const lb = game.getLeaderboard();
  io.emit('state:final', {
    podium: lb.slice(0, 3),
    fullLeaderboard: lb,
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
    ack && ack({ ok: true, player: { id: res.player.id, name: res.player.name } });
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
    };
    if (game.phase === PHASES.QUESTION) {
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
    }
    ack && ack(payload);
    broadcastLobby();
  });

  socket.on('player:answer', ({ questionId, choiceIndex }, ack) => {
    if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
    const res = game.submitAnswer({ playerId, questionId, choiceIndex });
    if (!res.ok) return ack && ack(res);
    ack && ack({ ok: true, locked: true });
    broadcastAnswerCount();
    // If answering caused an early end, the game.phase is now REVEAL.
    if (game.phase === PHASES.REVEAL) broadcastReveal();
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
    if (game.phase === PHASES.QUESTION) {
      return ack && ack({ ok: false, reason: 'phase-closed' });
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
    });
    // Replay current state so a refreshed host page resumes exactly where it was.
    if (game.phase === PHASES.QUESTION) {
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
        socket.emit('state:reveal', {
          questionId: q.id,
          index: game.currentIndex,
          total: questions.length,
          correctIndex: q.correctIndex,
          distribution: game.getAnswerDistribution(),
          leaderboardTop5: game.getLeaderboard(5),
          isLastQuestion: game.currentIndex === questions.length - 1,
        });
      }
    } else if (game.phase === PHASES.FINAL) {
      const lb = game.getLeaderboard();
      socket.emit('state:final', { podium: lb.slice(0, 3), fullLeaderboard: lb });
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
    broadcastQuestion();
  });

  socket.on('host:next', (_p, ack) => {
    if (!requireHost(ack)) return;
    if (game.phase === PHASES.QUESTION) {
      // allow host to force-end the question early
      game._endQuestion('host');
      broadcastReveal();
      return ack && ack({ ok: true, advanced: 'reveal' });
    }
    const res = game.advance();
    if (!res.ok) return ack && ack(res);
    if (res.phase === PHASES.FINAL) {
      ack && ack({ ok: true, advanced: 'final' });
      broadcastFinal();
    } else {
      ack && ack({ ok: true, advanced: 'question' });
      broadcastQuestion();
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

  socket.on('host:reset', (_p, ack) => {
    if (!requireHost(ack)) return;
    game.reset();
    ack && ack({ ok: true });
    io.emit('state:reset');
    broadcastLobby();
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
