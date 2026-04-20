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
const INTRO_DURATION_MS = 5000;
const PROMPT_DURATION_MS = 3000;

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
    this.currentStartTs = Date.now();
    this.currentEndsAt = this.currentStartTs + INTRO_DURATION_MS;
    this._phaseTimer = setTimeout(() => {
      this._phaseTimer = null;
      this._endIntro();
    }, INTRO_DURATION_MS + 50);
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
    this.currentEndsAt = this.currentStartTs + PROMPT_DURATION_MS;
    this._phaseTimer = setTimeout(() => {
      this._phaseTimer = null;
      this._endPrompt();
    }, PROMPT_DURATION_MS + 50);
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
      durationMs: PROMPT_DURATION_MS,
      // Surface the question's own time limit so the host/player can show
      // a "20s to answer" hint during the lead-in.
      timeLimitSec: q.timeLimitSec,
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
    const arr = Array.from(this.players.values())
      .map((p) => ({ id: p.id, name: p.name, score: p.score, lastTs: p.lastScoringAnswerTs }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        // earlier timestamp wins (non-zero preferred over zero)
        const at = a.lastTs || Infinity;
        const bt = b.lastTs || Infinity;
        return at - bt;
      })
      .map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, score: p.score }));
    return typeof limit === 'number' ? arr.slice(0, limit) : arr;
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
    const rank = lb.findIndex((e) => e.id === playerId) + 1;
    return {
      questionId: q.id,
      answered: !!a,
      wasCorrect: a ? a.wasCorrect : false,
      pointsEarned: a ? a.points : 0,
      totalScore: p.score,
      rank: rank || lb.length,
      totalPlayers: lb.length,
      isLastQuestion: this.currentIndex === this.questions.length - 1,
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

  reset() {
    this._clearTimers();
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this.currentIndex = -1;
    this.currentStartTs = 0;
    this.currentEndsAt = 0;
  }
}

module.exports = { Game, PHASES, MAX_NAME_LEN, INTRO_DURATION_MS, PROMPT_DURATION_MS };
