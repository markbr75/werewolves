'use strict';
/* Werewolf player screen. The server decides everything about the game;
   this file draws what the server says and manages this player's camera. */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LK = window.LivekitClient;

const ROLE_INFO = {
  werewolf: ['Werewolf', 'Each night, agree with the pack on one villager to kill. By day, blend in and survive the vote.'],
  seer: ['Seer', 'Each night, pick one player and learn whether they are a werewolf.'],
  doctor: ['Doctor', 'Each night, protect one player from the wolves. You cannot protect the same player two nights running.'],
  witch: ['Witch', 'You hold one healing potion, to save the wolves’ victim, and one poison, to kill. Each works once.'],
  hunter: ['Hunter', 'When you die, you fire one last shot at anyone you choose.'],
  villager: ['Villager', 'No night power. Watch, listen, and vote out the wolves.'],
};
const PHASE_NAMES = {
  lobby: 'The village gathers', reveal: 'Your role', night: 'Night', dawn: 'Dawn', hunter: 'The hunter’s shot',
  day: 'Day', vote: 'The vote', verdict: 'The verdict', over: 'Game over',
};

let ws = null;
let session = load('ww-session');   // { code, id, secret, video }
let S = null;                       // latest state from the server
let clockSkew = 0;
let lk = null;                      // LiveKit room
let lkStarting = false;
let videoTriedAt = 0;
let mediaKey = '';
let micOn = true, camOn = true;
let lastPhaseKey = '';
let witchDraft = { heal: false, poison: null };
let narratorOn = load('ww-narrator') !== false;
let lastNarration = null;           // seq of the last narrator line this device has dealt with
let decoy = null;                   // in person: the name a player with no night job is tapping
const tiles = new Map();            // playerId -> tile element
const videoTracks = new Map();      // playerId -> video track

function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function save(key, value) { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } }

// ---------- connection ----------
function connect(first) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    if (first) send(first);
    else if (session) send({ type: 'rejoin', ...session });
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => { ws = null; if (session) setTimeout(() => { if (!ws && session) connect(); }, 1500); };
}
function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function handle(msg) {
  if (msg.type === 'joined') {
    session = { code: msg.code, id: msg.id, secret: msg.secret, video: msg.video };
    save('ww-session', session);
    history.replaceState(null, '', '#' + msg.code);
    lastNarration = null;
    keepAwake();
  } else if (msg.type === 'state') {
    clockSkew = msg.state.now - Date.now();
    S = msg.state;
    render();
  } else if (msg.type === 'left') {
    leaveLocal();
  } else if (msg.type === 'error') {
    toast(msg.message);
  }
}

function leaveLocal() {
  session = null; S = null;
  save('ww-session', null);
  stopVideo();
  stopAmbience();
  hush();
  $('game').hidden = true;
  $('home').hidden = false;
  document.body.dataset.phase = 'home';
}

// ---------- home screen ----------
$('nameInput').value = load('ww-name') || '';
$('codeInput').value = (location.hash || '').replace('#', '').slice(0, 4).toUpperCase();
let passcodeRequired = false;
$('passInput').value = load('ww-pass') || '';
fetch('/api/config').then((r) => r.json()).then((c) => {
  passcodeRequired = Boolean(c.passcodeRequired);
  $('passWrap').hidden = !passcodeRequired;
}).catch(() => {});
function enter(type) {
  const name = $('nameInput').value.trim();
  if (!name) { $('nameInput').focus(); return toast('Enter your name first.'); }
  save('ww-name', name);
  const msg = { type, name };
  if (type === 'create') msg.mode = document.querySelector('input[name="mode"]:checked').value;
  if (type === 'create' && passcodeRequired) {
    msg.passcode = $('passInput').value.trim();
    if (!msg.passcode) { $('passInput').focus(); return toast('Enter the host passcode to start a village.'); }
    save('ww-pass', msg.passcode);
  }
  if (type === 'join') {
    msg.code = $('codeInput').value.trim().toUpperCase();
    if (msg.code.length !== 4) { $('codeInput').focus(); return toast('Enter the 4-letter village code.'); }
  }
  unlockSound(); // sound and the narrator's voice need a tap to be allowed
  if (ws && ws.readyState === 1) send(msg); else connect(msg);
}
$('createBtn').onclick = () => enter('create');
$('homeForm').onsubmit = (e) => { e.preventDefault(); enter('join'); };

