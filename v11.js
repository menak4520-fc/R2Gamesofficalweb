/* R2 GAMES V11 CLIENT BRIDGE
 * Keeps the existing UI and game code, but moves multiplayer lifecycle to the
 * authoritative V11 server. This file is intentionally a bridge: it does not
 * redesign the site and it does not replace the existing game screens.
 */
(function () {
  'use strict';

  const PLAYER_KEY = 'r2_v11_player';
  const ROOM_KEY = 'r2_v11_room';
  const ID_RE = /^\d{16}$/;
  const GAMES = ['auction', 'five', 'deal', 'blind', 'guess', 'hidden'];
  const LABELS = {
    auction: '🔨 المزاد برو ماكس',
    five: '⚽ الملعب الخماسي',
    deal: '💼 DEAL OR NO DEAL',
    blind: '🙈 المزاد الأعمى',
    guess: '🕵️ تخمين اللاعب',
    hidden: '🕶️ اللاعب الخفي'
  };
  const GAME_SECTIONS = {
    auction: 'auction-game',
    five: 'five-game',
    deal: 'deal-game',
    blind: 'blind-game',
    guess: 'guess-game',
    hidden: 'hidden-game'
  };

  let player = readPlayer();
  let socket = null;
  let connected = false;
  let room = null;
  let onlineGuess = false;
  let guessState = null;

  function readPlayer() {
    try {
      const old = JSON.parse(localStorage.getItem(PLAYER_KEY) || 'null');
      if (old && ID_RE.test(old.id)) return old;
    } catch (_) {}
    try {
      const old = JSON.parse(localStorage.getItem('r2_v10_player') || 'null');
      if (old && ID_RE.test(old.id)) {
        localStorage.setItem(PLAYER_KEY, JSON.stringify(old));
        return old;
      }
    } catch (_) {}
    const id = Array.from({ length: 16 }, () => Math.floor(Math.random() * 10)).join('');
    return { id, name: 'لاعب R2' };
  }

  function savePlayer() {
    localStorage.setItem(PLAYER_KEY, JSON.stringify(player));
    localStorage.setItem('r2_v10_player', JSON.stringify(player));
  }
  savePlayer();

  function setStatus(text) {
    const el = document.getElementById('room-status');
    if (el) el.textContent = text;
  }

  function setRoom(roomData) {
    room = roomData ? { ...roomData } : null;
    if (room) localStorage.setItem(ROOM_KEY, JSON.stringify(room));
    else localStorage.removeItem(ROOM_KEY);
  }

  function readyCount() {
    return room?.readyCount ?? (room?.players || []).filter(p => p.ready).length;
  }

  function insertPlayNowButton(show) {
    let button = document.getElementById('r2-server-play-now');
    if (!button && show) {
      button = document.createElement('button');
      button.id = 'r2-server-play-now';
      button.className = 'btn';
      button.type = 'button';
      button.textContent = '🎮 العب الآن';
      button.style.cssText = 'width:100%;margin-top:10px;font-size:1.05rem;';
      button.onclick = playNow;
      const status = document.getElementById('room-status');
      if (status && status.parentNode) status.parentNode.insertBefore(button, status.nextSibling);
    }
    if (button) {
      button.style.display = show ? 'block' : 'none';
      button.disabled = !!room?.players?.find(p => p.id === player.id && p.ready);
      if (button.disabled) button.textContent = '⏳ جاهز — في انتظار اللاعب الآخر';
      else button.textContent = '🎮 العب الآن';
    }
  }

  function ensureProfileCard() {
    const modal = document.getElementById('settingsModal');
    if (!modal || document.getElementById('r2-profile-id-card')) return;
    const content = modal.querySelector('.modal-content') || modal;
    const card = document.createElement('div');
    card.id = 'r2-profile-id-card';
    card.className = 'r2-card';
    card.style.cssText = 'margin-top:12px;text-align:center;';
    card.innerHTML = '<h3 style="margin-bottom:8px">👤 بروفايل R2</h3>' +
      '<div style="font-size:.85rem;margin-bottom:5px">R2 PLAYER ID — ثابت لحسابك</div>' +
      '<div id="r2-player-id" style="font-size:1.35rem;letter-spacing:2px;font-weight:bold;user-select:text">' + player.id + '</div>' +
      '<input id="r2-profile-name" class="r2-input" maxlength="40" style="margin-top:8px" value="' + escapeHtml(player.name || '') + '" placeholder="اسم اللاعب">' +
      '<button id="r2-save-profile" class="btn btn-secondary" style="width:100%;margin-top:8px">💾 حفظ البروفايل</button>';
    const close = content.querySelector('button');
    content.insertBefore(card, close || content.lastElementChild);
    document.getElementById('r2-save-profile').onclick = saveProfile;
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function saveProfile() {
    const input = document.getElementById('r2-profile-name');
    if (input) player.name = String(input.value || '').trim().slice(0, 40) || 'لاعب R2';
    savePlayer();
    if (socket?.connected) {
      socket.emit('player:sync', { playerId: player.id, name: player.name }, result => {
        if (result?.player) applyServerPlayer(result.player);
      });
    } else {
      try {
        const response = await fetch('/api/player/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerId: player.id, name: player.name })
        });
        const result = await response.json();
        if (result.player) applyServerPlayer(result.player);
      } catch (_) {}
    }
    alert('تم حفظ البروفايل. ID الخاص بك: ' + player.id);
  }

  function applyServerPlayer(data) {
    if (!data) return;
    player = { ...player, ...data };
    savePlayer();
    if (window.R2?.state) {
      if (data.xb != null) window.R2.state.xb = data.xb;
      if (data.points != null) window.R2.state.points = data.points;
      if (data.coins != null) window.R2.state.coins = data.coins;
      if (data.xp != null) window.R2.state.xp = data.xp;
      if (data.level != null) window.R2.state.level = data.level;
      try { window.R2.render(); } catch (_) {}
    }
  }

  function connectSocket() {
    if (!window.io) return setTimeout(connectSocket, 250);
    if (socket) return;
    socket = window.io({ transports: ['websocket', 'polling'] });
    socket.on('connect_error', () => setStatus('🔄 تعذر الاتصال اللحظي — إعادة المحاولة تلقائيًا...'));
    socket.on('reconnect_attempt', () => setStatus('🔄 إعادة الاتصال بالسيرفر...'));
    socket.on('connect', () => {
      connected = true;
      socket.emit('identify', { playerId: player.id, name: player.name }, result => {
        if (result?.player) applyServerPlayer(result.player);
      });
      if (room?.code) {
        socket.emit('room:state-request', { code: room.code }, result => {
          if (result?.ok) {
            setRoom(result.room);
            if (result.room.playerCount === 2) insertPlayNowButton(true);
          }
        });
      }
    });
    socket.on('disconnect', () => {
      connected = false;
      if (room?.state?.started || room?.started) setStatus('🔄 انقطع الاتصال مؤقتًا — جاري محاولة إعادة الاتصال...');
    });
    socket.on('connect_error', () => setStatus('🟠 تعذر الاتصال بالسيرفر، جاري إعادة المحاولة...'));

    socket.on('player:data', applyServerPlayer);
    socket.on('game:reward', payload => {
      if (payload?.playerId === player.id && payload.player) applyServerPlayer(payload.player);
    });

    socket.on('room:connected', data => {
      setRoom(data);
      const count = data.playerCount || data.players?.length || 0;
      if (count === 2) {
        insertPlayNowButton(true);
        setStatus('🟢 تم اتصال اللاعبين 2/2 — لازم الاتنين يدوسوا «العب الآن»');
      } else {
        insertPlayNowButton(false);
        setStatus('⏳ في انتظار اللاعب الثاني...');
      }
    });

    socket.on('room:players', data => {
      setRoom(data);
      if ((data.playerCount || data.players?.length) === 2) {
        insertPlayNowButton(true);
        setStatus('🟢 اللاعبان متصلان — اضغط «العب الآن»');
      }
    });

    socket.on('room:ready-state', data => {
      setRoom(data);
      insertPlayNowButton(true);
      setStatus('🎮 الجاهزون: ' + (data.readyCount || 0) + '/2');
    });

    socket.on('room:player-left', data => {
      if (room) room.players = room.players?.filter(p => p.id === player.id) || [];
      insertPlayNowButton(false);
      setStatus('🔴 خرج اللاعب الآخر — المتصلون: ' + (data?.players || 1) + '/2');
    });

    socket.on('quick:waiting', data => setStatus('⚡ QUICK MATCH: جاري البحث عن لاعب مناسب...'));
    socket.on('quick:expired', () => setStatus('⚠️ لم نجد لاعبًا في الوقت الحالي — جرّب QUICK MATCH مرة أخرى'));
    socket.on('quick:matched', data => {
      setRoom(data.room);
      insertPlayNowButton(true);
      setStatus('⚡ تم العثور على لاعب! الاتنين لازم يدوسوا «العب الآن»');
    });

    socket.on('game:start', startRealGame);
    socket.on('game:event', payload => {
      if (typeof window.R2OnlineEvent === 'function') window.R2OnlineEvent(payload);
      if (payload?.type === 'guess:answer') return;
    });
    socket.on('game:sync', payload => {
      if (typeof window.R2OnlineSync === 'function') window.R2OnlineSync(payload);
    });

    socket.on('guess:state', data => {
      onlineGuess = true;
      guessState = data;
      renderOnlineGuess(data);
    });
    socket.on('guess:result', data => renderGuessResult(data));
    socket.on('guess:finished', data => finishOnlineGuess(data));
  }

  function startRealGame(data) {
    setRoom(data.room);
    insertPlayNowButton(false);
    const game = data.game;
    const section = GAME_SECTIONS[game];
    if (section && typeof window.showSection === 'function') window.showSection(section);
    setStatus('🚀 بدأت المباراة فعليًا: ' + (LABELS[game] || game));
    if (game === 'guess') {
      onlineGuess = true;
      if (socket) socket.emit('guess:start', { code: data.room.code }, result => {
        if (result?.guess) renderOnlineGuess(result.guess);
      });
    } else {
      // Existing game functions remain responsible for drawing the UI.
      const starters = {
        auction: 'startAuctionSetup',
        five: 'startFiveGame',
        deal: 'startDealGame',
        blind: 'startBlindGame',
        hidden: 'startHiddenPlayerGame'
      };
      const fn = starters[game];
      if (fn && typeof window[fn] === 'function') {
        try { window[fn](); } catch (_) {}
      }
    }
  }

  function playNow() {
    if (!socket?.connected) return alert('السيرفر غير متصل حاليًا.');
    if (!room?.code) return alert('لا توجد غرفة متصلة.');
    socket.emit('room:play-now', { code: room.code }, result => {
      if (!result?.ok) return alert(result?.error || 'تعذر تسجيل جاهز');
      setRoom(result.room);
      insertPlayNowButton(true);
      if ((result.room.readyCount || 0) < 2) {
        setStatus('⏳ أنت جاهز 1/2 — في انتظار اللاعب الآخر');
      } else {
        setStatus('🚀 2/2 — بدء اللعبة...');
      }
    });
  }

  function createRoom() {
    if (!socket?.connected) return alert('جارٍ الاتصال بالسيرفر، حاول مرة أخرى.');
    const game = document.getElementById('room-game-select')?.value || 'auction';
    const password = document.getElementById('room-password-enabled')?.checked
      ? document.getElementById('room-password')?.value || '' : '';
    if (document.getElementById('room-password-enabled')?.checked && !password) {
      return alert('اكتب كلمة السر أو ألغِ الخيار.');
    }
    socket.emit('room:create', { game, password, playerId: player.id, name: player.name }, result => {
      if (!result?.ok) return alert(result?.error || 'تعذر إنشاء الغرفة');
      setRoom(result);
      const code = document.getElementById('generated-code');
      if (code) code.textContent = result.code;
      insertPlayNowButton(false);
      setStatus('🟢 الغرفة جاهزة — الكود: ' + result.code + ' — 8 حروف/أرقام');
    });
  }

  function joinRoom() {
    const code = String(document.getElementById('join-code-input')?.value || '').trim().toUpperCase();
    const password = document.getElementById('join-password-input')?.value || '';
    if (!/^[A-Z0-9]{8}$/.test(code)) return alert('كود الغرفة يجب أن يكون 8 حروف أو أرقام.');
    if (!socket?.connected) return alert('جارٍ الاتصال بالسيرفر، حاول مرة أخرى.');
    socket.emit('room:join', { code, password, playerId: player.id, name: player.name }, result => {
      if (!result?.ok) return alert(result?.error || 'تعذر الاتصال بالغرفة');
      setRoom(result);
      if (document.getElementById('room-game-select')) document.getElementById('room-game-select').value = result.game;
      if ((result.playerCount || result.players?.length) === 2) {
        insertPlayNowButton(true);
        setStatus('🟢 تم الاتصال 2/2 — لازم الاتنين يدوسوا «العب الآن»');
      }
    });
  }

  function quickMatch() {
    if (!socket?.connected) return alert('جارٍ الاتصال بالسيرفر، حاول مرة أخرى.');
    const game = document.getElementById('room-game-select')?.value || 'auction';
    socket.emit('quick:join', { game, playerId: player.id, name: player.name }, result => {
      if (!result?.ok) return alert(result?.error || 'تعذر تشغيل QUICK MATCH');
      if (result.matched) {
        setRoom(result.room);
        insertPlayNowButton(true);
        setStatus('⚡ تم إيجاد الخصم — اضغط «العب الآن»');
      } else {
        setStatus('⚡ QUICK MATCH: جاري البحث...');
      }
    });
  }

  function sendFriendRequest() {
    const input = document.getElementById('friend-id-input');
    const friendId = String(input?.value || '').trim();
    if (!ID_RE.test(friendId)) return alert('اكتب ID صحيح مكون من 16 رقم.');
    if (!socket?.connected) return alert('السيرفر غير متصل.');
    socket.emit('friends:add', { playerId: player.id, friendId }, result => {
      if (!result?.ok) return alert(result?.error || 'تعذر إرسال الطلب');
      if (input) input.value = '';
      alert('📩 تم إرسال طلب الصداقة إلى ' + friendId);
    });
  }

  function startOnlineGuess() {
    if (!socket?.connected || !room?.code) return false;
    onlineGuess = true;
    if (typeof window.showSection === 'function') window.showSection('guess-game');
    socket.emit('guess:start', { code: room.code }, result => {
      if (!result?.ok) return alert(result?.error || 'تعذر بدء تخمين اللاعب');
      renderOnlineGuess(result.guess);
    });
    return true;
  }

  function renderOnlineGuess(data) {
    if (!data) return;
    guessState = data;
    const round = document.getElementById('guess-round');
    const turn = document.getElementById('guess-turn');
    const clubs = document.getElementById('guess-clubs');
    const answer = document.getElementById('guess-answer');
    const result = document.getElementById('guess-result');
    if (round) round.textContent = 'الجولة ' + data.round + ' من 5';
    const mine = data.turnPlayerId === player.id;
    const name = room?.players?.find(p => p.id === data.turnPlayerId)?.name || 'اللاعب الآخر';
    if (turn) turn.innerHTML = mine ? '🎯 دورك الآن — اكتب اسم اللاعب' : '⏳ دور ' + escapeHtml(name) + ' — انتظر دورك';
    if (clubs) clubs.innerHTML = '🏟️ الأندية: <b>' + (data.clubs || []).map(escapeHtml).join(' ← ') + '</b>';
    if (answer) {
      answer.disabled = !mine;
      answer.value = '';
      answer.placeholder = mine ? 'اكتب اسم اللاعب بالعربي' : 'انتظر دورك';
    }
    if (result) result.textContent = '📊 النتيجة: ' + scoreText(data.score);
  }

  function scoreText(score) {
    const ids = room?.players?.map(p => p.id) || Object.keys(score || {});
    return ids.map(id => (room?.players?.find(p => p.id === id)?.name || id) + ': ' + (score?.[id] || 0)).join(' — ');
  }

  function submitOnlineGuess() {
    const input = document.getElementById('guess-answer');
    const answer = String(input?.value || '').trim();
    if (!answer) return alert('اكتب اسم اللاعب أولًا.');
    if (!guessState || guessState.turnPlayerId !== player.id) return alert('ليس دورك الآن.');
    socket.emit('guess:answer', { code: room.code, answer }, result => {
      if (!result?.ok) alert(result?.error || 'تعذر إرسال الإجابة');
    });
  }

  function renderGuessResult(data) {
    if (!onlineGuess || !data) return;
    const result = document.getElementById('guess-result');
    if (result) result.innerHTML = (data.correct ? '✅ إجابة صحيحة!' : '❌ إجابة خاطئة!') + ' اللاعب هو: <b>' + escapeHtml(data.answer) + '</b><br>📊 ' + scoreText(data.score);
  }

  function finishOnlineGuess(data) {
    onlineGuess = false;
    guessState = null;
    const result = document.getElementById('guess-result');
    const scores = room?.players || [];
    const a = data?.score?.[scores[0]?.id] || 0;
    const b = data?.score?.[scores[1]?.id] || 0;
    if (result) result.innerHTML = '🏁 انتهت 5 جولات!<br><b>' + a + ' - ' + b + '</b><br>' + (a === b ? '🤝 تعادل!' : a > b ? '🏆 فوز ' + escapeHtml(scores[0]?.name || '') : '🏆 فوز ' + escapeHtml(scores[1]?.name || ''));
  }

  async function initServerProfile() {
    try {
      const response = await fetch('/api/player/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: player.id, name: player.name })
      });
      const data = await response.json();
      if (data.player) applyServerPlayer(data.player);
    } catch (_) {}
  }



  // Server-backed tournaments: the existing modal/design stays untouched.
  const oldCreateTournament = window.R2?.createTournament;
  const oldJoinTournament = window.R2?.joinTournament;
  if (window.R2) {
    window.R2.createTournament = async function () {
      const name = String(document.getElementById('r2-tournament-name')?.value || '').trim();
      const size = Number(document.getElementById('r2-tournament-size')?.value || 16);
      const game = String(document.getElementById('r2-tournament-game')?.value || 'auction');
      if (!name) return alert('اكتب اسم البطولة أولاً');
      try {
        const response = await fetch('/api/tournaments', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, size, game, playerId: player.id, hostName: player.name })
        });
        const data = await response.json();
        if (!response.ok) return alert(data.error || 'تعذر إنشاء البطولة');
        const info = document.getElementById('r2-tournament-info');
        if (info) info.innerHTML = '<div class="r2-card">🏆 تم إنشاء <b>' + escapeHtml(data.tournament.name) + '</b><br>أنت مسجل تلقائيًا 1/' + data.tournament.size + '.<br>أكواد الدعوة (' + data.codes.length + '):<br><small style="word-break:break-word">' + data.codes.join(' | ') + '</small></div>';
        return data;
      } catch (_) { return alert('السيرفر غير متصل حاليًا.'); }
    };
    window.R2.joinTournament = async function () {
      const code = String(document.getElementById('r2-tournament-code')?.value || '').trim().toUpperCase();
      if (!code) return alert('اكتب كود الدعوة');
      try {
        const response = await fetch('/api/tournaments/join', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, playerId: player.id, playerName: player.name })
        });
        const data = await response.json();
        if (!response.ok) return alert(data.error || 'تعذر الانضمام');
        const t = data.tournament;
        const info = document.getElementById('r2-tournament-info');
        if (info) info.innerHTML = '<div class="r2-card">🏆 ' + escapeHtml(t.name) + '<br>👥 ' + t.players + '/' + t.size + '<br>الحالة: ' + escapeHtml(t.status) + (t.status === 'playing' ? '<br>🎲 القرعة اكتملت والمواجهات تُدار من السيرفر.' : '') + '</div>';
        return data;
      } catch (_) { return alert('السيرفر غير متصل حاليًا.'); }
    };
  }

  // Keep local single-device guess game exactly as it is, but use the server
  // state machine whenever a real online room is active.
  const oldStartGuess = window.startGuessPlayerGame;
  window.startGuessPlayerGame = function () {
    if (room?.code && room.started && socket?.connected && room.game === 'guess') {
      return startOnlineGuess();
    }
    onlineGuess = false;
    return typeof oldStartGuess === 'function' ? oldStartGuess.apply(this, arguments) : undefined;
  };

  const oldSubmitGuess = window.submitGuess;
  window.submitGuess = function () {
    if (onlineGuess) return submitOnlineGuess();
    return typeof oldSubmitGuess === 'function' ? oldSubmitGuess.apply(this, arguments) : undefined;
  };

  // The server is the reward authority for a live multiplayer room. For
  // single-device/AI games the existing local reward system remains intact.
  const oldComplete = window.R2?.completeGame;
  if (window.R2 && typeof oldComplete === 'function') {
    window.R2.completeGame = function () {
      if (room?.code && socket?.connected) {
        socket.emit('game:complete', { code: room.code, playerId: player.id }, response => {
          if (response?.ok) setStatus('🎁 المكافأة اتسجلت على السيرفر وتم تحديث Ultimate Team');
        });
        return;
      }
      const beforePoints = Number(window.R2.state?.points || 0);
      const beforeCoins = Number(window.R2.state?.coins || 0);
      const result = oldComplete.apply(this, arguments);
      // Older game code grants 500 POINTS / 800 COINS. Add the difference so
      // the final local reward is the same contract as the server: 600/1000.
      if (window.R2?.state) {
        window.R2.state.points = beforePoints + 600;
        window.R2.state.coins = beforeCoins + 1000;
        try { window.R2.render(); } catch (_) {}
      }
      return result;
    };
  }

  // Override the old REST-only room functions without changing the HTML.
  window.generateNewRoomCode = createRoom;
  window.connectRoom = joinRoom;
  window.quickMatch = quickMatch;
  window.sendFriendRequest = sendFriendRequest;
  window.R2V11 = {
    player,
    getRoom: () => room,
    socket: () => socket,
    playNow,
    createRoom,
    joinRoom,
    quickMatch,
    sendFriendRequest,
    startOnlineGuess
  };

  function boot() {
    ensureProfileCard();
    initServerProfile();
    connectSocket();
    setTimeout(ensureProfileCard, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
