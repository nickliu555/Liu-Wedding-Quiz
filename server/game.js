'use strict';

const { calculatePoints } = require('./scoring');

const PHASES = {
  LOBBY: 'LOBBY',
  // "Get ready..." 5-second splash shown once when the game starts, before
  // the very first question's prompt appears.
  INTRO: 'INTRO',
  // Per-question lead-in: the question text (and image) is shown for a
  // brief beat before the answer choices appear and the answer timer
  // starts. Gives the room a chance to actually read the question.
  PROMPT: 'PROMPT',
  QUESTION: 'QUESTION',
  REVEAL: 'REVEAL',
  FINAL: 'FINAL',
};

const MAX_NAME_LEN = 20;
const INTRO_DURATION_MS = 4000;
// After the countdown reaches 0 the splash sits on "Go!" for a brief beat
// before we transition into the first question's PROMPT phase.
const INTRO_GO_HOLD_MS = 1100;
const PROMPT_DURATION_MS = 3000;
// Extra time tacked onto the prompt phase before the very last question, so
// the host page has room to show a "💍 Final Question!" splash before the
// question itself becomes readable. Sized so the splash + fade-in leave
// just a brief beat of prompt-only before the choices drop in (rather than
// playing the full regular 3s prompt phase on top of the splash, which
// reads as a dead second).
const FINAL_PROMPT_EXTRA_MS = 3500;

/**
 * Single-room quiz game state machine.
 * All writes go through methods that return either:
 *   { ok: true, ...payload }     or     { ok: false, reason: '...' }
 * Side-effect (broadcasting) lives in the transport layer (server/index.js).
 */
class Game {
  constructor(questions) {
    this.questions = questions;
    this.phase = PHASES.LOBBY;
    /** @type {Map<string, Player>} */
    this.players = new Map();
    this.currentIndex = -1;
    this.currentStartTs = 0;
    this.currentEndsAt = 0;
    this._questionTimer = null;
    this._phaseTimer = null; // shared timer for INTRO and PROMPT lead-ins
    this.onQuestionTimeout = null; // set by transport
    this.onIntroEnd = null;        // set by transport — fires when INTRO -> PROMPT
    this.onPromptEnd = null;       // set by transport — fires when PROMPT -> QUESTION
    // FINAL-phase gate: flipped true once the host's podium animation
    // finishes (via the `host:podiumDone` socket event). Player phones
    // hold back the rank-reveal card until this is true so the standings
    // aren't spoiled before the room sees them on the big screen. Reset
    // to false on any new-game transition (intro start, reset).
    this.podiumRevealed = false;
    // Announcement Mode: a DJ-led fallback for venues where the host
    // screen isn't visible to the audience. When true:
    //   - PROMPT phase does NOT auto-advance; it waits for the host to
    //     click "Start answering →" (`host:startAnswering` socket event,
    //     wired to `startAnsweringNow()` below).
    //   - The host UI suppresses fade-in animations, audio cues, and
    //     the podium reveal sequence (handled client-side).
    // Only mutable while in LOBBY — once `start()` runs, the flag is
    // locked for the duration of the quiz. See `setAnnouncementMode`.
    this.announcementMode = false;
  }

  // ---------------- Lobby / players ----------------

  sanitizeName(raw) {
    if (typeof raw !== 'string') return '';
    // allow letters, numbers, spaces, and a few safe punctuation chars
    let n = raw.replace(/[^\p{L}\p{N} '._-]/gu, '').trim().replace(/\s+/g, ' ');
    if (n.length > MAX_NAME_LEN) n = n.slice(0, MAX_NAME_LEN);
    return n;
  }

  nameIsTaken(name) {
    const lower = name.toLowerCase();
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === lower) return true;
    }
    return false;
  }

