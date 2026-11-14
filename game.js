'use strict';
// Werewolf game engine. One Game per room. The server owns all secrets;
// each player only ever receives the view built by viewFor().

const TIMES = {
  reveal: 15,      // role reveal before the first night
  nightMin: 20,    // a night never ends faster than this, so timing gives little away
  nightMax: 75,
  witchMin: 10,
  witchMax: 30,
  dawn: 8,
  hunter: 30,
  hunterResult: 5,
  vote: 60,
  verdict: 8,
};

const MAX_PLAYERS = 18;
const MIN_PLAYERS = 4;

const DEFAULT_SETTINGS = {
  wolves: 0,          // 0 = automatic for the player count
  seer: true,
  doctor: true,
  hunter: true,
  witch: true,
  discussSecs: 180,
  revealRoles: true,  // show a player's role when they die
  mode: 'online',     // 'online' = cameras on, 'inperson' = same room, no video
};
const MODES = ['online', 'inperson'];

function spokenTime(secs) {
  if (secs < 60) return `${secs} seconds`;
  const m = Math.floor(secs / 60), s = secs % 60;
  return `${m} minute${m === 1 ? '' : 's'}${s ? ` ${s} seconds` : ''}`;
}

function autoWolves(n) {
  if (n <= 6) return 1;
  if (n <= 10) return 2;
  if (n <= 14) return 3;
  return 4;
}

