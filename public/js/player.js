(function () {
  'use strict';

  const playerId = localStorage.getItem('quiz.playerId');
  if (!playerId) {
    window.location.replace('/join');
    return;
  }

  const elName = document.getElementById('playerName');
  const elScore = document.getElementById('playerScore');
  const elView = document.getElementById('playerView');

  elName.textContent = localStorage.getItem('quiz.playerName') || '…';

  const socket = io({ transports: ['polling', 'websocket'] });

  let currentQuestion = null;
  let answeredQuestionId = null;
  let countdownInterval = null;
  let lastResult = null; // for display between reveal states

  // ---------------- Rendering ----------------
  function render(html) {
    elView.innerHTML = '<div class="state-card">' + html + '</div>';
  }

  function renderLobbyWaiting() {
    render(
      '<h2 class="serif">You\'re in!</h2>' +
      '<p>Look up at the big screen. The quiz will start soon.</p>' +
      '<p style="margin-top:14px; color: var(--muted); font-size: 14px;">Keep this tab open.</p>'
    );
  }

  // Answer options are labelled A/B/C/D — easier to call out ("B!") than
  // "diamond" / "circle" etc., and avoids looking like a direct Kahoot copy.
  const CHOICE_LETTERS = ['A', 'B', 'C', 'D'];
  function shape(i) { return '<span class="choice-letter">' + (CHOICE_LETTERS[i] || '') + '</span>'; }

  // Server clock sync: the server includes its own `Date.now()` on every
  // question payload. We compute an offset so our countdown is anchored to
  // the server's clock — keeps the player and host phones in sync regardless
  // of per-device clock drift.
  let clockOffset = 0;
  function serverNow() { return Date.now() + clockOffset; }

  function renderQuestion(q) {
    currentQuestion = q;
    answeredQuestionId = null;
    if (typeof q.serverNow === 'number') clockOffset = q.serverNow - Date.now();
    const timeLeft = Math.max(0, Math.ceil((q.endsAt - serverNow()) / 1000));
    elView.innerHTML =
      '<div class="state-card">' +
        '<div class="countdown-pill" id="pcountdown">' + timeLeft + 's</div>' +
        '<div class="urgent-bar" id="urgentBar" aria-hidden="true"></div>' +
        '<h2 class="serif">Make your pick</h2>' +
        '<p style="color: var(--muted);">Question ' + (q.index + 1) + ' of ' + q.total + '</p>' +
        '<div class="tiles" id="pTiles">' +
          [0,1,2,3].map(function (i) {
            return '<button class="tile tile-color-' + i + '" data-choice="' + i + '" aria-label="Choice ' + (i+1) + '">' + shape(i) + '</button>';
          }).join('') +
        '</div>' +
      '</div>';

    const tilesEl = document.getElementById('pTiles');
    tilesEl.addEventListener('click', function (e) {
      const btn = e.target.closest('.tile');
      if (!btn) return;
      const choice = parseInt(btn.dataset.choice, 10);
      submitAnswer(choice);
    });

    startCountdown();
  }

  function renderAnswerLocked(choiceIndex) {
    elView.innerHTML =
      '<div class="state-card">' +
        '<h2 class="serif">Answer locked in!</h2>' +
        '<div style="font-size: 56px; margin: 14px 0; color: white; display:inline-flex; align-items:center; justify-content:center; width:120px; height:120px; border-radius: 20px;" class="tile-color-' + choiceIndex + '">' + shape(choiceIndex) + '</div>' +
        '<p>Waiting for everyone else…</p>' +
      '</div>';
  }

  function renderResult(res) {
    const correct = res.wasCorrect;
    const pts = res.pointsEarned;
    const rank = res.rank;
    const total = res.totalPlayers;
    const klass = correct ? 'result-correct' : 'result-wrong';
    const heading = res.answered
      ? (correct ? 'Correct! 🎉' : 'Not quite…')
      : 'Too slow!';
    elView.innerHTML =
      '<div class="state-card">' +
        '<h2 class="serif ' + klass + '">' + heading + '</h2>' +
        (res.answered
          ? '<div class="result-points ' + klass + '">+' + pts + '</div>'
          : '<p>No answer recorded.</p>') +
        // Hide the rank on the very last question — the host's podium reveal
        // is about to drop and we don't want to spoil the standings.
        (res.isLastQuestion
          ? '<p class="result-rank">Final results coming up on the big screen…</p>'
          : '<p class="result-rank">You are <strong>#' + rank + '</strong> of ' + total + '</p>') +
      '</div>';
  }

  function renderFinal() {
    render(
      '<h2 class="serif">Thanks for playing! 💕</h2>' +
      '<p>Check the big screen for the winners.</p>'
    );
  }

  function renderRejected(reason) {
    setReactionsAllowed(false);
    const msg = {
      'kicked': 'You were removed by the host.',
      'lobby-closed': 'The quiz has already started.',
      'unknown-player': 'Your session was not found. Please rejoin.',
      'reset': 'The host has reset the game.',
    }[reason] || 'Disconnected.';
    // Stash the previous name only for reasons where it makes sense to
    // pre-fill the join form (e.g. host reset). Never carry the name
    // forward when the player was kicked.
    const savedName = localStorage.getItem('quiz.playerName') || '';
    if (reason === 'reset' && savedName) {
      localStorage.setItem('quiz.rejoinName', savedName);
    } else {
      localStorage.removeItem('quiz.rejoinName');
    }
    elView.innerHTML =
      '<div class="state-card">' +
        '<h2 class="serif">' + msg + '</h2>' +
        '<button class="btn-primary" style="margin-top: 16px;" onclick="localStorage.removeItem(\'quiz.playerId\'); localStorage.removeItem(\'quiz.playerName\'); window.location.replace(\'/join\');">Rejoin</button>' +
      '</div>';
  }

  // ---------------- Countdown ----------------
  // Track which urgency cues have already fired this question so we don't
  // re-trigger them on every interval tick.
  let urgentClassAdded = false;
  let haptic5Fired = false;
  let haptic2Fired = false;

  function tryVibrate(pattern) {
    if (typeof navigator === 'undefined' || !navigator.vibrate) return;
    try { navigator.vibrate(pattern); } catch (e) {}
  }

  function startCountdown() {
    stopCountdown();
    urgentClassAdded = false;
    haptic5Fired = false;
    haptic2Fired = false;
    countdownInterval = setInterval(function () {
      if (!currentQuestion) return stopCountdown();
      const el = document.getElementById('pcountdown');
      if (!el) return stopCountdown();
      const left = Math.max(0, Math.ceil((currentQuestion.endsAt - serverNow()) / 1000));
      el.textContent = left + 's';

      // Subtle "you haven't answered yet" cues — only fire while the player
      // still hasn't submitted for this question.
      const stillAnswering =
        !answeredQuestionId || answeredQuestionId !== currentQuestion.id;

      if (stillAnswering && left <= 5 && left > 0) {
        if (!urgentClassAdded) {
          urgentClassAdded = true;
          document.body.classList.add('urgent');
          el.classList.add('urgent');
          // Sync the drain-bar animation to the actual time remaining: if
          // we entered the urgent window mid-animation (e.g. on refresh),
          // jump the 5s animation forward by the elapsed amount via a
          // negative animation-delay.
          const bar = document.getElementById('urgentBar');
          if (bar) {
            const msLeftPrecise = Math.max(0, currentQuestion.endsAt - serverNow());
            const elapsedInUrgent = 5000 - msLeftPrecise;
            bar.style.animationDelay = '-' + (elapsedInUrgent / 1000).toFixed(2) + 's';
          }
        }
        if (left <= 5 && !haptic5Fired) {
          haptic5Fired = true;
          tryVibrate(50);
        }
        if (left <= 2 && !haptic2Fired) {
          haptic2Fired = true;
          tryVibrate([90, 60, 90]);
        }
      } else if (urgentClassAdded && (!stillAnswering || left <= 0)) {
        // Player answered or time ran out — clear the cue immediately.
        urgentClassAdded = false;
        document.body.classList.remove('urgent');
        el.classList.remove('urgent');
      }

      if (left <= 0) stopCountdown();
    }, 250);
  }
  function stopCountdown() {
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    document.body.classList.remove('urgent');
    const el = document.getElementById('pcountdown');
    if (el) el.classList.remove('urgent');
  }

  // ---------------- Actions ----------------
  function submitAnswer(choiceIndex) {
    if (!currentQuestion || answeredQuestionId === currentQuestion.id) return;
    answeredQuestionId = currentQuestion.id;
    // Optimistic: show locked screen immediately
    renderAnswerLocked(choiceIndex);
    socket.emit('player:answer', { questionId: currentQuestion.id, choiceIndex: choiceIndex }, function (res) {
      if (!res || !res.ok) {
        // If rejected, revert the lock so they can try (but only if still accepting)
        if (res && (res.reason === 'too-late' || res.reason === 'not-accepting-answers')) {
          answeredQuestionId = currentQuestion.id; // don't re-open
          elView.innerHTML =
            '<div class="state-card">' +
              '<h2 class="serif">Time\'s up!</h2>' +
              '<p>Wait for the next question.</p>' +
            '</div>';
        } else {
          answeredQuestionId = null;
          renderQuestion(currentQuestion);
        }
      }
    });
  }

  // Once true, ignore all subsequent state events (we've been kicked).
  let rejected = false;

  // ---------------- Reactions (player -> host floating emojis) ----------------
  // Allowed during LOBBY, REVEAL, and FINAL phases (NOT during a live question).
  // Per-player cooldown of 10s enforced both client- and server-side.
  // The cooldown timestamp is also persisted in localStorage so it survives
  // page refreshes (otherwise the player would see fresh-looking buttons
  // immediately after a refresh and only learn about the cooldown when the
  // server silently rejects).
  const REACTION_COOLDOWN_MS = 10 * 1000;
  const REACTION_LS_KEY = 'quiz.lastReactionAt';
  const reactionBar = document.getElementById('reactionBar');
  const reactionCooldownEl = document.getElementById('reactionCooldown');
  const reactionBtns = reactionBar
    ? Array.prototype.slice.call(reactionBar.querySelectorAll('.reaction-btn'))
    : [];
  let reactionsAllowed = false;
  let reactionUntilMs = 0;
  let reactionCountdownTimer = null;

  // Restore any in-flight cooldown from a previous page load.
  (function restoreReactionCooldown() {
    const stored = parseInt(localStorage.getItem(REACTION_LS_KEY) || '0', 10);
    if (!stored) return;
    const elapsed = Date.now() - stored;
    if (elapsed < REACTION_COOLDOWN_MS) {
      reactionUntilMs = stored + REACTION_COOLDOWN_MS;
    } else {
      localStorage.removeItem(REACTION_LS_KEY);
    }
  })();
  // If we restored an active cooldown, make sure the on-screen countdown
  // actually ticks (otherwise the seconds-remaining label freezes after refresh).
  if (Date.now() < reactionUntilMs) {
    startReactionCountdown();
  }

  function setReactionsAllowed(allowed) {
    reactionsAllowed = allowed;
    if (!reactionBar) return;
    reactionBar.hidden = !allowed;
    updateReactionButtonState();
  }
  function updateReactionButtonState() {
    const now = Date.now();
    const onCooldown = now < reactionUntilMs;
    const disabled = !reactionsAllowed || onCooldown || rejected;
    reactionBtns.forEach(function (b) { b.disabled = disabled; });
    if (onCooldown && reactionsAllowed) {
      const sec = Math.ceil((reactionUntilMs - now) / 1000);
      reactionCooldownEl.hidden = false;
      reactionCooldownEl.textContent = sec + 's';
    } else {
      reactionCooldownEl.hidden = true;
    }
  }
  function startReactionCountdown() {
    if (reactionCountdownTimer) clearInterval(reactionCountdownTimer);
    updateReactionButtonState();
    reactionCountdownTimer = setInterval(function () {
      if (Date.now() >= reactionUntilMs) {
        clearInterval(reactionCountdownTimer);
        reactionCountdownTimer = null;
      }
      updateReactionButtonState();
    }, 250);
  }
  if (reactionBar) {
    reactionBar.addEventListener('click', function (e) {
      const btn = e.target.closest('.reaction-btn');
      if (!btn || btn.disabled) return;
      const idx = parseInt(btn.dataset.reaction, 10);
      if (isNaN(idx)) return;
      // Optimistically start cooldown; if the server rejects with a longer
      // cooldown, we'll respect that in the ack.
      const now = Date.now();
      reactionUntilMs = now + REACTION_COOLDOWN_MS;
      localStorage.setItem(REACTION_LS_KEY, String(now));
      startReactionCountdown();
      socket.emit('player:reaction', { index: idx }, function (res) {
        if (res && !res.ok && res.reason === 'cooldown' && res.retryInMs) {
          // Server says we still need to wait — anchor the cooldown to that.
          const ackNow = Date.now();
          reactionUntilMs = ackNow + res.retryInMs;
          // Back-date the stored timestamp so future refreshes also see the wait.
          localStorage.setItem(
            REACTION_LS_KEY,
            String(ackNow + res.retryInMs - REACTION_COOLDOWN_MS)
          );
          startReactionCountdown();
        }
      });
    });
  }

  // ---------------- Socket wiring ----------------
  socket.on('connect', function () {
    if (rejected) return;
    socket.emit('player:reconnect', { playerId: playerId }, function (res) {
      if (rejected) return;
      if (!res || !res.ok) {
        // unknown player (server restarted, etc.) — send back to join
        localStorage.removeItem('quiz.playerId');
        localStorage.removeItem('quiz.playerName');
        window.location.replace('/join');
        return;
      }
      elName.textContent = res.player.name;
      elScore.textContent = res.player.score || 0;
      if (res.phase === 'LOBBY') { setReactionsAllowed(true); renderLobbyWaiting(); }
      else if (res.phase === 'QUESTION' && res.question) {
        setReactionsAllowed(false);
        if (typeof res.myChoiceIndex === 'number') {
          // Player already answered this question before refreshing — anchor
          // the clock offset and show the locked-in view (don't re-render
          // the answer tiles).
          currentQuestion = res.question;
          answeredQuestionId = res.question.id;
          if (typeof res.question.serverNow === 'number') {
            clockOffset = res.question.serverNow - Date.now();
          }
          renderAnswerLocked(res.myChoiceIndex);
        } else {
          renderQuestion(res.question);
        }
      }
      else if (res.phase === 'REVEAL') {
        setReactionsAllowed(true);
        if (res.myResult) {
          // Refresh during reveal: restore the same per-player result card
          // the player was looking at before they refreshed.
          renderResult(res.myResult);
        } else {
          render('<h2 class="serif">Hold tight…</h2><p>Next question coming up.</p>');
        }
      }
      else if (res.phase === 'FINAL') { setReactionsAllowed(true); renderFinal(); }
    });
  });

  socket.on('state:lobby', function (s) {
    if (rejected) return;
    // Note: state:lobby is also broadcast mid-game (e.g. when a player joins
    // or disconnects) to keep the host's roster fresh. Only enable reactions
    // when the game's phase is actually LOBBY — otherwise we'd un-disable
    // the reaction bar during a live question.
    if (s && s.phase === 'LOBBY') {
      setReactionsAllowed(true);
      if (!currentQuestion || answeredQuestionId === (currentQuestion && currentQuestion.id)) {
        renderLobbyWaiting();
      }
    }
  });

  socket.on('state:question', function (q) {
    if (rejected) return;
    setReactionsAllowed(false);
    renderQuestion(q);
  });

  socket.on('state:reveal', function () {
    if (rejected) return;
    setReactionsAllowed(true);
    stopCountdown();
    setTimeout(function () {
      if (rejected) return;
      if (!lastResult || (currentQuestion && lastResult.questionId !== currentQuestion.id)) {
        render('<h2 class="serif">Hold tight…</h2><p>Results on the big screen.</p>');
      }
    }, 400);
  });

  socket.on('player:result', function (res) {
    if (rejected) return;
    lastResult = res;
    elScore.textContent = res.totalScore;
    renderResult(res);
  });

  socket.on('state:final', function () {
    if (rejected) return;
    setReactionsAllowed(true);
    stopCountdown();
    renderFinal();
  });

  socket.on('state:reset', function () {
    // Show an intermediate "host reset" screen with a Rejoin button instead of
    // bouncing the player straight to /join.
    rejected = true;
    stopCountdown();
    // NOTE: do NOT clear quiz.playerName here — renderRejected('reset')
    // copies it into quiz.rejoinName so the join form can pre-fill it.
    // The Rejoin button's inline onclick handles the final cleanup.
    localStorage.removeItem('quiz.playerId');
    renderRejected('reset');
  });

  socket.on('player:rejected', function (payload) {
    rejected = true;
    stopCountdown();
    // Clear stored identity so the Rejoin button works cleanly.
    localStorage.removeItem('quiz.playerId');
    localStorage.removeItem('quiz.playerName');
    renderRejected(payload && payload.reason);
  });

  socket.on('disconnect', function () {
    if (rejected) return;
    render('<h2 class="serif">Reconnecting…</h2><p>Don\'t refresh.</p>');
  });
})();
