// DOM wiring for the lofi + atc UI. Logic worth testing lives in player.js.
import {
  Channel,
  addCustomFeeds,
  atcSources,
  mergeAirports,
  mountFromAtcUrl,
  musicSources,
  nextMuteAll,
  parseFeedInput,
  shortcutFor,
} from './player.js';
import { SoundCloudAudio } from './soundcloud.js';
import { SpotifyAudio, loadSpotifySdk } from './spotify.js';
import { SpotifyAuth } from './spotify-auth.js';

const $ = (id) => document.getElementById(id);

// localStorage can be missing or throw (private mode, blocked storage).
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`lofi-atc:${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`lofi-atc:${key}`, JSON.stringify(value));
    } catch {
      // not persisted; fine
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(`lofi-atc:${key}`);
    } catch {
      // nothing to remove
    }
  },
};

const els = {
  playBtn: $('play-btn'),
  playIcon: $('play-icon'),
  lofiVol: $('lofi-vol'),
  atcVol: $('atc-vol'),
  lofiPct: $('lofi-pct'),
  atcPct: $('atc-pct'),
  lofiMute: $('lofi-mute'),
  atcMute: $('atc-mute'),
  lofiStatus: $('lofi-status'),
  atcStatus: $('atc-status'),
  feedInfo: $('feed-info'),
  musicInfo: $('music-info'),
  musicSelect: $('music-select'),
  soundcloudHost: $('soundcloud-host'),
  spotifyRow: $('spotify-row'),
  spotifyConnect: $('spotify-connect'),
  spotifyInfo: $('spotify-info'),
  feedSelect: $('feed-select'),
  removeAirport: $('remove-airport'),
  airportSelector: $('airport-selector'),
  addForm: $('add-form'),
  addInput: $('add-input'),
  addSubmit: $('add-submit'),
  viz: $('visualizer'),
};

const ICON_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>';
const ICON_MUTED = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
const ICON_PLAY = '<polygon points="5,3 19,12 5,21"/>';
const ICON_PAUSE = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';

// ── State ──
let builtin = [];
let custom = store.get('customAirports', []);
let airports = [];
let music = [];
let musicUrl = store.get('musicUrl', null);
let selected = { icao: null, mount: null };
let isPlaying = false;

// ── Status display ──
function showStatus(el, state, detail, liveText) {
  const [cls, text] = {
    idle: ['', isPlaying ? 'stopped' : 'paused'],
    connecting: ['loading', 'connecting'],
    live: ['live', liveText],
    retrying: ['error', `retry ${Math.round((detail?.delayMs ?? 0) / 1000)}s`],
    error: ['error', 'unavailable'],
  }[state];
  el.className = `status ${cls}`;
  el.querySelector('span').textContent = text;
}

function setText(el, text, isError = false, link = null) {
  el.textContent = text;
  if (link) {
    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.text;
    a.target = '_blank';
    a.rel = 'noopener';
    el.append(text ? ' ' : '', a);
  }
  el.classList.toggle('error', isError);
}

function setInfo(text, isError = false, link = null) {
  setText(els.feedInfo, text, isError, link);
}

// Lookups can fail (LiveATC sometimes puts its search page behind a browser
// check). The user's own browser can always open it, so offer that instead.
function liveatcSearchLink(icao) {
  return { href: `https://www.liveatc.net/search/?icao=${encodeURIComponent(icao)}`, text: `find ${icao} feeds on LiveATC ↗` };
}

function currentAirport() {
  return airports.find((a) => a.icao === selected.icao) ?? null;
}

function currentFeed() {
  return currentAirport()?.feeds.find((f) => f.mount === selected.mount) ?? null;
}