// ---------- video (LiveKit) ----------
async function startVideo() {
  if (!session || !session.video || lk || lkStarting || !LK || !S || inPerson()) return;
  if (Date.now() - videoTriedAt < 15000) return;   // do not hammer the video server if it is refusing us
  videoTriedAt = Date.now();
  lkStarting = true;
  try {
    const q = new URLSearchParams({ code: session.code, id: session.id, secret: session.secret });
    const res = await fetch('/api/token?' + q);
    if (!res.ok) throw new Error('token');
    const { url, token } = await res.json();
    const room = new LK.Room({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: { resolution: LK.VideoPresets.h180.resolution, facingMode: 'user' },
      publishDefaults: { simulcast: false, videoEncoding: { maxBitrate: 160000, maxFramerate: 15 } },
    });
    room.on(LK.RoomEvent.TrackSubscribed, (track, pub, participant) => attachTrack(track, participant.identity));
    room.on(LK.RoomEvent.TrackUnsubscribed, (track, pub, participant) => detachTrack(track, participant.identity));
    room.on(LK.RoomEvent.LocalTrackPublished, (pub) => { if (pub.track && pub.kind === 'video') attachTrack(pub.track, session.id); });
    room.on(LK.RoomEvent.LocalTrackUnpublished, (pub) => { if (pub.track && pub.kind === 'video') detachTrack(pub.track, session.id); });
    room.on(LK.RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const ids = new Set(speakers.map((p) => p.identity));
      for (const [id, el] of tiles) el.classList.toggle('speaking', ids.has(id));
    });
    room.on(LK.RoomEvent.AudioPlaybackStatusChanged, () => { $('audioBanner').hidden = room.canPlaybackAudio; });
    room.on(LK.RoomEvent.Reconnected, () => { mediaKey = ''; applyMedia(); });
    room.on(LK.RoomEvent.Disconnected, () => {
      if (lk === room) { lk = null; clearVideo(); setTimeout(startVideo, 3000); }
    });
    await room.connect(url, token);
    if (!session || inPerson()) { room.disconnect(); return; }   // the host switched to in person meanwhile
    lk = room;
    // Set who may see us BEFORE the camera goes live, so joining mid-night leaks nothing.
    mediaKey = ''; applyMedia(true);
    try {
      await room.localParticipant.setCameraEnabled(camOn);
      await room.localParticipant.setMicrophoneEnabled(micOn && micAllowed());
    } catch {
      toast('Camera or microphone is blocked. Allow them in your browser settings, then reload.');
    }
    room.startAudio().catch(() => {});
    $('audioBanner').hidden = room.canPlaybackAudio;
    mediaKey = ''; applyMedia();
    render();
  } catch (e) {
    if (e.message !== 'token') toast('Could not connect to video. The game still works without it.');
  } finally {
    lkStarting = false;
  }
}
function stopVideo() {
  const room = lk; lk = null;
  if (room) room.disconnect();
  clearVideo();
}
function clearVideo() {
  videoTracks.clear();
  $('audio').replaceChildren();
  for (const el of tiles.values()) showInitial(el);
}
function attachTrack(track, identity) {
  if (track.kind === 'audio') {
    if (identity !== session?.id) $('audio').appendChild(track.attach());
    return;
  }
  videoTracks.set(identity, track);
  const tile = tiles.get(identity);
  if (tile) showVideo(tile, track, identity);
}
function detachTrack(track, identity) {
  track.detach().forEach((el) => el.remove());
  if (track.kind === 'video' && videoTracks.get(identity) === track) {
    videoTracks.delete(identity);
    const tile = tiles.get(identity);
    if (tile) showInitial(tile);
  }
}
function showVideo(tile, track, identity) {
  const el = track.attach();
  el.muted = true; el.playsInline = true;
  tile.querySelector('.media').replaceChildren(el);
}
function showInitial(tile) {
  const span = document.createElement('span');
  span.className = 'initial';
  span.textContent = (tile.dataset.name || '?').slice(0, 1).toUpperCase();
  tile.querySelector('.media').replaceChildren(span);
}
$('audioBanner').onclick = () => {
  unlockSound();
  if (lk) lk.startAudio().then(() => { $('audioBanner').hidden = true; }).catch(() => {});
  else $('audioBanner').hidden = true;
};

function micAllowed() {
  if (!S) return true;
  const inPlay = S.phase !== 'lobby' && S.phase !== 'over';
  return !(inPlay && !S.you.alive);   // the dead stay silent
}
function awakeWolf() { return S && S.phase === 'night' && S.you.alive && S.you.role === 'werewolf'; }
function inPerson() { return Boolean(S && S.settings.mode === 'inperson'); }

/* The night rule. Each player tells the video server who is allowed to receive
   their camera and microphone:
     day    -> everyone
     night  -> wolves: only the other living wolves. Everyone else: nobody.
   The video server enforces it, so a sleeping player's device is never sent the wolves' feeds. */
function applyMedia(permissionsOnly) {
  if (!lk || !S) return;
  const night = S.phase === 'night';
  const pack = S.players.filter((p) => p.role === 'werewolf' && p.alive && p.id !== S.you.id).map((p) => p.id);
  const awake = awakeWolf();
  const key = [night, awake, awake ? pack.join(',') : '', micAllowed(), micOn, camOn].join('|');
  if (key === mediaKey) return;
  mediaKey = key;
  const me = lk.localParticipant;
  if (!night) me.setTrackSubscriptionPermissions(true);
  else if (awake) me.setTrackSubscriptionPermissions(false, pack.map((id) => ({ participantIdentity: id, allowAll: true })));
  else me.setTrackSubscriptionPermissions(false, []);
  if (permissionsOnly) { mediaKey = ''; return; }
  me.setMicrophoneEnabled(micOn && micAllowed()).catch(() => {});
  me.setCameraEnabled(camOn).catch(() => {});
}

