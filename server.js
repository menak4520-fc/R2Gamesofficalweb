/*
 * R2 GAMES WORLD SERVER V11
 * Server-authoritative multiplayer backend.
 *
 * Design goals:
 *  - The server owns room state, ready state, match state and rewards.
 *  - The browser is a renderer/input client, not the source of truth.
 *  - Room codes are exactly 8 alphanumeric characters.
 *  - Player IDs are exactly 16 decimal digits.
 *  - The same synchronization engine powers Rooms, Quick Match and Tournaments.
 *  - All six R2 games are registered in the game registry.
 *  - Guess The Player has a server-side five-round state machine.
 *  - Rewards are idempotent and persisted.
 *  - Disconnect/reconnect is handled by playerId, not only socket id.
 *
 * Production note:
 *  This build uses a durable JSON store for compatibility with the existing
 *  project. For multiple Node instances, point DATA_DIR at shared storage or
 *  migrate the repository layer to PostgreSQL/Redis. The authoritative game
 *  protocol itself is deliberately independent of that storage choice.
 */

'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const { Server } = require('socket.io');

const APP_VERSION = '11.1.0-world';
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const DISCONNECT_GRACE_MS = 5 * 60 * 1000;
const QUICK_MATCH_TTL_MS = 90 * 1000;
const MAX_ROOM_PLAYERS = 2;
const MAX_NAME = 40;
const MAX_EVENT_BYTES = 32 * 1024;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'r2-data.json');
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : __dirname;

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ['GET', 'POST'] },
  maxHttpBufferSize: MAX_EVENT_BYTES,
  pingInterval: 25000,
  pingTimeout: 20000,
  transports: ['polling', 'websocket'],
  allowUpgrades: true
});

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '1h' }));

/* -------------------------------------------------------------------------- */
/* DATA LAYER                                                                 */
/* -------------------------------------------------------------------------- */

const EMPTY_DB = {
  version: 11,
  players: {},
  tournaments: {},
  usedTournamentCodes: {},
  rewardClaims: {},
  stats: { games: 0, rooms: 0, quickMatches: 0, tournamentMatches: 0 }
};

let db = loadDb();
let saveTimer = null;
let saving = false;
let saveAgain = false;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadDb() {
  if (!fs.existsSync(DB_FILE)) return clone(EMPTY_DB);
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return {
      ...clone(EMPTY_DB),
      ...raw,
      players: raw.players || {},
      tournaments: raw.tournaments || {},
      usedTournamentCodes: raw.usedTournamentCodes || {},
      rewardClaims: raw.rewardClaims || {},
      stats: { ...EMPTY_DB.stats, ...(raw.stats || {}) }
    };
  } catch (error) {
    console.error('[DB] load failed:', error.message);
    return clone(EMPTY_DB);
  }
}

function flushDb() {
  if (saving) {
    saveAgain = true;
    return;
  }
  saving = true;
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (error) {
    console.error('[DB] save failed:', error.message);
  } finally {
    saving = false;
    if (saveAgain) {
      saveAgain = false;
      setTimeout(flushDb, 0);
    }
  }
}

function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushDb, 100);
}

/* -------------------------------------------------------------------------- */
/* SECURITY / NORMALIZATION                                                   */
/* -------------------------------------------------------------------------- */

const ROOM_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const GAME_NAMES = ['auction', 'five', 'deal', 'blind', 'guess', 'hidden'];
const GAME_LABELS = {
  auction: 'المزاد برو ماكس',
  five: 'الملعب الخماسي',
  deal: 'DEAL OR NO DEAL',
  blind: 'المزاد الأعمى',
  guess: 'تخمين اللاعب',
  hidden: 'اللاعب الخفي'
};
const TOURNAMENT_SIZES = [16, 32, 64, 128];