function showFeedInfo(state, detail) {
  const ap = currentAirport();
  const feed = currentFeed();
  if (!ap || !feed) return;
  const base = `${ap.icao} · ${feed.label}`;
  if (state === 'connecting') setInfo(`${base} · tuning in (ATC can take ~20s to start)…`);
  else if (state === 'retrying') {
    const s = Math.round(detail.delayMs / 1000);
    setInfo(`${ap.icao} · no feeds are online right now, retrying in ${s}s`, true);
  } else setInfo(base);
}

// ── Music stations ──
function currentStation() {
  return music.find((m) => m.url === musicUrl) ?? null;
}

function creditLink(station) {
  return station?.credit && station.credit_url ? { href: station.credit_url, text: `via ${station.credit} ↗` } : null;
}

function showMusicInfo(state, detail) {
  const station = currentStation();
  if (!station) return;
  if (state === 'live' && station.type === 'spotify' && nowPlaying) {
    setText(els.musicInfo, `♪ ${nowPlaying.name} · ${nowPlaying.artists}`, false, creditLink(station));
  } else if (state === 'connecting') setText(els.musicInfo, `${station.label} · connecting…`);
  else if (state === 'retrying') {
    const s = Math.round(detail.delayMs / 1000);
    setText(els.musicInfo, `no music stations reachable, retrying in ${s}s`, true);
  } else {
    // The picker already shows the station name; just credit the source.
    const link = creditLink(station);
    setText(els.musicInfo, link ? '' : station.label, false, link);
  }
}

function renderMusic() {
  els.musicSelect.replaceChildren(
    ...music.map((m) => {
      const opt = document.createElement('option');
      opt.value = m.url;
      opt.textContent = m.type === 'spotify' && !spotifyAuth?.connected ? `${m.label} (connect Spotify first)` : m.label;
      opt.selected = m.url === musicUrl;
      return opt;
    }),
  );
  showMusicInfo('idle');
}

function selectStation(url) {
  if (url === musicUrl) return;
  nowPlaying = null;
  musicUrl = url;
  store.set('musicUrl', musicUrl);
  renderMusic();
  if (isPlaying) startMusic();
}

function startMusic() {
  nowPlaying = null;
  // Spotify stations are only worth trying as fallbacks once connected.
  const usable = (s) => s.type !== 'spotify' || spotifyAuth?.connected || s.url === musicUrl;
  lofi.start(musicSources(music, musicUrl).filter(usable));
}

// Why the last station failed, so a fallback can say more than "unavailable".
let lastMusicError = null;

function createMusicAudio(station) {
  let audio;
  if (station.type === 'soundcloud') audio = new SoundCloudAudio({ host: els.soundcloudHost });
  else if (station.type === 'spotify') {
    audio = new SpotifyAudio({
      auth: spotifyAuth ?? { connected: false },
      onTrack: (track) => {
        nowPlaying = track;
        if (currentStation()?.url === station.url) showMusicInfo('live');
      },
    });
  } else audio = new Audio();
  audio.addEventListener('error', () => {
    lastMusicError = { url: station.url, message: audio.error?.message };
  });
  return audio;
}

els.musicSelect.addEventListener('change', () => selectStation(els.musicSelect.value));

// ── Channels ──
const lofi = new Channel({
  connectTimeoutMs: 15000,
  createAudio: createMusicAudio,
  onStatus: (s, d) => {
    showStatus(els.lofiStatus, s, d, 'streaming');
    if (s === 'live' && d.url !== musicUrl) {
      // The chosen station failed and a fallback is playing: say why.
      const wanted = currentStation();
      const reason = lastMusicError?.url === wanted?.url && lastMusicError.message;
      musicUrl = d.url;
      store.set('musicUrl', musicUrl);
      renderMusic();
      const station = currentStation();
      const why = reason ? `${wanted.label}: ${reason}` : `${wanted?.label ?? 'station'} unavailable`;
      setText(els.musicInfo, `${station?.label ?? d.url} (${why})`, false, creditLink(station));
      return;
    }
    showMusicInfo(s, d);
  },
});
const atc = new Channel({
  // ATC feeds are low bitrate, so the browser needs ~15-20s of audio before it
  // will start playing. A shorter timeout gives up on perfectly good feeds.
  connectTimeoutMs: 45000,
  onStatus: (s, d) => {
    showStatus(els.atcStatus, s, d, 'live');
    const live = s === 'live' ? mountFromAtcUrl(d.url) : null;
    if (live && live !== selected.mount) {
      // The chosen feed was offline and a fallback feed is playing: say so.
      const wanted = currentFeed()?.label ?? selected.mount;
      selected = { ...selected, mount: live };
      store.set('selected', selected);
      updateSelection();
      setInfo(`${selected.icao} · ${currentFeed()?.label ?? live} (${wanted} is offline)`);
      return;
    }
    showFeedInfo(s, d);
  },
});