$('micBtn').onclick = () => { micOn = !micOn; applyMedia(); renderTools(); };
$('camBtn').onclick = () => { camOn = !camOn; applyMedia(); renderTools(); };

// ---------- sound and the narrator ----------
/* The narrator runs the game out loud: the server sends one line per phase and this
   device speaks it. Online, every device speaks. In person, only the host's phone
   does, so the room hears one voice and nobody's phone gives them away. */
let audioCtx = null;
let master = null;      // everything but the voice goes through here, so it can dip while the narrator talks
let ambience = null;
let voice = null;

function iAmSpeaker() { return Boolean(S && narratorOn && (!inPerson() || S.you.id === S.hostId)); }

function ctx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    master = audioCtx.createGain();
    master.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function unlockSound() {
  try { ctx(); } catch { /* no audio, no problem */ }
  try {
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);   // a silent first line, so later lines are allowed without a tap
    }
  } catch { /* no voice on this device */ }
  $('audioBanner').hidden = true;
}
function soundLocked() { return !audioCtx || audioCtx.state !== 'running'; }

function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  const all = speechSynthesis.getVoices();
  return all.find((v) => v.lang === 'en-GB' && v.localService) || all.find((v) => v.lang === 'en-GB')
    || all.find((v) => v.lang && v.lang.startsWith('en')) || null;
}
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => { voice = pickVoice(); };

function speak(text, interrupt) {
  if (!('speechSynthesis' in window) || !text) return;
  try {
    if (interrupt) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    voice = voice || pickVoice();
    if (voice) u.voice = voice;
    u.lang = voice ? voice.lang : 'en-GB';
    u.rate = 0.92; u.pitch = 0.8;
    u.onstart = () => duck(0.35);
    u.onend = u.onerror = () => duck(1);
    speechSynthesis.speak(u);
  } catch { /* no voice on this device */ }
}
function hush() { try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch { /* nothing to stop */ } }
function duck(level) {
  if (!master) return;
  master.gain.cancelScheduledValues(audioCtx.currentTime);
  master.gain.setTargetAtTime(level, audioCtx.currentTime, 0.15);
}

// Called on every state from the server: speak a new line once, keep the night sounds in step.
function narrate() {
  const n = S.narration;
  if (n) {
    if (lastNarration === null) lastNarration = n.seq;        // just (re)joined: do not repeat an old line
    else if (n.seq !== lastNarration) { lastNarration = n.seq; if (iAmSpeaker()) speak(n.text, true); }
  }
  const loud = iAmSpeaker();
  if (S.phase === 'night' && loud) startAmbience(); else stopAmbience();
  if (!loud) hush();
  if (loud && soundLocked() && S.phase !== 'lobby') $('audioBanner').hidden = false;
}

function tone(freq, at, len, peak, type) {
  const c = ctx(), o = c.createOscillator(), g = c.createGain();
  o.type = type || 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  o.connect(g).connect(master);
  o.start(at); o.stop(at + len + 0.05);
  return o;
}
function chime(kind) {
  try {
    const notes = { dawn: [392, 523, 659], vote: [330, 330], over: [262, 330, 392, 523] }[kind] || [];
    const t0 = ctx().currentTime;
    notes.forEach((freq, i) => tone(freq, t0 + i * 0.28, 0.9, 0.12));
  } catch { /* no audio, no problem */ }
}
// A wolf howl: one note that rises, holds and falls away.
function howl() {
  try {
    const c = ctx(), t = c.currentTime + 0.1;
    const o = c.createOscillator(), g = c.createGain(), f = c.createBiquadFilter();
    const vib = c.createOscillator(), vg = c.createGain();
    o.type = 'sawtooth'; f.type = 'lowpass'; f.frequency.value = 900; f.Q.value = 4;
    o.frequency.setValueAtTime(260, t);
    o.frequency.exponentialRampToValueAtTime(540, t + 0.9);
    o.frequency.setValueAtTime(540, t + 1.9);
    o.frequency.exponentialRampToValueAtTime(330, t + 3.4);
    vib.frequency.value = 5.5; vg.gain.value = 6; vib.connect(vg).connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.7);
    g.gain.setValueAtTime(0.16, t + 2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);
    o.connect(f).connect(g).connect(master);
    o.start(t); vib.start(t); o.stop(t + 3.6); vib.stop(t + 3.6);
  } catch { /* no audio, no problem */ }
}
// Morning birdsong: a handful of quick rising chirps.
function birds() {
  try {
    const c = ctx(), t0 = c.currentTime + 0.9;
    for (let i = 0; i < 9; i++) {
      const at = t0 + i * 0.22 + Math.random() * 0.1;
      const o = tone(2200 + Math.random() * 1400, at, 0.14, 0.05);
      o.frequency.exponentialRampToValueAtTime(o.frequency.value * 1.35, at + 0.1);
    }
  } catch { /* no audio, no problem */ }
}
// Night air while the village sleeps: low wind and crickets, until dawn.
function startAmbience() {
  if (ambience) return;
  try {
    const c = ctx();
    const out = c.createGain();
    out.gain.setValueAtTime(0.0001, c.currentTime);
    out.gain.exponentialRampToValueAtTime(1, c.currentTime + 2);
    out.connect(master);
    const buf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const wind = c.createBufferSource(); wind.buffer = buf; wind.loop = true;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
    const wg = c.createGain(); wg.gain.value = 0.11;
    const sway = c.createOscillator(), sg = c.createGain();
    sway.frequency.value = 0.13; sg.gain.value = 0.06; sway.connect(sg).connect(wg.gain);
    wind.connect(lp).connect(wg).connect(out);
    wind.start(); sway.start();
    const chirp = () => {
      if (!ambience) return;
      const t = c.currentTime + 0.05;
      for (let i = 0; i < 3; i++) {
        const o = c.createOscillator(), g = c.createGain();
        o.frequency.value = 4300; 
        g.gain.setValueAtTime(0.0001, t + i * 0.09);
        g.gain.exponentialRampToValueAtTime(0.018, t + i * 0.09 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.06);
        o.connect(g).connect(out);
        o.start(t + i * 0.09); o.stop(t + i * 0.09 + 0.08);
      }
    };
    ambience = { out, wind, sway, timer: setInterval(chirp, 1100) };
  } catch { ambience = null; }
}
function stopAmbience() {
  const a = ambience;
  if (!a) return;
  ambience = null;
  clearInterval(a.timer);
  try {
    const t = audioCtx.currentTime;
    a.out.gain.cancelScheduledValues(t);
    a.out.gain.setTargetAtTime(0.0001, t, 0.4);
    a.wind.stop(t + 2); a.sway.stop(t + 2);
  } catch { /* already stopped */ }
}

