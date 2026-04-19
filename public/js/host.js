(function () {
  'use strict';

  const socket = io({ transports: ['polling', 'websocket'] });

  // ---------------- Element refs ----------------
  const views = {
    lobby: document.getElementById('view-lobby'),
    question: document.getElementById('view-question'),
    reveal: document.getElementById('view-reveal'),
    final: document.getElementById('view-final'),
  };
  function show(name) {
    Object.keys(views).forEach(function (k) { views[k].classList.toggle('active', k === name); });
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
  const resetBtn = document.getElementById('resetBtn');

  const sfxLobby = document.getElementById('sfx-lobby');
  const sfxTick = document.getElementById('sfx-tick');
  const sfxReveal = document.getElementById('sfx-reveal');
  const sfxPodium = document.getElementById('sfx-podium');

  // Master sound toggle. Controls every sound effect on the host page
  // (tick beeps, cheer chords, applause). Default ON.
  let soundOn = true;
  function updateMusicBtnLabel() {
    musicBtn.textContent = soundOn ? '🔊 Sound: On' : '🔇 Sound: Off';
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
  function safePlay(a) { try { a.currentTime = 0; a.play().catch(function(){}); } catch(e){} }

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
  fullscreenBtn.addEventListener('click', function () {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(function(){});
    } else {
      document.exitFullscreen();
    }
  });
  document.addEventListener('fullscreenchange', function () {
    fullscreenBtn.textContent = document.fullscreenElement ? '⛶ Exit' : '⛶ Fullscreen';
  });

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

  // ---------------- Auto-enter on load ----------------
  socket.on('connect', function () {
    socket.emit('host:auth', {}, function (res) {
      if (!res || !res.ok) return;
      // Always prep totals so reveal/final views show correct counts.
      qTotal.textContent = res.questionsTotal;
      rTotal.textContent = res.questionsTotal;
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
  function renderLobby(s) {
    const players = s.players || [];
    playerCount.textContent = players.length;
    playerList.innerHTML = players.map(function (p) {
      const cls = 'player-chip' + (p.connected ? '' : ' disconnected');
      return '<div class="' + cls + '" data-pid="' + p.id + '" title="Click to remove">' + escapeHtml(p.name) + '</div>';
    }).join('');
    startBtn.disabled = players.length === 0;
  }

  playerList.addEventListener('click', function (e) {
    const chip = e.target.closest('.player-chip');
    if (!chip) return;
    const pid = chip.dataset.pid;
    const name = chip.textContent;
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
      // Bright "let's begin!" fanfare as the first question loads.
      playStartFanfare();
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
    if (!soundOn) return;
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
    if (!soundOn) return;
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
    if (!soundOn) return;
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

  // Game-show "let's begin" stinger: 3-note rising fanfare (C5 -> E5 -> G5)
  // played in quick succession when the host starts the game.
  function playStartFanfare() {
    if (!soundOn) return;
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

  function renderQuestion(q) {
    currentQ = q;
    lastTickSec = null;
    show('question');
    qIndex.textContent = q.index + 1;
    qTotal.textContent = q.total;
    qPrompt.textContent = q.prompt;
    if (q.image) { qImage.src = q.image; qImage.style.display = 'block'; }
    else { qImage.style.display = 'none'; qImage.removeAttribute('src'); }

    answerGrid.innerHTML = q.choices.map(function (c, i) {
      return (
        '<div class="answer-card tile-color-' + i + '" data-idx="' + i + '">' +
          '<div class="shape">' + shapeHTML(i) + '</div>' +
          '<div class="text">' + escapeHtml(c) + '</div>' +
        '</div>'
      );
    }).join('');

    answersReceived.textContent = '0';
    // answersTotal is updated via host:answerCount event

    startQTimer(q);
  }

  function startQTimer(q) {
    stopQTimer();
    if (typeof q.serverNow === 'number') clockOffset = q.serverNow - Date.now();
    const update = function () {
      const msLeft = Math.max(0, q.endsAt - serverNow());
      const secLeft = Math.ceil(msLeft / 1000);
      const pct = Math.max(0, (msLeft / (q.timeLimitSec * 1000)) * 100);
      timerText.textContent = String(secLeft);
      timerRing.style.setProperty('--pct', pct.toFixed(1));
      // Mirror the player's urgent cue on the host: when <=5s remain, turn
      // the timer pink and pulse it so the room feels the pressure too.
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
      if (msLeft <= 0) stopQTimer();
    };
    update();
    qTimer = setInterval(update, 100);
  }
  function stopQTimer() {
    if (qTimer) { clearInterval(qTimer); qTimer = null; }
    if (timerRing) timerRing.classList.remove('urgent');
  }

  // ---------------- Reveal ----------------
  function renderReveal(r) {
    stopQTimer();
    show('reveal');
    if (soundOn) safePlay(sfxReveal);

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
      return (
        '<div class="bar-row ' + (isCorrect ? 'correct' : '') + '">' +
          '<div class="shape" style="color: var(' + colorVar + ')">' + shapeHTML(i) + '</div>' +
          '<div class="choice-text">' + escapeHtml(choiceText) + '</div>' +
          '<div class="bar"><div class="bar-fill" style="width:' + pct.toFixed(1) + '%; background: var(' + colorVar + ')"></div></div>' +
          '<div class="count">' + count + '</div>' +
        '</div>'
      );
    }).join('');

    leaderboard.innerHTML = r.leaderboardTop5.map(function (e) {
      return (
        '<div class="lb-row">' +
          '<div class="rank">' + e.rank + '</div>' +
          '<div class="name">' + escapeHtml(e.name) + '</div>' +
          '<div class="score">' + e.score + '</div>' +
        '</div>'
      );
    }).join('');

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
  function renderFinal(f) {
    show('final');

    // Podium: render 2nd, 1st, 3rd in that column order, reveal in 3-2-1
    const p = f.podium;
    const p1 = p[0], p2 = p[1], p3 = p[2];
    podium.innerHTML =
      podiumCell('place-2', '🥈', p2) +
      podiumCell('place-1', '🥇', p1) +
      podiumCell('place-3', '🥉', p3);

    const steps = podium.querySelectorAll('.podium-step');
    // Reveal order: 3rd (index 2 in DOM), 2nd (index 0), 1st (index 1)
    const order = [steps[2], steps[0], steps[1]];
    const tiers = [3, 2, 1]; // matches reveal order
    let delay = 400;
    order.forEach(function (el, i) {
      if (!el) return;
      setTimeout(function () {
        el.classList.add('visible');
        // Triumphant chord on each placement reveal — gets bigger each time.
        playCheerChord(tiers[i]);
        if (i === 2) {
          // 1st place — big celebration: confetti + crowd applause.
          confettiBurst();
          playApplause(4);
        }
      }, delay + i * 900);
    });

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
  }

  function podiumCell(klass, medal, entry) {
    if (!entry) {
      return '<div class="podium-step ' + klass + '"></div>';
    }
    return (
      '<div class="podium-step ' + klass + '">' +
        '<div class="medal">' + medal + '</div>' +
        '<div class="name">' + escapeHtml(entry.name) + '</div>' +
        '<div class="score">' + entry.score + ' pts</div>' +
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
    renderLobby(s);
    answersTotal.textContent = s.total;
  });
  socket.on('state:question', renderQuestion);
  socket.on('state:reveal', renderReveal);
  socket.on('state:final', renderFinal);

  // ---------------- Floating reactions from players ----------------
  // Players tap an emoji on their phone -> server -> we spawn a floating
  // emoji that drifts up the screen and fades out. Cap 30 concurrent so the
  // host page never gets overwhelmed even with 150 active guests.
  const REACTION_EMOJIS = ['😂', '🔥', '👀', '🎉', '😱', '👑'];
  const REACTION_MAX_ON_SCREEN = 30;
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
        enterLobby(res);
      }
    });
  });
  socket.on('host:answerCount', function (c) {
    answersReceived.textContent = c.answered;
    answersTotal.textContent = c.total;
  });
})();