function startAtc() {
  const ap = currentAirport();
  if (ap) atc.start(atcSources(ap.feeds, selected.mount));
}

// ── Airports & feeds ──
function shortLabel(icao) {
  // US airports read better without the leading K (KBOS -> BOS).
  return /^K[A-Z]{3}$/.test(icao) ? icao.slice(1) : icao;
}

function renderAirports() {
  airports = mergeAirports(builtin, custom);
  const buttons = airports.map((ap) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'airport-btn';
    btn.textContent = ap.label;
    btn.title = ap.name;
    btn.dataset.icao = ap.icao;
    btn.addEventListener('click', () => selectAirport(ap.icao));
    return btn;
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'airport-btn add';
  add.textContent = '+';
  add.title = 'Add any LiveATC airport or feed';
  add.setAttribute('aria-label', add.title);
  add.addEventListener('click', toggleAddForm);
  els.airportSelector.replaceChildren(...buttons, add);
  updateSelection();
}

function updateSelection() {
  for (const btn of els.airportSelector.querySelectorAll('[data-icao]')) {
    btn.classList.toggle('active', btn.dataset.icao === selected.icao);
  }
  const ap = currentAirport();
  els.feedSelect.replaceChildren(
    ...(ap?.feeds ?? []).map((f) => {
      const opt = document.createElement('option');
      opt.value = f.mount;
      opt.textContent = f.status === 'DOWN' ? `${f.label} (reported down)` : f.label;
      opt.selected = f.mount === selected.mount;
      return opt;
    }),
  );
  els.removeAirport.hidden = !ap?.custom;
  showFeedInfo(isPlaying ? 'connecting' : 'idle');
}

function selectAirport(icao, mount) {
  const ap = airports.find((a) => a.icao === icao);
  if (!ap) return;
  const feed = ap.feeds.find((f) => f.mount === mount) ?? ap.feeds[0];
  if (selected.icao === ap.icao && selected.mount === feed.mount) return;
  selected = { icao: ap.icao, mount: feed.mount };
  store.set('selected', selected);
  updateSelection();
  if (isPlaying) startAtc();
}

function saveCustom(next) {
  custom = next;
  store.set('customAirports', custom);
  renderAirports();
}

function addAirport(ap, mount) {
  saveCustom(addCustomFeeds(custom, ap));
  els.addForm.hidden = true;
  els.addInput.value = '';
  selected = { icao: null, mount: null }; // force reselect even if same airport
  selectAirport(ap.icao, mount ?? ap.feeds[0].mount);
}

els.removeAirport.addEventListener('click', () => {
  const icao = selected.icao;
  saveCustom(custom.filter((a) => a.icao !== icao));
  const still = airports.find((a) => a.icao === icao);
  selected = { icao: null, mount: null };
  selectAirport(still ? icao : airports[0]?.icao);
});

els.feedSelect.addEventListener('change', () => selectAirport(selected.icao, els.feedSelect.value));

// ── Add any airport / feed ──
function toggleAddForm() {
  els.addForm.hidden = !els.addForm.hidden;
  if (!els.addForm.hidden) els.addInput.focus();
}

async function lookUpAirport(icao) {
  setInfo(`looking up ${icao} on LiveATC…`);
  els.addSubmit.disabled = true;
  try {
    const res = await fetch(`/api/search?icao=${encodeURIComponent(icao)}`);
    const body = await res.json().catch(() => ({}));
    if (res.status === 429) {
      const wait = res.headers.get('Retry-After') ?? 'a few';
      setInfo(`LiveATC is rate limiting lookups; try again in ${wait}s`, true);
      return;
    }
    if (!res.ok) {
      const why = body.browser_check ? 'LiveATC wants a browser check' : `lookup failed (${body.error ?? res.statusText})`;
      setInfo(`${why}; copy a feed link from there and paste it here:`, true, liveatcSearchLink(icao));
      return;
    }
    if (!body.feeds?.length) {
      setInfo(`no feeds found for ${icao}; check LiveATC and paste a feed link here:`, true, liveatcSearchLink(icao));
      return;
    }
    addAirport({ icao, label: shortLabel(icao), name: icao, feeds: body.feeds });
  } catch {
    setInfo('lookup failed: is the lofi-atc server still running?', true);
  } finally {
    els.addSubmit.disabled = false;
  }
}

els.addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const parsed = parseFeedInput(els.addInput.value);
  if (!parsed) {
    setInfo('enter an airport code (KBOS), a feed name (kbos_twr), or a LiveATC link', true);
    return;
  }
  if (parsed.kind === 'icao') {
    lookUpAirport(parsed.icao);
    return;
  }
  const icao = parsed.icao ?? 'CUSTOM';
  addAirport(
    { icao, label: shortLabel(icao), name: icao, feeds: [{ mount: parsed.mount, label: parsed.mount }] },
    parsed.mount,
  );
});