function clean(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

function safeName(value) {
  const text = String(value || 'لاعب').trim().replace(/[<>]/g, '');
  return text.slice(0, MAX_NAME) || 'لاعب';
}

function validGame(value) {
  const game = String(value || '').trim().toLowerCase();
  return GAME_NAMES.includes(game) ? game : 'auction';
}

function validPlayerId(value) {
  return /^\d{16}$/.test(String(value || ''));
}

function randomPlayerId() {
  let id = '';
  while (id.length < 16) {
    id += crypto.randomInt(0, 100000000).toString().padStart(8, '0');
  }
  return id.slice(0, 16);
}

function newUniquePlayerId() {
  let id;
  do id = randomPlayerId(); while (db.players[id]);
  return id;
}

function randomCode(length = 8) {
  let value = '';
  for (let i = 0; i < length; i += 1) {
    value += ROOM_CHARS[crypto.randomInt(0, ROOM_CHARS.length)];
  }
  return value;
}

function newRoomCode() {
  let code;
  do code = randomCode(8); while (rooms.has(code));
  return code;
}

function newTournamentInviteCode() {
  let code;
  do code = randomCode(8); while (db.usedTournamentCodes[code]);
  return code;
}

function now() {
  return Date.now();
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function limitedObject(value, maxKeys = 40) {
  if (!isPlainObject(value)) return {};
  const entries = Object.entries(value).slice(0, maxKeys);
  return Object.fromEntries(entries);
}

/* -------------------------------------------------------------------------- */
/* PLAYER REPOSITORY                                                          */
/* -------------------------------------------------------------------------- */

function createPlayer(id, name) {
  return {
    id,
    name: safeName(name),
    xb: 0,
    points: 0,
    coins: 0,
    freeDrafts: 0,
    level: 1,
    xp: 0,
    friends: [],
    incomingRequests: [],
    outgoingRequests: [],
    completedGames: {},
    rewardClaims: {},
    stats: {
      gamesPlayed: 0,
      gamesWon: 0,
      gamesDrawn: 0,
      gamesLost: 0,
      guessCorrect: 0,
      tournamentsWon: 0,
      tournamentMatches: 0
    },
    createdAt: now(),
    updatedAt: now()
  };
}

function ensurePlayer(id, name) {
  let playerId = String(id || '');
  if (!validPlayerId(playerId)) playerId = newUniquePlayerId();
  if (!db.players[playerId]) db.players[playerId] = createPlayer(playerId, name);
  if (name) db.players[playerId].name = safeName(name);
  db.players[playerId].updatedAt = now();
  saveDb();
  return db.players[playerId];
}

function publicPlayer(player) {
  if (!player) return null;
  return {
    id: player.id,
    name: player.name,
    xb: player.xb || 0,
    points: player.points || 0,
    coins: player.coins || 0,
    level: player.level || 1,
    xp: player.xp || 0,
    freeDrafts: player.freeDrafts || 0,
    friends: (player.friends || []).length,
    online: onlinePlayers.has(player.id),
    stats: { ...(player.stats || {}) }
  };
}

function playerById(id) {
  return db.players[String(id || '')] || null;
}

function updatePlayerResources(player, reward) {
  player.xb = Math.max(0, (player.xb || 0) + (reward.xb || 0));
  player.points = Math.max(0, (player.points || 0) + (reward.points || 0));
  player.coins = Math.max(0, (player.coins || 0) + (reward.coins || 0));
  const xp = Math.max(0, Number(reward.xp || 0));
  player.xp = (player.xp || 0) + xp;
  while (player.xp >= 100 && player.level < 1000) {
    player.xp -= 100;
    player.level += 1;
    player.points += player.level === 2 ? 3000 : 1000;
    if (player.level === 2) player.coins += 1000;
  }
  player.updatedAt = now();
}

function claimReward(playerId, claimKey, reward) {
  const player = playerById(playerId);
  if (!player) return { ok: false, error: 'اللاعب غير موجود' };
  const key = String(claimKey || '').slice(0, 160);
  if (!key) return { ok: false, error: 'معرف المكافأة غير صالح' };
  player.rewardClaims = player.rewardClaims || {};
  if (player.rewardClaims[key]) {
    return { ok: true, duplicate: true, reward: { ...reward }, player: publicPlayer(player) };
  }
  player.rewardClaims[key] = now();
  db.rewardClaims[key] = { playerId, at: now() };
  updatePlayerResources(player, reward);
  saveDb();
  return { ok: true, duplicate: false, reward: { ...reward }, player: publicPlayer(player) };
}

/* -------------------------------------------------------------------------- */
/* PRESENCE                                                                    */
/* -------------------------------------------------------------------------- */

const onlinePlayers = new Map();
const playerSockets = new Map();

function addPresence(socket, player) {
  socket.data.playerId = player.id;
  socket.data.name = player.name;
  onlinePlayers.set(player.id, { socketId: socket.id, since: now() });
  playerSockets.set(player.id, socket.id);
}

function socketForPlayer(playerId) {
  const socketId = playerSockets.get(playerId);
  return socketId ? io.sockets.sockets.get(socketId) : null;
}

function emitToPlayer(playerId, event, payload) {
  const socket = socketForPlayer(playerId);
  if (socket) socket.emit(event, payload);
}

function removePresence(socket) {
  const playerId = socket.data.playerId;
  if (!playerId) return;
  if (playerSockets.get(playerId) === socket.id) playerSockets.delete(playerId);
  if (onlinePlayers.get(playerId)?.socketId === socket.id) onlinePlayers.delete(playerId);
}

/* -------------------------------------------------------------------------- */
/* ROOM ENGINE                                                                 */
/* -------------------------------------------------------------------------- */

const rooms = new Map();
const quickQueue = new Map();

function makeRoomPlayer(socket, player, role) {
  return {
    socketId: socket ? socket.id : null,
    playerId: player.id,
    name: player.name,
    role,
    ready: false,
    connectedAt: now(),
    disconnectedAt: null,
    sessionToken: crypto.randomBytes(12).toString('hex')
  };
}

function createRoom(game, password, hostSocket, hostPlayer) {
  const code = newRoomCode();
  const room = {
    code,
    game: validGame(game),
    password: String(password || '').slice(0, 64),
    createdAt: now(),
    updatedAt: now(),
    status: 'waiting',
    players: [makeRoomPlayer(hostSocket, hostPlayer, 'host')],
    state: {
      version: 1,
      started: false,
      ended: false,
      turn: null,
      revision: 0,
      data: {}
    },
    events: [],
    lastActivity: now(),
    tournament: null,
    quickMatch: false
  };
  rooms.set(code, room);
  db.stats.rooms = (db.stats.rooms || 0) + 1;
  saveDb();
  return room;
}

function roomPublic(room) {
  return {
    code: room.code,
    game: room.game,
    gameLabel: GAME_LABELS[room.game],
    status: room.status,
    players: room.players.map((player) => ({
      id: player.playerId,
      name: player.name,
      role: player.role,
      ready: !!player.ready,
      connected: !!player.socketId
    })),
    playerCount: room.players.length,
    readyCount: room.players.filter((p) => p.ready).length,
    maxPlayers: MAX_ROOM_PLAYERS,
    passwordProtected: !!room.password,
    createdAt: room.createdAt,
    revision: room.state.revision,
    started: !!room.state.started,
    ended: !!room.state.ended,
    tournamentId: room.tournament?.id || null,
    quickMatch: !!room.quickMatch
  };
}

function findRoom(code) {
  const value = clean(code);
  if (!/^[A-Z0-9]{8}$/.test(value)) return null;
  return rooms.get(value);
}

function playerInRoom(room, playerId) {
  return room.players.find((p) => p.playerId === playerId) || null;
}

function socketInRoom(room, socketId) {
  return room.players.find((p) => p.socketId === socketId) || null;
}

function roomForSocket(socket) {
  for (const room of rooms.values()) {
    if (room.players.some((p) => p.socketId === socket.id)) return room;
  }
  return null;
}

function broadcastRoom(room, event = 'room:state') {
  io.to(room.code).emit(event, roomPublic(room));
}

function requireRoomPlayer(socket, room) {
  if (!room) return { ok: false, error: 'الغرفة غير موجودة' };
  const player = socketInRoom(room, socket.id);
  if (!player) return { ok: false, error: 'أنت لست داخل هذه الغرفة' };
  return { ok: true, player };
}

function joinRoomSocket(socket, room, player, password) {
  if (!room) return { ok: false, error: 'كود الغرفة غير موجود' };
  if (room.password && String(password || '') !== room.password) {
    return { ok: false, error: 'كلمة السر غير صحيحة' };
  }
  const existing = playerInRoom(room, player.id);
  if (existing) {
    existing.socketId = socket.id;
    existing.disconnectedAt = null;
    existing.connectedAt = now();
    socket.join(room.code);
    room.updatedAt = now();
    room.lastActivity = now();
    return { ok: true, reconnected: true };
  }
  if (room.players.length >= MAX_ROOM_PLAYERS) {
    return { ok: false, error: 'الغرفة ممتلئة' };
  }
  room.players.push(makeRoomPlayer(socket, player, 'guest'));
  room.status = 'connected';
  room.updatedAt = now();
  room.lastActivity = now();
  socket.join(room.code);
  return { ok: true, reconnected: false };
}

function maybeStartRoom(room) {
  if (room.players.length !== 2) return false;
  if (!room.players.every((p) => p.ready)) return false;
  if (room.state.started) return true;
  room.status = 'playing';
  room.state.started = true;
  room.state.ended = false;
  room.state.revision += 1;
  room.state.turn = room.players[0].playerId;
  room.lastActivity = now();
  room.events.push({ type: 'game:start', at: now() });
  io.to(room.code).emit('game:start', {
    room: roomPublic(room),
    game: room.game,
    state: clone(room.state)
  });
  broadcastRoom(room);
  return true;
}

function markReady(room, socket) {
  const p = socketInRoom(room, socket.id);
  if (!p) return { ok: false, error: 'أنت لست داخل الغرفة' };
  if (room.players.length !== 2) return { ok: false, error: 'انتظر اللاعب الثاني' };
  if (room.state.started) return { ok: false, error: 'المباراة بدأت بالفعل' };
  p.ready = true;
  room.status = 'ready';
  room.updatedAt = now();
  room.lastActivity = now();
  room.state.revision += 1;
  broadcastRoom(room, 'room:ready-state');
  io.to(room.code).emit('room:connected', roomPublic(room));
  maybeStartRoom(room);
  return { ok: true, room: roomPublic(room) };
}

function leaveRoomSocket(socket) {
  const room = roomForSocket(socket);
  if (!room) return;
  const p = socketInRoom(room, socket.id);
  if (!p) return;
  p.socketId = null;
  p.disconnectedAt = now();
  p.ready = false;
  room.status = room.state.started ? 'reconnecting' : (room.players.length === 1 ? 'waiting' : 'connected');
  room.updatedAt = now();
  room.lastActivity = now();
  broadcastRoom(room, 'room:player-left');
  setTimeout(() => cleanupDisconnectedRoom(room.code), DISCONNECT_GRACE_MS);
}

function cleanupDisconnectedRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  const live = room.players.some((p) => p.socketId);
  if (live) return;
  const recent = room.players.some((p) => p.disconnectedAt && now() - p.disconnectedAt < DISCONNECT_GRACE_MS);
  if (recent) return;
  rooms.delete(code);
}

function serverGameEvent(room, socket, type, data) {
  if (!room.state.started || room.state.ended) {
    return { ok: false, error: 'المباراة ليست قيد التشغيل' };
  }
  const sender = socketInRoom(room, socket.id);
  if (!sender) return { ok: false, error: 'لاعب غير مصرح' };
  if (room.state.turn && room.state.turn !== sender.playerId && isTurnBoundEvent(type)) {
    return { ok: false, error: 'ليس دورك الآن' };
  }
  const cleanType = String(type || 'move').slice(0, 60);
  const payload = limitedObject(data, 60);
  const event = {
    id: crypto.randomBytes(8).toString('hex'),
    seq: room.state.revision + 1,
    type: cleanType,
    by: sender.playerId,
    at: now(),
    data: payload
  };
  room.state.revision += 1;
  room.events.push(event);
  if (room.events.length > 100) room.events.shift();
  applyAuthoritativeEvent(room, event);
  room.updatedAt = now();
  room.lastActivity = now();
  io.to(room.code).emit('game:event', event);
  io.to(room.code).emit('game:sync', {
    revision: room.state.revision,
    state: clone(room.state)
  });
  return { ok: true, event, state: clone(room.state) };
}

function isTurnBoundEvent(type) {
  return !['chat', 'ping', 'state:request', 'guess:answer'].includes(String(type || ''));
}

function applyAuthoritativeEvent(room, event) {
  const state = room.state.data || (room.state.data = {});
  if (room.game === 'guess') {
    applyGuessEvent(room, event);
    return;
  }
  if (event.type === 'turn:end') {
    const next = room.players.find((p) => p.playerId !== event.by);
    room.state.turn = next ? next.playerId : event.by;
  }
  if (event.type === 'match:end') {
    room.state.ended = true;
    room.status = 'finished';
  }
  state.lastEvent = event.type;
}

/* -------------------------------------------------------------------------- */
/* GUESS THE PLAYER — SERVER AUTHORITATIVE                                   */
/* -------------------------------------------------------------------------- */

const GUESS_PLAYERS = [
  ['كريستيانو رونالدو', ['سبورتينغ لشبونة', 'مانشستر يونايتد', 'ريال مدريد', 'يوفنتوس', 'النصر']],
  ['ليونيل ميسي', ['برشلونة', 'باريس سان جيرمان', 'إنتر ميامي']],
  ['نيمار', ['سانتوس', 'برشلونة', 'باريس سان جيرمان', 'الهلال']],
  ['كيليان مبابي', ['موناكو', 'باريس سان جيرمان', 'ريال مدريد']],
  ['محمد صلاح', ['المقاولون', 'بازل', 'تشيلسي', 'فيورنتينا', 'روما', 'ليفربول']],
  ['زلاتان إبراهيموفيتش', ['مالمو', 'أياكس', 'يوفنتوس', 'إنتر', 'برشلونة', 'ميلان', 'باريس سان جيرمان', 'مانشستر يونايتد']],
  ['لوكا مودريتش', ['دينامو زغرب', 'توتنهام', 'ريال مدريد']],
  ['روبرت ليفاندوفسكي', ['بوروسيا دورتموند', 'بايرن ميونخ', 'برشلونة']],
  ['إيرلينغ هالاند', ['مولده', 'سالزبورغ', 'بوروسيا دورتموند', 'مانشستر سيتي']],
  ['كريم بنزيما', ['ليون', 'ريال مدريد', 'الاتحاد']],
  ['سيرجيو راموس', ['إشبيلية', 'ريال مدريد', 'باريس سان جيرمان', 'مونتيري']],
  ['رونالدينيو', ['غريميو', 'باريس سان جيرمان', 'برشلونة', 'ميلان']],
  ['رونالدو نازاريو', ['كروزيرو', 'آيندهوفن', 'برشلونة', 'إنتر', 'ريال مدريد', 'ميلان']],
  ['تييري هنري', ['موناكو', 'يوفنتوس', 'أرسنال', 'برشلونة']],
  ['ديفيد بيكهام', ['مانشستر يونايتد', 'ريال مدريد', 'ميلان', 'لوس أنجلوس غالاكسي', 'باريس سان جيرمان']],
  ['واين روني', ['إيفرتون', 'مانشستر يونايتد', 'دي سي يونايتد', 'ديربي']],
  ['لويس سواريز', ['ناسيونال', 'أياكس', 'ليفربول', 'برشلونة', 'أتلتيكو مدريد', 'إنتر ميامي']],
  ['ريكاردو كاكا', ['ساو باولو', 'ميلان', 'ريال مدريد', 'أورلاندو']],
  ['آريين روبن', ['غرونينغن', 'آيندهوفن', 'تشيلسي', 'ريال مدريد', 'بايرن']],
  ['مانويل نوير', ['شالكه', 'بايرن ميونخ']],
  ['جانلويجي بوفون', ['بارما', 'يوفنتوس', 'باريس سان جيرمان']],
  ['إيكر كاسياس', ['ريال مدريد', 'بورتو']],
  ['بيبي', ['ماريتيمو', 'بورتو', 'ريال مدريد', 'بشكتاش']],
  ['فيرجيل فان دايك', ['غرونينغن', 'سيلتيك', 'ساوثهامبتون', 'ليفربول']],
  ['كيفن دي بروين', ['جينك', 'تشيلسي', 'فيردر بريمن', 'فولفسبورغ', 'مانشستر سيتي']],
  ['جود بيلينغهام', ['برمنغهام', 'بوروسيا دورتموند', 'ريال مدريد']],
  ['فينيسيوس جونيور', ['فلامنغو', 'ريال مدريد']],
  ['رودري', ['فياريال', 'أتلتيكو مدريد', 'مانشستر سيتي']],
  ['برونو فيرنانديز', ['نوفارا', 'أودينيزي', 'سامبدوريا', 'سبورتينغ', 'مانشستر يونايتد']],
  ['سون هيونغ مين', ['هامبورغ', 'باير ليفركوزن', 'توتنهام']],
  ['ساديو ماني', ['ميتز', 'سالزبورغ', 'ساوثهامبتون', 'ليفربول', 'بايرن', 'النصر']],
  ['رافائيل لياو', ['سبورتينغ', 'ليل', 'ميلان']],
  ['فيكتور أوسيمين', ['فولفسبورغ', 'شارلروا', 'ليل', 'نابولي', 'غلطة سراي']],
  ['لوتارو مارتينيز', ['راسينغ', 'إنتر']],
  ['إيدين هازارد', ['ليل', 'تشيلسي', 'ريال مدريد']],
  ['غاريث بيل', ['ساوثهامبتون', 'توتنهام', 'ريال مدريد', 'لوس أنجلوس']],
  ['مارسيلو', ['فلومينينسي', 'ريال مدريد', 'أولمبياكوس']],
  ['روبرتو كارلوس', ['بالميراس', 'إنتر', 'ريال مدريد', 'فنربخشة', 'كورينثيانز']],
  ['ديدييه دروغبا', ['لو مان', 'غانغان', 'مارسيليا', 'تشيلسي', 'غلطة سراي']],
  ['يايا توريه', ['بيفيرين', 'ميتاليورغ', 'أولمبياكوس', 'موناكو', 'برشلونة', 'مانشستر سيتي']],
  ['صامويل إيتو', ['ريال مدريد', 'مايوركا', 'برشلونة', 'إنتر', 'أنجي', 'تشيلسي']],
  ['داني ألفيش', ['باهيا', 'إشبيلية', 'برشلونة', 'يوفنتوس', 'باريس سان جيرمان']],
  ['جورج بست', ['مانشستر يونايتد', 'فولهام', 'لوس أنجلوس أزتيكس']]
];

function normalizeGuess(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function newGuessState(room) {
  const shuffled = [...GUESS_PLAYERS].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 5);
  room.state.data.guess = {
    round: 1,
    turnIndex: 0,
    score: {},
    selected: selected.map((p) => ({ name: p[0], clubs: p[1] })),
    answered: false,
    finished: false,
    used: selected.map((p) => p[0])
  };
  for (const p of room.players) room.state.data.guess.score[p.playerId] = 0;
}

function publicGuessState(room) {
  const g = room.state.data.guess;
  if (!g) return null;
  const current = g.selected[g.round - 1];
  return {
    round: g.round,
    totalRounds: 5,
    turnPlayerId: room.players[g.turnIndex]?.playerId || null,
    score: { ...g.score },
    clubs: current ? current.clubs : [],
    finished: !!g.finished
  };
}

function applyGuessEvent(room, event) {
  const state = room.state.data;
  if (!state.guess) newGuessState(room);
  const g = state.guess;
  if (event.type === 'guess:start') {
    newGuessState(room);
    room.state.turn = room.players[0]?.playerId || null;
    return;
  }
  if (event.type !== 'guess:answer') return;
  if (g.finished || g.answered) return;
  const active = room.players[g.turnIndex];
  if (!active || active.playerId !== event.by) return;
  const answer = normalizeGuess(event.data?.answer);
  const current = g.selected[g.round - 1];
  if (!answer || !current) return;
  const correct = normalizeGuess(current.name);
  const ok = answer === correct || answer.includes(correct) || correct.includes(answer);
  if (ok) {
    g.score[event.by] = (g.score[event.by] || 0) + 1;
    const player = playerById(event.by);
    if (player) player.stats.guessCorrect = (player.stats.guessCorrect || 0) + 1;
  }
  g.answered = true;
  room.state.revision += 1;
  io.to(room.code).emit('guess:result', {
    round: g.round,
    playerId: event.by,
    correct: ok,
    answer: current.name,
    score: { ...g.score }
  });
  setTimeout(() => advanceGuess(room.code), 1200);
}

function advanceGuess(code) {
  const room = rooms.get(code);
  if (!room || room.game !== 'guess') return;
  const g = room.state.data.guess;
  if (!g || !g.answered || g.finished) return;

  // Each round has exactly two turns: player A then player B.
  // After B answers, increment the round once (not twice).
  if (g.turnIndex < room.players.length - 1) {
    g.turnIndex += 1;
  } else if (g.round >= 5) {
    g.finished = true;
    room.state.ended = true;
    room.status = 'finished';
    room.state.revision += 1;
    io.to(room.code).emit('guess:finished', {
      score: { ...g.score },
      room: roomPublic(room)
    });
    const ids = room.players.map((p) => p.playerId);
    const a = g.score[ids[0]] || 0;
    const b = g.score[ids[1]] || 0;
    const winnerId = a === b ? null : (a > b ? ids[0] : ids[1]);
    recordGameCompletion(room, 'guess', winnerId, a === b);
    return;
  } else {
    g.round += 1;
    g.turnIndex = 0;
  }

  g.answered = false;
  room.state.turn = room.players[g.turnIndex]?.playerId || null;
  room.state.revision += 1;
  io.to(room.code).emit('guess:state', publicGuessState(room));
}


/* -------------------------------------------------------------------------- */
/* GAME COMPLETION / REWARDS                                                  */
/* -------------------------------------------------------------------------- */

const STANDARD_GAME_REWARD = { xb: 15, points: 600, coins: 1000, xp: 15 };

function recordGameCompletion(room, game, winnerId = null, draw = false) {
  const matchKey = `${room.code}:${room.state.revision}:${game}`;
  for (const participant of room.players) {
    const player = playerById(participant.playerId);
    if (!player) continue;
    player.stats.gamesPlayed = (player.stats.gamesPlayed || 0) + 1;
    if (winnerId && participant.playerId === winnerId) player.stats.gamesWon = (player.stats.gamesWon || 0) + 1;
    else if (winnerId && participant.playerId !== winnerId) player.stats.gamesLost = (player.stats.gamesLost || 0) + 1;
    else if (draw) player.stats.gamesDrawn = (player.stats.gamesDrawn || 0) + 1;
    const result = claimReward(player.id, `${matchKey}:${player.id}`, STANDARD_GAME_REWARD);
    emitToPlayer(player.id, 'game:reward', {
      playerId: player.id,
      claimKey: `${matchKey}:${player.id}`,
      reward: result.reward,
      player: result.player
    });
  }
  db.stats.games = (db.stats.games || 0) + 1;
  saveDb();
}

function finalizeRoom(room, result = {}) {
  if (room.state.ended) return;
  room.state.ended = true;
  room.status = 'finished';
  room.state.revision += 1;
  room.state.data.result = limitedObject(result, 30);
  const winnerId = result.winnerId || null;
  const draw = !!result.draw;
  recordGameCompletion(room, room.game, winnerId, draw);
  io.to(room.code).emit('game:finished', {
    room: roomPublic(room),
    result: room.state.data.result,
    state: clone(room.state)
  });
}

/* -------------------------------------------------------------------------- */
/* MATCH RESULT HELPERS                                                       */
/* -------------------------------------------------------------------------- */

const RESULT_POOL = [
  [1, 0], [1, 1], [3, 2], [2, 2], [2, 1], [0, 1], [1, 2], [2, 3],
  [3, 1], [0, 0], [3, 3], [4, 2], [2, 0], [0, 2], [4, 1], [1, 3]
];

function randomMatchScore() {
  const score = RESULT_POOL[crypto.randomInt(0, RESULT_POOL.length)];
  return { home: score[0], away: score[1] };
}

/* -------------------------------------------------------------------------- */
/* QUICK MATCH                                                                */
/* -------------------------------------------------------------------------- */

function quickKey(game) {
  return validGame(game);
}

function removeQuickEntry(playerId) {
  for (const [key, entry] of quickQueue) {
    if (entry.playerId === playerId) quickQueue.delete(key);
  }
}

function tryQuickMatch(entry) {
  const key = quickKey(entry.game);
  const waiting = quickQueue.get(key);
  if (!waiting || waiting.playerId === entry.playerId) return null;
  if (now() - waiting.createdAt > QUICK_MATCH_TTL_MS) {
    quickQueue.delete(key);
    return null;
  }
  quickQueue.delete(key);
  const aSocket = socketForPlayer(waiting.playerId);
  const bSocket = socketForPlayer(entry.playerId);
  if (!aSocket || !bSocket) return null;
  const aPlayer = playerById(waiting.playerId);
  const bPlayer = playerById(entry.playerId);
  if (!aPlayer || !bPlayer) return null;
  const room = createRoom(key, '', aSocket, aPlayer);
  room.quickMatch = true;
  joinRoomSocket(bSocket, room, bPlayer, '');
  aSocket.join(room.code);
  bSocket.join(room.code);
  room.status = 'connected';
  db.stats.quickMatches = (db.stats.quickMatches || 0) + 1;
  saveDb();
  io.to(room.code).emit('quick:matched', {
    room: roomPublic(room),
    game: room.game
  });
  io.to(room.code).emit('room:connected', roomPublic(room));
  return room;
}

/* -------------------------------------------------------------------------- */
/* FRIENDS                                                                    */
/* -------------------------------------------------------------------------- */

function addFriendRequest(fromId, toId) {
  const from = playerById(fromId);
  const to = playerById(toId);
  if (!from || !to) return { ok: false, error: 'ID غير موجود' };
  if (from.id === to.id) return { ok: false, error: 'لا يمكنك إضافة نفسك' };
  from.friends = from.friends || [];
  to.friends = to.friends || [];
  if (from.friends.includes(to.id)) return { ok: false, error: 'الصديق موجود بالفعل' };
  if ((to.incomingRequests || []).includes(from.id)) return { ok: false, error: 'تم إرسال الطلب بالفعل' };
  if ((from.outgoingRequests || []).includes(to.id)) return { ok: false, error: 'تم إرسال الطلب بالفعل' };
  to.incomingRequests = to.incomingRequests || [];
  from.outgoingRequests = from.outgoingRequests || [];
  to.incomingRequests.push(from.id);
  from.outgoingRequests.push(to.id);
  saveDb();
  emitToPlayer(to.id, 'friends:request', { from: publicPlayer(from) });
  return { ok: true };
}

function acceptFriendRequest(playerId, friendId) {
  const player = playerById(playerId);
  const friend = playerById(friendId);
  if (!player || !friend) return { ok: false, error: 'ID غير موجود' };
  player.incomingRequests = (player.incomingRequests || []).filter((id) => id !== friend.id);
  friend.outgoingRequests = (friend.outgoingRequests || []).filter((id) => id !== player.id);
  player.friends = player.friends || [];
  friend.friends = friend.friends || [];
  if (!player.friends.includes(friend.id)) player.friends.push(friend.id);
  if (!friend.friends.includes(player.id)) friend.friends.push(player.id);
  saveDb();
  emitToPlayer(friend.id, 'friends:accepted', { friend: publicPlayer(player) });
  return { ok: true, friend: publicPlayer(friend) };
}

function rejectFriendRequest(playerId, friendId) {
  const player = playerById(playerId);
  const friend = playerById(friendId);
  if (!player || !friend) return { ok: false, error: 'ID غير موجود' };
  player.incomingRequests = (player.incomingRequests || []).filter((id) => id !== friend.id);
  friend.outgoingRequests = (friend.outgoingRequests || []).filter((id) => id !== player.id);
  saveDb();
  return { ok: true };
}

function friendsPublic(player) {
  return (player.friends || [])
    .map((id) => playerById(id))
    .filter(Boolean)
    .map(publicPlayer);
}

/* -------------------------------------------------------------------------- */
/* TOURNAMENT ENGINE                                                          */
/* -------------------------------------------------------------------------- */

function tournamentPublic(t) {
  return {
    id: t.id,
    name: t.name,
    game: t.game,
    gameLabel: GAME_LABELS[t.game] || t.game,
    size: t.size,
    players: t.players.length,
    playersList: t.players.map((p) => ({ id: p.id, name: p.name })),
    status: t.status,
    createdAt: t.createdAt,
    joinCodesRemaining: (t.codes || []).filter((c) => !db.usedTournamentCodes[c]).length,
    bracket: t.bracket || [],
    champion: t.champion || null,
    currentRound: t.currentRound || 0
  };
}

function createTournament(name, game, size, host) {
  const id = 'T' + now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
  const codes = [];
  while (codes.length < size - 1) codes.push(newTournamentInviteCode());
  const tournament = {
    id,
    name: safeName(name || 'بطولة R2'),
    game: validGame(game),
    size,
    codes,
    players: [{ id: host.id, name: host.name }],
    status: 'open',
    createdAt: now(),
    updatedAt: now(),
    currentRound: 0,
    bracket: [],
    champion: null,
    rooms: {}
  };
  db.tournaments[id] = tournament;
  saveDb();
  return tournament;
}

function shufflePlayers(players) {
  const arr = [...players];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildTournamentBracket(t) {
  const players = shufflePlayers(t.players);
  const matches = [];
  for (let i = 0; i < players.length; i += 2) {
    const a = players[i];
    const b = players[i + 1] || null;
    matches.push({
      id: `R1-${String(i / 2 + 1).padStart(2, '0')}`,
      round: 1,
      a,
      b,
      status: b ? 'pending' : 'bye',
      winner: b ? null : a,
      score: null,
      roomCode: null
    });
  }
  t.bracket = [matches];
  t.currentRound = 1;
  t.status = 'playing';
  t.updatedAt = now();
  resolveByes(t);
  saveDb();
  return t;
}

function resolveByes(t) {
  const round = t.bracket[t.bracket.length - 1];
  for (const match of round) {
    if (match.status === 'bye' && match.winner) match.status = 'done';
  }
  if (round.every((m) => m.status === 'done')) advanceTournamentRound(t);
}

function advanceTournamentRound(t) {
  const last = t.bracket[t.bracket.length - 1];
  if (!last || last.some((m) => m.status !== 'done')) return;
  if (last.length === 1) {
    t.champion = last[0].winner;
    t.status = 'finished';
    t.currentRound = last[0].round;
    const champion = playerById(t.champion?.id);
    if (champion) champion.stats.tournamentsWon = (champion.stats.tournamentsWon || 0) + 1;
    saveDb();
    io.emit('tournament:update', tournamentPublic(t));
    return;
  }
  const next = [];
  for (let i = 0; i < last.length; i += 2) {
    const a = last[i].winner;
    const b = last[i + 1]?.winner || null;
    next.push({
      id: `R${last[0].round + 1}-${String(i / 2 + 1).padStart(2, '0')}`,
      round: last[0].round + 1,
      a,
      b,
      status: b ? 'pending' : 'bye',
      winner: b ? null : a,
      score: null,
      roomCode: null
    });
  }
  t.bracket.push(next);
  t.currentRound = next[0].round;
  t.updatedAt = now();
  resolveByes(t);
  saveDb();
  io.emit('tournament:update', tournamentPublic(t));
}

function tournamentMatchResult(t, matchId, winnerId, score) {
  const match = t.bracket.flat().find((m) => m.id === matchId);
  if (!match) return { ok: false, error: 'المباراة غير موجودة' };
  if (match.status === 'done') return { ok: false, error: 'تم تسجيل النتيجة بالفعل' };
  if (![match.a?.id, match.b?.id].includes(winnerId)) return { ok: false, error: 'الفائز غير صالح' };
  match.winner = match.a.id === winnerId ? match.a : match.b;
  match.score = score || null;
  match.status = 'done';
  db.stats.tournamentMatches = (db.stats.tournamentMatches || 0) + 1;
  for (const p of [match.a, match.b]) {
    if (!p) continue;
    const player = playerById(p.id);
    if (player) player.stats.tournamentMatches = (player.stats.tournamentMatches || 0) + 1;
  }
  advanceTournamentRound(t);
  saveDb();
  return { ok: true, tournament: tournamentPublic(t) };
}

function startTournamentMatchRoom(t, match) {
  if (!match || !match.a || !match.b || match.status !== 'pending') return null;
  const aSocket = socketForPlayer(match.a.id);
  const bSocket = socketForPlayer(match.b.id);
  if (!aSocket || !bSocket) return null;
  const a = playerById(match.a.id);
  const b = playerById(match.b.id);
  const room = createRoom(t.game, '', aSocket, a);
  room.quickMatch = false;
  room.tournament = { id: t.id, matchId: match.id };
  joinRoomSocket(bSocket, room, b, '');
  aSocket.join(room.code);
  bSocket.join(room.code);
  room.status = 'connected';
  match.roomCode = room.code;
  t.rooms[match.id] = room.code;
  t.updatedAt = now();
  // Tournament matches auto-start as soon as both qualified players are connected.
  room.players.forEach(p => { p.ready = true; });
  maybeStartRoom(room);
  saveDb();
  io.to(room.code).emit('tournament:match-ready', {
    tournamentId: t.id,
    matchId: match.id,
    room: roomPublic(room)
  });
  return room;
}

function autoOpenTournamentMatches(t) {
  const current = t.bracket[t.bracket.length - 1] || [];
  for (const match of current) {
    if (match.status === 'pending' && !match.roomCode) startTournamentMatchRoom(t, match);
  }
}

/* -------------------------------------------------------------------------- */
/* DAILY / INBOX / DRAFT / REWARD SERVICES                                    */
/* -------------------------------------------------------------------------- */

const DAILY_TASK_TEMPLATES = [
  { id: 'play1', name: 'العب مباراة واحدة', target: 1, reward: { xb: 10, points: 250, coins: 250, xp: 10 } },
  { id: 'play3', name: 'العب 3 مباريات', target: 3, reward: { xb: 20, points: 400, coins: 500, xp: 15 } },
  { id: 'win1', name: 'حقق فوزًا واحدًا', target: 1, reward: { xb: 20, points: 500, coins: 750, xp: 20 } },
  { id: 'guess2', name: 'أجب إجابتين صحيحتين في تخمين اللاعب', target: 2, reward: { xb: 25, points: 600, coins: 900, xp: 20 } },
  { id: 'hard5', name: 'أنهِ 5 مباريات اليوم', target: 5, reward: { xb: 50, points: 1000, coins: 1500, xp: 30 } }
];

const DRAFT_POOL = [
  ['Cristiano Ronaldo','ST',95],['Lionel Messi','RW',95],['Kylian Mbappe','ST',96],['Mohamed Salah','RW',94],
  ['Vinicius Jr','LW',94],['Erling Haaland','ST',95],['Kevin De Bruyne','CM',94],['Jude Bellingham','CM',94],
  ['Luka Modric','CM',92],['Robert Lewandowski','ST',94],['Neymar Jr','LW',93],['Rodri','CDM',94],
  ['Virgil van Dijk','CB',93],['Sergio Ramos','CB',91],['Thibaut Courtois','GK',93],['Alisson','GK',91],
  ['Manuel Neuer','GK',90],['Marquinhos','CB',91],['Marcelo','LB',89],['Roberto Carlos','LB',92],
  ['Ronaldinho','LW',94],['Ronaldo Nazario','ST',95],['Kaka','CAM',92],['Zidane','CAM',96],
  ['Beckham','RM',91],['Thierry Henry','ST',94],['Xavi','CM',93],['Iniesta','CM',93],
  ['Paolo Maldini','CB',94],['Fabio Cannavaro','CB',91],['Gianluigi Buffon','GK',93],['Iker Casillas','GK',92],
  ['Drogba','ST',92],['Eto’o','ST',92],['Yaya Toure','CM',91],['Sadio Mane','LW',91],
  ['Son','LW',90],['Bruno Fernandes','CAM',91],['Rafael Leao','LW',90],['Victor Osimhen','ST',91]
].map(([name,pos,rating]) => ({ name, pos, rating }));

function dayKey() {
  const d = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function getDaily(player) {
  const key = dayKey();
  if (!player.daily || player.daily.date !== key) {
    player.daily = { date: key, tasks: DAILY_TASK_TEMPLATES.map(t => ({ ...clone(t), progress: 0, claimed: false })) };
    player.updatedAt = now();
    saveDb();
  }
  return player.daily;
}

function dailyPublic(player) {
  const daily = getDaily(player);
  return { date: daily.date, tasks: daily.tasks.map(t => ({ id:t.id, name:t.name, target:t.target, progress:Math.min(t.target,t.progress||0), claimed:!!t.claimed, reward:t.reward })) };
}

function advanceDaily(player, event, amount = 1) {
  const daily = getDaily(player);
  for (const task of daily.tasks) {
    const hit = (task.id === 'play1' && event === 'game') ||
      (task.id === 'play3' && event === 'game') ||
      (task.id === 'win1' && event === 'win') ||
      (task.id === 'guess2' && event === 'guess') ||
      (task.id === 'hard5' && event === 'game');
    if (hit && !task.claimed) task.progress = Math.min(task.target, (task.progress || 0) + amount);
  }
}

function claimDailyTask(player, taskId) {
  const daily = getDaily(player);
  const task = daily.tasks.find(t => t.id === taskId);
  if (!task) return { ok:false, error:'المهمة غير موجودة' };
  if (task.claimed) return { ok:false, error:'المكافأة مستلمة بالفعل' };
  if ((task.progress || 0) < task.target) return { ok:false, error:'المهمة لم تكتمل بعد' };
  task.claimed = true;
  updatePlayerResources(player, task.reward);
  saveDb();
  return { ok:true, task, player:publicPlayer(player), daily:dailyPublic(player) };
}

function draftCandidates(player, count = 1) {
  player.ownedPlayers = player.ownedPlayers || [];
  const owned = new Set(player.ownedPlayers.map(x => x.name));
  const available = DRAFT_POOL.filter(p => !owned.has(p.name));
  const pool = [...available];
  for (let i=pool.length-1;i>0;i--) { const j=crypto.randomInt(0,i+1); [pool[i],pool[j]]=[pool[j],pool[i]]; }
  return pool.slice(0, Math.max(1, Math.min(10,count)));
}

function claimWelcome(player) {
  player.rewardClaims = player.rewardClaims || {};
  if (player.rewardClaims.welcome_v1) return { ok:true, duplicate:true, player:publicPlayer(player) };
  player.rewardClaims.welcome_v1 = now();
  player.points = Math.max(0, Number(player.points || 0)) + 3000;
  player.freeDrafts = Math.max(0, Number(player.freeDrafts || 0)) + 1;
  saveDb();
  return { ok:true, duplicate:false, reward:{ points:3000, freeDrafts:1 }, player:publicPlayer(player) };
}

function completeGameForPlayer(player, game, claimKey, result = {}) {
  const key = `single:${player.id}:${String(claimKey || (game + ':' + now())).slice(0,120)}`;
  const score = result.score && Number.isInteger(result.score.home) && Number.isInteger(result.score.away)
    ? { home: result.score.home, away: result.score.away } : randomMatchScore();
  let winnerId = null;
  if (score.home !== score.away) winnerId = score.home > score.away ? player.id : null;
  const reward = claimReward(player.id, key, STANDARD_GAME_REWARD);
  advanceDaily(player, 'game', 1);
  if (winnerId) advanceDaily(player, 'win', 1);
  return { ok:true, duplicate:!!reward.duplicate, reward:reward.reward, player:publicPlayer(player), score, stats:player.stats, matchSummary:{ captain:null, wildcard:null } };
}

/* -------------------------------------------------------------------------- */
/* HTTP API                                                                   */
/* -------------------------------------------------------------------------- */

app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    version: APP_VERSION,
    server: 'R2 GAMES WORLD SERVER',
    authoritative: true,
    rooms: rooms.size,
    quickQueue: quickQueue.size,
    tournaments: Object.keys(db.tournaments).length,
    players: Object.keys(db.players).length,
    online: onlinePlayers.size,
    uptime: Math.round(process.uptime()),
    time: now()
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    games: GAME_NAMES.map((id) => ({ id, name: GAME_LABELS[id] })),
    tournamentSizes: TOURNAMENT_SIZES,
    roomCodeLength: 8,
    playerIdLength: 16,
    multiplayer: true,
    serverAuthoritative: true
  });
});