  dedupeName(name) {
    if (!this.nameIsTaken(name)) return name;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${name} (${i})`.slice(0, MAX_NAME_LEN);
      if (!this.nameIsTaken(candidate)) return candidate;
    }
    return name; // give up; caller will see duplicate but it's fine
  }

  addPlayer({ playerId, name, socketId }) {
    if (this.phase !== PHASES.LOBBY) {
      return { ok: false, reason: 'lobby-closed' };
    }
    if (!playerId || typeof playerId !== 'string') {
      return { ok: false, reason: 'bad-player-id' };
    }
    if (this.players.has(playerId)) {
      // treat as reconnect
      return this.reconnectPlayer({ playerId, socketId });
    }
    const clean = this.sanitizeName(name);
    if (clean.length < 1) return { ok: false, reason: 'name-too-short' };
    const finalName = this.dedupeName(clean);
    /** @type {Player} */
    const player = {
      id: playerId,
      name: finalName,
      socketId,
      score: 0,
      answers: [], // { questionId, choiceIndex, responseMs, points, wasCorrect, ts }
      lastScoringAnswerTs: 0,
      joinedAt: Date.now(),
      connected: true,
    };
    this.players.set(playerId, player);
    return { ok: true, player };
  }

  reconnectPlayer({ playerId, socketId }) {
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    p.socketId = socketId;
    p.connected = true;
    return { ok: true, player: p };
  }

  markDisconnected(socketId) {
    for (const p of this.players.values()) {
      if (p.socketId === socketId) {
        p.connected = false;
        return p;
      }
    }
    return null;
  }

  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return null;
    this.players.delete(playerId);
    return p;
  }

  // ---------------- Game progression ----------------

  start() {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'already-started' };
    if (this.questions.length === 0) return { ok: false, reason: 'no-questions' };
    this.currentIndex = -1;
    return this._enterIntro();
  }

  /**
   * Advance to the next phase from the host's perspective.
   *  - INTRO    -> PROMPT (skip the Get Ready splash)
   *  - PROMPT   -> QUESTION (skip the read-the-question delay)
   *  - QUESTION -> REVEAL (force-end the question early)
   *  - REVEAL   -> next PROMPT, or FINAL if this was the last question
   */
  advance() {
    if (this.phase === PHASES.FINAL) return { ok: false, reason: 'final' };
    if (this.phase === PHASES.LOBBY) return { ok: false, reason: 'not-started' };

    if (this.phase === PHASES.INTRO) {
      this._endIntro();
      return { ok: true, phase: PHASES.PROMPT };
    }
    if (this.phase === PHASES.PROMPT) {
      this._endPrompt();
      return { ok: true, phase: PHASES.QUESTION };
    }
    if (this.phase === PHASES.QUESTION) {
      this._endQuestion('host');
      return { ok: true, phase: PHASES.REVEAL };
    }

    // REVEAL -> next question's PROMPT, or FINAL
    const nextIndex = this.currentIndex + 1;
    if (nextIndex >= this.questions.length) {
      this.phase = PHASES.FINAL;
      this._clearTimers();
      return { ok: true, phase: PHASES.FINAL };
    }
    return this._enterPrompt(nextIndex);
  }

  _enterIntro() {
    this._clearTimers();
    this.phase = PHASES.INTRO;
    // New game starting — clear any stale podium-reveal gate left over
    // from a previous round so the next FINAL phase starts blocked again.
    this.podiumRevealed = false;
    this.currentStartTs = Date.now();
    this.currentEndsAt = this.currentStartTs + INTRO_DURATION_MS;
    this._phaseTimer = setTimeout(() => {
      this._phaseTimer = null;
      this._endIntro();
    }, INTRO_DURATION_MS + INTRO_GO_HOLD_MS);
    return { ok: true, phase: PHASES.INTRO };
  }

  _endIntro() {
    if (this.phase !== PHASES.INTRO) return;
    this._clearTimers();
    // Move into the first question's PROMPT phase.
    this._enterPrompt(0);
    if (typeof this.onIntroEnd === 'function') {
      try { this.onIntroEnd(); } catch (_) { /* swallow */ }
    }
  }

  _enterPrompt(index) {
    this._clearTimers();
    this.currentIndex = index;
    this.phase = PHASES.PROMPT;
    this.currentStartTs = Date.now();
    const isLast = index === this.questions.length - 1;
    const duration = PROMPT_DURATION_MS + (isLast ? FINAL_PROMPT_EXTRA_MS : 0);
    this.currentEndsAt = this.currentStartTs + duration;
    // Announcement Mode: skip the auto-advance timer entirely. The PROMPT
    // phase will stay active until the host clicks "Start answering →",
    // which invokes `startAnsweringNow()` below. `currentEndsAt` is still
    // populated (above) for symmetry, but no client uses it as an actual
    // countdown in this mode — the host page hides the lead-in timer.
    if (!this.announcementMode) {
      this._phaseTimer = setTimeout(() => {
        this._phaseTimer = null;
        this._endPrompt();
      }, duration + 50);
    }
    return { ok: true, phase: PHASES.PROMPT };
  }

  _endPrompt() {
    if (this.phase !== PHASES.PROMPT) return;
    this._clearTimers();
    this._enterQuestion();
    if (typeof this.onPromptEnd === 'function') {
      try { this.onPromptEnd(); } catch (_) { /* swallow */ }
    }
  }

  _enterQuestion() {
    this._clearTimers();
    this.phase = PHASES.QUESTION;
    const q = this.questions[this.currentIndex];
    this.currentStartTs = Date.now();
    this.currentEndsAt = this.currentStartTs + q.timeLimitSec * 1000;
    this._questionTimer = setTimeout(() => {
      this._questionTimer = null;
      this._endQuestion('timeout');
    }, q.timeLimitSec * 1000 + 100); // small grace
    return { ok: true, phase: PHASES.QUESTION, question: q };
  }

  _clearTimers() {
    if (this._questionTimer) {
      clearTimeout(this._questionTimer);
      this._questionTimer = null;
    }
    if (this._phaseTimer) {
      clearTimeout(this._phaseTimer);
      this._phaseTimer = null;
    }
  }

  // Backwards-compat alias: nothing else uses this externally, but the name
  // is referenced from server/index.js for symmetry with onQuestionTimeout.
  _clearTimer() { this._clearTimers(); }

  /** Force-end current question and move to REVEAL. Idempotent. */
  _endQuestion(reason) {
    if (this.phase !== PHASES.QUESTION) return;
    this._clearTimers();
    this.phase = PHASES.REVEAL;
    // Remember WHY the question ended so the transport layer can pick the
    // right "sting" copy on the reveal screen ("Time's up!" vs.
    // "Let's see the answers!"). Defaults to 'host' for the manual case.
    this.lastEndReason = reason || 'host';
    if (typeof this.onQuestionTimeout === 'function') {
      try { this.onQuestionTimeout(); } catch (_) { /* swallow */ }
    }
  }

  submitAnswer({ playerId, questionId, choiceIndex }) {
    if (this.phase !== PHASES.QUESTION) {
      return { ok: false, reason: 'not-accepting-answers' };
    }
    const q = this.questions[this.currentIndex];
    if (!q || q.id !== questionId) {
      return { ok: false, reason: 'wrong-question' };
    }
    if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex > 3) {
      return { ok: false, reason: 'bad-choice' };
    }
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    if (p.answers.some((a) => a.questionId === questionId)) {
      return { ok: false, reason: 'already-answered' };
    }
    const now = Date.now();
    const responseMs = now - this.currentStartTs;
    const timeLimitMs = q.timeLimitSec * 1000;
    if (responseMs > timeLimitMs) {
      return { ok: false, reason: 'too-late' };
    }
    const wasCorrect = choiceIndex === q.correctIndex;
    const points = calculatePoints(wasCorrect, responseMs, timeLimitMs);
    p.answers.push({ questionId, choiceIndex, responseMs, points, wasCorrect, ts: now });
    p.score += points;
    if (points > 0) p.lastScoringAnswerTs = now;

    // If every connected player has answered, end the question early.
    const totalActive = Array.from(this.players.values()).length;
    const answered = Array.from(this.players.values()).filter((pp) =>
      pp.answers.some((a) => a.questionId === questionId)
    ).length;
    if (totalActive > 0 && answered >= totalActive) {
      this._endQuestion('all-answered');
    }

    return { ok: true, player: p, pointsEarned: points, wasCorrect };
  }

  // ---------------- Views / serialization ----------------

  getCurrentQuestion() {
    if (this.currentIndex < 0 || this.currentIndex >= this.questions.length) return null;
    return this.questions[this.currentIndex];
  }

  /** Public view of a question (no correctIndex). */
  getQuestionPublic() {
    const q = this.getCurrentQuestion();
    if (!q) return null;
    return {
      id: q.id,
      index: this.currentIndex,
      total: this.questions.length,
      prompt: q.prompt,
      image: q.image,
      choices: q.choices,
      timeLimitSec: q.timeLimitSec,
      serverStartTs: this.currentStartTs,
      endsAt: this.currentEndsAt,
      // Wall-clock time on the server at the moment of this payload. Clients
      // use it to compute their own clock offset so the countdown stays in
      // sync with the host (and with each other) regardless of device drift.
      serverNow: Date.now(),
    };
  }

  /** Public view of the "Get Ready" intro splash. */
  getIntroPublic() {
    return {
      endsAt: this.currentEndsAt,
      serverNow: Date.now(),
      totalQuestions: this.questions.length,
      durationMs: INTRO_DURATION_MS,
    };
  }

  /** Public view of a question's PROMPT phase (no answer timer yet). */
  getPromptPublic() {
    const q = this.getCurrentQuestion();
    if (!q) return null;
    return {
      id: q.id,
      index: this.currentIndex,
      total: this.questions.length,
      prompt: q.prompt,
      image: q.image,
      // Include the choices so the host can pre-render the answer tiles
      // during the lead-in (kept hidden via CSS) and then smoothly fade
      // them in when QUESTION begins — avoids the visible "pop" you get
      // from inserting fresh DOM nodes at the same moment they transition.
      choices: q.choices,
      // When this prompt phase ends and the choices appear.
      endsAt: this.currentEndsAt,
      serverNow: Date.now(),
      durationMs: PROMPT_DURATION_MS + (this.currentIndex === this.questions.length - 1 ? FINAL_PROMPT_EXTRA_MS : 0),
      // Surface the question's own time limit so the host/player can show
      // a "20s to answer" hint during the lead-in.
      timeLimitSec: q.timeLimitSec,
      // Lets the host show a "💍 Final Question!" splash before the very
      // last question's prompt content becomes readable.
      isLastQuestion: this.currentIndex === this.questions.length - 1,
    };
  }

  getAnswerDistribution() {
    const q = this.getCurrentQuestion();
    if (!q) return [0, 0, 0, 0];
    const dist = [0, 0, 0, 0];
    for (const p of this.players.values()) {
      const a = p.answers.find((x) => x.questionId === q.id);
      if (a) dist[a.choiceIndex]++;
    }
    return dist;
  }

  getLeaderboard(limit) {
    // Sort by score desc. Tiebreak by name (case-insensitive) so the
    // display order among tied players is deterministic and fair —
    // NOT biased by join order (Map insertion order) or who happened
    // to answer a scoring question earliest. The alphabetical sort is
    // PURELY cosmetic: every player with the same score gets the SAME
    // rank value below; alphabetical only decides which name appears
    // above the other in the list when scores tie.
    const sorted = Array.from(this.players.values())
      .map((p) => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

    // Standard competition ranking ("1224"): every player with the same
    // score gets the same rank; the next distinct score skips ahead by
    // the size of the tie group. e.g. scores [1000, 900, 900, 800] yield
    // ranks [1, 2, 2, 4]. Replaces the old timestamp-tiebreaker logic
    // where ties were silently broken by who answered first.
    const ranked = [];
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const rank = (i > 0 && sorted[i - 1].score === p.score)
        ? ranked[i - 1].rank
        : i + 1;
      ranked.push({ rank, id: p.id, name: p.name, score: p.score });
    }
    return typeof limit === 'number' ? ranked.slice(0, limit) : ranked;
  }

  // Top N for the between-question leaderboard panel. Returns:
  //   { rows: <ranked rows, capped at `limit`>,
  //     moreTiedAtLastRank: <how many additional players share the LAST
  //                          shown rank but were cut off by the cap> }
  // The host UI renders an honest "…and N more tied at rank X" line
  // from `moreTiedAtLastRank` instead of silently hiding tied players
  // that would otherwise have been bumped off the list by alphabetical
  // order alone.
  getLeaderboardTop(limit) {
    const full = this.getLeaderboard();
    if (typeof limit !== 'number' || full.length <= limit) {
      return { rows: full, moreTiedAtLastRank: 0 };
    }
    const rows = full.slice(0, limit);
    const lastShownRank = rows[rows.length - 1].rank;
    let moreTied = 0;
    for (let i = limit; i < full.length; i++) {
      if (full[i].rank === lastShownRank) moreTied++;
      else break;
    }
    return { rows, moreTiedAtLastRank: moreTied };
  }

  // Buckets players into up to 3 podium GROUPS by distinct rank — not
  // by player count. Returns shape:
  //   [{ rank, score, players: [{id, name}, ...] }, ...]
  // With ties this can yield fewer than 3 groups (e.g. 5 players tied
  // for 1st returns a single group with 5 players; no silver/bronze).
  // Used by the host's final podium reveal so every player at a
  // top-3 rank gets recognized, not just `array[0..2]`.
  getPodiumGroups() {
    const full = this.getLeaderboard();
    if (full.length === 0) return [];
    const groups = [];
    for (const row of full) {
      const last = groups[groups.length - 1];
      if (last && last.rank === row.rank) {
        last.players.push({ id: row.id, name: row.name });
      } else {
        if (groups.length >= 3) break;
        groups.push({
          rank: row.rank,
          score: row.score,
          players: [{ id: row.id, name: row.name }],
        });
      }
    }
    return groups;
  }

  // Same rows as getLeaderboard(), with each row annotated with
  // `podiumTier` ∈ {1, 2, 3, null}. Tier is assigned by the SAME
  // top-3-distinct-ranks rule used by getPodiumGroups(), so the host
  // podium and the player phones agree on who gets gold/silver/bronze.
  //
  // Important: tier is NOT raw rank. If ranks are [1,1,3,3,3,6,6,6,6],
  // the distinct ranks are [1,3,6] -> tiers [1,2,3]. So players at
  // rank 6 get tier 3 (bronze), NOT null. Rows beyond the top 3
  // distinct ranks get `podiumTier: null`.
  //
  // Edge cases:
  //   - All players tied for 1st: only one distinct rank exists, so
  //     every row gets tier 1 and no silver/bronze ever appears.
  //   - Two distinct ranks (e.g. [1,1,3]): tiers [1,1,2], no bronze.
  //   - Empty game: returns [].
  getLeaderboardWithPodiumTier() {
    const full = this.getLeaderboard();
    if (full.length === 0) return [];
    // Walk the rows in rank order, collect the first 3 distinct ranks.
    const distinctRanks = [];
    for (const row of full) {
      if (distinctRanks[distinctRanks.length - 1] !== row.rank) {
        distinctRanks.push(row.rank);
        if (distinctRanks.length === 3) break;
      }
    }
    const rankToTier = new Map();
    for (let i = 0; i < distinctRanks.length; i++) {
      rankToTier.set(distinctRanks[i], i + 1);
    }
    return full.map((row) => ({
      ...row,
      podiumTier: rankToTier.has(row.rank) ? rankToTier.get(row.rank) : null,
    }));
  }

  getLobbyPlayers() {
    return Array.from(this.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
    }));
  }

  getPlayerResult(playerId) {
    const p = this.players.get(playerId);
    const q = this.getCurrentQuestion();
    if (!p || !q) return null;
    const a = p.answers.find((x) => x.questionId === q.id);
    const lb = this.getLeaderboard();
    // Use the competition rank stored on the leaderboard row, NOT the
    // array index. With ties, the index is just alphabetical position
    // (e.g. all 116 players at 0 points all share rank 1, but the
    // player who sorts 64th alphabetically would have read as "#64").
    // `idx === -1` is unreachable given the `!p` guard above — players
    // in `this.players` are always in `getLeaderboard()` — so the
    // fallback is defensive only.
    const idx = lb.findIndex((e) => e.id === playerId);
    const rank = idx >= 0 ? lb[idx].rank : (lb.length || 1);
    return {
      questionId: q.id,
      answered: !!a,
      wasCorrect: a ? a.wasCorrect : false,
      pointsEarned: a ? a.points : 0,
      totalScore: p.score,
      rank,
      totalPlayers: lb.length,
      isLastQuestion: this.currentIndex === this.questions.length - 1,
      // The correct answer's index + text. Used by the player client in
      // Announcement Mode to render a single colored "B Florida" line on
      // the result card when the player got the question wrong or didn't
      // answer. Default-mode UI ignores these fields, so adding them is a
      // pure superset of the previous payload — no contract changes.
      correctIndex: q.correctIndex,
      correctChoice: q.choices[q.correctIndex],
    };
  }

  answeredCount() {
    const q = this.getCurrentQuestion();
    if (!q) return 0;
    let n = 0;
    for (const p of this.players.values()) {
      if (p.answers.some((a) => a.questionId === q.id)) n++;
    }
    return n;
  }

  // Toggle Announcement Mode. Only allowed in LOBBY — once the quiz has
  // started we don't want the timer / render behavior to flip mid-flight.
  setAnnouncementMode(value) {
    if (this.phase !== PHASES.LOBBY) {
      return { ok: false, reason: 'quiz-started' };
    }
    this.announcementMode = !!value;
    return { ok: true, announcementMode: this.announcementMode };
  }

  // Host-controlled trigger that advances PROMPT → QUESTION when
  // Announcement Mode is on (no auto-timer is running in that mode —
  // see `_enterPrompt`). Mirrors what the `_phaseTimer` callback would
  // have done in the default flow. Idempotent / phase-guarded so a
  // double-click can't double-fire.
  startAnsweringNow() {
    if (!this.announcementMode) return { ok: false, reason: 'not-announcement-mode' };
    if (this.phase !== PHASES.PROMPT) return { ok: false, reason: 'wrong-phase' };
    this._endPrompt();
    return { ok: true, phase: PHASES.QUESTION };
  }

  reset() {
    this._clearTimers();
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this.currentIndex = -1;
    this.currentStartTs = 0;
    this.currentEndsAt = 0;
    this.podiumRevealed = false;
    // Intentionally NOT clearing `announcementMode` here — the host
    // operator may want to keep the mode setting across a reset (e.g.
    // re-running the quiz at the same venue). It's lobby-toggleable
    // anyway via `setAnnouncementMode`.
  }
}

module.exports = { Game, PHASES, MAX_NAME_LEN, INTRO_DURATION_MS, PROMPT_DURATION_MS };