// ── Play / pause ──
function setPlayingUi(playing) {
  els.playBtn.classList.toggle('playing', playing);
  els.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  els.playIcon.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  els.viz.classList.toggle('active', playing);
}

function togglePlay() {
  if (isPlaying) {
    isPlaying = false;
    setPlayingUi(false);
    lofi.stop();
    atc.stop();
    showFeedInfo('idle');
    return;
  }
  isPlaying = true;
  setPlayingUi(true);
  startMusic();
  startAtc();
}

els.playBtn.addEventListener('click', togglePlay);

// ── Volume & mute ──
function bindVolume(channel, slider, pct, key) {
  slider.value = store.get(key, Number(slider.value));
  const apply = () => {
    pct.textContent = `${slider.value}%`;
    channel.setVolume(slider.value / 100);
    store.set(key, Number(slider.value));
  };
  slider.addEventListener('input', apply);
  apply();
}

function setMuted(channel, btn, muted) {
  channel.setMuted(muted);
  btn.innerHTML = muted ? ICON_MUTED : ICON_ON;
  btn.classList.toggle('muted', muted);
  btn.setAttribute('aria-pressed', String(muted));
}

bindVolume(lofi, els.lofiVol, els.lofiPct, 'lofiVolume');
bindVolume(atc, els.atcVol, els.atcPct, 'atcVolume');
setMuted(lofi, els.lofiMute, false);
setMuted(atc, els.atcMute, false);
els.lofiMute.addEventListener('click', () => setMuted(lofi, els.lofiMute, !lofi.muted));
els.atcMute.addEventListener('click', () => setMuted(atc, els.atcMute, !atc.muted));

// ── Keyboard shortcuts ──
document.addEventListener('keydown', (e) => {
  const action = shortcutFor(e.code, e.target);
  if (!action) return;
  e.preventDefault();
  if (action === 'toggle') togglePlay();
  else if (action === 'mute') {
    const muteAll = nextMuteAll([lofi.muted, atc.muted]);
    setMuted(lofi, els.lofiMute, muteAll);
    setMuted(atc, els.atcMute, muteAll);
  } else {
    const step = action === 'volumeUp' ? 5 : -5;
    els.lofiVol.value = Math.min(100, Math.max(0, Number(els.lofiVol.value) + step));
    els.lofiVol.dispatchEvent(new Event('input'));
  }
});