app.post('/api/player/init', (req, res) => {
  const player = ensurePlayer(req.body?.playerId, req.body?.name);
  res.json({ ok: true, player: publicPlayer(player) });
});

app.post('/api/player/welcome', (req, res) => {
  const player = ensurePlayer(req.body?.playerId, req.body?.name);
  const result = claimWelcome(player);
  res.json(result);
});

app.get('/api/daily/:id', (req, res) => {
  const player = playerById(req.params.id);
  if (!player) return res.status(404).json({ error:'اللاعب غير موجود' });
  res.json({ ok:true, daily:dailyPublic(player) });
});

app.post('/api/daily/claim', (req, res) => {
  const player = playerById(String(req.body?.playerId || ''));
  if (!player) return res.status(404).json({ error:'اللاعب غير موجود' });
  const result = claimDailyTask(player, String(req.body?.taskId || ''));
  res.status(result.ok ? 200 : 400).json(result);
});

app.get('/api/inbox/:id', (req, res) => {
  const player = playerById(req.params.id);
  if (!player) return res.status(404).json({ error:'اللاعب غير موجود' });
  res.json({ ok:true, incomingRequests:(player.incomingRequests||[]).map(playerById).filter(Boolean).map(publicPlayer), welcomeAvailable:!player.rewardClaims?.welcome_v1 });
});

