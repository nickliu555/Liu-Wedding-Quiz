(function () {
  'use strict';

  function uuid() {
    // RFC4122-ish v4 — good enough for identifying a phone across refreshes
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  const form = document.getElementById('joinForm');
  const nameInput = document.getElementById('nameInput');
  const errorMsg = document.getElementById('errorMsg');
  const submitBtn = form.querySelector('button[type="submit"]');
  const closedNotice = document.getElementById('closedNotice');

  // If we already have a playerId, go straight to /play
  const existing = localStorage.getItem('quiz.playerId');
  if (existing) {
    window.location.replace('/play');
    return;
  }

  // Pre-fill the name field if the host just reset the game and the
  // player previously had a name (set by player.js before redirecting).
  const rejoinName = localStorage.getItem('quiz.rejoinName');
  if (rejoinName) {
    nameInput.value = rejoinName;
    localStorage.removeItem('quiz.rejoinName');
  }

  const socket = io({ transports: ['polling', 'websocket'] });

  let socketReady = false;
  // Tracks the last known lobby-open state from the server. Starts true
  // (optimistic) so the form renders normally pre-probe; the probe ack
  // on connect (or any state:lobby broadcast) corrects it within a
  // round-trip. Set to false by setLobbyOpen() when host:start fires.
  let lobbyOpen = true;

  // Toggle between the interactive name form and the "quiz already
  // started" notice. Called from the lobby:status probe ack and from
  // any state:lobby broadcast (which the server emits on host:start
  // and host:reset). Idempotent — safe to call repeatedly with the
  // same value.
  function setLobbyOpen(open) {
    lobbyOpen = !!open;
    if (lobbyOpen) {
      document.body.classList.remove('lobby-closed');
      if (closedNotice) closedNotice.hidden = true;
      submitBtn.disabled = false;
    } else {
      document.body.classList.add('lobby-closed');
      if (closedNotice) closedNotice.hidden = false;
      submitBtn.disabled = true;
      // Clear any in-flight "could not join" error — the notice replaces it.
      errorMsg.textContent = '';
    }
  }

  socket.on('connect', function () {
    socketReady = true;
    errorMsg.textContent = '';
    // Probe current lobby state so a guest arriving mid-quiz sees the
    // blocked notice immediately instead of typing a name and getting
    // a `lobby-closed` error back. The server handler is in
    // server/index.js (search for `lobby:status`).
    socket.emit('lobby:status', null, function (res) {
      if (!res) return;
      setLobbyOpen(!!res.open);
    });
  });
  socket.on('connect_error', function (err) {
    errorMsg.textContent = 'Connection error: ' + (err && err.message ? err.message : err);
  });
  socket.on('disconnect', function () {
    socketReady = false;
  });

  // Live updates: server broadcasts state:lobby on host:start AND
  // host:reset (see server/index.js), so this listener handles both
  // directions: lobby opens -> form re-enabled; lobby closes -> notice.
  socket.on('state:lobby', function (st) {
    if (st && typeof st.phase === 'string') {
      setLobbyOpen(st.phase === 'LOBBY');
    }
  });

  function showError(msg) {
    errorMsg.textContent = msg;
    submitBtn.disabled = false;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorMsg.textContent = '';
    // Defensive: even though the button is disabled when lobby is closed,
    // a keyboard submit could still fire. Server stays the source of
    // truth, but skipping the emit avoids a pointless round-trip.
    if (!lobbyOpen) return;
    const name = nameInput.value.trim();
    if (!name) return showError('Please enter a name.');

    if (!socketReady) {
      return showError('Not connected to server yet — please wait a moment and try again.');
    }

    submitBtn.disabled = true;
    const pid = uuid();

    let acked = false;
    const timeout = setTimeout(function () {
      if (acked) return;
      showError('Server did not respond. Check your WiFi and try again.');
    }, 5000);

    socket.emit('player:join', { playerId: pid, name: name }, function (res) {
      acked = true;
      clearTimeout(timeout);
      if (!res || !res.ok) {
        const reason = res && res.reason;
        const friendly = {
          'lobby-closed': 'The quiz has already started — sorry, you cannot join now.',
          'name-blocked': 'Please choose a different name.',
          'name-too-short': 'Please enter a valid name.',
          'bad-player-id': 'Something went wrong. Please reload the page.',
        }[reason] || 'Could not join. Please try again.';
        return showError(friendly);
      }
      localStorage.setItem('quiz.playerId', pid);
      localStorage.setItem('quiz.playerName', res.player.name);
      window.location.replace('/play');
    });
  });
})();