// Which roles a game of n players gets, given the host's settings.
function composition(n, s) {
  const maxWolves = Math.max(1, Math.floor((n - 1) / 2));
  const wolves = Math.min(maxWolves, Math.max(1, s.wolves || autoWolves(n)));
  const out = { werewolf: wolves, seer: 0, doctor: 0, hunter: 0, witch: 0, villager: 0 };
  let rest = n - wolves;
  const want = [['seer', 4], ['doctor', 5], ['hunter', 6], ['witch', 7]];
  for (const [role, minPlayers] of want) {
    if (s[role] && n >= minPlayers && rest > 0) { out[role] = 1; rest--; }
  }
  out.villager = rest;
  return out;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class Game {
  constructor(code, opts = {}) {
    this.code = code;
    this.players = new Map();
    this.hostId = null;
    this.phase = 'lobby';
    this.step = null;
    this.round = 0;
    this.settings = { ...DEFAULT_SETTINGS };
    if (MODES.includes(opts.mode)) this.settings.mode = opts.mode;
    this.narration = { seq: 0, text: '' };   // the narrator's latest line, the same for every player
    this.speed = opts.speed || 1;          // <1 shortens every timer (used by tests)
    this.onChange = opts.onChange || (() => {});
    this.timer = null;
    this.minTimer = null;
    this.deadline = null;
    this.log = [];
    this.touched = Date.now();
    this.resetRound();
  }

  resetRound() {
    this.night = null;
    this.votes = {};
    this.verdict = null;
    this.lastDeaths = [];
    this.pendingHunters = [];
    this.hunterId = null;
    this.hunterShot = undefined;
    this.afterHunter = null;
    this.winner = null;
    this.potions = { heal: true, poison: true };
    this.lastProtected = null;
    this.rolesInGame = {};
  }

  // ---------- helpers ----------
  changed() { this.touched = Date.now(); this.onChange(this); }
  say(text) { this.log.push({ t: Date.now(), text }); if (this.log.length > 60) this.log.shift(); }
  // The narrator speaks `text` aloud on the players' devices; `logText` (or the same words) goes in the story log.
  narrate(text, logText) { this.say(logText || text); this.narration = { seq: this.narration.seq + 1, text }; }
  inPerson() { return this.settings.mode === 'inperson'; }
  name(id) { const p = this.players.get(id); return p ? p.name : 'Someone'; }
  list() { return [...this.players.values()]; }
  alive() { return this.list().filter(p => p.alive); }
  aliveWith(role) { return this.alive().filter(p => p.role === role); }
  clearTimers() {
    clearTimeout(this.timer); clearTimeout(this.minTimer);
    this.timer = null; this.minTimer = null; this.deadline = null;
  }
  after(secs, fn) {
    clearTimeout(this.timer);
    const ms = secs * 1000 * this.speed;
    this.deadline = Date.now() + ms;
    this.timer = setTimeout(fn, ms);
  }
  // Run fn once the current step has lasted at least minSecs.
  afterMin(minSecs, fn) {
    clearTimeout(this.minTimer);
    const wait = this.stepStart + minSecs * 1000 * this.speed - Date.now();
    if (wait <= 0) fn(); else this.minTimer = setTimeout(fn, wait);
  }
  destroy() { this.clearTimers(); }

  // ---------- lobby ----------
  addPlayer(id, secret, name) {
    if (this.phase !== 'lobby') throw new Error('That game has already started. Wait for the next round.');
    if (this.players.size >= MAX_PLAYERS) throw new Error(`The village is full (${MAX_PLAYERS} players).`);
    let clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 16) || 'Villager';
    const taken = new Set(this.list().map(p => p.name.toLowerCase()));
    let unique = clean, n = 2;
    while (taken.has(unique.toLowerCase())) unique = `${clean} ${n++}`;
    this.players.set(id, {
      id, secret, name: unique, role: null, alive: true, connected: true,
      ready: false, seerResults: [],
    });
    if (!this.hostId) this.hostId = id;
    this.changed();
  }

  setConnected(id, connected) {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = connected;
    if (!connected && id === this.hostId) {
      const next = this.list().find(q => q.connected);
      if (next) this.hostId = next.id;
    }
    if (connected && !this.players.get(this.hostId)?.connected) this.hostId = id;
    this.changed();
    if (!connected) this.recheck();
  }

  removePlayer(id) {
    if (this.phase !== 'lobby') return;
    this.players.delete(id);
    if (this.hostId === id) this.hostId = (this.list().find(p => p.connected) || this.list()[0] || {}).id || null;
    this.changed();
  }

  // A disconnect can complete a step that was waiting on that player.
  recheck() {
    if (this.phase === 'night' && this.step === 'acts') this.maybeEndActs();
    if (this.phase === 'vote') this.maybeEndVote();
    if (this.phase === 'reveal') this.maybeEndReveal();
  }

  // ---------- actions ----------
  act(id, msg) {
    const me = this.players.get(id);
    if (!me) return;
    const isHost = id === this.hostId;
    switch (msg.type) {
      case 'settings': {
        if (!isHost || this.phase !== 'lobby') return;
        const s = msg.settings || {};
        for (const k of ['seer', 'doctor', 'hunter', 'witch', 'revealRoles']) {
          if (typeof s[k] === 'boolean') this.settings[k] = s[k];
        }
        if (Number.isInteger(s.wolves) && s.wolves >= 0 && s.wolves <= 6) this.settings.wolves = s.wolves;
        if (MODES.includes(s.mode)) this.settings.mode = s.mode;
        if (Number.isInteger(s.discussSecs)) this.settings.discussSecs = Math.min(600, Math.max(30, s.discussSecs));
        return this.changed();
      }
      case 'kick':
        if (isHost && this.phase === 'lobby' && msg.id !== id) this.removePlayer(msg.id);
        return;
      case 'start':
        if (isHost && this.phase === 'lobby') this.start();
        return;
      case 'ready':
        if (this.phase === 'reveal') { me.ready = true; this.changed(); this.maybeEndReveal(); }
        return;
      case 'wolfVote': return this.wolfVote(me, msg.target);
      case 'seer': return this.seerLook(me, msg.target);
      case 'doctor': return this.doctorProtect(me, msg.target);
      case 'witch': return this.witchAct(me, msg);
      case 'hunter': return this.hunterShoot(me, msg.target);
      case 'startVote':
        if (isHost && this.phase === 'day') this.startVote();
        return;
      case 'vote': return this.castVote(me, msg.target);
      case 'playAgain':
        if (isHost && this.phase === 'over') this.backToLobby();
        return;
    }
  }

  start() {
    // Anyone who dropped out of the lobby is left behind.
    for (const p of this.list()) if (!p.connected) this.players.delete(p.id);
    const n = this.players.size;
    if (n < MIN_PLAYERS) throw new Error(`You need at least ${MIN_PLAYERS} players to start.`);
    this.resetRound();
    const comp = composition(n, this.settings);
    this.rolesInGame = comp;
    const deck = [];
    for (const [role, count] of Object.entries(comp)) for (let i = 0; i < count; i++) deck.push(role);
    shuffle(deck);
    this.list().forEach((p, i) => {
      p.role = deck[i]; p.alive = true; p.ready = false; p.seerResults = [];
    });
    this.round = 0;
    this.log = [];
    this.narrate(this.inPerson()
      ? 'The cards are dealt. Keep your phone to yourself, peek at your role, then tap ready.'
      : 'The cards are dealt. Check your role in secret, then tap ready.', 'The game begins. Check your role.');
    this.phase = 'reveal';
    this.step = null;
    this.after(TIMES.reveal, () => this.startNight());
    this.changed();
  }

  maybeEndReveal() {
    if (this.phase !== 'reveal') return;
    if (this.list().filter(p => p.connected).every(p => p.ready)) this.startNight();
  }

  // ---------- night ----------
  startNight() {
    this.clearTimers();
    this.round++;
    this.phase = 'night';
    this.step = 'acts';
    this.stepStart = Date.now();
    this.night = {
      wolfVotes: {}, victim: null,
      seerDone: false, doctorDone: false, doctorTarget: null,
      witchDone: false, heal: false, poison: null,
    };
    this.lastDeaths = [];
    this.verdict = null;
    // Every role in the game is called every night, alive or not, so the call gives nothing away.
    const r = this.rolesInGame;
    this.narrate(`Night ${this.round} falls on the village. `
      + (this.inPerson() ? 'Eyes on your own phone, and not a word. ' : 'Every screen goes dark. ')
      + 'Werewolves, choose your victim.'
      + (r.seer ? ' Seer, choose someone to read.' : '')
      + (r.doctor ? ' Doctor, choose someone to protect.' : '')
      + (this.inPerson() ? ' Everyone else, tap a name too, so nobody can tell who is who.' : ''),
    `Night ${this.round} falls on the village.`);
    this.after(TIMES.nightMax, () => this.endActs());
    this.changed();
  }

  wolfVote(me, target) {
    if (this.phase !== 'night' || this.step !== 'acts') return;
    if (!me.alive || me.role !== 'werewolf') return;
    const t = this.players.get(target);
    if (!t || !t.alive || t.role === 'werewolf') return;
    this.night.wolfVotes[me.id] = t.id;
    this.changed();
    this.maybeEndActs();
  }

  seerLook(me, target) {
    if (this.phase !== 'night' || this.step !== 'acts') return;
    if (!me.alive || me.role !== 'seer' || this.night.seerDone) return;
    const t = this.players.get(target);
    if (!t || !t.alive || t.id === me.id) return;
    me.seerResults.push({ id: t.id, wolf: t.role === 'werewolf', night: this.round });
    this.night.seerDone = true;
    this.changed();
    this.maybeEndActs();
  }

  doctorProtect(me, target) {
    if (this.phase !== 'night' || this.step !== 'acts') return;
    if (!me.alive || me.role !== 'doctor' || this.night.doctorDone) return;
    const t = this.players.get(target);
    if (!t || !t.alive || t.id === this.lastProtected) return;
    this.night.doctorTarget = t.id;
    this.night.doctorDone = true;
    this.changed();
    this.maybeEndActs();
  }

  actsComplete() {
    const wolves = this.aliveWith('werewolf').filter(p => p.connected);
    const picks = wolves.map(w => this.night.wolfVotes[w.id]);
    if (wolves.length && (picks.some(x => !x) || new Set(picks).size > 1)) return false;
    if (this.aliveWith('seer').some(p => p.connected) && !this.night.seerDone) return false;
    if (this.aliveWith('doctor').some(p => p.connected) && !this.night.doctorDone) return false;
    return true;
  }

  maybeEndActs() {
    if (this.phase !== 'night' || this.step !== 'acts') return;
    if (!this.actsComplete()) { clearTimeout(this.minTimer); this.minTimer = null; return; }
    this.afterMin(TIMES.nightMin, () => {
      if (this.phase === 'night' && this.step === 'acts' && this.actsComplete()) this.endActs();
    });
  }

  endActs() {
    if (this.phase !== 'night' || this.step !== 'acts') return;
    this.clearTimers();
    // The pack kills whoever most wolves chose; a tie is broken at random.
    const tally = {};
    for (const w of this.aliveWith('werewolf')) {
      const t = this.night.wolfVotes[w.id];
      if (t && this.players.get(t)?.alive) tally[t] = (tally[t] || 0) + 1;
    }
    const top = Math.max(0, ...Object.values(tally));
    const tied = Object.keys(tally).filter(k => tally[k] === top);
    this.night.victim = tied.length ? tied[Math.floor(Math.random() * tied.length)] : null;

    if (!this.rolesInGame.witch) return this.resolveNight();
    this.step = 'witch';
    this.stepStart = Date.now();
    const witch = this.aliveWith('witch')[0];
    const canAct = witch && witch.connected && (this.potions.heal || this.potions.poison);
    // If the witch is dead or out of potions, the pause still happens so nobody can tell.
    const secs = canAct ? TIMES.witchMax : TIMES.witchMin + Math.random() * 8;
    this.after(secs, () => this.resolveNight());
    this.narrate('Witch, the night is yours.');
    this.changed();
  }

  witchAct(me, msg) {
    if (this.phase !== 'night' || this.step !== 'witch') return;
    if (!me.alive || me.role !== 'witch' || this.night.witchDone) return;
    if (msg.heal && this.potions.heal && this.night.victim) this.night.heal = true;
    if (msg.poison && this.potions.poison) {
      const t = this.players.get(msg.poison);
      if (t && t.alive && t.id !== me.id) this.night.poison = t.id;
    }
    this.night.witchDone = true;
    this.changed();
    this.afterMin(TIMES.witchMin, () => {
      if (this.phase === 'night' && this.step === 'witch') this.resolveNight();
    });
  }

  resolveNight() {
    if (this.phase !== 'night') return;
    this.clearTimers();
    const n = this.night;
    const deaths = [];
    if (n.victim && n.victim !== n.doctorTarget && !n.heal) deaths.push(n.victim);
    if (n.poison && !deaths.includes(n.poison)) deaths.push(n.poison);
    if (n.heal) this.potions.heal = false;
    if (n.poison) this.potions.poison = false;
    this.lastProtected = n.doctorTarget;
    for (const id of deaths) this.kill(id);
    this.lastDeaths = deaths;
    this.phase = 'dawn';
    this.step = null;
    if (deaths.length) {
      this.narrate(`Dawn breaks. Everyone, wake up. ${deaths.map(id => this.speakDead(id)).join(' and ')} did not survive the night.`,
        `Dawn. ${deaths.map(id => this.describeDead(id)).join(' and ')} did not survive the night.`);
    } else this.narrate('Dawn breaks. Everyone, wake up. Nobody died in the night.', 'Dawn. Nobody died in the night.');
    this.after(TIMES.dawn, () => this.proceed('day'));
    this.changed();
  }

  describeDead(id) {
    const p = this.players.get(id);
    return this.settings.revealRoles ? `${p.name} (${p.role})` : p.name;
  }

  speakDead(id) {
    const p = this.players.get(id);
    return this.settings.revealRoles ? `${p.name}, the ${p.role},` : p.name;
  }

  kill(id) {
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    p.alive = false;
    if (p.role === 'hunter') this.pendingHunters.push(p.id);
  }

  // ---------- flow between phases ----------
  proceed(next) {
    this.clearTimers();
    if (this.pendingHunters.length) {
      this.hunterId = this.pendingHunters.shift();
      this.afterHunter = next;
      this.hunterShot = undefined;
      this.phase = 'hunter';
      this.step = 'aim';
      this.narrate(`${this.name(this.hunterId)} was the hunter and gets one last shot.`);
      this.after(TIMES.hunter, () => this.finishHunter(null));
      return this.changed();
    }
    const winner = this.checkWin();
    if (winner) return this.endGame(winner);
    if (next === 'day') return this.startDay();
    return this.startNight();
  }

  hunterShoot(me, target) {
    if (this.phase !== 'hunter' || this.step !== 'aim' || me.id !== this.hunterId) return;
    const t = target ? this.players.get(target) : null;
    if (target && (!t || !t.alive)) return;
    this.finishHunter(t ? t.id : null);
  }

  finishHunter(targetId) {
    if (this.phase !== 'hunter' || this.step !== 'aim') return;
    this.clearTimers();
    this.hunterShot = targetId;
    if (targetId) {
      this.kill(targetId);
      this.narrate(`${this.name(this.hunterId)} shot ${this.speakDead(targetId).replace(/,$/, '')}.`, `${this.name(this.hunterId)} shot ${this.describeDead(targetId)}.`);
    } else {
      this.narrate(`${this.name(this.hunterId)} lowered the gun without firing.`);
    }
    this.step = 'result';
    this.after(TIMES.hunterResult, () => this.proceed(this.afterHunter));
    this.changed();
  }

  checkWin() {
    const wolves = this.aliveWith('werewolf').length;
    const others = this.alive().length - wolves;
    if (wolves === 0) return 'village';
    if (wolves >= others) return 'werewolves';
    return null;
  }

  endGame(winner) {
    this.clearTimers();
    this.phase = 'over';
    this.step = null;
    this.winner = winner;
    this.narrate(winner === 'village' ? 'The last werewolf is gone. The village wins.' : 'The werewolves have overrun the village. The werewolves win.');
    this.changed();
  }

  backToLobby() {
    this.clearTimers();
    for (const p of this.list()) {
      if (!p.connected) { this.players.delete(p.id); continue; }
      p.role = null; p.alive = true; p.ready = false; p.seerResults = [];
    }
    this.phase = 'lobby';
    this.step = null;
    this.round = 0;
    this.log = [];
    this.resetRound();
    this.changed();
  }

  // ---------- day ----------
  startDay() {
    this.phase = 'day';
    this.step = null;
    this.narrate(`The village talks it over. You have ${spokenTime(this.settings.discussSecs)}.`, 'The village wakes and talks it over.');
    this.after(this.settings.discussSecs, () => this.startVote());
    this.changed();
  }

  startVote() {
    if (this.phase !== 'day') return;
    this.clearTimers();
    this.phase = 'vote';
    this.votes = {};
    this.narrate(this.inPerson() ? 'Time to vote. Pick up your phones and choose who is banished.' : 'Time to vote. Who is banished?', 'Time to vote. Who is banished?');
    this.after(TIMES.vote, () => this.endVote());
    this.changed();
  }

  castVote(me, target) {
    if (this.phase !== 'vote' || !me.alive) return;
    if (target !== 'skip') {
      const t = this.players.get(target);
      if (!t || !t.alive) return;
    }
    if (this.votes[me.id] === target) return;   // a repeat of the same vote changes nothing
    this.votes[me.id] = target;
    this.changed();
    this.maybeEndVote();
  }

  maybeEndVote() {
    if (this.phase !== 'vote') return;
    const voters = this.alive().filter(p => p.connected);
    if (voters.length && voters.every(p => this.votes[p.id])) this.endVote();
  }

  endVote() {
    if (this.phase !== 'vote') return;
    this.clearTimers();
    const tally = {};
    for (const p of this.alive()) {
      const v = this.votes[p.id];
      if (v) tally[v] = (tally[v] || 0) + 1;
    }
    const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    let out = null;
    if (sorted.length && sorted[0][0] !== 'skip' && (sorted.length === 1 || sorted[0][1] > sorted[1][1])) {
      out = sorted[0][0];
    }
    this.verdict = { votes: { ...this.votes }, out };
    if (out) {
      this.kill(out);
      this.narrate(`The village banished ${this.speakDead(out).replace(/,$/, '')}.`, `The village banished ${this.describeDead(out)}.`);
    } else {
      this.narrate('The vote was split. Nobody is banished.', 'The vote was split. Nobody was banished.');
    }
    this.phase = 'verdict';
    this.after(TIMES.verdict, () => this.proceed('night'));
    this.changed();
  }

  // ---------- what one player is allowed to see ----------
  viewFor(id) {
    const me = this.players.get(id);
    if (!me) return null;
    const over = this.phase === 'over';
    const inGame = this.phase !== 'lobby';
    const iAmWolf = me.role === 'werewolf';
    const players = this.list().map(p => ({
      id: p.id, name: p.name, alive: p.alive, connected: p.connected,
      ready: this.phase === 'reveal' ? p.ready : undefined,
      role: inGame && (p.id === id || over || (!p.alive && this.settings.revealRoles) || (iAmWolf && p.role === 'werewolf'))
        ? p.role : null,
    }));
    const v = {
      code: this.code, phase: this.phase, step: this.step, round: this.round,
      deadline: this.deadline, now: Date.now(), hostId: this.hostId,
      settings: this.settings, players, narration: this.narration,
      you: { id, role: me.role, alive: me.alive },
      log: this.log.slice(-25),
      setup: this.phase === 'lobby'
        ? composition(Math.max(MIN_PLAYERS, this.list().filter(p => p.connected).length), this.settings)
        : this.rolesInGame,
      minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS,
    };
    if (me.role === 'seer') v.seerResults = me.seerResults;
    if (this.phase === 'night' && me.alive) {
      const n = this.night;
      if (iAmWolf) v.wolfVotes = n.wolfVotes;
      if (me.role === 'seer') v.acted = n.seerDone;
      if (me.role === 'doctor') { v.acted = n.doctorDone; v.lastProtected = this.lastProtected; v.protecting = n.doctorTarget; }
      if (me.role === 'witch') {
        v.potions = this.potions;
        v.acted = n.witchDone;
        if (this.step === 'witch' && this.potions.heal) v.victim = n.victim;
      }
    }
    if (this.phase === 'dawn') v.deaths = this.lastDeaths;
    if (this.phase === 'hunter') { v.hunterId = this.hunterId; v.hunterShot = this.hunterShot; }
    if (this.phase === 'vote') { v.voted = Object.keys(this.votes); v.myVote = this.votes[id] || null; }
    if (this.phase === 'verdict') v.verdict = this.verdict;
    if (over) v.winner = this.winner;
    return v;
  }
}

module.exports = { Game, composition, TIMES, MAX_PLAYERS, MIN_PLAYERS };