app.post('/api/draft/open-free', (req, res) => {
  const player = playerById(String(req.body?.playerId || ''));
  if (!player) return res.status(404).json({ error:'اللاعب غير موجود' });
  if ((player.freeDrafts || 0) < 1) return res.status(400).json({ error:'لا يوجد Draft مجاني' });
  const cards = draftCandidates(player, 3);
  if (!cards.length) return res.status(400).json({ error:'لا يوجد لاعب جديد متاح بدون تكرار' });
  player.freeDrafts -= 1;
  player.ownedPlayers = player.ownedPlayers || [];
  player.ownedPlayers.push(cards[0]);
  saveDb();
  res.json({ ok:true, card:cards[0], choices:cards, player:publicPlayer(player) });
});

app.post('/api/game/complete', (req, res) => {
  const player = playerById(String(req.body?.playerId || ''));
  if (!player) return res.status(404).json({ error:'اللاعب غير موجود' });
  const result = completeGameForPlayer(player, validGame(req.body?.game), req.body?.claimKey, req.body?.result || {});
  saveDb();
  res.json(result);
});

app.get('/api/player/:id', (req, res) => {
  const player = playerById(req.params.id);
  if (!player) return res.status(404).json({ error: 'اللاعب غير موجود' });
  return res.json({ ok: true, player: publicPlayer(player) });
});