$('voiceBtn').onclick = () => {
  narratorOn = !narratorOn;
  save('ww-narrator', narratorOn);
  if (narratorOn) unlockSound(); else { hush(); stopAmbience(); }
  renderTools();
};

// A phone that locks mid-game drops out, and the narrator's phone must not fall silent.
let wakeLock = null;
function keepAwake() {
  if (!('wakeLock' in navigator) || (wakeLock && !wakeLock.released)) return;
  navigator.wakeLock.request('screen').then((w) => { wakeLock = w; }).catch(() => {});
}

// ---------- rendering ----------
function player(id) { return S.players.find((p) => p.id === id); }
function nameOf(id) { const p = player(id); return p ? p.name : 'Someone'; }
function roleLabel(role) { return ROLE_INFO[role] ? ROLE_INFO[role][0] : ''; }

function render() {
  if (!S) return;
  $('home').hidden = true;
  $('game').hidden = false;
  document.body.dataset.phase = S.phase;

  if (inPerson()) { if (lk) stopVideo(); } else startVideo();

  const phaseKey = S.phase + ':' + S.step + ':' + S.round;
  if (phaseKey !== lastPhaseKey) {
    const loud = iAmSpeaker();
    if (S.phase === 'night' && S.step === 'acts') { decoy = null; if (loud) howl(); }
    if (S.phase === 'dawn' && loud) { chime('dawn'); birds(); }
    if (S.phase === 'vote' && loud) chime('vote');
    if (S.phase === 'over' && loud) chime('over');
    if (S.phase === 'night' && S.step === 'witch') witchDraft = { heal: false, poison: null };
    if (S.phase === 'reveal') showRole();
    if (S.phase === 'lobby') $('roleDialog').close();
    lastPhaseKey = phaseKey;
  }

  $('phaseName').textContent = S.phase === 'night' ? `Night ${S.round}` : S.phase === 'day' ? `Day ${S.round}` : PHASE_NAMES[S.phase];
  const last = S.log[S.log.length - 1];
  $('story').textContent = S.phase === 'lobby' ? 'Share the code so the others can join.' : last ? last.text : '';
  renderTools();
  renderTiles();
  renderPanel();
  tick();
  applyMedia();
  narrate();
}

function renderTools() {
  $('codeBtn').textContent = S.code;
  $('roleBtn').hidden = !S.you.role;
  const hasVideo = Boolean(lk);
  $('micBtn').hidden = $('camBtn').hidden = !hasVideo;
  $('micBtn').setAttribute('aria-pressed', String(micOn && micAllowed()));
  $('micBtn').disabled = !micAllowed();
  $('camBtn').setAttribute('aria-pressed', String(camOn));
  // In person only the host's phone speaks, so only the host gets the switch.
  $('voiceBtn').hidden = inPerson() && S.you.id !== S.hostId;
  $('voiceBtn').setAttribute('aria-pressed', String(narratorOn));
}

