// DOM wiring for the lofi + atc UI. Logic worth testing lives in player.js.
import {
  Channel,
  addCustomFeeds,
  atcUrl,
  mergeAirports,
  nextMuteAll,
  parseFeedInput,
  shortcutFor,
} from './player.js';

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
let lofiSources = [];
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

function setInfo(text, isError = false) {
  els.feedInfo.textContent = text;
  els.feedInfo.classList.toggle('error', isError);
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
  if (state === 'connecting') setInfo(`${base} · connecting…`);
  else if (state === 'retrying') {
    const s = Math.round(detail.delayMs / 1000);
    setInfo(`${base} · no audio, retrying in ${s}s (or pick another feed)`, true);
  } else setInfo(base);
}

// ── Channels ──
const lofi = new Channel({
  onStatus: (s, d) => showStatus(els.lofiStatus, s, d, 'streaming'),
});
const atc = new Channel({
  onStatus: (s, d) => {
    showStatus(els.atcStatus, s, d, 'live');
    showFeedInfo(s, d);
  },
});

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
  if (isPlaying) atc.start([atcUrl(feed.mount)]);
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
      setInfo(`lookup failed: ${body.error ?? res.statusText}`, true);
      return;
    }
    if (!body.feeds?.length) {
      setInfo(`no LiveATC feeds found for ${icao}; paste a feed name or LiveATC link instead`, true);
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
  lofi.start(lofiSources);
  const feed = currentFeed();
  if (feed) atc.start([atcUrl(feed.mount)]);
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

// ── Boot ──
async function init() {
  try {
    const res = await fetch('/api/stations');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    builtin = data.airports;
    lofiSources = data.lofi;
  } catch (e) {
    console.error('loading stations failed', e);
    setInfo('cannot reach the lofi-atc server; start it with `make run`', true);
    els.playBtn.disabled = true;
    return;
  }
  renderAirports();
  const saved = store.get('selected', null);
  if (saved && airports.some((a) => a.icao === saved.icao)) selectAirport(saved.icao, saved.mount);
  else selectAirport(airports[0]?.icao);
}

init();