app.post('/api/player/profile', (req, res) => {
  const player = ensurePlayer(req.body?.playerId, req.body?.name);
  if (req.body?.name) player.name = safeName(req.body.name);
  saveDb();
  res.json({ ok: true, player: publicPlayer(player) });
});

app.post('/api/friends/add', (req, res) => {
  const player = ensurePlayer(req.body?.playerId, req.body?.name);
  const result = addFriendRequest(player.id, req.body?.friendId);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/friends/accept', (req, res) => {
  const result = acceptFriendRequest(String(req.body?.playerId || ''), String(req.body?.friendId || ''));
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/friends/reject', (req, res) => {
  const result = rejectFriendRequest(String(req.body?.playerId || ''), String(req.body?.friendId || ''));
  res.status(result.ok ? 200 : 400).json(result);
});

app.get('/api/friends/:id', (req, res) => {
  const player = playerById(req.params.id);
  if (!player) return res.status(404).json({ error: 'اللاعب غير موجود' });
  res.json({
    ok: true,
    friends: friendsPublic(player),
    incomingRequests: (player.incomingRequests || []).map(playerById).filter(Boolean).map(publicPlayer),
    outgoingRequests: (player.outgoingRequests || []).map(playerById).filter(Boolean).map(publicPlayer)
  });
});

