'use strict';

// Spawn N fake players that connect to the running server and join the lobby.
// Usage:
//   node scripts/sim-players.js              # 20 players, http://localhost:3000
//   node scripts/sim-players.js 50           # 50 players
//   COUNT=30 URL=http://192.168.1.10:3000 node scripts/sim-players.js
//   ANSWER=A node scripts/sim-players.js 115 # every player auto-answers A
//   ANSWER=random node scripts/sim-players.js 115  # (this is the default)
//
// ANSWER values: A | B | C | D | random  (default: random)
// MAX_ANSWER_DELAY_MS: max random delay before each answer (default: 2500)
//
// The script keeps connections open until you press Ctrl+C, so the host
// lobby page actually sees the chips.

const { io } = require('socket.io-client');
const crypto = require('crypto');

const COUNT = parseInt(process.argv[2] || process.env.COUNT || '20', 10);
const URL = process.env.URL || 'http://localhost:3000';
const ANSWER_MODE = (process.env.ANSWER || 'RANDOM').toUpperCase();
const MAX_ANSWER_DELAY_MS = parseInt(process.env.MAX_ANSWER_DELAY_MS || '2500', 10);

// Map ANSWER setting -> choice index (0=A, 1=B, 2=C, 3=D, random per question)
function chooseAnswerIndex() {
  if (ANSWER_MODE === 'RANDOM') return Math.floor(Math.random() * 4);
  const idx = { A: 0, B: 1, C: 2, D: 3 }[ANSWER_MODE];
  return typeof idx === 'number' ? idx : Math.floor(Math.random() * 4);
}

const FIRST = [
  'Avery', 'Bea', 'Casey', 'Dev', 'Eli', 'Finn', 'Gigi', 'Hana',
  'Indy', 'Jules', 'Kai', 'Luna', 'Mira', 'Niko', 'Omar', 'Pia',
  'Quinn', 'Remy', 'Sage', 'Tess', 'Uma', 'Vik', 'Wren', 'Xio',
  'Yuna', 'Zane',
];

function uniqueName(i) {
  return `${FIRST[i % FIRST.length]} ${String.fromCharCode(65 + Math.floor(i / FIRST.length))}.`;
}

const sockets = [];
let joined = 0;
let failed = 0;
let answersSubmitted = 0;

console.log(`Spawning ${COUNT} fake players against ${URL} (answer mode: ${ANSWER_MODE}) ...`);

for (let i = 0; i < COUNT; i++) {
  const pid = crypto.randomUUID();
  const name = uniqueName(i);
  const s = io(URL, { transports: ['websocket'], reconnection: false });
  // Track which question ids this player has already answered so we
  // don't double-submit if state:question is re-broadcast.
  const answered = new Set();

  s.on('connect', () => {
    s.emit('player:join', { playerId: pid, name }, (res) => {
      if (res && res.ok) {
        joined++;
        process.stdout.write(`+ ${name.padEnd(12)} joined  (${joined}/${COUNT})\n`);
      } else {
        failed++;
        console.warn(`x ${name} failed:`, res && res.reason);
      }
    });
  });

  s.on('connect_error', (err) => {
    failed++;
    console.warn(`x ${name} connect_error:`, err.message);
  });

  // Auto-answer whenever a new question is broadcast. Stagger each
  // player's submission by a random 50ms..MAX_ANSWER_DELAY_MS so the
  // server isn't hit by 115 simultaneous packets and the host UI sees
  // the "X / 115 answered" counter tick up naturally.
  s.on('state:question', (q) => {
    if (!q || !q.id || answered.has(q.id)) return;
    answered.add(q.id);
    const delay = 50 + Math.floor(Math.random() * Math.max(0, MAX_ANSWER_DELAY_MS - 50));
    setTimeout(() => {
      const choiceIndex = chooseAnswerIndex();
      s.emit('player:answer', { questionId: q.id, choiceIndex: choiceIndex }, (res) => {
        if (res && res.ok) answersSubmitted++;
      });
    }, delay);
  });

  sockets.push(s);
}

function shutdown() {
  console.log(`\nDisconnecting ${sockets.length} sockets ...`);
  for (const s of sockets) {
    try { s.disconnect(); } catch (_) {}
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Status nudge once a second so it's obvious the script is alive.
setInterval(() => {
  process.stdout.write(`  ... ${joined} joined, ${failed} failed, ${answersSubmitted} answers submitted. Ctrl+C to disconnect.\r`);
}, 2000);
