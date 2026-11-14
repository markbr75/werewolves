'use strict';
// Werewolf server: serves the player screen, runs the games over WebSocket,
// and hands out LiveKit tokens for the video room.

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { AccessToken } = require('livekit-server-sdk');
const { Game } = require('./game');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env file, use real env vars */ }

const PORT = process.env.PORT || 3000;
const LIVEKIT_URL = process.env.LIVEKIT_URL || '';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const VIDEO_ON = Boolean(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET);
const HOST_PASSCODE = (process.env.HOST_PASSCODE || '').trim(); // if set, only people who know it can start a village
const SPEED = Number(process.env.WW_SPEED) || 1; // e.g. 0.02 makes timers 50x faster for tests

const games = new Map();   // code -> Game
const sockets = new Map(); // playerId -> ws

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, they read as 1 and 0
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join('');
  } while (games.has(code));
  return code;
}

// Wrong village codes and wrong passcodes are counted per visitor, so nobody can find a game by guessing.
const MAX_WRONG = 8;
const WRONG_WINDOW_MS = 10 * 60 * 1000;
const wrongTries = new Map(); // visitor address -> { count, until }
function blocked(who) {
  const w = wrongTries.get(who);
  if (w && w.until < Date.now()) { wrongTries.delete(who); return false; }
  return Boolean(w && w.count >= MAX_WRONG);
}
function wrong(who) {
  const w = wrongTries.get(who) || { count: 0, until: Date.now() + WRONG_WINDOW_MS };
  w.count++;
  wrongTries.set(who, w);
}
function samePasscode(given) {
  const a = crypto.createHash('sha256').update(String(given || '').trim().toLowerCase()).digest();
  const b = crypto.createHash('sha256').update(HOST_PASSCODE.toLowerCase()).digest();
  return crypto.timingSafeEqual(a, b);
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(game) {
  for (const p of game.players.values()) {
    const ws = sockets.get(p.id);
    if (ws) send(ws, { type: 'state', state: game.viewFor(p.id) });
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/vendor/livekit-client.umd.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/livekit-client/dist/livekit-client.umd.js'));
});
app.get('/healthz', (req, res) => res.json({ ok: true, video: VIDEO_ON, passcode: Boolean(HOST_PASSCODE), games: games.size }));
app.get('/api/config', (req, res) => res.json({ passcodeRequired: Boolean(HOST_PASSCODE) }));

// A player swaps their private game secret for a token to the video room.
app.get('/api/token', async (req, res) => {
  if (!VIDEO_ON) return res.status(503).json({ error: 'Video is not set up on this server.' });
  const game = games.get(String(req.query.code || '').toUpperCase());
  const player = game && game.players.get(String(req.query.id || ''));
  if (!player || player.secret !== req.query.secret) return res.status(403).json({ error: 'Not in this game.' });
  if (game.settings.mode === 'inperson') return res.status(409).json({ error: 'This village is playing in person, without video.' });
  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: player.id, name: player.name, ttl: '6h',
  });
  token.addGrant({ roomJoin: true, room: `werewolf-${game.code}`, canPublish: true, canSubscribe: true });
  res.json({ url: LIVEKIT_URL, token: await token.toJwt() });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws, req) => {
  const who = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  let game = null;
  let playerId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  function attach(g, id) {
    game = g; playerId = id;
    const old = sockets.get(id);
    if (old && old !== ws) { old.replaced = true; old.close(); }
    sockets.set(id, ws);
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.type === 'create' || msg.type === 'join') {
        if (game) return;
        if (blocked(who)) throw new Error('Too many wrong tries. Wait ten minutes and try again.');
        let g;
        if (msg.type === 'create') {
          if (HOST_PASSCODE && !samePasscode(msg.passcode)) {
            wrong(who);
            throw new Error('That host passcode is not right. Only the host needs it; to join a game, use the village code.');
          }
          g = new Game(newCode(), { speed: SPEED, onChange: broadcast, mode: msg.mode });
          games.set(g.code, g);
        } else {
          g = games.get(String(msg.code || '').trim().toUpperCase());
          if (!g) { wrong(who); throw new Error('No game with that code. Check it and try again.'); }
        }
        const id = crypto.randomUUID();
        const secret = crypto.randomBytes(16).toString('hex');
        attach(g, id);
        send(ws, { type: 'joined', code: g.code, id, secret, video: VIDEO_ON });
        try { g.addPlayer(id, secret, msg.name); } catch (e) {
          sockets.delete(id); game = null; playerId = null;
          if (msg.type === 'create') { games.delete(g.code); g.destroy(); }
          send(ws, { type: 'left' });
          throw e;
        }
        return;
      }
      if (msg.type === 'rejoin') {
        if (game) return;
        const g = games.get(String(msg.code || '').toUpperCase());
        const p = g && g.players.get(msg.id);
        if (!p || p.secret !== msg.secret) return send(ws, { type: 'left' });
        attach(g, p.id);
        send(ws, { type: 'joined', code: g.code, id: p.id, secret: p.secret, video: VIDEO_ON });
        g.setConnected(p.id, true);
        return;
      }
      if (msg.type === 'leave') {
        if (game && game.phase === 'lobby') game.removePlayer(playerId);
        send(ws, { type: 'left' });
        sockets.delete(playerId);
        if (game && game.phase !== 'lobby') game.setConnected(playerId, false);
        game = null; playerId = null;
        return;
      }
      if (!game || !game.players.has(playerId)) return send(ws, { type: 'left' });
      game.act(playerId, msg);
    } catch (e) {
      send(ws, { type: 'error', message: e.message || 'Something went wrong.' });
    }
  });

  ws.on('close', () => {
    if (!game || ws.replaced) return;
    if (sockets.get(playerId) === ws) sockets.delete(playerId);
    if (game.players.has(playerId)) game.setConnected(playerId, false);
  });
});

// Drop dead connections, and games that everyone has left.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [who, w] of wrongTries) if (w.until < now) wrongTries.delete(who);
  for (const [code, g] of games) {
    const anyone = [...g.players.values()].some(p => p.connected);
    const idle = now - g.touched;
    if ((!anyone && idle > 10 * 60 * 1000) || idle > 6 * 60 * 60 * 1000) { g.destroy(); games.delete(code); }
  }
}, 25000).unref();

server.listen(PORT, () => {
  console.log(`Werewolf is running on http://localhost:${PORT}`);
  console.log(HOST_PASSCODE ? 'Starting a village needs the host passcode.' : 'No HOST_PASSCODE set: anyone who finds this address can start a village.');
  console.log(VIDEO_ON ? `Video: on (${LIVEKIT_URL})` : 'Video: OFF. Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET to turn it on.');
});