function renderTiles() {
  const grid = $('grid');
  const ids = new Set(S.players.map((p) => p.id));
  for (const [id, el] of tiles) if (!ids.has(id)) { el.remove(); tiles.delete(id); }
  // In person every phone shows the same dark screen at night and never marks the pack, so a glance gives nothing away.
  const wolfNight = awakeWolf() && !inPerson();
  const asleep = S.phase === 'night' && !wolfNight;
  let shown = 0;
  for (const p of S.players) {
    let el = tiles.get(p.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tile';
      el.innerHTML = '<div class="media"></div><span class="tag"></span><div class="label"></div>';
      el.dataset.name = p.name;
      tiles.set(p.id, el);
      grid.appendChild(el);
      const track = videoTracks.get(p.id);
      if (track) showVideo(el, track, p.id); else showInitial(el);
    }
    const isPack = p.role === 'werewolf' && S.you.role === 'werewolf' && S.phase !== 'over' && !inPerson();
    const hide = wolfNight && !(p.role === 'werewolf' && p.alive);
    if (!hide) shown++;
    el.classList.toggle('me', p.id === S.you.id);
    el.classList.toggle('dead', !p.alive);
    el.classList.toggle('away', !p.connected);
    el.classList.toggle('pack', isPack && p.alive);
    el.classList.toggle('gone', hide);
    el.classList.toggle('voted', S.phase === 'vote' && (S.voted || []).includes(p.id));
    el.querySelector('.label').textContent = p.name + (p.id === S.you.id ? ' (you)' : '') + (p.id === S.hostId && S.phase === 'lobby' ? ' · host' : '');
    let tag = '';
    if (!p.alive) tag = p.role ? `Dead · ${roleLabel(p.role)}` : 'Dead';
    else if (S.phase === 'over' && p.role) tag = roleLabel(p.role);
    else if (isPack) tag = 'Wolf';
    else if (!p.connected) tag = 'Away';
    else if (S.phase === 'reveal' && p.ready) tag = 'Ready';
    el.querySelector('.tag').textContent = tag;
  }
  grid.dataset.size = shown <= 4 ? 's' : shown <= 9 ? 'm' : 'l';
  $('sleep').hidden = !asleep;
  if (asleep) $('sleepText').textContent = !S.you.alive ? 'You are dead. Stay silent until dawn.' : inPerson() ? 'Night. Eyes on your own phone, and not a word.' : 'You are asleep. The village is dark.';
}

function picks(list, act, opts = {}) {
  return '<div class="picks">' + list.map((p) => {
    const who = opts.badges && opts.badges[p.id] ? `<span class="who">${esc(opts.badges[p.id])}</span>` : '';
    const on = opts.selected === p.id ? ' class="on"' : '';
    const off = opts.disabled === p.id ? ' disabled' : '';
    return `<button data-act="${act}" data-id="${p.id}"${on}${off}><span>${esc(p.name)}</span>${who}</button>`;
  }).join('') + '</div>';
}

// In person every night screen carries the same heading, so a glance at a neighbour's phone shows nothing.
function nightHead(title) { return inPerson() ? `<h2>Night</h2><p>${title}</p>` : `<h2>${title}</h2>`; }

function setupText(setup) {
  const parts = [];
  const add = (n, one, many) => { if (n) parts.push(n === 1 ? one : `${n} ${many}`); };
  add(setup.werewolf, '1 werewolf', 'werewolves');
  add(setup.seer, 'a seer', 'seers');
  add(setup.doctor, 'a doctor', 'doctors');
  add(setup.hunter, 'a hunter', 'hunters');
  add(setup.witch, 'a witch', 'witches');
  add(setup.villager, '1 villager', 'villagers');
  return parts.join(', ');
}

