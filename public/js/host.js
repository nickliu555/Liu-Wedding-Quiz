(function () {
  'use strict';

  const socket = io({ transports: ['polling', 'websocket'] });

  // ---------------- Settings popover ----------------
  // Wires up the ⚙ Settings dropdown in the topbar. Clicking the button
  // toggles the panel; clicking outside closes it. Buttons inside the
  // panel close it after firing, *unless* they opt out with the
  // `data-settings-keep-open` attribute (used by toggles like Music and
  // Reactions that the host may flip multiple times in a row).
  (function wireSettingsPopover() {
    const btn = document.getElementById('settingsBtn');
    const panel = document.getElementById('settingsPanel');
    if (!btn || !panel) return;
    function close() {
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
    function open() {
      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
    }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (panel.hidden) open(); else close();
    });
    document.addEventListener('click', function (e) {
      if (panel.hidden) return;
      if (e.target.closest('#settingsPanel')) {
        // Click on a panel action: close unless it opts out.
        const action = e.target.closest('button, a');
        if (action && !action.hasAttribute('data-settings-keep-open')) {
          // Defer so the button's own handler runs first.
          setTimeout(close, 0);
        }
        return;
      }
      if (e.target.closest('#settingsBtn')) return;
      close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !panel.hidden) close();
    });
  })();

  // ---------------- Element refs ----------------
  const views = {
    lobby: document.getElementById('view-lobby'),
    intro: document.getElementById('view-intro'),
    question: document.getElementById('view-question'),
    reveal: document.getElementById('view-reveal'),
    final: document.getElementById('view-final'),
  };
  function show(name) {
    // Crossfade between views instead of a hard `display` swap. We mark the
    // outgoing view with `.fading-out` (which CSS animates to opacity 0),
    // then after the transition we drop `.active` from it and add `.active`
    // to the incoming view. Quick safeguard: if the same view is requested
    // we skip the dance entirely.
    const currentName = Object.keys(views).find(function (k) {
      return views[k].classList.contains('active');
    });
    if (currentName === name) return;

    const incoming = views[name];
    if (!incoming) return;

    const outgoing = currentName ? views[currentName] : null;
    if (outgoing) {
      outgoing.classList.add('fading-out');
      // Match the .view opacity transition duration (350ms in CSS).
      setTimeout(function () {
        outgoing.classList.remove('active');
        outgoing.classList.remove('fading-out');
        incoming.classList.add('active');
      }, 350);
    } else {
      incoming.classList.add('active');
    }
  }

  // ---------------- Inline modal / toast (avoids browser confirm() that exits fullscreen) ----------------
  function showInlineConfirm(message, onYes) {
    const existing = document.getElementById('inlineConfirm');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'inlineConfirm';
    overlay.className = 'inline-modal-overlay';
    overlay.innerHTML =
      '<div class="inline-modal">' +
        '<p class="inline-modal-msg"></p>' +
        '<div class="inline-modal-actions">' +
          '<button type="button" class="btn-ghost" data-act="no">Cancel</button>' +
          '<button type="button" class="btn-accent" data-act="yes">Yes</button>' +
        '</div>' +
      '</div>';
    overlay.querySelector('.inline-modal-msg').textContent = message;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'yes') { overlay.remove(); onYes && onYes(); }
      else if (act === 'no' || e.target === overlay) { overlay.remove(); }
    });
  }

  function showToast(message) {
    const t = document.createElement('div');
    t.className = 'inline-toast';
    t.textContent = message;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('visible'); }, 10);
    setTimeout(function () { t.classList.remove('visible'); setTimeout(function () { t.remove(); }, 300); }, 3000);
  }

  const joinUrlEl = document.getElementById('joinUrl');
  const qrImg = document.getElementById('qrImg');
  const playerList = document.getElementById('playerList');
  const playerCount = document.getElementById('playerCount');
  const startBtn = document.getElementById('startBtn');

  const qIndex = document.getElementById('qIndex');
  const qTotal = document.getElementById('qTotal');
  const qPrompt = document.getElementById('qPrompt');
  const qImage = document.getElementById('qImage');
  const answerGrid = document.getElementById('answerGrid');
  const answersReceived = document.getElementById('answersReceived');
  const answersTotal = document.getElementById('answersTotal');
  const timerRing = document.getElementById('timerRing');
  const timerText = document.getElementById('timerText');

  const introCountdown = document.getElementById('introCountdown');

  const rIndex = document.getElementById('rIndex');
  const rTotal = document.getElementById('rTotal');
  const rPrompt = document.getElementById('rPrompt');
  const barRows = document.getElementById('barRows');
  const leaderboard = document.getElementById('leaderboard');
  const nextBtn = document.getElementById('nextBtn');

  const podium = document.getElementById('podium');
  const fullLb = document.getElementById('fullLb');

  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const musicBtn = document.getElementById('musicBtn');
  const muteReactionsBtn = document.getElementById('muteReactionsBtn');
  const resetBtn = document.getElementById('resetBtn');
  const announcementToggle = document.getElementById('announcementToggle');
  const announcementBadge = document.getElementById('announcementBadge');
  const startAnsweringBtn = document.getElementById('startAnsweringBtn');
  const startAnsweringRow = document.getElementById('startAnsweringRow');
  const revealToPhonesBtn = document.getElementById('revealToPhonesBtn');
  const revealToPhonesRow = document.getElementById('revealToPhonesRow');
  const exportResultsBtn = document.getElementById('exportResultsBtn');

  const sfxLobby = document.getElementById('sfx-lobby');
  const sfxTick = document.getElementById('sfx-tick');
  const sfxReveal = document.getElementById('sfx-reveal');
  const sfxPodium = document.getElementById('sfx-podium');

  // Master sound toggle. Controls every sound effect on the host page
  // (tick beeps, cheer chords, applause). Default ON.
  let soundOn = true;
  function updateMusicBtnLabel() {
    musicBtn.textContent = soundOn ? '🔊 Sound: On' : '🔇 Sound: Off';
    musicBtn.classList.toggle('btn-muted', !soundOn);
  }
  updateMusicBtnLabel();
  let sfxUnlocked = false;

  function unlockSfx() {
    if (sfxUnlocked) return;
    sfxUnlocked = true;
    [sfxLobby, sfxTick, sfxReveal, sfxPodium].forEach(function (a) {
      // prime them so later plays aren't blocked
      a.volume = 0; a.play().then(function () { a.pause(); a.currentTime = 0; a.volume = 1; }).catch(function () {});
    });
  }
  function safePlay(a) {
    // Announcement Mode silences ALL host audio — see the docs on
    // `announcementMode` above. The mode is toggled lobby-only, so once
    // set it stays for the whole quiz.
    if (announcementMode) return;
    try { a.currentTime = 0; a.play().catch(function(){}); } catch(e){}
  }

  // ---------------- Wake Lock (keep the PC awake while host page is open) ----------------
  // Uses the Screen Wake Lock API. Supported in Chrome/Edge/Safari 16.4+.
  // The lock auto-releases when the tab is hidden, so we re-acquire it when
  // the page becomes visible again.
  let wakeLock = null;
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', function () { wakeLock = null; });
    } catch (e) {
      // Most common reason: user gesture not yet given, or page not visible.
      // We'll retry on next visibility change or click.
      wakeLock = null;
    }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && wakeLock === null) {
      acquireWakeLock();
    }
  });
  // Try once immediately and again on first user interaction (some browsers
  // require a gesture before granting the lock).
  acquireWakeLock();
  document.addEventListener('click', function once() {
    document.removeEventListener('click', once);
    if (wakeLock === null) acquireWakeLock();
  });

  // ---------------- Fullscreen ----------------
  // Safari still ships the webkit-prefixed APIs, so prefer the standard one
  // and fall back if missing. Called synchronously inside the click so the
  // browser's transient activation requirement is satisfied.
  fullscreenBtn.addEventListener('click', function () {
    const el = document.documentElement;
    const inFs = document.fullscreenElement || document.webkitFullscreenElement;
    try {
      if (!inFs) {
        const req = el.requestFullscreen || el.webkitRequestFullscreen;
        if (req) {
          const p = req.call(el);
          if (p && typeof p.catch === 'function') p.catch(function () {});
        }
      } else {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
      }
    } catch (_) { /* swallow */ }
  });
  function syncFullscreenLabel() {
    const inFs = document.fullscreenElement || document.webkitFullscreenElement;
    fullscreenBtn.textContent = inFs ? '⛶ Exit' : '⛶ Fullscreen';
  }
  document.addEventListener('fullscreenchange', syncFullscreenLabel);
  document.addEventListener('webkitfullscreenchange', syncFullscreenLabel);

  musicBtn.addEventListener('click', function () {
    unlockSfx();
    soundOn = !soundOn;
    updateMusicBtnLabel();
  });

  resetBtn.addEventListener('click', function () {
    showInlineConfirm('Reset the entire game? All players will be kicked.', function () {
      socket.emit('host:reset', {});
    });
  });

  // ---------------- Mute player reactions ----------------
  // Toggle button that tells the server to block all incoming player
  // reactions and broadcasts the muted state so player phones gray out
  // their reaction bar. The button label/style mirrors the current state
  // so a refreshed host page can read it from the host:auth ack.
  let reactionsMuted = false;
  function updateMuteReactionsBtn() {
    if (!muteReactionsBtn) return;
    if (reactionsMuted) {
      muteReactionsBtn.textContent = '🔕 Reactions: Off';
      muteReactionsBtn.classList.add('btn-muted');
      muteReactionsBtn.title = 'Player reactions are muted — click to allow';
    } else {
      muteReactionsBtn.textContent = '🔔 Reactions: On';
      muteReactionsBtn.classList.remove('btn-muted');
      muteReactionsBtn.title = 'Click to mute all player reactions';
    }
  }
  updateMuteReactionsBtn();
  if (muteReactionsBtn) {
    muteReactionsBtn.addEventListener('click', function () {
      const next = !reactionsMuted;
      socket.emit('host:setReactionsMuted', { muted: next }, function (res) {
        if (res && res.ok) {
          reactionsMuted = !!res.reactionsMuted;
          updateMuteReactionsBtn();
        }
      });
    });
  }
  // Keep the button in sync if another host page toggles it.
  socket.on('state:reactionsMuted', function (p) {
    reactionsMuted = !!(p && p.muted);
    updateMuteReactionsBtn();
  });

  // ---------------- Announcement Mode ----------------
  // DJ-led fallback for venues where the host screen isn't visible to the
  // audience. When ON:
  //   - PROMPT phase does NOT auto-advance — host clicks "Start answering
  //     →" to begin the answering timer (see Phase 3 wiring in renderPrompt).
  //   - The fade-in PROMPT animation is skipped; full Q + 4 choices show
  //     immediately for the DJ to read.
  //   - ALL host audio is muted (lobby loop pauses immediately; SFX/cheer/
  //     drumroll calls are no-ops). The DJ owns the audio in this mode.
  //   - FINAL podium reveal renders instantly with a manual "Reveal
  //     results to phones →" button (Phase 5).
  // Defaults to true to match the server-side default (DJ-led wedding
  // deployment). The connect ack below overwrites this with the
  // authoritative server value the moment it arrives, so this only
  // controls the brief pre-ack window. Only mutable in LOBBY — server
  // enforces this; client disables the toggle UI mid-quiz so the
  // operator can't try.
  let announcementMode = true;
  // Tracks the host's authoritative game phase ('LOBBY' | 'INTRO' |
  // 'PROMPT' | 'QUESTION' | 'REVEAL' | 'FINAL'). The server's
  // `state:lobby` event is really a ROSTER-UPDATE broadcast — it fires on
  // any guest join/reconnect in *every* phase (a phone refreshing during
  // the results screen triggers it), so it must NOT be treated as a
  // genuine "we are now in the lobby" phase change. The true lobby entry
  // always goes through enterLobby() (auth + reset paths). We keep this
  // flag so the state:lobby handler can skip lobby-only side effects
  // (e.g. hiding the Export button) when we're not actually in LOBBY.
  let currentPhase = null;
  function updateAnnouncementUI() {
    if (announcementToggle) {
      announcementToggle.setAttribute('aria-checked', announcementMode ? 'true' : 'false');
    }
    if (announcementBadge) {
      announcementBadge.hidden = !announcementMode;
    }
    // When the mode flips on, immediately silence anything currently
    // playing so the DJ owns the room from this point forward. The audio
    // play helpers below also early-return while the mode is on, so future
    // attempts to play SFX during the quiz are no-ops.
    if (announcementMode) {
      try { sfxLobby.pause(); sfxLobby.currentTime = 0; } catch (_) {}
      try { sfxTick.pause(); sfxTick.currentTime = 0; } catch (_) {}
      try { sfxReveal.pause(); sfxReveal.currentTime = 0; } catch (_) {}
      try { sfxPodium.pause(); sfxPodium.currentTime = 0; } catch (_) {}
      try { applauseAudio.pause(); applauseAudio.currentTime = 0; } catch (_) {}
      try { drumrollAudio.pause(); drumrollAudio.currentTime = 0; } catch (_) {}
    }
  }
  // The toggle is only operable while we're in LOBBY (server rejects
  // changes mid-quiz). Call this whenever the phase changes so the
  // disabled state reflects reality.
  function setAnnouncementToggleEnabled(enabled) {
    if (!announcementToggle) return;
    if (enabled) {
      announcementToggle.disabled = false;
      announcementToggle.removeAttribute('aria-disabled');
      announcementToggle.title = 'DJ reads questions aloud instead of the audience reading the host screen';
    } else {
      announcementToggle.disabled = true;
      announcementToggle.setAttribute('aria-disabled', 'true');
      announcementToggle.title = 'Announcement mode is locked once the quiz starts';
    }
  }
  updateAnnouncementUI();
  if (announcementToggle) {
    announcementToggle.addEventListener('click', function () {
      if (announcementToggle.disabled) return;
      const next = !announcementMode;
      // Optimistic UI: flip immediately so the click feels responsive.
      // Reverted in the ack handler if the server rejects (e.g. quiz
      // already started in another host tab between render and click).
      announcementMode = next;
      updateAnnouncementUI();
      socket.emit('host:setAnnouncementMode', { on: next }, function (res) {
        if (!res || !res.ok) {
          // Revert to the server's truth.
          announcementMode = !!(res && res.announcementMode);
          updateAnnouncementUI();
          if (res && res.reason === 'quiz-started') {
            showToast('Announcement mode can only be changed in the lobby.');
          }
        } else {
          announcementMode = !!res.announcementMode;
          updateAnnouncementUI();
        }
      });
    });
  }
  // Keep the toggle and badge in sync if another host page (or the server)
  // changes the mode.
  socket.on('state:announcementMode', function (p) {
    announcementMode = !!(p && p.on);
    updateAnnouncementUI();
  });

  // "Start answering →" button — only visible during Announcement Mode's
  // PROMPT phase (see renderPrompt). Fires host:startAnswering, which on
  // the server calls game.startAnsweringNow() to transition PROMPT ->
  // QUESTION immediately (the auto _phaseTimer was suppressed in PROMPT).
  // On success the server broadcasts state:question and renderQuestion
  // does the snap-instant swap to the running-timer state.
  if (startAnsweringBtn) {
    startAnsweringBtn.addEventListener('click', function () {
      if (startAnsweringBtn.disabled) return;
      // Optimistic disable: prevent double-clicks while the server processes.
      // renderQuestion (fired from the resulting state:question broadcast)
      // hides the row entirely. If the server rejects we re-enable below.
      startAnsweringBtn.disabled = true;
      startAnsweringBtn.setAttribute('aria-busy', 'true');
      socket.emit('host:startAnswering', {}, function (res) {
        if (!res || !res.ok) {
          // Most common rejection reasons:
          //   - 'wrong-phase': operator double-clicked or the phase
          //     advanced between the click and the emit.
          //   - 'not-announcement-mode': someone toggled the flag off
          //     between renderPrompt and the click (shouldn't happen
          //     since the toggle is locked outside LOBBY, but defensive).
          startAnsweringBtn.disabled = false;
          startAnsweringBtn.removeAttribute('aria-busy');
          showToast('Could not start answering — try again.');
        }
        // On success the server broadcasts state:question which calls
        // renderQuestion, which hides #startAnsweringRow. No work needed
        // here in the success branch.
      });
    });
  }

  // "Reveal results to phones →" button — only visible in Announcement
  // Mode's FINAL phase (see renderFinalAnnouncement). Fires host:podiumDone
  // which the server treats as the "podium reveal complete" signal — it
  // sets podiumRevealed = true and broadcasts state:rankReveal so every
  // player phone flips from the "Final results coming up…" holding card
  // to its personal rank card in unison. Server is idempotent on dupes,
  // but we disable the button after the first click to make the UX clear.
  if (revealToPhonesBtn) {
    revealToPhonesBtn.addEventListener('click', function () {
      if (revealToPhonesBtn.disabled) return;
      revealToPhonesBtn.disabled = true;
      revealToPhonesBtn.setAttribute('aria-busy', 'true');
      socket.emit('host:podiumDone');
      // No ack from the server for host:podiumDone (it's a fire-and-forget
      // signal; the server broadcasts state:rankReveal as the visible
      // confirmation). Visually settle the button into a "done" state so
      // the operator sees their click was received.
      revealToPhonesBtn.removeAttribute('aria-busy');
      revealToPhonesBtn.textContent = '✓ Results revealed to phones';
    });
  }

  // ---------------- Export results to CSV (Google Sheets) ----------------
  // Lives in the top bar, shown only on the FINAL page (toggled in the
  // state:final / phase handlers). On click we ask the server for the full
  // per-player dump and build a CSV the operator can import into Google
  // Sheets (File → Import). One row per player: Name, each question's
  // chosen answer (with a ✓/✗ marker), and the final score.
  function showExportBtn(visible) {
    if (!exportResultsBtn) return;
    exportResultsBtn.hidden = !visible;
  }

  // RFC 4180 field escaping: wrap in double quotes and double any embedded
  // quotes whenever the value contains a comma, quote, or newline.
  function csvField(value) {
    var s = value == null ? '' : String(value);
    if (/[",\n\r]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function buildResultsCsv(questions, rows) {
    var header = ['Rank', 'Name'];
    questions.forEach(function (q, i) {
      header.push('Q' + (i + 1) + ': ' + q.prompt);
    });
    header.push('Final Score');

    var lines = [header.map(csvField).join(',')];

    rows.forEach(function (row) {
      var cells = [row.rank, row.name];
      questions.forEach(function (q) {
        var a = row.answers ? row.answers[q.id] : null;
        if (!a) {
          cells.push(''); // never answered this question
        } else {
          cells.push(a.text + (a.wasCorrect ? ' ✓' : ' ✗'));
        }
      });
      cells.push(row.score);
      lines.push(cells.map(csvField).join(','));
    });

    // Prepend a UTF-8 BOM so Google Sheets / Excel render the ✓/✗ glyphs
    // and any accented names correctly on import.
    return '\ufeff' + lines.join('\r\n');
  }

  function downloadCsv(filename, csv) {
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke on the next tick so the download has a chance to start.
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  if (exportResultsBtn) {
    exportResultsBtn.addEventListener('click', function () {
      // Keep the button visible and re-clickable the whole time — just
      // show transient feedback text. We don't disable it (the disabled
      // dim on a transparent btn-ghost reads as "disappearing"), and the
      // operator may legitimately want to export more than once.
      socket.emit('host:exportResults', {}, function (res) {
        if (!res || !res.ok) {
          exportResultsBtn.textContent = '⚠ Export failed';
          setTimeout(function () {
            exportResultsBtn.textContent = '⬇ Export as CSV';
          }, 2500);
          return;
        }
        var csv = buildResultsCsv(res.questions || [], res.rows || []);
        var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        downloadCsv('wedding-quiz-results-' + stamp + '.csv', csv);
        exportResultsBtn.textContent = '✓ Exported';
        setTimeout(function () {
          exportResultsBtn.textContent = '⬇ Export as CSV';
        }, 2500);
      });
    });
  }

  // ---------------- Auto-enter on load ----------------
  socket.on('connect', function () {
    socket.emit('host:auth', {}, function (res) {
      if (!res || !res.ok) return;
      // Always prep totals so reveal/final views show correct counts.
      qTotal.textContent = res.questionsTotal;
      rTotal.textContent = res.questionsTotal;
      reactionsMuted = !!res.reactionsMuted;
      updateMuteReactionsBtn();
      // Hydrate announcement mode from the server ack so a refreshed host
      // page picks up the current truth (badge, toggle position, audio
      // gating) immediately — not after the next state:* broadcast.
      announcementMode = !!res.announcementMode;
      updateAnnouncementUI();
      setAnnouncementToggleEnabled(res.phase === 'LOBBY');
      if (res.phase === 'LOBBY') {
        enterLobby(res);
      }
      // For QUESTION / REVEAL / FINAL the server replays the matching
      // state:* event right after this ack, which will switch to the
      // correct view via the existing handlers below.
    });
  });

  function enterLobby(initial) {
    show('lobby');
    currentPhase = 'LOBBY';
    // Defensive cleanup of phase-only UI (announcement-mode "Start
    // answering →" button, prompt-only / announcement-prompt body classes)
    // so a refresh into the lobby is clean even if a previous quiz left
    // stale state attached.
    if (startAnsweringRow) startAnsweringRow.hidden = true;
    if (revealToPhonesRow) revealToPhonesRow.hidden = true;
    showExportBtn(false);
    document.body.classList.remove('host-prompt-only', 'host-announcement-prompt', 'host-prompt-instant', 'host-final-question');
    qTotal.textContent = initial.questionsTotal;
    rTotal.textContent = initial.questionsTotal;
    renderQR();
    renderLobby({ players: initial.players });
  }

  // ---------------- QR ----------------
  function renderQR() {
    // Ask the server for the canonical join URL (LAN IP in dev, public URL on Render).
    // This way, even if the host opened the page at http://localhost:..., the QR will
    // encode the LAN IP so phones on the same WiFi can actually reach it.
    fetch('/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        const url = (cfg && cfg.joinUrl) || (window.location.origin + '/join');
        joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
        qrImg.src = '/qr?url=' + encodeURIComponent(url);
      })
      .catch(function () {
        const url = window.location.origin + '/join';
        joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
        qrImg.src = '/qr?url=' + encodeURIComponent(url);
      });
  }

  // ---------------- Lobby ----------------
  // Track which players we've already seen so newly-arriving guests get a
  // sparkle/bounce-in animation while existing chips just re-render. The
  // very first lobby paint (e.g. host reloads mid-party) is treated as a
  // "warm start" so we don't sparkle the whole roster at once.
  const knownPids = new Set();
  let lobbyFirstRender = true;
  let lastPlayerCount = 0;

  // Stable per-name color index so each player keeps the same avatar tint
  // across re-renders. 5 wedding-palette tints in CSS via .avatar-c0..c4.
  function avatarColorIndex(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return h % 5;
  }
  function initialOf(name) {
    const s = (name || '').trim();
    if (!s) return '?';
    // Grab the first letter of the first word; uppercased.
    return s.charAt(0).toUpperCase();
  }

  // Shrink the lobby title ("Carly & Nick · Wedding Quiz") to whatever
  // font size fits beside the count pill on its single line. CSS alone
  // can't do this reliably because the pill's width changes with the
  // player count and `vw`/`cqi` units don't know about the pill at all
  // — earlier attempts either left the title overflowing the pill, or
  // truncated it with ellipsis. This is a hard contract: the title
  // must ALWAYS be fully visible.
  //
  // Cost: ~25 DOM reads on every renderLobby() call. Each measurement
  // is just `scrollWidth` on a single element; well under 1ms in
  // practice. Idempotent — safe to call repeatedly.
  function fitLobbyTitle() {
    const header = document.querySelector('.players-panel .header');
    if (!header) return;
    const titleEl = header.querySelector('h3');
    if (!titleEl) return;
    const countEl = header.querySelector('.count');
    const headerStyle = getComputedStyle(header);
    const gap = parseFloat(headerStyle.columnGap || headerStyle.gap || '0') || 0;
    const headerWidth = header.clientWidth;
    const countWidth = countEl ? countEl.offsetWidth : 0;
    const available = Math.max(0, headerWidth - countWidth - gap);
    // Start at the design-max font size and shrink in 1px steps until
    // it fits. Linear search is fine — at most 28 iterations for the
    // 38px..10px range, each just one scrollWidth read.
    const MAX = 38;
    const MIN = 10;
    for (let size = MAX; size >= MIN; size--) {
      titleEl.style.fontSize = size + 'px';
      if (titleEl.scrollWidth <= available) return;
    }
    titleEl.style.fontSize = MIN + 'px';
  }
  // Re-fit on window resize too (fullscreen toggle, window drag, etc.).
  window.addEventListener('resize', fitLobbyTitle);

  function renderLobby(s) {
    const players = s.players || [];
    // Heart-pulse the count badge whenever the roster grows.
    if (players.length > lastPlayerCount) {
      playerCount.classList.remove('bumped');
      // Force reflow so the animation restarts even on consecutive joins.
      void playerCount.offsetWidth;
      playerCount.classList.add('bumped');
    }
    lastPlayerCount = players.length;
    playerCount.textContent = players.length + (players.length === 1 ? ' player' : ' players');
    // The count pill just grew ("9 players" -> "115 players" widens it
    // by ~30px) so the lobby title may no longer fit. Re-fit on every
    // render — cheap and idempotent. See fitLobbyTitle() below.
    fitLobbyTitle();

    playerList.innerHTML = players.map(function (p) {
      const isNew = !lobbyFirstRender && !knownPids.has(p.id);
      const classes = ['player-chip', 'avatar-c' + avatarColorIndex(p.name)];
      if (!p.connected) classes.push('disconnected');
      if (isNew) classes.push('is-new');
      return (
        '<div class="' + classes.join(' ') + '" data-pid="' + p.id + '" title="Click to remove">' +
          '<span class="avatar" aria-hidden="true">' + escapeHtml(initialOf(p.name)) + '</span>' +
          '<span class="name">' + escapeHtml(p.name) + '</span>' +
          (isNew ? '<span class="sparkle" aria-hidden="true">✨</span>' : '') +
        '</div>'
      );
    }).join('');

    // Remember everyone we've shown so they don't sparkle on the next paint.
    knownPids.clear();
    players.forEach(function (p) { knownPids.add(p.id); });
    lobbyFirstRender = false;

    startBtn.disabled = players.length === 0;
  }

  playerList.addEventListener('click', function (e) {
    const chip = e.target.closest('.player-chip');
    if (!chip) return;
    const pid = chip.dataset.pid;
    // The chip now wraps an avatar + name; grab the explicit .name node so we
    // don't pick up the avatar letter (and the sparkle) in the confirm copy.
    const nameEl = chip.querySelector('.name');
    const name = nameEl ? nameEl.textContent : chip.textContent;
    showInlineConfirm('Remove "' + name + '" from the game?', function () {
      socket.emit('host:kick', { playerId: pid });
    });
  });

  startBtn.addEventListener('click', function () {
    socket.emit('host:start', {}, function (res) {
      if (!res || !res.ok) {
        showToast('Could not start: ' + (res && res.reason));
        return;
      }
      // The fanfare is fired by renderIntro() when the server's state:intro
      // event arrives, so it's perfectly synced with the splash itself.
    });
  });

  // Answer options are labelled A/B/C/D — easier to call out ("B!") than
  // "diamond" / "circle" etc., and avoids looking like a direct Kahoot copy.
  const CHOICE_LETTERS = ['A', 'B', 'C', 'D'];
  function shapeHTML(i) { return '<span class="choice-letter">' + (CHOICE_LETTERS[i] || '') + '</span>'; }
  let currentQ = null;
  let qTimer = null;
  let lastTickSec = null; // last whole-second value we played a tick on

  // ---------------- Server clock sync ----------------
  // Each `state:question` payload carries the server's `Date.now()`. We use
  // it to compute an offset so the host countdown is anchored to the server's
  // clock — which keeps the host and player phones in sync regardless of
  // per-device clock drift.
  let clockOffset = 0; // ms to add to local Date.now() to approximate server time
  function serverNow() { return Date.now() + clockOffset; }

  // ---------------- Synth tick (Web Audio API) ----------------
  // We don't ship a tick.mp3 — instead we synthesize a short percussive
  // beep so it always works and we can ramp the volume per-tick.
  let audioCtx = null;
  function getAudioCtx() {
    if (audioCtx) return audioCtx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
    return audioCtx;
  }
  // Unlock the AudioContext on the very first user gesture anywhere on the
  // page. Browsers require this before any sound will actually play.
  function unlockAudio() {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(function(){});
    }
    // Play a 1ms silent blip to fully unlock on iOS/Safari.
    try {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.001);
    } catch (e) {}
  }
  ['click', 'keydown', 'touchstart'].forEach(function (evt) {
    window.addEventListener(evt, unlockAudio, { once: false, capture: true });
  });

  // secLeft is 5..1 for the per-second tick, or 0 for the final "time's up"
  // alarm. The 5..1 ticks are short, clean 880Hz beeps that get louder each
  // second; the 0s tick is a longer higher 1320Hz "BEEEEP" alarm.
  function playTick(secLeft) {
    if (!soundOn || announcementMode) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      ctx.resume().catch(function(){});
      if (ctx.state !== 'running') return;
    }
    const t = ctx.currentTime;
    const isFinal = secLeft === 0;
    // Volume ramps 0.4 (5s) -> ~0.95 (1s); final beep is full volume.
    const vol = isFinal ? 1.0 : 0.4 + (5 - secLeft) * 0.14;
    const freq = isFinal ? 1320 : 880;
    const dur = isFinal ? 0.55 : 0.12;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.01);
    gain.gain.setValueAtTime(vol, t + dur - 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // ---------------- Celebration sound ----------------
  // We try to use a real applause sample if one is present at
  // /assets/sounds/applause.mp3 (since synthesized applause never sounds
  // quite right). If the file 404s, we silently fall back to a short
  // synthesized burst.
  const applauseAudio = new Audio('/assets/sounds/applause.mp3');
  applauseAudio.preload = 'auto';
  applauseAudio.volume = 0.85;
  let applauseFileAvailable = null; // null=unknown, true/false once tested
  applauseAudio.addEventListener('canplaythrough', function () { applauseFileAvailable = true; });
  applauseAudio.addEventListener('error', function () { applauseFileAvailable = false; });

  function playApplause(durationSec) {
    if (!soundOn || announcementMode) return;
    // Prefer the real recording if present.
    if (applauseFileAvailable === true) {
      try {
        applauseAudio.currentTime = 0;
        applauseAudio.play().catch(function(){});
      } catch (e) {}
      return;
    }
    // Fallback: short synthesized clap-like burst (~4s).
    playApplauseSynth(durationSec || 4);
  }

  function playApplauseSynth(durationSec) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      ctx.resume().catch(function(){});
      if (ctx.state !== 'running') return;
    }
    const t0 = ctx.currentTime;
    const dur = Math.max(1.0, durationSec || 4);
    const sampleRate = ctx.sampleRate;
    const clapLen = Math.floor(sampleRate * 0.05);
    const clapBuf = ctx.createBuffer(1, clapLen, sampleRate);
    const clapData = clapBuf.getChannelData(0);
    for (let i = 0; i < clapLen; i++) clapData[i] = (Math.random() * 2 - 1);
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    const peakDensity = 24;
    const totalClaps = Math.floor(peakDensity * dur);
    for (let i = 0; i < totalClaps; i++) {
      const when = Math.random() * dur;
      // Density envelope: fade in (0.4s), hold, fade out (0.6s).
      let densityScale;
      if (when < 0.4) densityScale = when / 0.4;
      else if (when < dur - 0.6) densityScale = 1.0;
      else densityScale = Math.max(0, (dur - when) / 0.6);
      if (Math.random() > densityScale) continue;
      const t = t0 + when;
      const src = ctx.createBufferSource();
      src.buffer = clapBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1700 + Math.random() * 1500;
      bp.Q.value = 1.0 + Math.random() * 0.6;
      const env = ctx.createGain();
      const peakVol = 0.2 + Math.random() * 0.25;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(peakVol, t + 0.002);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.05 + Math.random() * 0.03);
      let lastNode = env;
      if (ctx.createStereoPanner) {
        const pan = ctx.createStereoPanner();
        pan.pan.value = (Math.random() * 2 - 1) * 0.7;
        env.connect(pan);
        lastNode = pan;
      }
      src.connect(bp).connect(env);
      lastNode.connect(master);
      src.start(t);
      src.stop(t + 0.06);
    }
  }

  // A short triumphant chord ("ding!") played when each podium spot is revealed.
  // tier: 3 = 3rd place (low chord), 2 = 2nd place (mid), 1 = 1st place (high & longer).
  function playCheerChord(tier) {
    if (!soundOn || announcementMode) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      ctx.resume().catch(function(){});
      if (ctx.state !== 'running') return;
    }
    const t = ctx.currentTime;
    // Major chords stacked higher for higher placements.
    // 3rd: C major (C4, E4, G4); 2nd: E major (E4, G#4, B4); 1st: G major (G4, B4, D5, G5)
    const chords = {
      3: { freqs: [261.63, 329.63, 392.00],          dur: 0.9, vol: 0.45 },
      2: { freqs: [329.63, 415.30, 493.88],          dur: 1.1, vol: 0.55 },
      1: { freqs: [392.00, 493.88, 587.33, 783.99],  dur: 1.6, vol: 0.7  },
    };
    const c = chords[tier] || chords[3];
    c.freqs.forEach(function (f, i) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const startGain = c.vol / c.freqs.length;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(startGain, t + 0.02 + i * 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + c.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + c.dur + 0.05);
    });
  }

  // Synthesized drumroll: a rapid stream of low filtered-noise hits with a
  // crescendo. Used during the suspense beats before each podium reveal.
  // Returns a stop() function so the caller can cut it off precisely on the
  // reveal beat. durationSec is the target length of the roll.
  //
  // If /assets/sounds/drumroll.mp3 is available, we prefer the real
  // recording (capped to the first `durationSec` so the file's "tada" tail
  // is never heard). Falls back to the synth if the file is missing.
  const drumrollAudio = new Audio('/assets/sounds/drumroll.mp3');
  drumrollAudio.preload = 'auto';
  drumrollAudio.volume = 0.85;
  let drumrollFileAvailable = null;
  // `canplaythrough` is the strictest signal but isn't fired by all browsers
  // until much later (sometimes never). `loadeddata` fires as soon as the
  // first frame of audio is decoded — that's enough for our 3s clip.
  drumrollAudio.addEventListener('loadeddata',     function () { drumrollFileAvailable = true; });
  drumrollAudio.addEventListener('canplaythrough', function () { drumrollFileAvailable = true; });
  drumrollAudio.addEventListener('error',          function () { drumrollFileAvailable = false; });
  // Kick off the load now (some browsers don't auto-fetch with preload alone).
  try { drumrollAudio.load(); } catch (_) {}

  function playDrumroll(durationSec) {
    var dur = Math.max(0.4, durationSec || 1.2);
    if (!soundOn || announcementMode) return function () {};
    // Prefer the real recording if it's loaded enough to play. We check
    // `readyState >= 2` (HAVE_CURRENT_DATA) at call time as a fallback, in
    // case neither `loadeddata` nor `canplaythrough` fired yet.
    var fileReady = drumrollFileAvailable === true || drumrollAudio.readyState >= 2;
    if (fileReady && drumrollFileAvailable !== false) {
      var stopped = false;
      var cutoffTimer = null;
      try {
        drumrollAudio.currentTime = 0;
        var p = drumrollAudio.play();
        if (p && typeof p.catch === 'function') {
          p.catch(function (err) {
            // Transient errors (e.g. "play() interrupted by pause()" from
            // the previous reveal) are common when reusing one <audio>
            // element across multiple reveals. Don't permanently blacklist
            // the file — just log and let subsequent reveals try again.
            console.warn('[drumroll] file play failed for this beat:', err);
          });
        }
      } catch (e) {
        // Hard error — fall back to synth this time only.
        return playDrumrollSynth(dur);
      }
      // Hard-stop after `dur` seconds so the trailing "tada" never plays.
      cutoffTimer = setTimeout(function () {
        try { drumrollAudio.pause(); drumrollAudio.currentTime = 0; } catch (_) {}
      }, dur * 1000);
      return function stop() {
        if (stopped) return;
        stopped = true;
        if (cutoffTimer) { clearTimeout(cutoffTimer); cutoffTimer = null; }
        try { drumrollAudio.pause(); drumrollAudio.currentTime = 0; } catch (_) {}
      };
    }
    return playDrumrollSynth(dur);
  }

  function playDrumrollSynth(dur) {
    var stopped = false;
    var stoppers = [];
    var ctx = getAudioCtx();
    if (!ctx) return function () {};
    if (ctx.state !== 'running') {
      ctx.resume().catch(function () {});
    }
    var t0 = ctx.currentTime;
    // ~22 hits per second, ramping from quiet to loud.
    var hitsPerSec = 22;
    var totalHits = Math.floor(dur * hitsPerSec);
    for (var i = 0; i < totalHits; i++) {
      var when = t0 + (i / hitsPerSec);
      var progress = i / totalHits; // 0..1
      var vol = 0.08 + progress * 0.35; // crescendo
      // Build a tiny noise burst.
      var bufferSize = Math.floor(ctx.sampleRate * 0.04);
      var buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      var data = buffer.getChannelData(0);
      for (var s = 0; s < bufferSize; s++) data[s] = (Math.random() * 2 - 1) * (1 - s / bufferSize);
      var src = ctx.createBufferSource();
      src.buffer = buffer;
      var filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 220;
      var gain = ctx.createGain();
      gain.gain.value = vol;
      src.connect(filt).connect(gain).connect(ctx.destination);
      src.start(when);
      src.stop(when + 0.05);
      stoppers.push(src);
    }
    return function stop() {
      if (stopped) return;
      stopped = true;
      stoppers.forEach(function (s) { try { s.stop(); } catch (_) {} });
    };
  }

  // Game-show "let's begin" stinger: 3-note rising fanfare (C5 -> E5 -> G5)
  // played in quick succession when the host starts the game.
  function playStartFanfare() {    if (!soundOn || announcementMode) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      ctx.resume().catch(function(){});
      if (ctx.state !== 'running') return;
    }
    const t0 = ctx.currentTime;
    // C5, E5, G5 — bright major-triad arpeggio, last note held for the punch.
    const notes = [
      { freq: 523.25, start: 0.00, dur: 0.22 }, // C5
      { freq: 659.25, start: 0.14, dur: 0.22 }, // E5
      { freq: 783.99, start: 0.28, dur: 0.55 }, // G5
    ];
    notes.forEach(function (n) {
      [
        { type: 'triangle', freq: n.freq,       vol: 0.45 },
        { type: 'sine',     freq: n.freq * 0.5, vol: 0.18 },
      ].forEach(function (layer) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = layer.type;
        osc.frequency.value = layer.freq;
        const t = t0 + n.start;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(layer.vol, t + 0.015);
        gain.gain.setValueAtTime(layer.vol, t + n.dur - 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + n.dur + 0.05);
      });
    });
  }

  // ---------------- Sting overlay (Time's up! / Let's see the answers!) ----------------
  // Brief full-screen flash between QUESTION and REVEAL — Kahoot-style
  // beat that gives the room a moment to react before the answer-bar
  // chart slams in. Two variants:
  //   - timeout       -> "Time's up!" (pinkish, urgent)
  //   - all-answered  -> "Let's see the answers!" (greenish, satisfied)
  // Calls `done` after the overlay has been visible long enough that the
  // caller can swap the underlying view (it stays on top during the swap
  // and fades out on its own).
  var STING_VISIBLE_MS = 2200; // how long the sting text holds
  var STING_FADE_MS = 350;     // matches the CSS opacity transition
  // Wall-clock deadline (Date.now() ms) by which whichever sting is
  // currently on screen should be fully cleared. Used by the
  // visibilitychange watchdog below to force-clear a stuck overlay if
  // the tab was hidden through the entire show/hide window. Shared by
  // playSting() (per-question "Time's up!" / "Let's see the answers!")
  // and showFinalQuestionSting() ("💍 Final Question" splash) — these
  // two are mutually exclusive in the game state machine, so a single
  // shared deadline is safe.
  var stingClearAt = 0;
  function playSting(reason, done) {
    var overlay = document.getElementById('stingOverlay');
    var textEl = document.getElementById('stingText');
    if (!overlay || !textEl) {
      if (typeof done === 'function') done();
      return;
    }
    var copy =
      reason === 'timeout' ? "Time's up!" :
      reason === 'all-answered' ? "Let's see the answers!" :
      'Results';
    textEl.textContent = copy;
    overlay.classList.remove('timeout', 'all-answered');
    overlay.classList.add(reason);
    // Add .visible SYNCHRONOUSLY. Previously this used requestAnimationFrame
    // ("trigger fade-in on next frame so the CSS transition runs") — but
    // rAF callbacks do NOT fire while the browser tab is hidden, whereas
    // the setTimeout calls below (remove .visible + call `done`) DO still
    // fire (throttled). When the tab was hidden across the entire sting
    // window the result was: cleanup setTimeouts ran with .visible never
    // added; user tabbed back; queued rAF finally ran; .visible got
    // added with no remaining cleanup → overlay stuck on screen
    // indefinitely. The CSS transition fires reliably from a synchronous
    // class add too (the overlay is a permanent DOM node, opacity:0 by
    // default, so toggling .visible is a clean opacity 0→1 transition —
    // see showFinalQuestionSting() below for the same pattern).
    overlay.classList.add('visible');
    stingClearAt = Date.now() + STING_VISIBLE_MS + STING_FADE_MS;
    // Audio: timeout already has the alarm tick at 0s from the per-second
    // countdown, so we stay quiet there to avoid stepping on it. For
    // 'all-answered' the question ended early with no countdown alarm,
    // so we play the two-note reveal chime — a quick "ding-ding" cue
    // that the answer is about to slide in. Fires exactly once per
    // reveal thanks to the server-side single-emission contract for
    // state:reveal (see server/index.js + the regression tests in
    // server/game.test.js).
    if (reason === 'all-answered') {
      playRevealChime();
    }
    // Hand control back to the caller (they'll render the reveal under
    // the overlay) and start the fade-out.
    if (typeof done === 'function') {
      setTimeout(done, STING_VISIBLE_MS - STING_FADE_MS);
    }
    setTimeout(function () { overlay.classList.remove('visible'); }, STING_VISIBLE_MS);
  }

  // Short two-note upward chime played alongside "Let's see the answers!".
  // G5 -> C6, ~130ms apart — reads as a single pleasant "ding-ding"
  // (not two separate dings). The server's onQuestionTimeout callback
  // is the single source of truth for the QUESTION->REVEAL transition
  // (see server/index.js + the game.test.js single-emission tests), so
  // this fires exactly once per reveal — if the two-note chime ever
  // sounds like it's playing twice or the notes feel too far apart,
  // that's the symptom of state:reveal being double-emitted again.
  function playRevealChime() {
    if (!soundOn || announcementMode) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      ctx.resume().catch(function(){});
      if (ctx.state !== 'running') return;
    }
    const t0 = ctx.currentTime;
    // G5 -> C6 — a pleasant little "ding-ding".
    const notes = [
      { freq: 783.99, start: 0.00, dur: 0.32 },
      { freq: 1046.50, start: 0.13, dur: 0.45 },
    ];
    notes.forEach(function (n) {
      [
        { type: 'triangle', freq: n.freq,       vol: 0.30 },
        { type: 'sine',     freq: n.freq * 2,   vol: 0.10 },
      ].forEach(function (layer) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = layer.type;
        osc.frequency.value = layer.freq;
        const t = t0 + n.start;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(layer.vol, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + n.dur + 0.05);
      });
    });
  }

  function renderQuestion(q) {
    currentQ = q;
    lastTickSec = null;
    // In Announcement Mode the PROMPT phase already rendered the question
    // text and the 4 answer tiles fully visible (no host-prompt-only
    // class). We treat that as "already populated" so we don't re-render
    // the tiles (which would cause them to pop) and so the swap to the
    // running-timer state is an instant in-place update.
    const wasAnnouncementPrompt = document.body.classList.contains('host-announcement-prompt');
    const wasPromptOnly =
      document.body.classList.contains('host-prompt-only') || wasAnnouncementPrompt;
    show('question');
    // Hide the "Start answering →" button on entry into QUESTION — even if
    // we got here via a host refresh that skipped PROMPT, the button must
    // not be visible while the countdown is running.
    if (startAnsweringRow) startAnsweringRow.hidden = true;
    if (startAnsweringBtn) startAnsweringBtn.disabled = false;
    // If we were in prompt-only mode, the answer tiles have already been
    // pre-rendered by renderPrompt() and are sitting hidden in the DOM.
    // We just need to remove the class to let the CSS transitions fade
    // them in. We DO NOT replace innerHTML here — that would create fresh
    // nodes that skip their initial transition state and pop in.
    qIndex.textContent = q.index + 1;
    qTotal.textContent = q.total;
    qPrompt.textContent = q.prompt;
    if (q.image) { qImage.src = q.image; qImage.style.display = 'block'; }
    else { qImage.style.display = 'none'; qImage.removeAttribute('src'); }

    // Re-render tiles only if they weren't already pre-rendered (e.g. host
    // refreshed mid-question and skipped the prompt phase entirely).
    const needsTiles =
      !wasPromptOnly ||
      answerGrid.children.length !== q.choices.length ||
      Array.from(answerGrid.children).some(function (c, i) {
        const txt = c.querySelector('.text');
        return !txt || txt.textContent !== q.choices[i];
      });
    if (needsTiles) {
      answerGrid.innerHTML = q.choices.map(function (c, i) {
        return (
          '<div class="answer-card tile-color-' + i + '" data-idx="' + i + '">' +
            '<div class="shape">' + shapeHTML(i) + '</div>' +
            '<div class="text">' + escapeHtml(c) + '</div>' +
          '</div>'
        );
      }).join('');
    }

    answersReceived.textContent = '0';
    // answersTotal is updated via host:answerCount event

    if (wasAnnouncementPrompt) {
      // Snap-instant swap: tiles are already visible (no transition needed),
      // and we just need to reveal the timer ring + answers counter and
      // start the countdown. Removing the class on the same frame is fine
      // because we don't want a fade — the DJ has just said "go" and the
      // timer should appear immediately.
      document.body.classList.remove('host-announcement-prompt', 'host-final-question');
      startQTimer(q);
    } else if (wasPromptOnly) {
      // Drop the prompt-only class on the next frame so the browser has a
      // chance to commit the current (hidden) state before transitioning.
      requestAnimationFrame(function () {
        document.body.classList.remove('host-prompt-only');
        startQTimer(q);
      });
    } else {
      document.body.classList.remove('host-prompt-only');
      startQTimer(q);
    }
  }

  // ---------------- Intro ("Get Ready" splash) ----------------
  // Shown once when the host starts the game, before the first question's
  // PROMPT phase. Pure visual beat to focus the room.
  let introTimer = null;
  function stopIntroTimer() {
    if (introTimer) { clearInterval(introTimer); introTimer = null; }
  }
  function renderIntro(payload) {
    stopQTimer();
    stopIntroTimer();
    show('intro');
    if (payload && typeof payload.serverNow === 'number') {
      clockOffset = payload.serverNow - Date.now();
    }
    const endsAt = (payload && payload.endsAt) || (Date.now() + 5000);
    function tick() {
      const left = Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
      if (introCountdown) introCountdown.textContent = left <= 0 ? 'Go!' : String(left);
      if (left <= 0) stopIntroTimer();
    }
    tick();
    introTimer = setInterval(tick, 200);
    // A short rising fanfare to cue the room that things are starting.
    if (soundOn && !announcementMode) playStartFanfare();
  }

  // ---------------- Prompt (read-the-question lead-in) ----------------
  // Shows the question text (and image, if any) WITHOUT the answer choices
  // and without an active answer timer. After ~3s the server fires
  // state:question and renderQuestion swaps in the choice tiles + timer.
  function renderPrompt(p) {
    stopQTimer();
    stopIntroTimer();
    show('question');
    // Announcement Mode short-circuits the visual "lead-in" we use in
    // default mode: instead of hiding the choices until the QUESTION phase
    // fires, we render the full question + 4 answer tiles immediately so
    // the wedding DJ can read them aloud at their own pace. The timer
    // ring is also hidden until the operator clicks "Start answering →"
    // (which fires host:startAnswering -> the server transitions
    // PROMPT -> QUESTION and broadcasts state:question with a fresh
    // endsAt clock). The default-OFF branch below is byte-identical to
    // the original implementation.
    if (announcementMode) {
      // No "💍 Final Question!" splash — the DJ owns the dramatic intro
      // in Announcement Mode. Skip the sting entirely, but DO show a soft
      // "💍 Final Question" pill under the "Question X of Y" meta line
      // during the PROMPT phase of the very last question so the operator
      // (and any audience members glancing at the host screen) get a
      // gentle heads-up. Visibility is CSS-driven; the body class auto-
      // hides the pill once host-announcement-prompt is removed (or the
      // class is cleared on the next question's prompt).
      document.body.classList.toggle('host-final-question', !!(p && p.isLastQuestion));
      qIndex.textContent = (p.index + 1);
      qTotal.textContent = p.total;
      qPrompt.textContent = p.prompt;
      if (p.image) { qImage.src = p.image; qImage.style.display = 'block'; }
      else { qImage.style.display = 'none'; qImage.removeAttribute('src'); }
      // Render the answer tiles FULLY VISIBLE — no host-prompt-only class.
      if (Array.isArray(p.choices) && p.choices.length === 4) {
        answerGrid.innerHTML = p.choices.map(function (c, i) {
          return (
            '<div class="answer-card tile-color-' + i + '" data-idx="' + i + '">' +
              '<div class="shape">' + shapeHTML(i) + '</div>' +
              '<div class="text">' + escapeHtml(c) + '</div>' +
            '</div>'
          );
        }).join('');
      } else {
        answerGrid.innerHTML = '';
      }
      answersReceived.textContent = '0';
      // Park the timer ring on the full time so the swap into QUESTION
      // mode (when the operator clicks "Start answering →") doesn't briefly
      // flash a stale value.
      if (timerText && p.timeLimitSec) timerText.textContent = String(p.timeLimitSec);
      if (timerRing) timerRing.style.setProperty('--pct', '100');
      // Defensive: never carry forward the default-mode prompt-only class.
      document.body.classList.remove('host-prompt-only', 'host-prompt-instant');
      document.body.classList.add('host-announcement-prompt');
      // Show the operator's "Start answering →" button + enable it (it may
      // have been disabled by a previous click on the same prompt phase
      // if e.g. the server rejected the emit and we returned to PROMPT).
      if (startAnsweringRow) startAnsweringRow.hidden = false;
      if (startAnsweringBtn) {
        startAnsweringBtn.disabled = false;
        startAnsweringBtn.removeAttribute('aria-busy');
      }
      if (p && typeof p.serverNow === 'number') {
        clockOffset = p.serverNow - Date.now();
      }
      return;
    }
    // ---- Default mode (announcementMode === false) ----
    // Default mode uses the splash sting (showFinalQuestionSting) instead
    // of the pill, so make sure the announcement-only body class is never
    // left over from a prior run / mode toggle.
    document.body.classList.remove('host-final-question');
    // For the very last question, briefly show a "💍 Final Question!" splash
    // before the prompt content becomes readable. The server has padded
    // this prompt phase with extra time so the regular cadence is preserved.
    if (p && p.isLastQuestion) {
      showFinalQuestionSting();
    }
    qIndex.textContent = (p.index + 1);
    qTotal.textContent = p.total;
    qPrompt.textContent = p.prompt;
    if (p.image) { qImage.src = p.image; qImage.style.display = 'block'; }
    else { qImage.style.display = 'none'; qImage.removeAttribute('src'); }
    // Pre-render the answer tiles NOW (during the lead-in) so they're
    // already in the DOM when state:question fires. The host-prompt-only
    // class keeps them hidden via CSS until then. This is what makes the
    // PROMPT -> QUESTION transition smooth — when the class is removed,
    // the existing nodes already have their "hidden" state committed and
    // the CSS transitions can carry them to the "visible" state.
    if (Array.isArray(p.choices) && p.choices.length === 4) {
      answerGrid.innerHTML = p.choices.map(function (c, i) {
        return (
          '<div class="answer-card tile-color-' + i + '" data-idx="' + i + '">' +
            '<div class="shape">' + shapeHTML(i) + '</div>' +
            '<div class="text">' + escapeHtml(c) + '</div>' +
          '</div>'
        );
      }).join('');
    } else {
      answerGrid.innerHTML = '';
    }
    answersReceived.textContent = '0';
    // Park the timer ring at the question's full time so the eye has
    // something to read while waiting for choices to drop in.
    if (timerText && p.timeLimitSec) timerText.textContent = String(p.timeLimitSec);
    if (timerRing) timerRing.style.setProperty('--pct', '100');
    // Add the class AFTER populating so the new tiles inherit the hidden
    // state from the moment they exist. The `host-prompt-instant` helper
    // suppresses transitions for one frame so the timer ring and tiles
    // snap to their hidden state instead of visibly fading out across the
    // intro -> question crossfade.
    document.body.classList.add('host-prompt-only', 'host-prompt-instant');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        document.body.classList.remove('host-prompt-instant');
      });
    });
    if (p && typeof p.serverNow === 'number') {
      clockOffset = p.serverNow - Date.now();
    }
  }

  // "💍 Final Question!" splash, shown over the prompt phase of the very
  // last question. Reuses the existing #stingOverlay node but with a
  // dedicated `final-question` class so it can be styled (and animated)
  // differently from the per-question "Time's up!" sting.
  function showFinalQuestionSting() {
    const ov = document.getElementById('stingOverlay');
    const txt = document.getElementById('stingText');
    if (!ov || !txt) return;
    txt.textContent = '💍 Final Question';
    ov.classList.remove('timeout', 'all-answered');
    // Hide the prompt content underneath so it doesn't peek through.
    document.body.classList.add('host-final-intro');
    document.body.classList.remove('host-final-intro-fading');
    ov.classList.add('visible', 'final-question');
    // Arm the shared visibilitychange watchdog (defined below playSting)
    // so this splash can't get stuck on screen either if the tab was
    // hidden through its entire 5.2s lifecycle. Deadline = the final
    // cleanup setTimeout below.
    stingClearAt = Date.now() + 5200;
    // Hold, then start the splash leaving while the prompt fades in.
    setTimeout(function () {
      ov.classList.remove('visible');
      document.body.classList.add('host-final-intro-fading');
    }, 3700);
    // Once the leave transition is done, clean up classes.
    setTimeout(function () {
      ov.classList.remove('final-question');
      document.body.classList.remove('host-final-intro', 'host-final-intro-fading');
    }, 5200);
  }

  // Watchdog: if the host tab was hidden through the entire sting
  // lifetime, tab-visibility races can leave the overlay stuck on
  // screen (see the long-form comment in playSting above for the
  // original rAF-vs-setTimeout bug). Synchronous .visible adds in both
  // sting functions prevent the primary failure mode; this watchdog is
  // belt-and-suspenders for any future timing path (browser quirks,
  // intensive throttling extremes, etc.). When the tab becomes visible
  // AFTER the sting's expected clear-by deadline (+ 500ms grace so the
  // normal cleanup setTimeout wins the race during a brief tab-flip),
  // force-clear every sting class on the overlay AND the body classes
  // the final-question splash sets. Class removal is idempotent, so
  // over-cleanup is safe for either sting type.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (stingClearAt === 0) return;
    if (Date.now() < stingClearAt + 500) return; // still inside expected window
    var overlay = document.getElementById('stingOverlay');
    if (overlay) {
      overlay.classList.remove('visible', 'timeout', 'all-answered', 'final-question');
    }
    document.body.classList.remove('host-final-intro', 'host-final-intro-fading');
    stingClearAt = 0;
  });

  function startQTimer(q) {
    stopQTimer();
    if (typeof q.serverNow === 'number') clockOffset = q.serverNow - Date.now();
    // rAF-driven update loop: vsync-granular ticks (~16ms) so the conic
    // ring animates smoothly AND the displayed second flips within one
    // frame of the true `endsAt` boundary. Combined with the server-clock
    // offset, this keeps the host and player phones flipping the second
    // counter within a vsync of each other — much tighter than the old
    // 100ms setInterval drift window.
    let lastSecShown = null;
    const update = function () {
      qTimer = null;
      const msLeft = Math.max(0, q.endsAt - serverNow());
      const secLeft = Math.ceil(msLeft / 1000);
      const pct = Math.max(0, (msLeft / (q.timeLimitSec * 1000)) * 100);
      if (secLeft !== lastSecShown) {
        lastSecShown = secLeft;
        timerText.textContent = String(secLeft);
        if (secLeft <= 5 && msLeft > 0) {
          timerRing.classList.add('urgent');
        } else {
          timerRing.classList.remove('urgent');
        }
        // Tick once per whole second when 5..1 remain (each louder), then a
        // longer "time's up" alarm beep at 0.
        if (secLeft >= 0 && secLeft <= 5 && secLeft !== lastTickSec) {
          lastTickSec = secLeft;
          playTick(secLeft);
        }
      }
      timerRing.style.setProperty('--pct', pct.toFixed(1));
      if (msLeft <= 0) { stopQTimer(); return; }
      qTimer = requestAnimationFrame(update);
    };
    qTimer = requestAnimationFrame(update);
  }
  function stopQTimer() {
    if (qTimer) { cancelAnimationFrame(qTimer); qTimer = null; }
    if (timerRing) timerRing.classList.remove('urgent');
  }

  // ---------------- Reveal ----------------
  function renderReveal(r) {
    stopQTimer();
    show('reveal');
    // Defensive: make sure the announcement-mode PROMPT button never lingers
    // into REVEAL (e.g. if all players answer instantly).
    if (startAnsweringRow) startAnsweringRow.hidden = true;
    if (soundOn && !announcementMode) safePlay(sfxReveal);

    // Pull prompt + choices from our in-memory currentQ (server doesn't resend them)
    const q = currentQ || { prompt: '', choices: ['', '', '', ''] };
    rIndex.textContent = r.index + 1;
    rTotal.textContent = r.total;
    rPrompt.textContent = q.prompt;

    // Dim / highlight answer cards too
    Array.from(answerGrid.children).forEach(function (card) {
      const idx = parseInt(card.dataset.idx, 10);
      card.classList.toggle('correct', idx === r.correctIndex);
      card.classList.toggle('dim', idx !== r.correctIndex);
    });

    const total = r.distribution.reduce(function (a, b) { return a + b; }, 0) || 1;
    barRows.innerHTML = [0,1,2,3].map(function (i) {
      const count = r.distribution[i];
      const pct = (count / total) * 100;
      const isCorrect = i === r.correctIndex;
      const colorVar = ['--tile-1','--tile-2','--tile-3','--tile-4'][i];
      const choiceText = (q.choices && q.choices[i]) || '';
      // Same escaped string is used in 3 places (element content, the
      // `title` fallback tooltip, and the `data-full` attribute that
      // powers the polished CSS hover bubble in host.css). escapeHtml()
      // covers " and ' so it's safe in both contexts.
      const choiceEsc = escapeHtml(choiceText);
      const indicator = isCorrect
        ? '<div class="row-indicator correct-check" aria-label="Correct answer">✓</div>'
        : '<div class="row-indicator" aria-hidden="true"></div>';
      return (
        '<div class="bar-row ' + (isCorrect ? 'correct' : '') + '">' +
          '<div class="shape" style="color: var(' + colorVar + ')">' + shapeHTML(i) + '</div>' +
          // tabindex=0 lets keyboard users Tab to each row to surface
          // the tooltip via :focus (mirrors the :hover reveal).
          '<div class="choice-text" title="' + choiceEsc + '" data-full="' + choiceEsc + '" tabindex="0">' + choiceEsc + '</div>' +
          '<div class="bar"><div class="bar-fill" style="width:' + pct.toFixed(1) + '%; background: var(' + colorVar + ')"></div></div>' +
          '<div class="count">' + count + '</div>' +
          indicator +
        '</div>'
      );
    }).join('');

    var rowsHtml = r.leaderboardTop5.map(function (e) {
      return (
        '<div class="lb-row">' +
          '<div class="rank">' + e.rank + '</div>' +
          '<div class="name">' + escapeHtml(e.name) + '</div>' +
          '<div class="score">' + e.score + '</div>' +
        '</div>'
      );
    }).join('');
    // Honest overflow indicator: when more players are tied at the last
    // shown rank but were cut off by the 5-row cap, surface that count
    // rather than silently hiding them (the alphabetical display
    // tiebreaker would otherwise look like a hidden ranking).
    var moreTied = r.leaderboardTop5MoreTied || 0;
    if (moreTied > 0 && r.leaderboardTop5.length > 0) {
      var lastShownRank = r.leaderboardTop5[r.leaderboardTop5.length - 1].rank;
      rowsHtml +=
        '<div class="lb-overflow">' +
          '…and ' + moreTied + ' more tied at rank ' + lastShownRank +
        '</div>';
    }
    leaderboard.innerHTML = rowsHtml;

    // On the last question, hide the Top 5 entirely so the host doesn't
    // spoil the podium reveal that's coming up next. Also collapse the
    // grid to a single centered column so the bars aren't left-leaning.
    var lbPanel = document.getElementById('leaderboardPanel');
    var revealGrid = document.getElementById('revealGrid');
    if (lbPanel) lbPanel.style.display = r.isLastQuestion ? 'none' : '';
    if (revealGrid) revealGrid.classList.toggle('solo', !!r.isLastQuestion);

    // On the last question, swap the green "Next" button for the pink
    // accent style + a trophy so the host clearly sees the game is ending.
    if (r.isLastQuestion) {
      nextBtn.textContent = '🏆 Show final results →';
      nextBtn.classList.remove('btn-primary');
      nextBtn.classList.add('btn-accent');
    } else {
      nextBtn.textContent = 'Next question →';
      nextBtn.classList.remove('btn-accent');
      nextBtn.classList.add('btn-primary');
    }
  }

  nextBtn.addEventListener('click', function () {
    socket.emit('host:next', {}, function () {});
  });

  // ---------------- Final ----------------
  // Reveal flow (per podium spot, bottom-up: 3rd → 2nd → 1st):
  //   1. Show suspense card with medal + animated dots ("🥉 Third place is...")
  //   2. Drumroll plays during the suspense beat
  //   3. Drumroll stops, name + cheer chord pop in
  //   4. Score counter rolls up from 0 to final value
  //   5. Pause, then move to next spot
  // The 1st place reveal also triggers confetti + applause.
  var SUSPENSE_MS = 3000;     // length of dots/drumroll per spot
  var REVEAL_HOLD_MS = 1700;  // how long the revealed spot sits before next
  var SCORE_ROLL_MS = 900;    // duration of the score count-up animation

  function renderFinal(f) {
    show('final');
    document.body.classList.remove('host-announcement-final');
    var congratsEl = document.getElementById('finalCongrats');
    if (congratsEl) congratsEl.hidden = false;

    // ---- Announcement Mode: instant render, manual reveal-to-phones ----
    // In Announcement Mode the DJ does the dramatic call-out aloud, so we
    // skip the "Now for the results…" hold, the per-tier suspense reveal,
    // the drumroll, the cheer chords, the confetti pre-emption, and the
    // score count-up. The full podium + leaderboard appear immediately,
    // and the operator clicks "Reveal results to phones →" to fire
    // host:podiumDone (which is what triggers state:rankReveal on the
    // server, so player phones flip from "Final results coming up…" to
    // their personal rank card).
    if (announcementMode) {
      renderFinalAnnouncement(f);
      return;
    }
    // ---- Default mode (announcementMode === false): original flow ----
    // The button row stays hidden; the auto host:podiumDone signal at the
    // end of runPodiumReveal handles the player-phone reveal.
    if (revealToPhonesRow) revealToPhonesRow.hidden = true;

    // Reset the "Congratulations" banner — it's revealed only after the
    // winner pops in (handled inside runPodiumReveal).
    var congratsEl = document.getElementById('finalCongrats');
    if (congratsEl) congratsEl.classList.remove('visible');

    // Brief "Now for the results…" intro before the podium reveal begins.
    // Pure visual beat — silence helps the room turn its attention to the
    // screen before the first drumroll fires.
    var INTRO_MS = 3000;
    var intro = document.getElementById('resultsIntro');
    var finalView = document.querySelector('.final-view');
    if (finalView) finalView.classList.add('pre-reveal');
    if (intro) {
      intro.classList.remove('hide');
      // Trigger the fade-in on the next frame so the transition runs.
      requestAnimationFrame(function () { intro.classList.add('show'); });
    }
    setTimeout(function () {
      if (intro) { intro.classList.remove('show'); intro.classList.add('hide'); }
      // Wait for the fade-out transition to fully complete (matches the
      // 0.6s opacity transition on .results-intro) before swapping the
      // podium in, so the two views don't overlap.
      setTimeout(function () {
        if (finalView) finalView.classList.remove('pre-reveal');
        runPodiumReveal(f);
      }, 650);
    }, INTRO_MS);
  }

  // Announcement Mode FINAL render: instant, silent, no per-tier reveal.
  // The DJ is calling out the winners aloud, so the entire room sees the
  // full podium + leaderboard the moment FINAL fires. The operator then
  // clicks "Reveal results to phones →" to fan the per-player rank cards
  // out to phones (server emits state:rankReveal on receiving
  // host:podiumDone). This deliberately does NOT play any audio, does NOT
  // burst confetti, and does NOT auto-fire host:podiumDone.
  function renderFinalAnnouncement(f) {
    // Skip the "pre-reveal" overlay state entirely — no intro hold.
    document.body.classList.add('host-announcement-final');
    var finalView = document.querySelector('.final-view');
    if (finalView) finalView.classList.remove('pre-reveal');
    var intro = document.getElementById('resultsIntro');
    if (intro) { intro.classList.remove('show'); intro.classList.add('hide'); }
    var congratsEl = document.getElementById('finalCongrats');
    if (congratsEl) {
      congratsEl.classList.remove('visible');
      congratsEl.hidden = true;
    }

    // Build podium DOM in its final-revealed state. We reuse podiumCell()
    // (which already returns the final HTML) and then add the `revealed`
    // class so any CSS that only paints in the revealed state lights up
    // without needing the per-tier animation timeline.
    var groups = (f && f.podiumGroups) || [];
    if (groups.length === 0 && f && f.podium && f.podium.length) {
      groups = f.podium.map(function (e) {
        return { rank: e.rank, score: e.score, players: [{ id: e.id, name: e.name }] };
      });
    }
    var g1 = groups[0];
    var g2 = groups[1];
    var g3 = groups[2];
    podium.innerHTML =
      podiumCell('place-2', '🥈', g2) +
      podiumCell('place-1', '🥇', g1) +
      podiumCell('place-3', '🥉', g3);
    // Mark every populated step as `visible revealed` so it appears in
    // its final state without the suspense overlay or the slide-in.
    Array.from(podium.querySelectorAll('.podium-step')).forEach(function (el) {
      if (el.classList.contains('empty-slot')) return;
      el.classList.add('visible', 'revealed');
      // Also flag the inner name(s) as revealed so any name-level CSS
      // transition paints them in the final state.
      var nameEls = el.querySelectorAll('.names-list .name');
      nameEls.forEach(function (n) { n.classList.add('revealed'); });
    });

    // Full leaderboard: render and mark visible immediately.
    fullLb.innerHTML =
      '<h3 class="serif" style="margin-top:0;">Full scores</h3>' +
      (f.fullLeaderboard || []).map(function (e) {
        return (
          '<div class="lb-row">' +
            '<div class="rank">' + e.rank + '</div>' +
            '<div class="name">' + escapeHtml(e.name) + '</div>' +
            '<div class="score">' + e.score + '</div>' +
          '</div>'
        );
      }).join('');
    fullLb.classList.add('visible');

    // Show the operator's reveal-to-phones button. Reset its disabled
    // state in case this is a re-render (e.g. host refresh after FINAL).
    if (revealToPhonesRow) revealToPhonesRow.hidden = false;
    if (revealToPhonesBtn) {
      // If the server has already received host:podiumDone (e.g. a previous
      // host tab already clicked the button before this one refreshed),
      // f.podiumRevealed will be true. Disable the button + relabel so the
      // operator doesn't try to fire it again. The server is idempotent
      // (it ignores duplicate signals) but the UX is clearer this way.
      if (f && f.podiumRevealed) {
        revealToPhonesBtn.disabled = true;
        revealToPhonesBtn.textContent = '✓ Results revealed to phones';
      } else {
        revealToPhonesBtn.disabled = false;
        revealToPhonesBtn.removeAttribute('aria-busy');
        revealToPhonesBtn.textContent = 'Reveal results to phones →';
      }
    }
  }

  function runPodiumReveal(f) {
    // `podiumGroups` buckets players by DISTINCT rank (up to 3 groups),
    // so a tied group at any spot is rendered together in a single card
    // with a TIE pill. If a rank is empty (e.g. 5 tied for 1st means no
    // rank-2 group exists), we render an invisible placeholder card to
    // keep the gold card centered in the 3-column grid.
    var groups = (f && f.podiumGroups) || [];
    // Fallback to legacy `podium` array shape if server didn't send
    // groups (shouldn't happen post-rollout, but keeps host robust).
    if (groups.length === 0 && f && f.podium && f.podium.length) {
      groups = f.podium.map(function (e) {
        return { rank: e.rank, score: e.score, players: [{ id: e.id, name: e.name }] };
      });
    }
    var g1 = groups[0]; // rank 1 (winner group)
    var g2 = groups[1]; // rank 2 (may be undefined if rank 1 is a big tie)
    var g3 = groups[2]; // rank 3 (may be undefined)

    // DOM order: 2nd, 1st, 3rd (so 1st is centered visually in the grid).
    podium.innerHTML =
      podiumCell('place-2', '🥈', g2) +
      podiumCell('place-1', '🥇', g1) +
      podiumCell('place-3', '🥉', g3);

    // Render the full leaderboard but keep it hidden until after the
    // winner has been announced — otherwise the rest of the standings
    // spoil the podium reveal.
    fullLb.innerHTML =
      '<h3 class="serif" style="margin-top:0;">Full scores</h3>' +
      (f.fullLeaderboard || []).map(function (e) {
        return (
          '<div class="lb-row">' +
            '<div class="rank">' + e.rank + '</div>' +
            '<div class="name">' + escapeHtml(e.name) + '</div>' +
            '<div class="score">' + e.score + '</div>' +
          '</div>'
        );
      }).join('');
    fullLb.classList.remove('visible');

    var steps = podium.querySelectorAll('.podium-step');
    // steps[0] = 2nd slot, steps[1] = 1st slot, steps[2] = 3rd slot.
    // Build reveal queue bottom-up by rank, skipping any rank group
    // that doesn't exist (so a giant rank-1 tie just reveals one card).
    var revealQueue = [];
    function suspenseLabel(tier, tied) {
      if (tier === 3) return tied ? 'Tied for third are…' : 'Third place is…';
      if (tier === 2) return tied ? 'Tied for second are…' : 'Second place is…';
      return tied ? 'And tied for the win are…' : 'And the winner is…';
    }
    if (g3) revealQueue.push({ el: steps[2], group: g3, tier: 3, label: suspenseLabel(3, g3.players.length > 1), isWinner: false });
    if (g2) revealQueue.push({ el: steps[0], group: g2, tier: 2, label: suspenseLabel(2, g2.players.length > 1), isWinner: false });
    if (g1) revealQueue.push({ el: steps[1], group: g1, tier: 1, label: suspenseLabel(1, g1.players.length > 1), isWinner: true  });

    // Pre-set each podium step to its "suspense" state: visible card with
    // medal + dots, name(s) and score hidden behind a label. Final names
    // and score are stashed in dataset attrs so the reveal step can
    // restore them.
    revealQueue.forEach(function (slot) {
      if (!slot.el) return;
      slot.el.classList.add('suspense');
      var namesList = slot.el.querySelector('.names-list');
      var scoreEl = slot.el.querySelector('.score');
      if (namesList) {
        namesList.dataset.finalHtml = namesList.innerHTML;
        namesList.innerHTML =
          '<span class="suspense-label">' + slot.label + '</span>' +
          '<span class="suspense-dots"><span></span><span></span><span></span></span>';
      }
      if (scoreEl) {
        scoreEl.dataset.finalScore = (slot.group && slot.group.score) || 0;
        scoreEl.textContent = '';
      }
    });

    var cursor = 400;
    revealQueue.forEach(function (slot, i) {
      if (!slot.el || !slot.group) return;

      // 1. Card slides in + drumroll begins. Winner's drumroll runs longer
      //    so it covers the score climb + tension hold without a silent
      //    gap — but capped just under 4s so the mp3's cymbal crash near
      //    its tail doesn't fire mid-reveal.
      var rollDur = SUSPENSE_MS / 1000;
      setTimeout(function () {
        slot.el.classList.add('visible');
        var stopRoll = playDrumroll(rollDur);
        // After suspense ends, reveal name(s) + score together for every
        // spot (winner included). Names in a tied group pop in sequentially
        // with a ~150ms beat so it reads as celebration rather than
        // dropping a list on screen.
        setTimeout(function () {
          var namesList = slot.el.querySelector('.names-list');
          var scoreEl = slot.el.querySelector('.score');
          var finalScore = scoreEl ? parseInt(scoreEl.dataset.finalScore || '0', 10) : 0;

          if (typeof stopRoll === 'function') stopRoll();
          if (namesList) {
            namesList.innerHTML = namesList.dataset.finalHtml || '';
            var nameEls = namesList.querySelectorAll('.name');
            nameEls.forEach(function (n, idx) {
              n.style.animationDelay = (idx * 0.15) + 's';
              n.classList.add('revealed');
            });
          }
          slot.el.classList.remove('suspense');
          slot.el.classList.add('revealed');
          playCheerChord(slot.tier);
          if (scoreEl) animateScoreCount(scoreEl, finalScore, SCORE_ROLL_MS);

          if (slot.isWinner) {
            confettiBurst();
            playApplause(4);
            // Drop the big "🎉 Congratulations! 🎉" banner only now — having
            // it sit at the top during the suspense reveal would spoil the
            // climax. It bounces in just as the winner lands, riding the
            // same confetti/applause moment.
            var congrats = document.getElementById('finalCongrats');
            if (congrats) {
              setTimeout(function () { congrats.classList.add('visible'); }, 250);
            }
            // Now the full standings can come up — they no longer spoil
            // anything since the winner is revealed.
            setTimeout(function () { fullLb.classList.add('visible'); }, 1100);
            // Signal the server that the podium reveal is fully done.
            // The server will broadcast `state:rankReveal` to every
            // player phone so they all flip from "Thanks for playing"
            // to their personal rank card in unison. We wait ~800ms
            // after the full leaderboard fades in so the room has a
            // beat to admire the winner before phones start buzzing.
            // Server-side guard ignores duplicate signals if the host
            // page is refreshed and runs the reveal again.
            setTimeout(function () {
              socket.emit('host:podiumDone');
            }, 1100 + 800);
          }
        }, SUSPENSE_MS);
      }, cursor);

      cursor += SUSPENSE_MS + REVEAL_HOLD_MS;
    });
  }

  // Counts up an integer in `el` from 0 to `to` over `durationMs`. Suffixed
  // with " pts" to match the static format used elsewhere on the podium.
  // Uses an ease-out so the climb feels alive, then settles.
  function animateScoreCount(el, to, durationMs) {
    var start = performance.now();
    function step(now) {
      var t = Math.min(1, (now - start) / durationMs);
      // Ease-out cubic for a satisfying decel.
      var eased = 1 - Math.pow(1 - t, 3);
      var v = Math.round(eased * to);
      el.textContent = v + ' pts';
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function podiumCell(klass, medal, group) {
    // Empty slot when this rank tier has no group (e.g. 5 tied for 1st
    // means no rank-2 group exists). Render an invisible placeholder so
    // the visible card stays in its grid column — keeps the gold card
    // centered in the 3-column layout.
    if (!group) {
      return '<div class="podium-step ' + klass + ' empty-slot"></div>';
    }
    var tied = group.players.length > 1;
    // Per-surface visible-name cap: podium cards are vertically constrained
    // and need to stay visually balanced across the three columns, so we
    // show fewer names than the Top 5 panel and surface the rest as a
    // single "…and N more" line.
    var VISIBLE_MAX = 2;
    var visible = group.players.slice(0, VISIBLE_MAX);
    var overflow = group.players.length - visible.length;
    var namesHtml =
      '<div class="names-list">' +
        visible.map(function (p) {
          return '<div class="name">' + escapeHtml(p.name) + '</div>';
        }).join('') +
        (overflow > 0
          ? '<div class="more-count">…and ' + overflow + ' more</div>'
          : '') +
      '</div>';
    var pillHtml = tied ? '<div class="tie-pill">TIE</div>' : '';
    return (
      '<div class="podium-step ' + klass + (tied ? ' tied' : '') + '">' +
        pillHtml +
        '<div class="medal">' + medal + '</div>' +
        namesHtml +
        '<div class="score">' + group.score + ' pts</div>' +
      '</div>'
    );
  }

  function confettiBurst() {
    const colors = ['#C77088', '#4F6B54', '#C9A96E', '#E8A5B5', '#9CB79A', '#7A9A9E'];
    for (let i = 0; i < 120; i++) {
      const el = document.createElement('div');
      el.className = 'confetti';
      el.style.left = Math.random() * 100 + 'vw';
      el.style.background = colors[i % colors.length];
      el.style.animationDuration = 2.5 + Math.random() * 2 + 's';
      el.style.animationDelay = Math.random() * 0.8 + 's';
      el.style.transform = 'rotate(' + (Math.random() * 360) + 'deg)';
      document.body.appendChild(el);
      setTimeout(function () { el.remove(); }, 6000);
    }
  }

  // ---------------- Util ----------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------------- Socket wiring ----------------
  socket.on('state:lobby', function (s) {
    // `state:lobby` is a roster-update broadcast that fires in EVERY phase
    // (guest join/reconnect), not just in the lobby. Only apply the
    // lobby-only UI side effects (hide Export button, re-enable the
    // announcement toggle, hydrate announcement mode) when we're actually
    // in the lobby — otherwise a guest refreshing their phone during the
    // FINAL results screen would wrongly hide the Export button.
    renderLobby(s);
    answersTotal.textContent = s.total;
    if (currentPhase !== 'LOBBY') return;
    showExportBtn(false);
    // LOBBY is the only phase in which the announcement-mode toggle is
    // mutable; re-enable it on every LOBBY broadcast so a reset/refresh
    // restores interactivity.
    setAnnouncementToggleEnabled(true);
    if (typeof s.announcementMode === 'boolean' && s.announcementMode !== announcementMode) {
      announcementMode = s.announcementMode;
      updateAnnouncementUI();
    }
  });
  socket.on('state:question', function (q) {
    currentPhase = 'QUESTION';
    showExportBtn(false);
    setAnnouncementToggleEnabled(false);
    renderQuestion(q);
  });
  socket.on('state:reveal', function (r) {
    currentPhase = 'REVEAL';
    showExportBtn(false);
    setAnnouncementToggleEnabled(false);
    // Play a brief "sting" between QUESTION and REVEAL — matches Kahoot's
    // beat where you hear "Time's up!" (timeout) or "Let's see the
    // answers!" (everyone answered early). On host refresh the server
    // sends endReason='replay' so we skip the sting entirely.
    var reason = r && r.endReason;
    // Stop the local countdown immediately — otherwise if the question
    // ended early (last player answered with a few seconds to spare), the
    // tick interval keeps firing in the background and you hear the
    // urgent-second beeps and "time's up" alarm under the sting.
    stopQTimer();
    if (reason === 'timeout' || reason === 'all-answered') {
      // Clear the underlying view FIRST so the sting fades in over a
      // clean app background — otherwise you briefly see the question
      // view sitting behind the overlay during the fade-in.
      Object.keys(views).forEach(function (k) {
        views[k].classList.remove('active', 'fading-out');
      });
      // Small beat on blank, then the sting.
      setTimeout(function () { playSting(reason); }, 120);
      // Reveal renders after the sting fades out + a short blank breath.
      // The sting is purely visual, so sfxReveal inside renderReveal()
      // is the single "ding" cue for the transition.
      setTimeout(function () { renderReveal(r); }, 120 + STING_VISIBLE_MS + 350);
    } else {
      renderReveal(r);
    }
  });
  socket.on('state:final', function (f) {
    currentPhase = 'FINAL';
    showExportBtn(true);
    setAnnouncementToggleEnabled(false);
    renderFinal(f);
  });
  socket.on('state:intro', function (i) {
    currentPhase = 'INTRO';
    showExportBtn(false);
    setAnnouncementToggleEnabled(false);
    renderIntro(i);
  });
  socket.on('state:prompt', function (p) {
    currentPhase = 'PROMPT';
    showExportBtn(false);
    setAnnouncementToggleEnabled(false);
    renderPrompt(p);
  });

  // ---------------- Floating reactions from players ----------------
  // Players tap an emoji on their phone -> server -> we spawn a floating
  // emoji that drifts up the screen and fades out. Cap 10 concurrent so the
  // host page stays uncluttered even with 100+ active guests.
  const REACTION_EMOJIS = ['😂', '🔥', '👀', '🎉', '😱', '👑'];
  const REACTION_MAX_ON_SCREEN = 10;
  const reactionLayer = document.getElementById('reactionLayer');
  function spawnReaction(index) {
    if (!reactionLayer) return;
    const emoji = REACTION_EMOJIS[index];
    if (!emoji) return;
    // Drop the oldest if we're at the cap.
    while (reactionLayer.children.length >= REACTION_MAX_ON_SCREEN) {
      reactionLayer.removeChild(reactionLayer.firstChild);
    }
    const el = document.createElement('div');
    el.className = 'reaction-emoji';
    el.textContent = emoji;
    // Random horizontal position (5%..95% of viewport width).
    el.style.left = (5 + Math.random() * 90) + '%';
    // Slight size + duration variation so they don't move in lockstep.
    const scale = 0.85 + Math.random() * 0.5;
    el.style.fontSize = (44 * scale) + 'px';
    el.style.animationDuration = (3.0 + Math.random() * 1.2) + 's';
    el.addEventListener('animationend', function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    reactionLayer.appendChild(el);
  }
  socket.on('host:reaction', function (payload) {
    if (!payload || typeof payload.index !== 'number') return;
    spawnReaction(payload.index);
  });

  socket.on('state:reset', function () {
    // Re-enter lobby in place; do NOT reload (would exit fullscreen).
    socket.emit('host:auth', {}, function (res) {
      if (res && res.ok) {
        // Reset cached question state so next round starts cleanly.
        currentQ = null;
        stopQTimer();
        stopIntroTimer();
        document.body.classList.remove('host-prompt-only');
        reactionsMuted = !!res.reactionsMuted;
        updateMuteReactionsBtn();
        announcementMode = !!res.announcementMode;
        updateAnnouncementUI();
        setAnnouncementToggleEnabled(true);
        enterLobby(res);
      }
    });
  });
  socket.on('host:answerCount', function (c) {
    answersReceived.textContent = c.answered;
    answersTotal.textContent = c.total;
  });
})();
