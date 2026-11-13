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
let mediaKey = '';
let micOn = true, camOn = true;
let lastPhaseKey = '';
let witchDraft = { heal: false, poison: null };
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
    startVideo();
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
  $('game').hidden = true;
  $('home').hidden = false;
  document.body.dataset.phase = 'home';
}

// ---------- home screen ----------
$('nameInput').value = load('ww-name') || '';
$('codeInput').value = (location.hash || '').replace('#', '').slice(0, 4).toUpperCase();
function enter(type) {
  const name = $('nameInput').value.trim();
  if (!name) { $('nameInput').focus(); return toast('Enter your name first.'); }
  save('ww-name', name);
  const msg = { type, name };
  if (type === 'join') {
    msg.code = $('codeInput').value.trim().toUpperCase();
    if (msg.code.length !== 4) { $('codeInput').focus(); return toast('Enter the 4-letter village code.'); }
  }
  chime('tap'); // also unlocks audio on this tap
  if (ws && ws.readyState === 1) send(msg); else connect(msg);
}
$('createBtn').onclick = () => enter('create');
$('homeForm').onsubmit = (e) => { e.preventDefault(); enter('join'); };

// ---------- video (LiveKit) ----------
async function startVideo() {
  if (!session || !session.video || lk || lkStarting || !LK) return;
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
$('audioBanner').onclick = () => { if (lk) lk.startAudio().then(() => { $('audioBanner').hidden = true; }).catch(() => {}); };

function micAllowed() {
  if (!S) return true;
  const inPlay = S.phase !== 'lobby' && S.phase !== 'over';
  return !(inPlay && !S.you.alive);   // the dead stay silent
}
function awakeWolf() { return S && S.phase === 'night' && S.you.alive && S.you.role === 'werewolf'; }

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

// ---------- sound cues ----------
let audioCtx = null;
function chime(kind) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const notes = { night: [220, 165], dawn: [392, 523, 659], vote: [330, 330], over: [262, 330, 392, 523], tap: [] }[kind] || [];
    notes.forEach((freq, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      const t = audioCtx.currentTime + i * 0.28;
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g).connect(audioCtx.destination);
      o.start(t); o.stop(t + 1);
    });
  } catch { /* no audio, no problem */ }
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

  const phaseKey = S.phase + ':' + S.step + ':' + S.round;
  if (phaseKey !== lastPhaseKey) {
    if (S.phase === 'night' && S.step === 'acts') chime('night');
    if (S.phase === 'dawn') chime('dawn');
    if (S.phase === 'vote') chime('vote');
    if (S.phase === 'over') chime('over');
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
}

function renderTools() {
  $('codeBtn').textContent = S.code;
  $('roleBtn').hidden = !S.you.role;
  const hasVideo = Boolean(lk);
  $('micBtn').hidden = $('camBtn').hidden = !hasVideo;
  $('micBtn').setAttribute('aria-pressed', String(micOn && micAllowed()));
  $('micBtn').disabled = !micAllowed();
  $('camBtn').setAttribute('aria-pressed', String(camOn));
}

function renderTiles() {
  const grid = $('grid');
  const ids = new Set(S.players.map((p) => p.id));
  for (const [id, el] of tiles) if (!ids.has(id)) { el.remove(); tiles.delete(id); }
  const wolfNight = awakeWolf();
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
    const isPack = p.role === 'werewolf' && S.you.role === 'werewolf' && S.phase !== 'over';
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
  if (asleep) $('sleepText').textContent = S.you.alive ? 'You are asleep. The village is dark.' : 'You are dead. Stay silent until dawn.';
}

function picks(list, act, opts = {}) {
  return '<div class="picks">' + list.map((p) => {
    const who = opts.badges && opts.badges[p.id] ? `<span class="who">${esc(opts.badges[p.id])}</span>` : '';
    const on = opts.selected === p.id ? ' class="on"' : '';
    const off = opts.disabled === p.id ? ' disabled' : '';
    return `<button data-act="${act}" data-id="${p.id}"${on}${off}><span>${esc(p.name)}</span>${who}</button>`;
  }).join('') + '</div>';
}

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
      const s = S.settings;
      const opt = (v, label, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`;
      h += `<div class="actions"><button class="primary" data-act="start"${n < S.minPlayers ? ' disabled' : ''}>Start the game</button><button data-act="share">Copy invite link</button><button data-act="leave">Leave</button></div>`;
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
    h += `<h2>You are the ${esc(roleLabel(me.role))}</h2><p class="muted">${esc(ROLE_INFO[me.role][1])}</p>`;
    h += `<div class="actions"><button class="primary" data-act="ready"${ready ? ' disabled' : ''}>${ready ? 'Waiting for the others' : 'I’m ready'}</button></div>`;
  }

  else if (S.phase === 'night') {
    if (!me.alive) {
      h += '<h2>You are dead</h2><p class="muted">Your microphone is off. You will see the village again at dawn.</p>';
    } else if (me.role === 'werewolf') {
      if (S.step === 'acts') {
        const badges = {};
        for (const [wolf, target] of Object.entries(S.wolfVotes || {})) {
          badges[target] = (badges[target] ? badges[target] + ', ' : '') + (wolf === me.id ? 'you' : nameOf(wolf));
        }
        h += '<h2>Choose tonight’s victim</h2><p class="muted">Only the pack can see and hear you. The night ends once you all pick the same player.</p>';
        h += picks(living.filter((p) => p.role !== 'werewolf'), 'wolfVote', { selected: (S.wolfVotes || {})[me.id], badges });
      } else {
        h += '<h2>The pack has chosen</h2><p class="muted">Wait for dawn.</p>';
      }
    } else if (me.role === 'seer' && S.step === 'acts') {
      if (!S.acted) {
        h += '<h2>Seer, whose soul will you read?</h2>' + picks(others, 'seer');
      } else {
        const r = S.seerResults[S.seerResults.length - 1];
        h += `<h2>${esc(nameOf(r.id))} is ${r.wolf ? '<span class="bad">a werewolf</span>' : '<span class="good">not a werewolf</span>'}</h2><p class="muted">Keep it to yourself until morning.</p>`;
      }
    } else if (me.role === 'doctor' && S.step === 'acts') {
      if (!S.acted) {
        h += '<h2>Doctor, who will you protect?</h2>';
        if (S.lastProtected) h += `<p class="muted">You protected ${esc(nameOf(S.lastProtected))} last night, so not them again.</p>`;
        h += picks(living, 'doctor', { disabled: S.lastProtected });
      } else {
        h += `<h2>You are watching over ${esc(nameOf(S.protecting))}</h2><p class="muted">Sleep until dawn.</p>`;
      }
    } else if (me.role === 'witch' && S.step === 'witch') {
      if (S.acted) {
        h += '<h2>Your work is done</h2><p class="muted">Sleep until dawn.</p>';
      } else if (!S.potions.heal && !S.potions.poison) {
        h += '<h2>Your potions are spent</h2><p class="muted">Sleep until dawn.</p>';
      } else {
        h += '<h2>Witch, the night is yours</h2>';
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
  $('roleBody').innerHTML = h;
  if (!$('roleDialog').open) $('roleDialog').showModal();
}
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
}
setInterval(tick, 500);

// Coming back to the tab (phones drop the connection when locked).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && session && !ws) connect();
});

if (session) connect();