function renderPanel() {
  const me = S.you;
  const isHost = me.id === S.hostId;
  const living = S.players.filter((p) => p.alive);
  const others = living.filter((p) => p.id !== me.id);
  let h = '';

  if (S.phase === 'lobby') {
    const n = S.players.filter((p) => p.connected).length;
    h += `<h2>${n} of ${S.maxPlayers} in the village</h2>`;
    h += `<p class="muted">Code <strong>${esc(S.code)}</strong>. With ${Math.max(n, S.minPlayers)} players the game has ${setupText(S.setup)}.</p>`;
    if (isHost) {
      h += `<div class="modes" role="group" aria-label="How are you playing?"><button data-act="mode" data-id="online" aria-pressed="${!inPerson()}">Online, cameras on</button><button data-act="mode" data-id="inperson" aria-pressed="${inPerson()}">In person, same room</button></div>`;
      h += inPerson()
        ? '<p class="muted small">No cameras. Your phone is the narrator for the whole room, so turn the volume right up or pair it to a speaker. You still get a role and play.</p>'
        : '<p class="muted small">The narrator speaks on every player’s device and runs the game, so you get a role and play too.</p>';
    } else {
      h += inPerson()
        ? `<p class="muted small">Playing in person: no cameras. ${esc(nameOf(S.hostId))}’s phone is the narrator; yours stays silent.</p>`
        : '<p class="muted small">Playing online with cameras. The narrator will speak on your device.</p>';
    }
    if (isHost) {
      const s = S.settings;
      const opt = (v, label, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`;
      h += `<div class="actions"><button class="primary" data-act="start"${n < S.minPlayers ? ' disabled' : ''}>Start the game</button><button data-act="testVoice">Test the narrator</button><button data-act="share">Copy invite link</button><button data-act="leave">Leave</button></div>`;
      if (n < S.minPlayers) h += `<p class="muted small" style="margin:.5rem 0 0">You need at least ${S.minPlayers} players to start.</p>`;
      h += '<div class="settings">';
      h += `<div><label for="setWolves">Werewolves</label><select id="setWolves" data-set="wolves">${opt(0, 'Automatic', s.wolves)}${[1, 2, 3, 4, 5].map((v) => opt(v, v, s.wolves)).join('')}</select></div>`;
      h += `<div><label for="setTalk">Discussion time</label><select id="setTalk" data-set="discussSecs">${[[60, '1 minute'], [120, '2 minutes'], [180, '3 minutes'], [300, '5 minutes'], [480, '8 minutes']].map(([v, l]) => opt(v, l, s.discussSecs)).join('')}</select></div>`;
      for (const [k, label] of [['seer', 'Seer'], ['doctor', 'Doctor (5+ players)'], ['hunter', 'Hunter (6+)'], ['witch', 'Witch (7+)'], ['revealRoles', 'Reveal roles on death']]) {
        h += `<label class="check" for="set-${k}"><input type="checkbox" id="set-${k}" data-set="${k}"${s[k] ? ' checked' : ''}> ${label}</label>`;
      }
      h += '</div>';
    } else {
      h += `<p>Waiting for ${esc(nameOf(S.hostId))} to start the game.</p>`;
      h += '<div class="actions"><button data-act="share">Copy invite link</button><button data-act="leave">Leave</button></div>';
    }
  }

  else if (S.phase === 'reveal') {
    const ready = player(me.id).ready;
    h += inPerson()
      ? '<h2>Peek at your card</h2><p class="muted">Tap “My role”, then press and hold the card to look. Keep your phone to yourself.</p>'
      : `<h2>You are the ${esc(roleLabel(me.role))}</h2><p class="muted">${esc(ROLE_INFO[me.role][1])}</p>`;
    h += `<div class="actions"><button class="primary" data-act="ready"${ready ? ' disabled' : ''}>${ready ? 'Waiting for the others' : 'I’m ready'}</button></div>`;
  }

  else if (S.phase === 'night') {
    if (!me.alive) {
      h += inPerson()
        ? '<h2>You are dead</h2><p class="muted">Stay silent. You can watch the rest of the game, but give nothing away.</p>'
        : '<h2>You are dead</h2><p class="muted">Your microphone is off. You will see the village again at dawn.</p>';
    } else if (me.role === 'werewolf') {
      if (S.step === 'acts') {
        const badges = {};
        for (const [wolf, target] of Object.entries(S.wolfVotes || {})) {
          badges[target] = (badges[target] ? badges[target] + ', ' : '') + (wolf === me.id ? 'you' : nameOf(wolf));
        }
        h += inPerson()
          ? '<h2>Night</h2><p>Werewolf, choose tonight’s victim. No talking: tap the same name as the rest of the pack. Their picks show beside each name.</p>'
          : '<h2>Choose tonight’s victim</h2><p class="muted">Only the pack can see and hear you. The night ends once you all pick the same player.</p>';
        h += picks(living.filter((p) => p.role !== 'werewolf'), 'wolfVote', { selected: (S.wolfVotes || {})[me.id], badges });
      } else {
        h += nightHead('The pack has chosen') + '<p class="muted">Wait for dawn.</p>';
      }
    } else if (me.role === 'seer' && S.step === 'acts') {
      if (!S.acted) {
        h += nightHead('Seer, whose soul will you read?') + picks(others, 'seer');
      } else {
        const r = S.seerResults[S.seerResults.length - 1];
        h += nightHead(inPerson() ? `${esc(nameOf(r.id))} is ${r.wolf ? 'a werewolf' : 'not a werewolf'}.` : `${esc(nameOf(r.id))} is ${r.wolf ? '<span class="bad">a werewolf</span>' : '<span class="good">not a werewolf</span>'}`) + '<p class="muted">Keep it to yourself until morning.</p>';
      }
    } else if (me.role === 'doctor' && S.step === 'acts') {
      if (!S.acted) {
        h += nightHead('Doctor, who will you protect?');
        if (S.lastProtected) h += `<p class="muted">You protected ${esc(nameOf(S.lastProtected))} last night, so not them again.</p>`;
        h += picks(living, 'doctor', { disabled: S.lastProtected });
      } else {
        h += nightHead(`You are watching over ${esc(nameOf(S.protecting))}`) + '<p class="muted">Wait for dawn.</p>';
      }
    } else if (me.role === 'witch' && S.step === 'witch') {
      if (S.acted) {
        h += nightHead('Your work is done') + '<p class="muted">Wait for dawn.</p>';
      } else if (!S.potions.heal && !S.potions.poison) {
        h += nightHead('Your potions are spent') + '<p class="muted">Wait for dawn.</p>';
      } else {
        h += nightHead('Witch, the night is yours');
        if (S.potions.heal) {
          h += S.victim
            ? `<p>The wolves attacked <strong>${esc(nameOf(S.victim))}</strong>.</p><label class="check" for="healBox"><input type="checkbox" id="healBox" data-act="healToggle"${witchDraft.heal ? ' checked' : ''}> Use the healing potion</label>`
            : '<p class="muted">The wolves attacked nobody tonight.</p>';
        }
        if (S.potions.poison) {
          h += '<p style="margin-top:.6rem">Poison someone? Tap a name, or leave it.</p>' + picks(others, 'poisonPick', { selected: witchDraft.poison });
        }
        h += '<div class="actions"><button class="primary" data-act="witchDone">Done</button></div>';
      }
    } else if (inPerson()) {
      // Everyone taps at night, so the players with real choices do not stand out.
      h += '<h2>Night</h2><p class="muted">Tap who you suspect. It changes nothing, but it keeps every hand busy.</p>' + picks(others, 'decoy', { selected: decoy });
    } else {
      h += '<h2>Night</h2><p class="muted">Keep quiet. Nobody can see or hear you until dawn.</p>';
    }
  }

  else if (S.phase === 'dawn') {
    const d = S.deaths || [];
    h += d.length
      ? `<h2>${d.map((id) => esc(nameOf(id))).join(' and ')} ${d.length > 1 ? 'were' : 'was'} killed in the night</h2>`
      : '<h2>Nobody died in the night</h2>';
    h += '<p class="muted">The village wakes.</p>';
  }

  else if (S.phase === 'hunter') {
    if (S.step === 'aim' && S.hunterId === me.id) {
      h += '<h2>Hunter, take your last shot</h2>' + picks(living, 'hunter');
      h += '<div class="actions"><button data-act="hunterSkip">Don’t shoot</button></div>';
    } else if (S.step === 'aim') {
      h += `<h2>${esc(nameOf(S.hunterId))} was the hunter</h2><p class="muted">They are choosing who to take with them.</p>`;
    } else {
      h += S.hunterShot ? `<h2>${esc(nameOf(S.hunterId))} shot ${esc(nameOf(S.hunterShot))}</h2>` : `<h2>${esc(nameOf(S.hunterId))} did not fire</h2>`;
    }
  }

  else if (S.phase === 'day') {
    h += '<h2>Talk it over</h2><p class="muted">Who is lying? The vote opens when the timer runs out.</p>';
    if (isHost) h += '<div class="actions"><button class="primary" data-act="startVote">Call the vote now</button></div>';
  }

  else if (S.phase === 'vote') {
    const count = `${(S.voted || []).length} of ${living.length} have voted`;
    if (me.alive) {
      h += `<h2>Who do you banish?</h2><p class="muted">${count}. You can change your vote until everyone is in.</p>`;
      h += picks(others, 'vote', { selected: S.myVote });
      h += `<div class="actions"><button data-act="voteSkip"${S.myVote === 'skip' ? ' class="primary"' : ''}>Banish nobody</button></div>`;
    } else {
      h += `<h2>The village is voting</h2><p class="muted">${count}. The dead have no vote.</p>`;
    }
  }

  else if (S.phase === 'verdict') {
    const v = S.verdict;
    h += v.out ? `<h2>${esc(nameOf(v.out))} is banished</h2>` : '<h2>Nobody is banished</h2>';
    const by = {};
    for (const [voter, target] of Object.entries(v.votes)) (by[target] = by[target] || []).push(nameOf(voter));
    h += '<ul class="plain">' + Object.entries(by).sort((a, b) => b[1].length - a[1].length).map(([target, voters]) =>
      `<li><strong>${target === 'skip' ? 'Nobody' : esc(nameOf(target))} (${voters.length})</strong><span class="muted small">${voters.map(esc).join(', ')}</span></li>`).join('') + '</ul>';
  }

  else if (S.phase === 'over') {
    h += S.winner === 'village' ? '<h2 class="good">The village wins</h2>' : '<h2 class="bad">The werewolves win</h2>';
    h += '<ul class="plain">' + S.players.map((p) => `<li><span>${esc(p.name)}${p.alive ? '' : ' <span class="muted small">(dead)</span>'}</span><strong${p.role === 'werewolf' ? ' class="bad"' : ''}>${esc(roleLabel(p.role))}</strong></li>`).join('') + '</ul>';
    h += isHost ? '<div class="actions"><button class="primary" data-act="playAgain">Play again</button></div>' : `<p class="muted">Waiting for ${esc(nameOf(S.hostId))} to start another round.</p>`;
  }

  $('panel').innerHTML = h;
}

$('panel').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const id = b.dataset.id;
  switch (b.dataset.act) {
    case 'start': return send({ type: 'start' });
    case 'mode': return send({ type: 'settings', settings: { mode: id } });
    case 'testVoice': unlockSound(); howl(); return speak('This is your narrator. If the whole village can hear me, you are ready to begin.', true);
    case 'decoy': decoy = id; return renderPanel();
    case 'share': return share();
    case 'leave': return send({ type: 'leave' });
    case 'ready': return send({ type: 'ready' });
    case 'wolfVote': return send({ type: 'wolfVote', target: id });
    case 'seer': return send({ type: 'seer', target: id });
    case 'doctor': return send({ type: 'doctor', target: id });
    case 'healToggle': witchDraft.heal = b.checked; return;
    case 'poisonPick': witchDraft.poison = witchDraft.poison === id ? null : id; return renderPanel();
    case 'witchDone': return send({ type: 'witch', heal: witchDraft.heal, poison: witchDraft.poison });
    case 'hunter': return send({ type: 'hunter', target: id });
    case 'hunterSkip': return send({ type: 'hunter', target: null });
    case 'startVote': return send({ type: 'startVote' });
    case 'vote': return send({ type: 'vote', target: id });
    case 'voteSkip': return send({ type: 'vote', target: 'skip' });
    case 'playAgain': return send({ type: 'playAgain' });
  }
});
$('panel').addEventListener('change', (e) => {
  const key = e.target.dataset.set;
  if (!key) return;
  const value = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
  send({ type: 'settings', settings: { [key]: value } });
});

// ---------- role card ----------
function showRole() {
  if (!S || !S.you.role) return;
  const [label, text] = ROLE_INFO[S.you.role];
  let h = `<p class="muted small">Your secret role</p><p class="role-name ${S.you.role}">${esc(label)}</p><p>${esc(text)}</p>`;
  if (S.you.role === 'werewolf') {
    const pack = S.players.filter((p) => p.role === 'werewolf' && p.id !== S.you.id);
    h += pack.length ? `<p>Your pack: <strong>${pack.map((p) => esc(p.name)).join(', ')}</strong></p>` : '<p>You hunt alone.</p>';
  }
  if (S.you.role === 'seer' && S.seerResults && S.seerResults.length) {
    h += '<p class="muted small">What you have seen</p><ul class="plain">' + S.seerResults.map((r) =>
      `<li><span>${esc(nameOf(r.id))}</span><span class="${r.wolf ? 'bad' : 'good'}">${r.wolf ? 'Werewolf' : 'Not a werewolf'}</span></li>`).join('') + '</ul>';
  }
  if (S.log.length) {
    h += '<p class="muted small" style="margin-top:.8rem">The story so far</p><ul class="plain">' + S.log.slice(-8).map((l) => `<li><span class="small">${esc(l.text)}</span></li>`).join('') + '</ul>';
  }
  // In person the card stays face down unless it is being held, so a neighbour cannot read it at a glance.
  $('roleBody').innerHTML = inPerson()
    ? `<div class="peek" id="peek">${h}</div><button type="button" id="peekBtn" class="peek-btn">Press and hold to look at your card</button>`
    : h;
  if (!$('roleDialog').open) $('roleDialog').showModal();
}
function peek(on) { const el = $('peek'); if (el) el.classList.toggle('show', on); }
$('roleBody').addEventListener('pointerdown', (e) => { if (e.target.closest('#peekBtn')) { e.preventDefault(); peek(true); } });
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) $('roleBody').addEventListener(ev, () => peek(false));
$('roleBody').addEventListener('contextmenu', (e) => { if (e.target.closest('#peekBtn')) e.preventDefault(); });
$('roleBody').addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && e.target.id === 'peekBtn') { e.preventDefault(); peek(true); } });
$('roleBody').addEventListener('keyup', () => peek(false));
$('roleBtn').onclick = showRole;
$('roleClose').onclick = () => $('roleDialog').close();

// ---------- small things ----------
function share() {
  const link = `${location.origin}/#${S.code}`;
  const done = () => toast('Invite link copied. Send it to your players.');
  if (navigator.clipboard) navigator.clipboard.writeText(link).then(done, () => toast(link));
  else toast(link);
}
$('codeBtn').onclick = share;

let toastTimer = null;
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}

function tick() {
  if (!S || !S.deadline || S.phase === 'lobby' || S.phase === 'over') { $('timer').textContent = ''; return; }
  const left = Math.max(0, Math.ceil((S.deadline - (Date.now() + clockSkew)) / 1000));
  $('timer').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  callTime(left);
}

// The narrator calls out how long is left as the clock runs down.
const TIME_CALLS = { day: [[60, 'One minute left.'], [30, 'Thirty seconds left.'], [10, 'Ten seconds.']], vote: [[30, 'Thirty seconds left to vote.'], [10, 'Ten seconds.']], 'night:acts': [[30, 'Thirty seconds of night left.'], [10, 'Ten seconds.']], 'hunter:aim': [[10, 'Ten seconds.']] };
let callKey = '', callPrev = 0;
function callTime(left) {
  const key = S.phase + ':' + S.step + ':' + S.round + ':' + S.deadline;
  if (key !== callKey) { callKey = key; callPrev = left; return; }
  const calls = TIME_CALLS[S.phase] || TIME_CALLS[S.phase + ':' + S.step] || [];
  for (const [at, text] of calls) if (callPrev > at && left <= at && iAmSpeaker()) speak(text, false);
  callPrev = left;
}
setInterval(tick, 500);

// Coming back to the tab (phones drop the connection when locked).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && session && !ws) connect();
  if (!document.hidden && session) keepAwake();
});

if (session) connect();
