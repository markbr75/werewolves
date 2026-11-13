'use strict';
// Plays complete games with bot players against a real server and checks that
// nobody is ever sent information their role should not have.
// Usage: node test/simulate.js   (starts its own server on port 3999 with fast timers)

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3999;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
let leaks = 0;

function check(cond, text) { if (!cond) { leaks++; console.error('  LEAK/BUG:', text); } }

function bot(name, code) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const b = { name, ws, state: null, id: null, done: null };
    const finished = new Promise((r) => { b.done = r; });
    b.finished = finished;
    ws.on('open', () => ws.send(JSON.stringify(code ? { type: 'join', code, name } : { type: 'create', name })));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'joined') { b.id = m.id; b.code = m.code; resolve(b); }
      if (m.type === 'error') console.error('  server error for', name, m.message);
      if (m.type === 'state') { b.state = m.state; play(b); }
    });
  });
}

const sendTo = (b, msg) => b.ws.send(JSON.stringify(msg));

function play(b) {
  const S = b.state, me = S.you;
  const living = S.players.filter((p) => p.alive);
  const others = living.filter((p) => p.id !== me.id);

  // ---- secrecy checks on every single state this player receives ----
  if (S.phase !== 'lobby' && S.phase !== 'over') {
    for (const p of S.players) {
      if (p.id === me.id || !p.role) continue;
      const allowed = (!p.alive && S.settings.revealRoles) || (me.role === 'werewolf' && p.role === 'werewolf');
      check(allowed, `${me.role} was told that living ${p.name} is ${p.role}`);
    }
    if (me.role !== 'werewolf') check(!('wolfVotes' in S), `${me.role} received the wolves' votes`);
    if (me.role !== 'witch') check(!('victim' in S) && !('potions' in S), `${me.role} received witch information`);
    if (me.role !== 'seer') check(!('seerResults' in S), `${me.role} received seer results`);
    if (S.phase === 'vote') check(!('verdict' in S), 'individual votes visible before the verdict');
  }

  // ---- act like a player ----
  const key = `${S.phase}:${S.step}:${S.round}`;
  if (S.phase === 'reveal' && b.key !== key) sendTo(b, { type: 'ready' });
  if (S.phase === 'night' && me.alive) {
    if (S.step === 'acts') {
      if (me.role === 'werewolf') {
        // Follow the first wolf's pick so the pack agrees; otherwise choose.
        const leaderPick = Object.values(S.wolfVotes || {})[0];
        const mine = (S.wolfVotes || {})[me.id];
        const target = leaderPick || pick(living.filter((p) => p.role !== 'werewolf')).id;
        if (mine !== target) sendTo(b, { type: 'wolfVote', target });
      }
      if (me.role === 'seer' && !S.acted) sendTo(b, { type: 'seer', target: pick(others).id });
      if (me.role === 'doctor' && !S.acted) sendTo(b, { type: 'doctor', target: pick(living.filter((p) => p.id !== S.lastProtected)).id });
    }
    if (S.step === 'witch' && me.role === 'witch' && !S.acted && b.key !== key) {
      sendTo(b, { type: 'witch', heal: Math.random() < 0.5, poison: Math.random() < 0.3 ? pick(others).id : null });
    }
  }
  if (S.phase === 'hunter' && S.step === 'aim' && S.hunterId === me.id && b.key !== key) {
    sendTo(b, { type: 'hunter', target: Math.random() < 0.8 ? pick(living).id : null });
  }
  if (S.phase === 'day' && me.id === S.hostId && b.key !== key) sendTo(b, { type: 'startVote' });
  if (S.phase === 'vote' && me.alive && !S.myVote) {
    sendTo(b, { type: 'vote', target: Math.random() < 0.1 ? 'skip' : pick(others).id });
  }
  if (S.phase === 'over') b.done(S);
  b.key = key;
}

async function game(n, settings) {
  const host = await bot('Host');
  const bots = [host];
  for (let i = 1; i < n; i++) bots.push(await bot('Bot' + i, host.code));
  if (settings) sendTo(host, { type: 'settings', settings });
  await new Promise((r) => setTimeout(r, 50));
  sendTo(host, { type: 'start' });
  const final = await Promise.race([
    host.finished,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`game of ${n} did not finish`)), 60000)),
  ]);
  const roles = {};
  for (const p of final.players) roles[p.role] = (roles[p.role] || 0) + 1;
  const wolvesAlive = final.players.filter((p) => p.alive && p.role === 'werewolf').length;
  const othersAlive = final.players.filter((p) => p.alive && p.role !== 'werewolf').length;
  check(final.players.length === n, 'player count changed');
  check(final.winner === 'village' ? wolvesAlive === 0 : wolvesAlive >= othersAlive, 'winner does not match the survivors');
  console.log(`${String(n).padStart(2)} players, ${final.round} nights -> ${final.winner.padEnd(10)} ${JSON.stringify(roles)}`);
  for (const b of bots) b.ws.close();
  return final.winner;
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, WW_SPEED: '0.005', LIVEKIT_URL: '' }, stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 800));
  try {
    const wins = { village: 0, werewolves: 0 };
    for (const n of [4, 5, 6, 7, 8, 10, 12, 15, 18, 18, 9, 11, 14, 16, 13, 17]) wins[await game(n)]++;
    await game(8, { revealRoles: false, witch: false, wolves: 3 });
    // A 19th player must be turned away.
    const host = await bot('Host');
    for (let i = 1; i < 18; i++) await bot('P' + i, host.code);
    const extra = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'join', code: host.code, name: 'Nineteen' })));
      ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'error') resolve(m.message); });
    });
    console.log('19th player:', extra);
    console.log('wins', wins, leaks ? `FAILED with ${leaks} problems` : 'ALL CHECKS PASSED');
  } catch (e) {
    console.error('FAILED:', e.message); leaks++;
  } finally {
    server.kill();
    process.exit(leaks ? 1 : 0);
  }
})();
