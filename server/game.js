'use strict';

const { calculatePoints } = require('./scoring');

const PHASES = {
  LOBBY: 'LOBBY',
  QUESTION: 'QUESTION',
  REVEAL: 'REVEAL',
  FINAL: 'FINAL',
};

const MAX_NAME_LEN = 20;

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
    this.onQuestionTimeout = null; // set by transport
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
    return this.advance();
  }

  advance() {
    // from LOBBY or REVEAL -> QUESTION, or from REVEAL after last -> FINAL
    if (this.phase === PHASES.FINAL) return { ok: false, reason: 'final' };
    if (this.phase === PHASES.QUESTION) return { ok: false, reason: 'question-in-progress' };

    const nextIndex = this.currentIndex + 1;
    if (nextIndex >= this.questions.length) {
      this.phase = PHASES.FINAL;
      this._clearTimer();
      return { ok: true, phase: PHASES.FINAL };
    }
    this.currentIndex = nextIndex;
    this.phase = PHASES.QUESTION;
    const q = this.questions[this.currentIndex];
    this.currentStartTs = Date.now();
    this.currentEndsAt = this.currentStartTs + q.timeLimitSec * 1000;
    this._clearTimer();
    this._questionTimer = setTimeout(() => {
      this._questionTimer = null;
      this._endQuestion('timeout');
    }, q.timeLimitSec * 1000 + 100); // small grace
    return { ok: true, phase: PHASES.QUESTION, question: q };
  }

  _clearTimer() {
    if (this._questionTimer) {
      clearTimeout(this._questionTimer);
      this._questionTimer = null;
    }
  }

  /** Force-end current question and move to REVEAL. Idempotent. */
  _endQuestion(_reason) {
    if (this.phase !== PHASES.QUESTION) return;
    this._clearTimer();
    this.phase = PHASES.REVEAL;
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
    this._clearTimer();
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this.currentIndex = -1;
    this.currentStartTs = 0;
    this.currentEndsAt = 0;
  }
}

module.exports = { Game, PHASES, MAX_NAME_LEN };
