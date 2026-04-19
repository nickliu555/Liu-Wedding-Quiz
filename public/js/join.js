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
  socket.on('connect', function () {
    socketReady = true;
    errorMsg.textContent = '';
  });
  socket.on('connect_error', function (err) {
    errorMsg.textContent = 'Connection error: ' + (err && err.message ? err.message : err);
  });
  socket.on('disconnect', function () {
    socketReady = false;
  });

  function showError(msg) {
    errorMsg.textContent = msg;
    submitBtn.disabled = false;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorMsg.textContent = '';
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