// ── Visualizer ──
for (let i = 0; i < 32; i++) {
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.style.animationDelay = `${Math.random() * 1.2}s`;
  bar.style.height = '4px';
  els.viz.appendChild(bar);
}

// ── Spotify ──
let spotifyAuth = null;
let nowPlaying = null;

// Spotify only accepts loopback redirect URIs written as 127.0.0.1, and the
// login must finish on the origin that started it (it keeps the PKCE verifier
// in that origin's storage).
const SPOTIFY_HOST = '127.0.0.1';

function renderSpotify(message = '', isError = false) {
  els.spotifyRow.hidden = !spotifyAuth;
  if (!spotifyAuth) return;
  els.spotifyConnect.textContent = spotifyAuth.connected ? 'disconnect Spotify' : 'connect Spotify';
  setText(els.spotifyInfo, message || (spotifyAuth.connected ? 'Spotify connected' : 'Premium needed'), isError);
}

async function startSpotifyLogin() {
  if (location.hostname !== SPOTIFY_HOST) {
    location.href = `http://${SPOTIFY_HOST}:${location.port}/?spotify=connect`;
    return;
  }
  location.href = await spotifyAuth.loginUrl();
}

els.spotifyConnect.addEventListener('click', () => {
  if (!spotifyAuth) return;
  if (!spotifyAuth.connected) {
    startSpotifyLogin().catch((e) => renderSpotify(e.message, true));
    return;
  }
  spotifyAuth.disconnect();
  renderSpotify('Spotify disconnected');
  renderMusic();
  if (isPlaying && currentStation()?.type === 'spotify') startMusic(); // falls back to the next station
});

async function initSpotify(config) {
  if (!config?.client_id) {
    // Without a client ID there's no way to log in, so hide Spotify stations.
    music = music.filter((m) => m.type !== 'spotify');
    return;
  }
  spotifyAuth = new SpotifyAuth({
    clientId: config.client_id,
    redirectUri: `http://${SPOTIFY_HOST}:${location.port}/spotify/callback`,
    storage: store,
  });
  const params = new URLSearchParams(location.search);
  let message = '';
  let isError = false;
  if (location.pathname === '/spotify/callback') {
    try {
      if (await spotifyAuth.handleCallback(params)) {
        message = 'Spotify connected; press play';
        const first = music.find((m) => m.type === 'spotify');
        if (first) {
          musicUrl = first.url;
          store.set('musicUrl', musicUrl);
        }
      }
    } catch (e) {
      message = e.message;
      isError = true;
    }
    history.replaceState(null, '', '/');
  } else if (params.get('spotify') === 'connect') {
    history.replaceState(null, '', '/');
    startSpotifyLogin().catch((e) => renderSpotify(e.message, true));
  }
  if (spotifyAuth.connected) {
    // Load the SDK up front so the player is created inside the play click.
    loadSpotifySdk().catch(() => {});
  }
  renderSpotify(message, isError);
}

// ── Boot ──
async function init() {
  let data;
  try {
    const res = await fetch('/api/stations');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    builtin = data.airports;
    music = data.lofi;
  } catch (e) {
    console.error('loading stations failed', e);
    setInfo('cannot reach the lofi-atc server; start it with `make run`', true);
    els.playBtn.disabled = true;
    return;
  }
  await initSpotify(data.spotify);
  if (!music.some((m) => m.url === musicUrl)) musicUrl = music[0]?.url ?? null;
  renderMusic();
  renderAirports();
  const saved = store.get('selected', null);
  if (saved && airports.some((a) => a.icao === saved.icao)) selectAirport(saved.icao, saved.mount);
  else selectAirport(airports[0]?.icao);
}

init();