app.get('/api/rankings', (req, res) => {
  const players = Object.values(db.players)
    .sort((a, b) => (b.xb || 0) - (a.xb || 0))
    .slice(0, 100)
    .map(publicPlayer);
  res.json({ ok: true, players });
});

app.post('/api/rooms', (req, res) => {
  const game = validGame(req.body?.game);
  const player = ensurePlayer(req.body?.playerId, req.body?.name);
  const room = createRoom(game, req.body?.password, null, player);
  res.status(201).json({ ok: true, ...roomPublic(room) });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = findRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'كود الغرفة غير موجود' });
  return res.json({ ok: true, ...roomPublic(room) });
});

app.post('/api/rooms/:code/join', (req, res) => {
  const room = findRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'كود الغرفة غير موجود' });
  const player = ensurePlayer(req.body?.playerId, req.body?.name);
  const fakeSocket = { id: null, join: () => {} };
  const result = joinRoomSocket(fakeSocket, room, player, req.body?.password);
  if (!result.ok) return res.status(400).json(result);
  room.updatedAt = now();
  saveDb();
  return res.json({ ok: true, ...roomPublic(room) });
});

app.post('/api/rooms/:code/play-now', (req, res) => {
  const room = findRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'الغرفة غير موجودة' });
  const player = playerInRoom(room, String(req.body?.playerId || ''));
  if (!player) return res.status(403).json({ error: 'اللاعب ليس داخل الغرفة' });
  if (room.players.length !== 2) return res.status(409).json({ error: 'انتظر اللاعب الثاني' });
  player.ready = true;
  room.status = 'ready';
  maybeStartRoom(room);
  saveDb();
  res.json({ ok: true, room: roomPublic(room) });
});

app.post('/api/quick-match/cancel', (req, res) => {
  removeQuickEntry(String(req.body?.playerId || ''));
  res.json({ ok: true });
});

app.post('/api/tournaments', (req, res) => {
  const size = Number(req.body?.size);
  if (!TOURNAMENT_SIZES.includes(size)) return res.status(400).json({ error: 'حجم بطولة غير صحيح' });
  const host = ensurePlayer(req.body?.playerId, req.body?.hostName || req.body?.name);
  const tournament = createTournament(req.body?.name, req.body?.game, size, host);
  res.status(201).json({ ok: true, tournament: tournamentPublic(tournament), codes: tournament.codes });
});

app.post('/api/tournaments/join', (req, res) => {
  const code = clean(req.body?.code);
  const tournament = Object.values(db.tournaments).find((t) => t.codes.includes(code));
  if (!tournament) return res.status(404).json({ error: 'كود البطولة غير صحيح' });
  if (db.usedTournamentCodes[code]) return res.status(409).json({ error: 'الكود مستخدم بالفعل' });
  if (tournament.status !== 'open') return res.status(409).json({ error: 'البطولة اكتملت أو بدأت' });
  if (tournament.players.length >= tournament.size) return res.status(409).json({ error: 'البطولة ممتلئة' });
  const player = ensurePlayer(req.body?.playerId, req.body?.playerName || req.body?.name);
  if (tournament.players.some((p) => p.id === player.id)) return res.status(409).json({ error: 'أنت مسجل بالفعل' });
  db.usedTournamentCodes[code] = { tournamentId: tournament.id, playerId: player.id, usedAt: now() };
  tournament.players.push({ id: player.id, name: player.name });
  tournament.updatedAt = now();
  if (tournament.players.length === tournament.size) {
    buildTournamentBracket(tournament);
    autoOpenTournamentMatches(tournament);
  }
  saveDb();
  io.emit('tournament:update', tournamentPublic(tournament));
  res.json({ ok: true, tournament: tournamentPublic(tournament) });
});

app.get('/api/tournaments', (req, res) => {
  const list = Object.values(db.tournaments)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100)
    .map(tournamentPublic);
  res.json({ ok: true, tournaments: list });
});

app.get('/api/tournaments/:id', (req, res) => {
  const tournament = db.tournaments[req.params.id];
  if (!tournament) return res.status(404).json({ error: 'البطولة غير موجودة' });
  return res.json({ ok: true, tournament: tournamentPublic(tournament) });
});

app.post('/api/tournaments/:id/match/:matchId/result', (req, res) => {
  const tournament = db.tournaments[req.params.id];
  if (!tournament) return res.status(404).json({ error: 'البطولة غير موجودة' });
  const result = tournamentMatchResult(tournament, req.params.matchId, String(req.body?.winnerId || ''), req.body?.score || null);
  if (!result.ok) return res.status(400).json(result);
  io.emit('tournament:update', tournamentPublic(tournament));
  autoOpenTournamentMatches(tournament);
  res.json(result);
});

/* -------------------------------------------------------------------------- */
/* NEWS ENGINE                                                                */
/* -------------------------------------------------------------------------- */

