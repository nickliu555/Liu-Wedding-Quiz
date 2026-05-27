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

  // Announcement Mode flag mirrored from the host. When ON, the wedding DJ
  // is reading questions/choices aloud and the player screen swaps the
  // "Look up at the big screen" copy for "listen to the DJ" copy. The flag
  // is locked in on the host before the quiz starts (server rejects toggles
  // outside LOBBY) so for a player's lifetime it's set at reconnect and
  // doesn't change again — but we still subscribe to state:announcementMode
  // in case a player joins/refreshes while still in LOBBY and the host
  // toggles it before clicking Start. Defaults to true to match the
  // server-side default; overwritten by the reconnect ack on connect.
  let announcementMode = true;
  // Latest lobby player count from state:lobby broadcasts. Null until the
  // first lobby payload arrives.
  let lobbyPlayerCount = null;

  // ---------------- Rendering ----------------
  function render(html) {
    elView.innerHTML = '<div class="state-card">' + html + '</div>';
  }

  // Centralized score writer. Comma-formats the number, and briefly
  // pops the parent .player-score-chip whenever the score grows so
  // the player feels the points land.
  let lastDisplayedScore = 0;
  function setScore(n) {
    const next = Number(n) || 0;
    elScore.textContent = next.toLocaleString();
    if (next > lastDisplayedScore) {
      const chip = elScore.closest('.player-score-chip');
      if (chip) {
        chip.classList.remove('bumped');
        void chip.offsetWidth; // restart animation on consecutive bumps
        chip.classList.add('bumped');
      }
    }
    lastDisplayedScore = next;
  }

  function renderLobbyWaiting() {
    const waitingLead = announcementMode
      ? 'The quiz will start soon. Follow along with the DJ.'
      : 'Look up at the big screen. The quiz will start soon.';
    const lobbyCountLine =
      announcementMode && typeof lobbyPlayerCount === 'number'
        ? ('<p class="waiting-lobby-count">' +
            '<span class="waiting-lobby-count-num">' + lobbyPlayerCount + '</span> ' +
            (lobbyPlayerCount === 1 ? 'guest' : 'guests') + ' in lobby' +
          '</p>')
        : '';
    render(
      '<h2 class="serif">You\'re in!</h2>' +
      '<p>' + waitingLead + '</p>' +
      '<div class="waiting-pulse" aria-hidden="true">' +
        '<span class="waiting-pulse-ring"></span>' +
        '<span class="waiting-pulse-ring"></span>' +
        '<span class="waiting-pulse-heart">♥</span>' +
      '</div>' +
      lobbyCountLine +
      '<p style="margin-top:14px; color: var(--muted); font-size: 14px;">Keep this tab open.</p>'
    );
    // Reveal the ambient petal drift only while the player is parked here.
    document.body.classList.add('player-waiting');
  }

  // Drop the waiting-petals layer when transitioning away from the lobby.
  function leaveLobbyWaiting() {
    document.body.classList.remove('player-waiting');
  }

  // ---------------- Intro ("Get Ready" splash) ----------------
  let introTimer = null;
  function stopIntroTimer() {
    if (introTimer) { clearInterval(introTimer); introTimer = null; }
  }
  function renderIntro(payload) {
    stopIntroTimer();
    if (payload && typeof payload.serverNow === 'number') {
      clockOffset = payload.serverNow - Date.now();
    }
    const endsAt = (payload && payload.endsAt) || (Date.now() + 5000);
    elView.innerHTML =
      '<div class="state-card intro-card">' +
        '<div class="intro-hint">Up next…</div>' +
        '<h2 class="serif intro-title">Get ready</h2>' +
        '<div class="intro-countdown" id="pIntroCountdown">5</div>' +
        '<p>First question coming up.</p>' +
      '</div>';
    const el = document.getElementById('pIntroCountdown');
    function tick() {
      const left = Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
      if (el) el.textContent = left <= 0 ? 'Go!' : String(left);
      if (left <= 0) stopIntroTimer();
    }
    tick();
    introTimer = setInterval(tick, 200);
  }

  // ---------------- Prompt (read-the-question lead-in) ----------------
  // Shown for ~3s before the answer choices appear. We deliberately do NOT
  // surface the question text on the player's phone — we want everyone
  // looking up at the big screen during this beat. In Announcement Mode
  // the DJ reads the question + 4 choices aloud, so we swap the copy to
  // direct the player's attention to the DJ instead (the room may not
  // have a visible host screen).
  function renderPrompt(p) {
    stopCountdown();
    stopIntroTimer();
    currentQuestion = null;
    answeredQuestionId = null;
    if (p && typeof p.serverNow === 'number') {
      clockOffset = p.serverNow - Date.now();
    }
    if (announcementMode) {
      elView.innerHTML =
        '<div class="state-card prompt-card">' +
          '<div class="intro-hint">Question ' + (p.index + 1) + ' of ' + p.total + '</div>' +
          '<h2 class="serif">🎤 Listen up! 🎤</h2>' +
          '<p>The DJ is reading the question.</p>' +
          '<p style="margin-top:10px; color: var(--muted); font-size: 14px;">Choices appear in a moment…</p>' +
        '</div>';
      return;
    }
    elView.innerHTML =
      '<div class="state-card prompt-card">' +
        '<div class="intro-hint">Question ' + (p.index + 1) + ' of ' + p.total + '</div>' +
        '<h2 class="serif">Look up!</h2>' +
        '<p>Read the question on the big screen.</p>' +
        '<p style="margin-top:10px; color: var(--muted); font-size: 14px;">Choices appear in a moment…</p>' +
      '</div>';
  }

  // Answer options are labelled A/B/C/D — easier to call out ("B!") than
  // "diamond" / "circle" etc., and avoids looking like a direct Kahoot copy.
  const CHOICE_LETTERS = ['A', 'B', 'C', 'D'];
  function shape(i) { return '<span class="choice-letter">' + (CHOICE_LETTERS[i] || '') + '</span>'; }

  // Minimal HTML escape used when interpolating author-supplied content
  // (question choice text in the Announcement Mode row tiles) into
  // innerHTML. Question content is author-controlled today, but escaping
  // is cheap and future-proofs against any later editing surface.
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Shrink-to-fit: starting at maxPx, step font size down by 1px until the
  // text fits inside its container both horizontally AND vertically, with a
  // minPx floor so it never becomes unreadable. Used by Announcement Mode's
  // row tiles, where the row height is fixed (no overflow allowed, no
  // growth allowed). Cap at ~14 iterations to bound the worst case; in
  // practice 0–7 are needed for our author-length answers.
  function fitText(el, minPx, maxPx) {
    if (!el) return;
    let size = maxPx;
    el.style.fontSize = size + 'px';
    // Use a small tolerance (1px) to forgive sub-pixel rounding so we don't
    // shrink unnecessarily on the threshold.
    for (let i = 0; i < (maxPx - minPx); i++) {
      if (el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1) break;
      size -= 1;
      if (size <= minPx) { size = minPx; el.style.fontSize = size + 'px'; break; }
      el.style.fontSize = size + 'px';
    }
  }

  // Re-run fitText on every Announcement-Mode row tile currently in the
  // DOM. The query is cheap and only does real work when row tiles exist
  // (default mode renders none of them, so the loop is a no-op).
  function fitAllRowTexts() {
    document.querySelectorAll('.row-text').forEach(function (el) { fitText(el, 11, 18); });
  }
  // One-shot resize listener — cheap (4 elements max) and only does real
  // work when row tiles exist in the DOM (in non-Announcement Mode the
  // querySelector returns nothing and the loop is a no-op).
  window.addEventListener('resize', fitAllRowTexts);

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
    // Announcement Mode: the room may not see the host screen at all, so
    // the player phone has to be self-contained for choice text. Swap the
    // 2×2 colored letter-only grid for 4 full-width stacked rows; each row
    // is a fixed-height button with a colored letter badge on the left and
    // the answer text on the right. Text auto-shrinks via fitText() to fit
    // the row's text area — never overflows, never grows the row. Default
    // (Announcement OFF) keeps the original byte-identical 2×2 tiles.
    const tilesMarkup = announcementMode
      ? ('<div class="tiles tiles-rows" id="pTiles">' +
          [0,1,2,3].map(function (i) {
            const txt = (q.choices && q.choices[i] != null) ? q.choices[i] : '';
            // tile-color-N is added to BOTH the row and the badge: badge
            // gets the solid saturated color, row gets a soft tint via the
            // higher-specificity `.row-tile.tile-color-N` rule in player.css
            // (which beats the single-class base.css rule painting the
            // badge solid).
            return '<button class="row-tile tile-color-' + i + '" data-choice="' + i + '" aria-label="Choice ' + CHOICE_LETTERS[i] + ': ' + escapeHtml(txt) + '">' +
              '<span class="row-badge tile-color-' + i + '">' + shape(i) + '</span>' +
              '<span class="row-text">' + escapeHtml(txt) + '</span>' +
            '</button>';
          }).join('') +
        '</div>')
      : ('<div class="tiles" id="pTiles">' +
          [0,1,2,3].map(function (i) {
            return '<button class="tile tile-color-' + i + '" data-choice="' + i + '" aria-label="Choice ' + (i+1) + '">' + shape(i) + '</button>';
          }).join('') +
        '</div>');
    elView.innerHTML =
      '<div class="state-card">' +
        '<div class="countdown-pill" id="pcountdown">' + timeLeft + 's</div>' +
        '<div class="urgent-bar" id="urgentBar" aria-hidden="true"></div>' +
        '<h2 class="serif">Make your pick</h2>' +
        '<p style="color: var(--muted);">Question ' + (q.index + 1) + ' of ' + q.total + '</p>' +
        tilesMarkup +
      '</div>';

    // After the rows are in the DOM, shrink any text that would overflow.
    // No-op for default mode (no .row-text elements present).
    if (announcementMode) fitAllRowTexts();

    const tilesEl = document.getElementById('pTiles');
    tilesEl.addEventListener('click', function (e) {
      // Match both default `.tile` and Announcement Mode `.row-tile` via
      // their shared `data-choice` attribute, so the same handler covers
      // both layouts without branching.
      const btn = e.target.closest('[data-choice]');
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
    const pointsToNextPlace = res.pointsToNextPlace;
    const klass = correct ? 'result-correct' : 'result-wrong';
    const heading = res.answered
      ? (correct ? 'Correct! 🎉' : 'Not quite…')
      : 'Too slow!';
    // Announcement Mode only, and only when the player got it wrong or
    // didn't answer: render a non-interactive copy of the correct row
    // tile (same Duolingo-style row from the question page — colored
    // border, badge, answer text). Reusing the row-tile visual language
    // keeps the result card tied to what they saw a moment ago, without
    // inventing any new primitive. Correct outcomes skip this (clean
    // win card stays clean).
    const showAnswer = announcementMode
      && !correct
      && typeof res.correctIndex === 'number'
      && typeof res.correctChoice === 'string';
    const answerMarkup = showAnswer
      ? ('<div class="result-answer-wrap">' +
           '<div class="row-tile row-tile-display" ' +
                'role="img" ' +
                'aria-label="Correct answer: ' + CHOICE_LETTERS[res.correctIndex] + ' ' + escapeHtml(res.correctChoice) + '">' +
             '<span class="row-badge" aria-hidden="true">' + shape(res.correctIndex) + '</span>' +
             '<span class="row-text">' + escapeHtml(res.correctChoice) + '</span>' +
             '<span class="row-check" aria-hidden="true">✓</span>' +
           '</div>' +
         '</div>')
      : '';
    const showNextPlace = !res.isLastQuestion && typeof pointsToNextPlace === 'number' && pointsToNextPlace > 0;
    elView.innerHTML =
      '<div class="state-card">' +
        '<h2 class="serif ' + klass + '">' + heading + '</h2>' +
        (res.answered
          ? '<div class="result-points ' + klass + '">+' + pts + '</div>'
          : '<p>No answer recorded.</p>') +
        // Hide the rank on the very last question — the host's podium reveal
        // is about to drop and we don't want to spoil the standings. In
        // Announcement Mode the host doesn't auto-reveal (the operator has
        // to click "Reveal results to phones →"), and the room may not see
        // the host screen at all, so we point the player at the DJ instead.
        (res.isLastQuestion
          ? (announcementMode
              ? '<p class="result-rank">Final results coming up — listen to the DJ! 🎤</p>'
              : '<p class="result-rank">Final results coming up on the big screen…</p>')
          : (res.tied
              ? '<p class="result-rank">You are tied at <strong>#' + rank + '</strong> of ' + total + '</p>'
              : '<p class="result-rank">You are <strong>#' + rank + '</strong> of ' + total + '</p>')) +
        (showNextPlace
          ? '<p class="result-next-place">↑ ' + pointsToNextPlace + ' pts to next place</p>'
          : '') +
        answerMarkup +
      '</div>';

    // After the result card is in the DOM, shrink the row tile's text if
    // it would overflow the fixed-width tile (same fitText pass the
    // question page uses). No-op when the tile isn't rendered.
    if (showAnswer) fitAllRowTexts();
  }

  // Cached state:final payload (or the equivalent piece returned by the
  // reconnect ack under `payload.final`). The reveal-rank moment is gated
  // by `state:rankReveal` from the server, which arrives AFTER the host's
  // podium animation completes, so we have to keep the leaderboard around
  // long enough to render the player's rank once that gate opens.
  let finalPayload = null;

  function renderFinal(f) {
    // Stash whatever the server sent so renderPlayerRank() can use it
    // when the rank-reveal signal arrives (or right now, if the host
    // already finished its podium reveal — i.e. on a refresh during the
    // post-podium part of FINAL).
    if (f) finalPayload = f;
    if (finalPayload && finalPayload.podiumRevealed) {
      renderPlayerRank();
      return;
    }
    // Podium reveal still in progress on the host — show the holding
    // copy and wait for `state:rankReveal` to flip us over to the rank
    // card. This keeps the standings off the player phone until the
    // room has seen them on the big screen.
    render(
      '<h2 class="serif">Thanks for playing! 💕</h2>' +
      (announcementMode
        ? '<p>Listen to the DJ for the winners!</p>'
        : '<p>Check the big screen for the winners.</p>')
    );
  }

  // Build and render the player's personal rank card. Only safe to call
  // when `finalPayload.fullLeaderboard` is populated AND we want the
  // standings revealed (i.e. `state:rankReveal` has fired, or the
  // reconnect ack told us `podiumRevealed: true`).
  function renderPlayerRank() {
    if (!finalPayload || !Array.isArray(finalPayload.fullLeaderboard)) {
      // Safety net: server should always send fullLeaderboard before
      // signaling rank reveal, but if something raced just fall back to
      // the placeholder copy so the player isn't staring at a blank view.
      render(
        '<h2 class="serif">Thanks for playing! 💕</h2>' +
        (announcementMode
          ? '<p>Listen to the DJ for the winners!</p>'
          : '<p>Check the big screen for the winners.</p>')
      );
      return;
    }
    const lb = finalPayload.fullLeaderboard;
    const me = lb.find(function (e) { return e.id === playerId; });
    if (!me) {
      // Player not in the leaderboard — most likely they were kicked or
      // somehow stripped from game.players before final. Show a generic
      // "thanks" without inventing a rank.
      render(
        '<h2 class="serif">Thanks for playing! 💕</h2>' +
        (announcementMode
          ? '<p>Listen to the DJ for the winners!</p>'
          : '<p>Check the big screen for the winners.</p>')
      );
      return;
    }
    const rank = me.rank;
    const totalPlayers = lb.length;
    // Tie size = number of leaderboard rows sharing the same rank value.
    // The server's `getLeaderboard()` uses competition ranking (1,2,2,4)
    // so this count is reliable.
    const tieCount = lb.filter(function (e) { return e.rank === rank; }).length;
    const tied = tieCount > 1;
    // Medal is driven by PODIUM TIER (1/2/3/null), not raw rank, so we
    // stay in lock-step with the host podium when ties push the silver
    // or bronze tier down to non-2/3 ranks. e.g. ranks [1,1,3,3,3,6...]
    // → tiers [1,1,2,2,2,3...] so the rank-6 players still get bronze
    // here just like they do on the big screen.
    //
    // Copy contract (per user spec):
    //   - Medal headline NEVER names a specific rank (silver ≠ rank 2
    //     in general; bronze ≠ rank 3).
    //   - Actual rank ALWAYS appears on its own line under any medal,
    //     for consistency across gold/silver/bronze (the user explicitly
    //     wants the rank shown even when you win).
    //   - "(N winners)" flavor is preserved for gold-tier ties; other
    //     tiers say "(N players)".
    const tier = me.podiumTier || null;

    let medal = '';
    let headline = '';
    let rankLine = '';   // separate line showing the actual rank (under any medal)
    // "out of N players" is shown under EVERY case so players always
    // know the size of the field they competed in. (Previously this
    // line was only shown for non-medal finishes, which was an
    // inconsistency.)
    if (tier === 1) {
      medal = '🥇';
      headline = tied ? 'Tied for the win!' : 'You won!';
      rankLine = tied
        ? '<p class="rank-tied-count">Tied at #' + rank + ' (' + tieCount + ' winners)</p>'
        : '<p class="rank-tied-count">You finished at #' + rank + '</p>';
    } else if (tier === 2) {
      medal = '🥈';
      headline = 'Silver medal!';
      rankLine = tied
        ? '<p class="rank-tied-count">Tied at #' + rank + ' (' + tieCount + ' players)</p>'
        : '<p class="rank-tied-count">You finished at #' + rank + '</p>';
    } else if (tier === 3) {
      medal = '🥉';
      headline = 'Bronze medal!';
      rankLine = tied
        ? '<p class="rank-tied-count">Tied at #' + rank + ' (' + tieCount + ' players)</p>'
        : '<p class="rank-tied-count">You finished at #' + rank + '</p>';
    } else {
      // Off the podium — no medal. Rank is already in the headline so
      // we skip the separate rank line. We intentionally do NOT show
      // the tie size here: at e.g. #14 the "(N players)" count adds
      // clutter without celebration value. The count is still shown
      // on podium tiers above where it reads as bragging rights
      // ("3 winners" / "2 players tied for silver").
      headline = tied ? ('Tied at #' + rank) : ('#' + rank);
    }
    const totalLine = '<p class="rank-total">out of ' + totalPlayers + ' players</p>';
    // Score is already shown in the sticky top bar chip; no need to
    // repeat it here.

    elView.innerHTML =
      '<div class="state-card rank-reveal-card">' +
        (medal ? '<div class="rank-medal" aria-hidden="true">' + medal + '</div>' : '') +
        '<h2 class="serif rank-headline">' + headline + '</h2>' +
        rankLine +
        totalLine +
        '<p class="rank-footnote">Thanks for playing! 💕</p>' +
      '</div>';
  }

  function renderRejected(reason) {
    setReactionsAllowed(false);
    // Player is no longer in the game — hide the bar entirely.
    if (reactionBar) reactionBar.hidden = true;
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
    // rAF-driven loop: flips the displayed second within one vsync frame
    // (~16ms) of the true server-anchored boundary, keeping the player's
    // counter in lockstep with the host's instead of drifting up to a
    // full setInterval cycle behind.
    let lastShown = null;
    function tick() {
      countdownInterval = null;
      if (!currentQuestion) return stopCountdown();
      const el = document.getElementById('pcountdown');
      if (!el) return stopCountdown();
      const msLeftPrecise = Math.max(0, currentQuestion.endsAt - serverNow());
      const left = Math.ceil(msLeftPrecise / 1000);
      if (left !== lastShown) {
        lastShown = left;
        el.textContent = left + 's';

        // Subtle "you haven't answered yet" cues — only fire while the
        // player still hasn't submitted for this question.
        const stillAnswering =
          !answeredQuestionId || answeredQuestionId !== currentQuestion.id;

        if (stillAnswering && left <= 5 && left > 0) {
          if (!urgentClassAdded) {
            urgentClassAdded = true;
            document.body.classList.add('urgent');
            el.classList.add('urgent');
            // Sync the drain-bar animation to the actual time remaining:
            // if we entered the urgent window mid-animation (e.g. on
            // refresh), jump the 5s animation forward by the elapsed
            // amount via a negative animation-delay.
            const bar = document.getElementById('urgentBar');
            if (bar) {
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
      }

      if (msLeftPrecise <= 0) return stopCountdown();
      countdownInterval = requestAnimationFrame(tick);
    }
    countdownInterval = requestAnimationFrame(tick);
  }
  function stopCountdown() {
    if (countdownInterval) { cancelAnimationFrame(countdownInterval); countdownInterval = null; }
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
  // True when the host has globally muted reactions. Independent of the
  // per-phase `reactionsAllowed` gate — when muted, the bar is shown but
  // the buttons stay grayed out.
  let reactionsMutedByHost = false;

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

  // Note: setReactionsAllowed only toggles the *enabled* state of the
  // buttons. The bar itself stays visible across all in-game phases so
  // the layout doesn't shift between question / lobby / reveal / final.
  // During phases where reactions aren't allowed (INTRO / PROMPT /
  // QUESTION) the buttons are simply disabled (grayed out by the
  // .reaction-btn:disabled rule). The bar is only truly hidden before
  // the player has joined and after they've been rejected — both done
  // explicitly via reactionBar.hidden = true/false at those points.
  function setReactionsAllowed(allowed) {
    reactionsAllowed = allowed;
    updateReactionButtonState();
  }
  function updateReactionButtonState() {
    const now = Date.now();
    const onCooldown = now < reactionUntilMs;
    const disabled = !reactionsAllowed || onCooldown || rejected || reactionsMutedByHost;
    reactionBtns.forEach(function (b) { b.disabled = disabled; });
    if (reactionsMutedByHost && reactionsAllowed) {
      reactionCooldownEl.hidden = false;
      reactionCooldownEl.textContent = 'Reactions paused by host';
    } else if (onCooldown && reactionsAllowed) {
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
      // Drop focus immediately so mobile browsers don't leave a focus
      // ring / highlight ring around the tapped emoji button (which
      // appears as a lingering circle when the user taps a different
      // emoji next).
      try { btn.blur(); } catch (_) {}
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
      setScore(res.player.score || 0);
      reactionsMutedByHost = !!res.reactionsMuted;
      announcementMode = !!res.announcementMode;
      // Player is confirmed — reveal the reaction bar UNLESS Announcement
      // Mode is on. The whole point of the reaction bar is to fan emojis
      // up the host screen for the room to see; in Announcement Mode the
      // room can't see the host screen (the DJ is calling the shots), so
      // the bar is hidden entirely for the rest of the session. The flag
      // is locked outside LOBBY so it won't flip once the player is in.
      if (reactionBar) reactionBar.hidden = !!announcementMode;
      updateReactionButtonState();
      if (res.phase === 'LOBBY') { setReactionsAllowed(true); renderLobbyWaiting(); }
      else if (res.phase === 'INTRO') {
        setReactionsAllowed(false);
        renderIntro(res.intro);
      }
      else if (res.phase === 'PROMPT') {
        setReactionsAllowed(false);
        renderPrompt(res.prompt);
      }
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
      else if (res.phase === 'FINAL') {
        setReactionsAllowed(true);
        // Server stuffs `fullLeaderboard` + `podiumRevealed` into
        // `res.final` on reconnect during FINAL (mid-flight join is
        // blocked, so this is the only path back in once the game has
        // ended). Feed it to renderFinal() so the phone either shows
        // the holding copy (podium reveal still in progress) or jumps
        // straight to the rank card (reveal already happened).
        renderFinal(res.final || null);
      }
    });
  });

  socket.on('state:lobby', function (s) {
    if (rejected) return;
    if (s && Array.isArray(s.players)) {
      lobbyPlayerCount = s.players.length;
    } else if (s && typeof s.total === 'number') {
      lobbyPlayerCount = s.total;
    }
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

  // Host has muted/unmuted all player reactions. Bar stays visible but the
  // buttons are grayed out with a "paused by host" label until unmuted.
  socket.on('state:reactionsMuted', function (p) {
    reactionsMutedByHost = !!(p && p.muted);
    updateReactionButtonState();
  });

  // Host toggled Announcement Mode. The host server only allows this in the
  // LOBBY phase, so by the time the player is in any later phase this flag
  // is effectively frozen — but we still rebind it here so a player who
  // joined mid-lobby picks up the latest setting before INTRO fires. We
  // also hide/show the reaction bar to match: reactions only make sense
  // when the room can see the host screen, which is not the case in
  // Announcement Mode (DJ-led, possibly no visible host display).
  socket.on('state:announcementMode', function (p) {
    announcementMode = !!(p && p.on);
    if (reactionBar && !rejected) {
      reactionBar.hidden = announcementMode;
    }
    if (document.body.classList.contains('player-waiting')) {
      renderLobbyWaiting();
    }
  });

  socket.on('state:question', function (q) {
    if (rejected) return;
    leaveLobbyWaiting();
    setReactionsAllowed(false);
    renderQuestion(q);
  });

  socket.on('state:intro', function (payload) {
    if (rejected) return;
    leaveLobbyWaiting();
    setReactionsAllowed(false);
    renderIntro(payload);
  });

  socket.on('state:prompt', function (p) {
    if (rejected) return;
    leaveLobbyWaiting();
    setReactionsAllowed(false);
    renderPrompt(p);
  });

  // When the host plays the "Time's up!" / "Let's see the answers!" sting,
  // we hold the player's screen on its previous state until the sting clears
  // so the small screen doesn't transition ahead of the big screen.
  // Host timing: 120ms blank + ~250ms fade-in + 2200ms hold + 350ms fade-out
  //            + ~550ms into the slow reveal fade-in = ~3470ms.
  var REVEAL_HOLD_MS = 3200;
  var pendingResult = null;
  var holdRevealUntil = 0;

  function applyReveal() {
    if (rejected) return;
    setReactionsAllowed(true);
    if (!lastResult || (currentQuestion && lastResult.questionId !== currentQuestion.id)) {
      render('<h2 class="serif">Hold tight…</h2>' +
        (announcementMode
          ? '<p>Listen to the DJ!</p>'
          : '<p>Results on the big screen.</p>'));
    }
    if (pendingResult) {
      var res = pendingResult;
      pendingResult = null;
      lastResult = res;
      setScore(res.totalScore);
      renderResult(res);
    }
  }

  socket.on('state:reveal', function (r) {
    if (rejected) return;
    leaveLobbyWaiting();
    stopCountdown();
    // The countdown was just frozen mid-tick (often at "1s" because Math.ceil
    // rounds the final fractional second up). Snap it to "0s" so the player's
    // screen doesn't sit on a stale value during the sting hold. Keep the
    // .urgent class on the pill so it stays red at 0s.
    var pill = document.getElementById('pcountdown');
    if (pill) {
      pill.textContent = '0s';
      pill.classList.add('urgent');
    }
    document.body.classList.remove('urgent');
    var reason = r && r.endReason;
    // If THIS player never submitted an answer for the current question and
    // time ran out, skip the sting hold — there's no "answer locked in"
    // screen to preserve, so jump straight to the "Too slow!" result.
    var didNotAnswer =
      reason === 'timeout' &&
      currentQuestion &&
      answeredQuestionId !== currentQuestion.id;
    if (didNotAnswer) {
      // Hold on the question screen for a beat so the player actually
      // sees the timer pill snap to 0s before "Too slow!" replaces it —
      // gives them a clear "you ran out" moment instead of cutting
      // straight from "1s" to the result card.
      holdRevealUntil = 0;
      setTimeout(applyReveal, 600);
    } else if (reason === 'timeout' || reason === 'all-answered') {
      // Hold the previous screen until the host's sting overlay clears.
      holdRevealUntil = Date.now() + REVEAL_HOLD_MS;
      setTimeout(applyReveal, REVEAL_HOLD_MS);
    } else {
      // 'host' (manual advance) or 'replay' — no sting, transition normally.
      holdRevealUntil = 0;
      setTimeout(applyReveal, 400);
    }
  });

  socket.on('player:result', function (res) {
    if (rejected) return;
    var wait = holdRevealUntil - Date.now();
    if (wait > 0) {
      // Sting is still playing on the host — queue this result and let
      // applyReveal() render it when the hold expires.
      pendingResult = res;
      return;
    }
    lastResult = res;
    setScore(res.totalScore);
    renderResult(res);
  });

  socket.on('state:final', function (f) {
    if (rejected) return;
    leaveLobbyWaiting();
    setReactionsAllowed(true);
    stopCountdown();
    renderFinal(f);
  });

  // Server fires this once the host's podium animation has finished and
  // it's safe to show every player their personal rank. `renderFinal()`
  // stashed the full leaderboard from `state:final` on this client, so
  // we don't need a payload here — just the signal to flip.
  socket.on('state:rankReveal', function () {
    if (rejected) return;
    if (!finalPayload) {
      // We somehow received the rank-reveal signal without ever seeing
      // `state:final` (shouldn't happen — server always broadcasts final
      // first). Mark the flag so when state:final does arrive it renders
      // straight to the rank card without making the player wait further.
      finalPayload = { podiumRevealed: true };
      return;
    }
    finalPayload.podiumRevealed = true;
    renderPlayerRank();
  });

  socket.on('state:reset', function () {
    // Show an intermediate "host reset" screen with a Rejoin button instead of
    // bouncing the player straight to /join.
    rejected = true;
    stopCountdown();
    stopIntroTimer();
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
