'use strict';

// Tests for the tie-aware leaderboard helpers on Game:
//   getLeaderboard()      — competition ranking (1, 2, 2, 4) + alphabetical
//                           display tiebreaker
//   getLeaderboardTop(N)  — capped rows + count of additional tied players
//                           at the last shown rank
//   getPodiumGroups()     — bucket top 3 RANKS (not top 3 players)
//
// These cover the cases that motivated the rewrite: pre-rewrite, tied
// players got different ranks based on join order / answer time, which
// was unfair when the game scoring is identical.

const { Game } = require('./game');

let failures = 0;
function assertEq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${name}\n  expected ${e}\n  got      ${a}`);
    failures++;
  } else {
    console.log(`ok: ${name}`);
  }
}

// Build a Game with the given [name, score] pairs. Player IDs are
// derived from names so output is deterministic; we set the score
// directly since these tests aren't exercising the scoring math.
function buildGame(pairs) {
  const g = new Game([]);
  for (const [name, score] of pairs) {
    g.players.set(`pid-${name}`, {
      id: `pid-${name}`,
      name,
      score,
      answers: [],
      connected: true,
      socketId: null,
    });
  }
  return g;
}

// --- getLeaderboard ---

// Competition ranking with a single tie in the middle.
{
  const g = buildGame([['Avery', 1000], ['Bea', 900], ['Casey', 900], ['Dev', 800]]);
  const lb = g.getLeaderboard();
  assertEq(
    lb.map((r) => [r.name, r.score, r.rank]),
    [['Avery', 1000, 1], ['Bea', 900, 2], ['Casey', 900, 2], ['Dev', 800, 4]],
    'getLeaderboard: 1, 2, 2, 4 ranking with mid tie'
  );
}

// All tied at zero (every player AFK) — all rank 1.
{
  const g = buildGame([['Casey', 0], ['Avery', 0], ['Bea', 0]]);
  const lb = g.getLeaderboard();
  assertEq(
    lb.map((r) => [r.name, r.rank]),
    [['Avery', 1], ['Bea', 1], ['Casey', 1]],
    'getLeaderboard: all-tied gets same rank, alphabetical display order'
  );
}

// Tiebreak is alphabetical regardless of insertion (join) order.
{
  const g = buildGame([['Zane', 500], ['Avery', 500]]);
  const lb = g.getLeaderboard();
  assertEq(
    lb.map((r) => [r.name, r.rank]),
    [['Avery', 1], ['Zane', 1]],
    'getLeaderboard: alphabetical tiebreak not biased by join order'
  );
}

// Case-insensitive alphabetical tiebreak.
{
  const g = buildGame([['bea', 100], ['Avery', 100]]);
  const lb = g.getLeaderboard();
  assertEq(
    lb.map((r) => r.name),
    ['Avery', 'bea'],
    'getLeaderboard: alphabetical tiebreak is case-insensitive'
  );
}

// Empty game.
{
  const g = buildGame([]);
  assertEq(g.getLeaderboard(), [], 'getLeaderboard: empty game returns []');
}

// Limit slice still applies.
{
  const g = buildGame([['A', 4], ['B', 3], ['C', 2], ['D', 1]]);
  const lb = g.getLeaderboard(2);
  assertEq(lb.length, 2, 'getLeaderboard(2): slices to 2 rows');
}

// --- getLeaderboardTop ---

// No overflow when the game fits in the cap.
{
  const g = buildGame([['A', 100], ['B', 50]]);
  const top = g.getLeaderboardTop(5);
  assertEq(top.rows.length, 2, 'getLeaderboardTop: rows present');
  assertEq(top.moreTiedAtLastRank, 0, 'getLeaderboardTop: no overflow when under cap');
}

// 7 players all tied at rank 1, cap at 5 -> 2 overflow at rank 1.
{
  const g = buildGame([
    ['A', 0], ['B', 0], ['C', 0], ['D', 0],
    ['E', 0], ['F', 0], ['G', 0],
  ]);
  const top = g.getLeaderboardTop(5);
  assertEq(top.rows.length, 5, 'getLeaderboardTop: capped to 5 rows');
  assertEq(top.moreTiedAtLastRank, 2, 'getLeaderboardTop: 2 more tied at rank 1 reported');
}

// Cap lands exactly on a tie boundary: row 5 is rank 3, row 6 is rank 6.
// No overflow because row 6 isn't tied with the last shown rank.
{
  const g = buildGame([
    ['A', 100], ['B', 90], ['C', 80], ['D', 80], ['E', 80], ['F', 50],
  ]);
  const top = g.getLeaderboardTop(5);
  assertEq(top.moreTiedAtLastRank, 0, 'getLeaderboardTop: no overflow when next row is a different rank');
}

// --- getPodiumGroups ---

// Clean: three distinct top-3 scores -> three groups, one player each.
{
  const g = buildGame([['A', 100], ['B', 90], ['C', 80], ['D', 70]]);
  const groups = g.getPodiumGroups();
  assertEq(groups.length, 3, 'getPodiumGroups: 3 distinct ranks -> 3 groups');
  assertEq(groups[0].players.length, 1, 'getPodiumGroups: rank 1 group has 1 player');
  assertEq(groups[0].rank, 1, 'getPodiumGroups: first group is rank 1');
  assertEq(groups[2].rank, 3, 'getPodiumGroups: third group is rank 3');
}

// 5 tied for 1st -> single group, no silver/bronze.
{
  const g = buildGame([['A', 50], ['B', 50], ['C', 50], ['D', 50], ['E', 50]]);
  const groups = g.getPodiumGroups();
  assertEq(groups.length, 1, 'getPodiumGroups: all tied for 1st -> 1 group only');
  assertEq(groups[0].players.length, 5, 'getPodiumGroups: 5 players in the tied group');
  assertEq(groups[0].rank, 1, 'getPodiumGroups: tied group rank is 1');
}

// 1st distinct, 2nd is a tie -> still 3 groups (rank 1, rank 2 with 2
// players, rank 4 with 1 player). With competition ranking nobody is
// "rank 3" here, but the 4th-ranked player still gets the bronze slot
// because we show the top 3 DISTINCT RANKS, not the top 3 ranks 1/2/3.
{
  const g = buildGame([['A', 100], ['B', 90], ['C', 90], ['D', 70]]);
  const groups = g.getPodiumGroups();
  assertEq(groups.length, 3, 'getPodiumGroups: rank 1 + rank 2 tie + rank 4 -> 3 groups');
  assertEq(groups[1].players.length, 2, 'getPodiumGroups: 2 players in rank 2 group');
  assertEq(groups[2].rank, 4, 'getPodiumGroups: bronze group rank is 4 (no rank 3 exists)');
}

// All 115 AFK case: 1 group with 115 players, rank 1.
{
  const pairs = [];
  for (let i = 0; i < 115; i++) pairs.push([`P${String(i).padStart(3, '0')}`, 0]);
  const g = buildGame(pairs);
  const groups = g.getPodiumGroups();
  assertEq(groups.length, 1, 'getPodiumGroups: 115-way tie -> 1 group');
  assertEq(groups[0].players.length, 115, 'getPodiumGroups: all 115 players in the tied group');
}

// Empty game.
{
  const g = buildGame([]);
  assertEq(g.getPodiumGroups(), [], 'getPodiumGroups: empty game returns []');
}

// --- onQuestionTimeout single-emission ---
// Regression test for the "2 dings on reveal" bug. When the last player
// submits an answer, the question ends early via _endQuestion('all-answered'),
// which fires the onQuestionTimeout callback ONCE. The server-side socket
// handlers must NOT call broadcastReveal a second time after submitAnswer
// returns — that double-emit caused the host's reveal sting (and its
// chime) to play twice, producing two dings instead of one.
{
  const q = {
    id: 'q1',
    prompt: 'Test?',
    choices: ['A', 'B', 'C', 'D'],
    correctIndex: 0,
    timeLimitSec: 30,
  };
  const g = new Game([q]);
  // Wire two players directly so we can drive submitAnswer without
  // going through the join flow.
  g.players.set('p1', { id: 'p1', name: 'P1', score: 0, answers: [], connected: true, socketId: null });
  g.players.set('p2', { id: 'p2', name: 'P2', score: 0, answers: [], connected: true, socketId: null });
  // Move into QUESTION phase by hand (skip the intro/prompt timers so
  // we don't need fake timers in the test).
  g.phase = 'QUESTION';
  g.currentIndex = 0;
  g.currentStartTs = Date.now();
  g.currentEndsAt = g.currentStartTs + 30 * 1000;

  let callbackCount = 0;
  g.onQuestionTimeout = () => { callbackCount++; };

  // First player answers — question still live.
  const r1 = g.submitAnswer({ playerId: 'p1', questionId: 'q1', choiceIndex: 0 });
  assertEq(r1.ok, true, 'submitAnswer: first player accepted');
  assertEq(callbackCount, 0, 'onQuestionTimeout: NOT fired before all answered');

  // Last player answers — _endQuestion('all-answered') should fire the
  // callback EXACTLY once.
  const r2 = g.submitAnswer({ playerId: 'p2', questionId: 'q1', choiceIndex: 1 });
  assertEq(r2.ok, true, 'submitAnswer: last player accepted');
  assertEq(callbackCount, 1, 'onQuestionTimeout: fired exactly once on all-answered');
  assertEq(g.phase, 'REVEAL', 'phase: transitioned to REVEAL on all-answered');
  assertEq(g.lastEndReason, 'all-answered', 'lastEndReason: tagged as all-answered');
}

// Host-driven advance during QUESTION also fires the callback exactly
// once. Same single-source-of-truth contract — server/index.js host:next
// handler must rely on this and not double-broadcast.
{
  const q = {
    id: 'q1', prompt: 'Q', choices: ['A', 'B', 'C', 'D'],
    correctIndex: 0, timeLimitSec: 30,
  };
  const g = new Game([q]);
  g.players.set('p1', { id: 'p1', name: 'P1', score: 0, answers: [], connected: true, socketId: null });
  g.phase = 'QUESTION';
  g.currentIndex = 0;
  g.currentStartTs = Date.now();
  g.currentEndsAt = g.currentStartTs + 30 * 1000;

  let callbackCount = 0;
  g.onQuestionTimeout = () => { callbackCount++; };

  const res = g.advance();
  assertEq(res.ok, true, 'advance: host-driven QUESTION->REVEAL accepted');
  assertEq(res.phase, 'REVEAL', 'advance: returned REVEAL phase');
  assertEq(callbackCount, 1, 'onQuestionTimeout: fired exactly once on host advance');
  assertEq(g.lastEndReason, 'host', 'lastEndReason: tagged as host');
}

// --- getLeaderboardWithPodiumTier ---
// Annotates each leaderboard row with podiumTier ∈ {1,2,3,null} based
// on the top-3-DISTINCT-ranks rule (mirroring getPodiumGroups). The
// player phone keys off `podiumTier` (not raw rank) when picking the
// medal, so this annotation is what keeps host podium and phones in
// agreement when ties shift silver/bronze to non-2/3 ranks.

// Vanilla case: 3 distinct scores -> tiers [1,2,3].
{
  const g = buildGame([['Avery', 100], ['Bea', 50], ['Casey', 25]]);
  const lb = g.getLeaderboardWithPodiumTier();
  assertEq(
    lb.map((r) => [r.name, r.rank, r.podiumTier]),
    [['Avery', 1, 1], ['Bea', 2, 2], ['Casey', 3, 3]],
    'getLeaderboardWithPodiumTier: vanilla 3 distinct ranks -> tiers 1/2/3'
  );
}

// User's reported scenario: 9 players with ranks [1,1,3,3,3,6,6,6,6]
// should map to tiers [1,1,2,2,2,3,3,3,3] so rank-6 players still get
// bronze on their phones (matching the host podium's bronze slot).
{
  const g = buildGame([
    ['Pia',  998], ['Remy', 998],
    ['Gigi', 996], ['Hana', 996], ['Niko', 996],
    ['Mira', 995], ['Omar', 995], ['Sage', 995], ['Vik', 995],
  ]);
  const lb = g.getLeaderboardWithPodiumTier();
  assertEq(
    lb.map((r) => [r.name, r.rank, r.podiumTier]),
    [
      ['Pia',  1, 1], ['Remy', 1, 1],
      ['Gigi', 3, 2], ['Hana', 3, 2], ['Niko', 3, 2],
      ['Mira', 6, 3], ['Omar', 6, 3], ['Sage', 6, 3], ['Vik',  6, 3],
    ],
    'getLeaderboardWithPodiumTier: 9-player [1,1,3,3,3,6,6,6,6] -> tiers [1,1,2,2,2,3,3,3,3]'
  );
}

// All-tied: only one distinct rank exists, every row gets tier 1.
// No silver or bronze tier should appear anywhere.
{
  const g = buildGame([['Avery', 100], ['Bea', 100], ['Casey', 100], ['Dev', 100]]);
  const lb = g.getLeaderboardWithPodiumTier();
  assertEq(
    lb.map((r) => r.podiumTier),
    [1, 1, 1, 1],
    'getLeaderboardWithPodiumTier: all tied for 1st -> every row tier 1'
  );
}

// Two distinct ranks ([1,1,3]): tiers [1,1,2], no bronze.
{
  const g = buildGame([['Avery', 100], ['Bea', 100], ['Casey', 50]]);
  const lb = g.getLeaderboardWithPodiumTier();
  assertEq(
    lb.map((r) => r.podiumTier),
    [1, 1, 2],
    'getLeaderboardWithPodiumTier: top tie + lone third -> tiers [1,1,2]'
  );
}

// Beyond top-3 distinct ranks: those rows get podiumTier: null.
{
  const g = buildGame([
    ['Avery', 100], ['Bea', 80], ['Casey', 60], ['Dev', 40], ['Eli', 20],
  ]);
  const lb = g.getLeaderboardWithPodiumTier();
  assertEq(
    lb.map((r) => [r.name, r.podiumTier]),
    [['Avery', 1], ['Bea', 2], ['Casey', 3], ['Dev', null], ['Eli', null]],
    'getLeaderboardWithPodiumTier: rows past tier 3 get null'
  );
}

// Empty game returns [].
{
  const g = buildGame([]);
  assertEq(g.getLeaderboardWithPodiumTier(), [], 'getLeaderboardWithPodiumTier: empty game -> []');
}

// --- getPlayerResult rank ---
// Regression: pre-fix the function used `lb.findIndex(...) + 1` as the
// reported rank, which is alphabetical position when scores tie. With
// 116 players at 0 points the player who sorted 64th alphabetically
// saw "#64 of 116" instead of the correct "#1 of 116". The fix reads
// the competition rank straight off the leaderboard row.

// Helper: build a Game with the given [name, score] pairs AND a single
// dummy question, then set the phase so getCurrentQuestion() resolves.
// Each player gets a pre-recorded answer so `answered/wasCorrect` are
// stable (we're testing rank math, not scoring).
function buildGameForResult(pairs) {
  const q = {
    id: 'qx',
    prompt: 'Q',
    choices: ['A', 'B', 'C', 'D'],
    correctIndex: 0,
    timeLimitSec: 30,
  };
  const g = new Game([q]);
  g.currentIndex = 0;
  for (const [name, score] of pairs) {
    g.players.set(`pid-${name}`, {
      id: `pid-${name}`,
      name,
      score,
      answers: [{ questionId: 'qx', choiceIndex: 0, responseMs: 1000, points: score, wasCorrect: true, ts: 0 }],
      connected: true,
      socketId: null,
    });
  }
  return g;
}

// All tied at zero — every player must report rank 1, not their
// alphabetical index. This is the exact 116-players-all-zero scenario
// the user hit.
{
  const g = buildGameForResult([
    ['Avery', 0], ['Bea', 0], ['Casey', 0], ['Dev', 0], ['Eli', 0],
  ]);
  const ranks = ['Avery', 'Bea', 'Casey', 'Dev', 'Eli'].map(
    (n) => g.getPlayerResult(`pid-${n}`).rank
  );
  assertEq(ranks, [1, 1, 1, 1, 1], 'getPlayerResult: all-tied-at-zero -> every player rank 1');
}

// Standard competition ranking across multiple tie groups.
// Scores [100, 50, 50, 10] -> ranks [1, 2, 2, 4].
{
  const g = buildGameForResult([
    ['Avery', 100], ['Bea', 50], ['Casey', 50], ['Dev', 10],
  ]);
  assertEq(g.getPlayerResult('pid-Avery').rank, 1, 'getPlayerResult: distinct leader -> rank 1');
  assertEq(g.getPlayerResult('pid-Bea').rank,   2, 'getPlayerResult: mid-tie alpha-first -> rank 2');
  assertEq(g.getPlayerResult('pid-Casey').rank, 2, 'getPlayerResult: mid-tie alpha-second -> rank 2 (NOT 3)');
  assertEq(g.getPlayerResult('pid-Dev').rank,   4, 'getPlayerResult: post-tie skip -> rank 4');
}

// Tie at the top: [100, 100, 50] -> ranks [1, 1, 3].
{
  const g = buildGameForResult([['Avery', 100], ['Bea', 100], ['Casey', 50]]);
  assertEq(g.getPlayerResult('pid-Avery').rank, 1, 'getPlayerResult: top-tie -> rank 1');
  assertEq(g.getPlayerResult('pid-Bea').rank,   1, 'getPlayerResult: top-tie second name -> rank 1');
  assertEq(g.getPlayerResult('pid-Casey').rank, 3, 'getPlayerResult: post-top-tie skip -> rank 3');
}

// totalPlayers includes everyone in this.players, including DC'd —
// matches pre-fix denominator semantics (the user explicitly wants
// disconnected players counted).
{
  const g = buildGameForResult([['Avery', 0], ['Bea', 0], ['Casey', 0]]);
  // Mark one disconnected — must still be counted.
  g.players.get('pid-Bea').connected = false;
  const res = g.getPlayerResult('pid-Avery');
  assertEq(res.totalPlayers, 3, 'getPlayerResult: totalPlayers includes disconnected players');
  assertEq(res.rank, 1, 'getPlayerResult: rank unaffected by connected status');
}

// --- podiumRevealed lifecycle ---
// Gates the player-screen rank reveal. Must start false on a fresh
// game, must survive an in-game `_enterIntro` (it gets cleared then
// because a new game is starting), and must reset to false on
// `reset()` so the next round starts blocked again. The actual flip
// to true happens in server/index.js's `host:podiumDone` handler,
// which we don't unit-test here.
{
  const g = new Game([]);
  assertEq(g.podiumRevealed, false, 'podiumRevealed: false on fresh game');

  // Simulate the host having signaled podium-done on a previous round.
  g.podiumRevealed = true;
  g.reset();
  assertEq(g.podiumRevealed, false, 'podiumRevealed: reset() clears the flag');

  // A new game starts via _enterIntro (called from start()). Even if
  // something somehow left the flag set, the intro entrance must
  // clear it so the next FINAL phase starts gated.
  g.podiumRevealed = true;
  g._enterIntro();
  assertEq(g.podiumRevealed, false, 'podiumRevealed: _enterIntro clears the flag for the new round');
  // _enterIntro schedules a setTimeout that eventually advances into a
  // question — and our test Game has no questions, so that timer would
  // crash the process after the assertions finished. Clear timers now
  // so the test exits cleanly.
  g._clearTimers();
}

// --- Announcement Mode ---
//
// Announcement Mode is a DJ-led fallback for venues where the host screen
// isn't visible. When ON: PROMPT phase does NOT auto-advance; the host
// triggers QUESTION manually via `startAnsweringNow()`. The flag is
// lockable only in LOBBY \u2014 once `start()` runs it can't be flipped.

{
  // Default state and lobby-only mutability.
  const g = new Game([
    { id: 'q1', prompt: 'p', choices: ['a', 'b', 'c', 'd'], correctIndex: 0, timeLimitSec: 10 },
  ]);
  assertEq(g.announcementMode, false, 'announcementMode: defaults to false');

  const r1 = g.setAnnouncementMode(true);
  assertEq(r1, { ok: true, announcementMode: true }, 'setAnnouncementMode: ok in LOBBY');
  assertEq(g.announcementMode, true, 'announcementMode: flag persists after set');

  // Start the game \u2014 should now be locked.
  g.players.set('p1', { id: 'p1', name: 'A', score: 0, answers: [], connected: true, socketId: 's1' });
  g.start();
  const r2 = g.setAnnouncementMode(false);
  assertEq(r2, { ok: false, reason: 'quiz-started' }, 'setAnnouncementMode: rejected once quiz started');
  assertEq(g.announcementMode, true, 'announcementMode: value unchanged after rejected set');

  g._clearTimers();
}

{
  // With announcementMode ON, `_enterPrompt` must NOT arm a phase timer
  // \u2014 the PROMPT phase should sit indefinitely until startAnsweringNow().
  const g = new Game([
    { id: 'q1', prompt: 'p', choices: ['a', 'b', 'c', 'd'], correctIndex: 0, timeLimitSec: 10 },
  ]);
  g.announcementMode = true;
  g._enterPrompt(0);
  assertEq(g.phase, 'PROMPT', 'announcementMode: _enterPrompt lands in PROMPT');
  assertEq(g._phaseTimer, null, 'announcementMode: _enterPrompt does NOT arm an auto-advance timer');
  g._clearTimers();
}

{
  // Default (announcementMode OFF) regression: `_enterPrompt` MUST still
  // arm the auto-advance timer the way it always has.
  const g = new Game([
    { id: 'q1', prompt: 'p', choices: ['a', 'b', 'c', 'd'], correctIndex: 0, timeLimitSec: 10 },
  ]);
  g._enterPrompt(0);
  assertEq(g.phase, 'PROMPT', 'default: _enterPrompt lands in PROMPT');
  if (g._phaseTimer === null) {
    console.error('FAIL: default: _enterPrompt arms _phaseTimer for auto-advance');
    failures++;
  } else {
    console.log('ok: default: _enterPrompt arms _phaseTimer for auto-advance');
  }
  g._clearTimers();
}

{
  // startAnsweringNow only valid in PROMPT + announcementMode.
  const g = new Game([
    { id: 'q1', prompt: 'p', choices: ['a', 'b', 'c', 'd'], correctIndex: 0, timeLimitSec: 10 },
  ]);

  // Off + LOBBY \u2014 reject (not in announcement mode).
  assertEq(
    g.startAnsweringNow(),
    { ok: false, reason: 'not-announcement-mode' },
    'startAnsweringNow: rejected when announcementMode off'
  );

  // On + LOBBY \u2014 still wrong phase.
  g.announcementMode = true;
  assertEq(
    g.startAnsweringNow(),
    { ok: false, reason: 'wrong-phase' },
    'startAnsweringNow: rejected outside PROMPT phase'
  );

  // On + PROMPT \u2014 transitions to QUESTION.
  g._enterPrompt(0);
  const r = g.startAnsweringNow();
  assertEq(r, { ok: true, phase: 'QUESTION' }, 'startAnsweringNow: transitions PROMPT -> QUESTION');
  assertEq(g.phase, 'QUESTION', 'startAnsweringNow: phase is QUESTION');
  // The question timer should now be armed (this is the answering timer,
  // NOT the prompt auto-advance timer that announcement mode suppresses).
  if (g._questionTimer === null) {
    console.error('FAIL: startAnsweringNow: arms the question (answering) timer');
    failures++;
  } else {
    console.log('ok: startAnsweringNow: arms the question (answering) timer');
  }

  // Idempotent: a second call (now in QUESTION, not PROMPT) is rejected.
  assertEq(
    g.startAnsweringNow(),
    { ok: false, reason: 'wrong-phase' },
    'startAnsweringNow: second call in QUESTION rejected'
  );

  g._clearTimers();
}

{
  // reset() does NOT clear announcementMode \u2014 host may want to re-run
  // the quiz at the same venue without re-toggling.
  const g = new Game([]);
  g.announcementMode = true;
  g.reset();
  assertEq(g.announcementMode, true, 'reset: announcementMode preserved across reset');
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll game (leaderboard/podium) tests passed');