function decodeXml(value = '') {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseRss(xml, sourceName) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => {
    const block = match[1];
    const get = (tag) => {
      const found = block.match(new RegExp(`<${tag}(?: [^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return found ? decodeXml(found[1].trim()) : '';
    };
    return {
      title: get('title'),
      link: get('link'),
      source: sourceName || get('source'),
      publishedAt: get('pubDate'),
      description: get('description')
    };
  }).filter((item) => item.title && item.link);
}

const NEWS_SOURCES = [
  { name: 'FilGoal', query: 'site:filgoal.com football' },
  { name: 'YallaKora', query: 'site:yallakora.com كرة القدم' },
  { name: 'GOAL', query: 'site:goal.com football' },
  { name: 'ESPN FC', query: 'site:espn.com/soccer football' },
  { name: 'Sky Sports Football', query: 'site:skysports.com/football football' },
  { name: 'FourFourTwo', query: 'site:fourfourtwo.com football' },
  { name: 'Kicker', query: 'site:kicker.de fußball' },
  { name: 'Marca', query: 'site:marca.com fútbol' },
  { name: 'L’Équipe', query: 'site:lequipe.fr football' }
];

function newsUrl(query) {
  return 'https://news.google.com/rss/search?q=' + encodeURIComponent(query) + '&hl=ar&gl=EG&ceid=EG:ar';
}

async function fetchNewsSource(source) {
  try {
    const response = await fetch(newsUrl(source.query), {
      headers: { 'user-agent': 'R2-GAMES-News/11.0' },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const xml = await response.text();
    return parseRss(xml, source.name).slice(0, 8);
  } catch (error) {
    console.warn('[NEWS]', source.name, error.message);
    return [];
  }
}

const translationCache = new Map();

async function translateToArabic(text) {
  const value = String(text || '').trim();
  if (!value || (/^[\u0600-\u06FF\s\d.,!?()\-]+$/.test(value))) return value;
  if (translationCache.has(value)) return translationCache.get(value);
  try {
    const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(value) + '&langpair=auto|ar';
    const response = await fetch(url, { signal: AbortSignal.timeout(3500), headers: { 'user-agent': 'R2-GAMES-News/11.1' } });
    if (!response.ok) return value;
    const json = await response.json();
    const translated = json?.responseData?.translatedText || value;
    translationCache.set(value, translated);
    if (translationCache.size > 1000) translationCache.delete(translationCache.keys().next().value);
    return translated;
  } catch (_) { return value; }
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try { out[i] = await worker(items[i], i); } catch (_) { out[i] = items[i]; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return out;
}

async function buildNews() {
  const buckets = await Promise.all(NEWS_SOURCES.map(fetchNewsSource));
  const all = buckets.flat();
  const seen = new Set();
  const unique = all.filter((item) => {
    const key = (item.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 45);
  // Translate in parallel so one slow translation service cannot freeze /api/news.
  return mapLimit(unique, 8, async (item) => ({
    ...item,
    originalTitle: item.title,
    title: await translateToArabic(item.title),
    language: /[\u0600-\u06FF]/.test(item.title) ? 'ar' : 'auto'
  }));
}

let newsCache = { items: [], updatedAt: 0, refreshing: false, lastError: null };

function refreshNewsInBackground() {
  if (newsCache.refreshing) return;
  newsCache.refreshing = true;
  buildNews().then((items) => {
    if (items.length) newsCache = { items, updatedAt: now(), refreshing: false, lastError: null };
    else newsCache.refreshing = false;
  }).catch((error) => {
    newsCache.refreshing = false;
    newsCache.lastError = error.message;
    console.warn('[NEWS] refresh failed:', error.message);
  });
}

app.get('/api/news', (req, res) => {
  const stale = !newsCache.items.length || now() - newsCache.updatedAt > 10 * 60 * 1000;
  if (stale) refreshNewsInBackground();
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    ready: newsCache.items.length > 0,
    refreshing: newsCache.refreshing,
    items: newsCache.items,
    updatedAt: newsCache.updatedAt,
    sources: NEWS_SOURCES.map((s) => s.name)
  });
});

// Warm the cache without making the first browser request wait for external sites.
setTimeout(refreshNewsInBackground, 500);

/* -------------------------------------------------------------------------- */
/* SOCKET PROTOCOL                                                            */
/* -------------------------------------------------------------------------- */

const socketRate = new Map();

function allowSocketEvent(socket, key, limit = 60, windowMs = 10000) {
  const mapKey = socket.id + ':' + key;
  const record = socketRate.get(mapKey) || { start: now(), count: 0 };
  if (now() - record.start >= windowMs) {
    record.start = now();
    record.count = 0;
  }
  record.count += 1;
  socketRate.set(mapKey, record);
  return record.count <= limit;
}

function ack(cb, payload) {
  if (typeof cb === 'function') cb(payload);
}

io.on('connection', (socket) => {
  socket.on('identify', (data = {}, cb = () => {}) => {
    if (!allowSocketEvent(socket, 'identify', 10, 10000)) return ack(cb, { ok: false, error: 'طلبات كثيرة' });
    const player = ensurePlayer(data.playerId, data.name);
    addPresence(socket, player);
    for (const t of Object.values(db.tournaments)) if (t.status === 'playing') autoOpenTournamentMatches(t);
    ack(cb, { ok: true, player: publicPlayer(player), daily: dailyPublic(player) });
    socket.emit('player:data', publicPlayer(player));
  });

  socket.on('room:create', (data = {}, cb = () => {}) => {
    if (!allowSocketEvent(socket, 'room-create', 10, 10000)) return ack(cb, { ok: false, error: 'طلبات كثيرة' });
    const player = ensurePlayer(data.playerId || socket.data.playerId, data.name || socket.data.name);
    addPresence(socket, player);
    const room = createRoom(data.game, data.password, socket, player);
    socket.join(room.code);
    ack(cb, { ok: true, ...roomPublic(room) });
  });

  socket.on('room:join', (data = {}, cb = () => {}) => {
    if (!allowSocketEvent(socket, 'room-join', 20, 10000)) return ack(cb, { ok: false, error: 'طلبات كثيرة' });
    const room = findRoom(data.code);
    if (!room) return ack(cb, { ok: false, error: 'كود الغرفة غير موجود أو انتهت صلاحيته' });
    const player = ensurePlayer(data.playerId || socket.data.playerId, data.name || socket.data.name);
    addPresence(socket, player);
    const result = joinRoomSocket(socket, room, player, data.password);
    if (!result.ok) return ack(cb, result);
    socket.join(room.code);
    room.state.revision += 1;
    saveDb();
    broadcastRoom(room, 'room:players');
    io.to(room.code).emit('room:connected', roomPublic(room));
    ack(cb, { ok: true, reconnected: result.reconnected, ...roomPublic(room) });
  });

  socket.on('room:play-now', (data = {}, cb = () => {}) => {
    if (!allowSocketEvent(socket, 'play-now', 10, 10000)) return ack(cb, { ok: false, error: 'طلبات كثيرة' });
    const room = findRoom(data.code);
    const check = requireRoomPlayer(socket, room);
    if (!check.ok) return ack(cb, check);
    const result = markReady(room, socket);
    ack(cb, result);
  });

  socket.on('room:state-request', (data = {}, cb = () => {}) => {
    const room = findRoom(data.code);
    const check = requireRoomPlayer(socket, room);
    if (!check.ok) return ack(cb, check);
    ack(cb, { ok: true, room: roomPublic(room), state: clone(room.state) });
  });

  socket.on('game:event', (data = {}, cb = () => {}) => {
    if (!allowSocketEvent(socket, 'game-event', 120, 10000)) return ack(cb, { ok: false, error: 'سرعة إرسال عالية' });
    const room = findRoom(data.code);
    const check = requireRoomPlayer(socket, room);
    if (!check.ok) return ack(cb, check);
    const result = serverGameEvent(room, socket, data.type, data.data);
    ack(cb, result);
  });

  socket.on('game:complete', (data = {}, cb = () => {}) => {
    const room = findRoom(data.code);
    const check = requireRoomPlayer(socket, room);
    if (!check.ok) return ack(cb, check);
    if (!room.state.ended) finalizeRoom(room, { winnerId: data.winnerId || null, draw: !!data.draw });
    ack(cb, { ok: true, state: clone(room.state) });
  });

  socket.on('match:score-request', (data = {}, cb = () => {}) => {
    const room = findRoom(data.code);
    const check = requireRoomPlayer(socket, room);
    if (!check.ok) return ack(cb, check);
    const score = randomMatchScore();
    room.state.data.score = score;
    room.state.revision += 1;
    const winner = score.home === score.away ? null : (score.home > score.away ? room.players[0].playerId : room.players[1].playerId);
    finalizeRoom(room, { score, winnerId: winner, draw: score.home === score.away });
    ack(cb, { ok: true, score, state: clone(room.state) });
  });

  socket.on('guess:start', (data = {}, cb = () => {}) => {
    const room = findRoom(data.code);
    const check = requireRoomPlayer(socket, room);
    if (!check.ok) return ack(cb, check);
    if (room.game !== 'guess') return ack(cb, { ok: false, error: 'هذه ليست لعبة تخمين اللاعب' });
    newGuessState(room);
    room.state.turn = room.players[0]?.playerId || null;
    room.state.revision += 1;
    io.to(room.code).emit('guess:state', publicGuessState(room));
    ack(cb, { ok: true, guess: publicGuessState(room) });
  });

  socket.on('guess:answer', (data = {}, cb = () => {}) => {
    const room = findRoom(data.code);
    const check = requireRoomPlayer(socket, room);
    if (!check.ok) return ack(cb, check);
    if (room.game !== 'guess') return ack(cb, { ok: false, error: 'هذه ليست لعبة تخمين اللاعب' });
    const result = serverGameEvent(room, socket, 'guess:answer', { answer: String(data.answer || '').slice(0, 120) });
    ack(cb, result);
  });

  socket.on('quick:join', (data = {}, cb = () => {}) => {
    if (!allowSocketEvent(socket, 'quick-join', 10, 10000)) return ack(cb, { ok: false, error: 'طلبات كثيرة' });
    const player = ensurePlayer(data.playerId || socket.data.playerId, data.name || socket.data.name);
    addPresence(socket, player);
    removeQuickEntry(player.id);
    const entry = { playerId: player.id, game: validGame(data.game), createdAt: now() };
    const room = tryQuickMatch(entry);
    if (room) {
      ack(cb, { ok: true, matched: true, room: roomPublic(room) });
      return;
    }
    quickQueue.set(quickKey(entry.game), entry);
    ack(cb, { ok: true, matched: false, queued: true, game: entry.game });
    socket.emit('quick:waiting', { game: entry.game });
  });

  socket.on('quick:cancel', (data = {}, cb = () => {}) => {
    const playerId = String(data.playerId || socket.data.playerId || '');
    removeQuickEntry(playerId);
    ack(cb, { ok: true });
  });

  socket.on('quick:invite', (data = {}, cb = () => {}) => {
    const from = playerById(String(data.playerId || socket.data.playerId || ''));
    const to = playerById(String(data.friendId || ''));
    if (!from || !to) return ack(cb, { ok: false, error: 'صديق غير صالح' });
    if (!(from.friends || []).includes(to.id)) return ack(cb, { ok: false, error: 'اللاعب ليس في قائمة الأصدقاء' });
    const target = socketForPlayer(to.id);
    if (!target) return ack(cb, { ok: false, error: 'الصديق غير متصل حاليًا' });
    target.emit('quick:invite', { from: publicPlayer(from), game: validGame(data.game) });
    ack(cb, { ok: true });
  });

  socket.on('quick:accept', (data = {}, cb = () => {}) => {
    const from = playerById(String(data.fromId || ''));
    const player = ensurePlayer(data.playerId || socket.data.playerId, data.name || socket.data.name);
    if (!from) return ack(cb, { ok: false, error: 'الدعوة انتهت' });
    const fromSocket = socketForPlayer(from.id);
    if (!fromSocket) return ack(cb, { ok: false, error: 'الصديق غير متصل' });
    const room = createRoom(data.game, '', fromSocket, from);
    room.quickMatch = true;
    joinRoomSocket(socket, room, player, '');
    fromSocket.join(room.code);
    socket.join(room.code);
    room.status = 'connected';
    io.to(room.code).emit('quick:matched', { room: roomPublic(room), game: room.game });
    io.to(room.code).emit('room:connected', roomPublic(room));
    ack(cb, { ok: true, room: roomPublic(room) });
  });

  socket.on('friends:add', (data = {}, cb = () => {}) => {
    const player = ensurePlayer(data.playerId || socket.data.playerId, data.name || socket.data.name);
    const result = addFriendRequest(player.id, data.friendId);
    ack(cb, result);
  });

  socket.on('friends:accept', (data = {}, cb = () => {}) => {
    const result = acceptFriendRequest(String(data.playerId || socket.data.playerId), String(data.friendId || ''));
    ack(cb, result);
  });

  socket.on('friends:reject', (data = {}, cb = () => {}) => {
    const result = rejectFriendRequest(String(data.playerId || socket.data.playerId), String(data.friendId || ''));
    ack(cb, result);
  });

  socket.on('friends:list', (data = {}, cb = () => {}) => {
    const player = playerById(String(data.playerId || socket.data.playerId || ''));
    if (!player) return ack(cb,{ok:false,error:'اللاعب غير موجود'});
    ack(cb,{ok:true,friends:friendsPublic(player),incomingRequests:(player.incomingRequests||[]).map(playerById).filter(Boolean).map(publicPlayer),outgoingRequests:(player.outgoingRequests||[]).map(playerById).filter(Boolean).map(publicPlayer)});
  });

  socket.on('inbox:get', (data = {}, cb = () => {}) => {
    const player = playerById(String(data.playerId || socket.data.playerId || ''));
    if (!player) return ack(cb,{ok:false,error:'اللاعب غير موجود'});
    ack(cb,{ok:true,incomingRequests:(player.incomingRequests||[]).map(playerById).filter(Boolean).map(publicPlayer),welcomeAvailable:!player.rewardClaims?.welcome_v1});
  });

  socket.on('daily:get', (data = {}, cb = () => {}) => {
    const player = playerById(String(data.playerId || socket.data.playerId || ''));
    if (!player) return ack(cb,{ok:false,error:'اللاعب غير موجود'});
    ack(cb,{ok:true,daily:dailyPublic(player)});
  });

  socket.on('daily:claim', (data = {}, cb = () => {}) => {
    const player = playerById(String(data.playerId || socket.data.playerId || ''));
    if (!player) return ack(cb,{ok:false,error:'اللاعب غير موجود'});
    const result=claimDailyTask(player,String(data.taskId||''));
    ack(cb,result);
  });

  socket.on('welcome:claim', (data = {}, cb = () => {}) => {
    const player=playerById(String(data.playerId||socket.data.playerId||''));
    if(!player)return ack(cb,{ok:false,error:'اللاعب غير موجود'});
    ack(cb,claimWelcome(player));
  });

  socket.on('draft:open-free', (data = {}, cb = () => {}) => {
    const player=playerById(String(data.playerId||socket.data.playerId||''));
    if(!player)return ack(cb,{ok:false,error:'اللاعب غير موجود'});
    if((player.freeDrafts||0)<1)return ack(cb,{ok:false,error:'لا يوجد Draft مجاني'});
    const cards=draftCandidates(player,3); if(!cards.length)return ack(cb,{ok:false,error:'لا يوجد لاعب جديد بدون تكرار'});
    player.freeDrafts-=1; player.ownedPlayers=player.ownedPlayers||[]; player.ownedPlayers.push(cards[0]); saveDb();
    ack(cb,{ok:true,card:cards[0],choices:cards,player:publicPlayer(player)});
  });

  socket.on('game:single-complete', (data = {}, cb = () => {}) => {
    const player=playerById(String(data.playerId||socket.data.playerId||''));
    if(!player)return ack(cb,{ok:false,error:'اللاعب غير موجود'});
    ack(cb,completeGameForPlayer(player,validGame(data.game),data.claimKey,data.result||{}));
  });

  socket.on('player:sync', (data = {}, cb = () => {}) => {
    const player = ensurePlayer(data.playerId || socket.data.playerId, data.name || socket.data.name);
    addPresence(socket, player);
    ack(cb, { ok: true, player: publicPlayer(player) });
  });

  socket.on('disconnect', () => {
    const room = roomForSocket(socket);
    if (room) leaveRoomSocket(socket);
    removePresence(socket);
    socketRate.delete(socket.id);
  });
});

/* -------------------------------------------------------------------------- */
/* PERIODIC MAINTENANCE                                                       */
/* -------------------------------------------------------------------------- */

setInterval(() => {
  const cutoff = now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) {
    if (room.lastActivity < cutoff && !room.state.started) rooms.delete(code);
    else if (room.lastActivity < cutoff && room.state.ended) rooms.delete(code);
  }
}, 60 * 1000);

setInterval(() => {
  const cutoff = now() - QUICK_MATCH_TTL_MS;
  for (const [game, entry] of quickQueue) {
    if (entry.createdAt < cutoff) {
      quickQueue.delete(game);
      emitToPlayer(entry.playerId, 'quick:expired', { game });
    }
  }
}, 15 * 1000);

setInterval(() => {
  refreshNewsInBackground();
}, 10 * 60 * 1000);

setInterval(() => {
  saveDb();
}, 30 * 1000);

/* -------------------------------------------------------------------------- */
/* ERROR HANDLING                                                             */
/* -------------------------------------------------------------------------- */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'NOT FOUND', path: req.path });
  }
  const index = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  return res.status(404).send('<h2>R2 GAMES: index.html not found</h2>');
});

app.use((error, req, res, next) => {
  console.error('[HTTP]', error.stack || error.message || error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'خطأ داخلي في السيرفر' });
});

process.on('SIGTERM', () => {
  flushDb();
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  flushDb();
  server.close(() => process.exit(0));
});

/* -------------------------------------------------------------------------- */
/* STARTUP                                                                    */
/* -------------------------------------------------------------------------- */

server.listen(PORT, HOST, () => {
  console.log('==================================================');
  console.log('R2 GAMES WORLD SERVER ' + APP_VERSION);
  console.log('Authoritative Multiplayer: ON');
  console.log('Games: ' + GAME_NAMES.join(', '));
  console.log('Room code: 8 alphanumeric characters');
  console.log('Player ID: 16 decimal digits');
  console.log('Tournament sizes: ' + TOURNAMENT_SIZES.join(', '));
  console.log('Quick Match: ON');
  console.log('Friends: ON');
  console.log('News engine: ON');
  console.log('Listening on ' + HOST + ':' + PORT);
  console.log('==================================================');
});

/* -------------------------------------------------------------------------- */
/* DOCUMENTATION / PROTOCOL CONTRACT                                          */
/* -------------------------------------------------------------------------- */

/*
01. room:create      create a two-player authoritative room.
02. room:join        join or reconnect by 8-character room code.
03. room:play-now    explicit readiness signal from each player.
04. game:start       emitted only when both players are ready.
05. game:event       validated server-side before broadcast.
06. game:sync        authoritative revision/state snapshot.
07. game:complete    idempotent completion and reward claim.
08. guess:start      initializes five unique rounds.
09. guess:answer     server checks the answer and awards the point.
10. guess:state      sends the current round/turn/score.
11. guess:finished   sends the final five-round score.
12. quick:join       pairs players without a room code.
13. quick:invite     invites an existing friend.
14. quick:accept     converts the invitation into a live room.
15. friends:add      sends a real friend request.
16. friends:accept   establishes a two-way friendship.
17. friends:reject   removes a pending request.
18. tournament:*     controls bracket lifecycle.
19. match:score-request produces varied server-side scores.
20. player:sync      restores server resources/profile.

The important rule is simple:
The client may REQUEST an action, but the server DECIDES whether the action
is legal and then publishes the resulting authoritative state.
*/

/*
Compatibility aliases intentionally live here so older frontend versions can
be upgraded without changing the visual design. They do not make the client
authoritative; they only preserve event names used by previous R2 builds.
*/

/*
Room lifecycle:
WAITING -> CONNECTED -> READY -> PLAYING -> FINISHED
                       \-> RECONNECTING -> PLAYING

Quick Match lifecycle:
QUEUE -> MATCHED -> CONNECTED -> READY -> PLAYING

Tournament lifecycle:
OPEN -> FULL -> PLAYING -> ROUND_ADVANCE -> FINISHED

Guess lifecycle:
ROUND 1 -> player A -> player B -> ROUND 2 -> ... -> ROUND 5 -> FINISHED
*/

/*
Reward contract:
A reward must always have a deterministic claim key. If the same completion
arrives twice because of reconnect/retry, claimReward returns duplicate=true
and does not add the currency twice.
*/

/*
Security contract:
- IDs are validated as 16 decimal digits.
- Room codes are normalized and validated by lookup.
- Game names are restricted to the six registered games.
- Socket events are rate limited.
- Event payloads are bounded and copied into server state.
- Turn-bound events are rejected when sent out of turn.
- Tournament winners must be one of the actual match participants.
*/

/*
Scaling contract:
This single-process edition is intentionally cleanly separated into:
  repository -> presence -> rooms -> game state -> tournament -> news.
For horizontal scaling, replace the Map/JSON adapters with Redis/PostgreSQL
and configure Socket.IO's Redis adapter. No game rule API needs to change.
*/

/*
News contract:
The server aggregates FilGoal, YallaKora and several major international
football publications through Google News RSS search feeds, deduplicates
headlines, and attempts Arabic translation for non-Arabic headlines. The
original source link remains available to the frontend.
*/

/*
This final block deliberately contains no client-side game logic. The client
should remain responsible for rendering, animation, input controls and the
existing R2 visual experience. The server is responsible for identity,
rooms, readiness, synchronization, validation, outcomes and persistence.
*/
