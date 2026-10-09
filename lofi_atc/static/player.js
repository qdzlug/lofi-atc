// Playback and input logic with no DOM dependencies, so it can be unit
// tested under `node --test` with fake audio elements and timers.

export const MOUNT_RE = /^[a-z0-9_]{1,64}$/;
export const ICAO_RE = /^[A-Z0-9]{3,4}$/;

export function atcUrl(mount) {
  return `/atc/${encodeURIComponent(mount)}`;
}

export function mountFromAtcUrl(url) {
  const m = /\/atc\/([^/?#]+)$/.exec(url ?? '');
  return m ? decodeURIComponent(m[1]) : null;
}

/** `items` with those matching `isChosen` moved to the front; order otherwise kept. */
export function chosenFirst(items, isChosen) {
  return [...items.filter(isChosen), ...items.filter((x) => !isChosen(x))];
}

/**
 * Proxy URLs to try for an airport: the chosen feed first, then the airport's
 * other feeds as fallbacks, since individual LiveATC feeds go offline often.
 */
export function atcSources(feeds, mount) {
  return chosenFirst(feeds, (f) => f.mount === mount).map((f) => atcUrl(f.mount));
}

/** Music stream URLs to try: the chosen station, then the others as fallbacks. */
export function musicSources(stations, url) {
  return chosenFirst(stations, (s) => s.url === url).map((s) => s.url);
}

// Exponential backoff for reconnects: 2s, 4s, 8s ... capped at `max`.
export function backoffDelay(attempt, base = 2000, max = 60000) {
  return Math.min(max, base * 2 ** Math.max(0, attempt));
}

// Guess an ICAO code from a mount like "kbos_twr" -> "KBOS".
export function icaoFromMount(mount) {
  const m = /^([a-z][a-z0-9]{3})(?:[_\d]|$)/.exec(mount);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Interpret what the user typed into the "add airport" box.
 *   "kbos" / "KBOS"                         -> { kind: 'icao', icao: 'KBOS' }
 *   "kbos_twr"                              -> { kind: 'mount', mount, icao }
 *   "https://www.liveatc.net/hlisten.php?mount=kbos_twr&icao=kbos"
 *   "https://www.liveatc.net/play/kbos_twr.pls"
 *   "https://d.liveatc.net/kbos_twr"        -> { kind: 'mount', ... }
 * Returns null for anything else.
 */
export function parseFeedInput(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { return null; }
    if (!/(^|\.)liveatc\.net$/i.test(url.hostname)) return null;
    let mount = url.searchParams.get('mount');
    if (!mount) {
      const m = /\/(?:play\/)?([A-Za-z0-9_]+)(?:\.pls|\.m3u)?$/.exec(url.pathname);
      mount = m ? m[1] : null;
    }
    const icao = (url.searchParams.get('icao') || '').toUpperCase();
    if (!mount) return ICAO_RE.test(icao) ? { kind: 'icao', icao } : null;
    mount = mount.toLowerCase();
    if (!MOUNT_RE.test(mount)) return null;
    return { kind: 'mount', mount, icao: ICAO_RE.test(icao) ? icao : icaoFromMount(mount) };
  }

  const upper = raw.toUpperCase();
  if (ICAO_RE.test(upper) && !raw.includes('_')) return { kind: 'icao', icao: upper };

  const mount = raw.toLowerCase();
  if (MOUNT_RE.test(mount)) return { kind: 'mount', mount, icao: icaoFromMount(mount) };
  return null;
}

/**
 * Combine the built-in airport list with user-added airports. A user airport
 * with the same ICAO as a built-in one contributes its extra feeds to it.
 * Each result carries `custom: true` when the user can remove it.
 */
export function mergeAirports(builtin, custom) {
  const out = builtin.map((a) => ({ ...a, feeds: [...a.feeds], custom: false }));
  for (const c of custom) {
    const existing = out.find((a) => a.icao === c.icao);
    if (existing) {
      const known = new Set(existing.feeds.map((f) => f.mount));
      for (const f of c.feeds) if (!known.has(f.mount)) existing.feeds.push(f);
      existing.custom = true;
    } else {
      out.push({ ...c, feeds: [...c.feeds], custom: true });
    }
  }
  return out;
}

/** Add feeds to the custom airport list (returns a new list). */
export function addCustomFeeds(custom, airport) {
  const list = custom.map((a) => ({ ...a, feeds: [...a.feeds] }));
  const existing = list.find((a) => a.icao === airport.icao);
  if (!existing) {
    list.push({ ...airport, feeds: [...airport.feeds] });
    return list;
  }
  const known = new Set(existing.feeds.map((f) => f.mount));
  for (const f of airport.feeds) if (!known.has(f.mount)) existing.feeds.push(f);
  return list;
}

/** "M" mutes everything if anything is audible, otherwise unmutes everything. */
export function nextMuteAll(mutedStates) {
  return mutedStates.some((m) => !m);
}

/**
 * Map a keydown to an app action, or null to leave the browser default alone.
 * `target` is { tagName, type } of the focused element.
 */
export function shortcutFor(code, target = {}) {
  const tag = (target.tagName || '').toUpperCase();
  const type = (target.type || '').toLowerCase();
  const typing = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && type !== 'range');
  if (typing) return null;
  const onControl = tag === 'BUTTON' || tag === 'INPUT';
  switch (code) {
    case 'Space': return onControl ? null : 'toggle';
    case 'KeyM': return 'mute';
    case 'ArrowUp': return tag === 'INPUT' ? null : 'volumeUp';
    case 'ArrowDown': return tag === 'INPUT' ? null : 'volumeDown';
    default: return null;
  }
}

/**
 * One audio channel (lofi or ATC). Tries each source URL in order, and if
 * the stream fails or drops later, reconnects with exponential backoff.
 *
 * Every connect bumps `generation`; async work from an older generation is
 * discarded, so rapid play/pause/feed switches can never leave a stale
 * stream playing.
 *
 * Status callbacks: onStatus(state, detail) with state one of
 *   'idle' | 'connecting' | 'live' | 'retrying' (detail.delayMs) | 'error'
 */
export class Channel {
  constructor({
    createAudio = () => new Audio(),
    timers = globalThis,
    connectTimeoutMs = 12000,
    reconnect = true,
    onStatus = () => {},
  } = {}) {
    this.createAudio = createAudio;
    this.timers = timers;
    this.connectTimeoutMs = connectTimeoutMs;
    this.reconnect = reconnect;
    this.onStatus = onStatus;
    this.audio = null;
    this.sources = [];
    this.generation = 0;
    this.attempt = 0;
    this.retryTimer = null;
    this.volume = 0.5;
    this.muted = false;
  }

  get effectiveVolume() {
    return this.muted ? 0 : this.volume;
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.audio) this.audio.volume = this.effectiveVolume;
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.audio) this.audio.volume = this.effectiveVolume;
  }

  /** Start playing the first working URL in `sources`. Resolves true if live. */
  start(sources) {
    this.sources = [...sources];
    this.attempt = 0;
    return this._connect();
  }

  stop() {
    this.generation++;
    this._clearRetry();
    this._teardown();
    this.onStatus('idle');
  }

  async _connect() {
    const gen = ++this.generation;
    this._clearRetry();
    this._teardown();
    this.onStatus('connecting');

    for (const url of this.sources) {
      if (gen !== this.generation) return false;
      let audio;
      try {
        audio = await this._open(url);
        if (gen !== this.generation) { discard(audio); return false; }
        await audio.play();
        if (gen !== this.generation) { discard(audio); return false; }
      } catch {
        if (audio) discard(audio);
        continue;
      }
      this.audio = audio;
      this.attempt = 0;
      this._watch(audio, gen);
      this.onStatus('live', { url });
      return true;
    }

    if (gen !== this.generation) return false;
    this._scheduleRetry(gen);
    return false;
  }

  _open(url) {
    return new Promise((resolve, reject) => {
      const audio = this.createAudio();
      audio.volume = this.effectiveVolume;
      const timer = this.timers.setTimeout(() => {
        discard(audio);
        reject(new Error('timeout'));
      }, this.connectTimeoutMs);
      audio.addEventListener('canplay', () => { this.timers.clearTimeout(timer); resolve(audio); }, { once: true });
      audio.addEventListener('error', () => {
        this.timers.clearTimeout(timer);
        discard(audio);
        reject(audio.error || new Error('audio error'));
      }, { once: true });
      audio.src = url;
      audio.load();
    });
  }

  _watch(audio, gen) {
    const lost = () => {
      if (gen !== this.generation || this.audio !== audio) return;
      this._teardown();
      this._scheduleRetry(gen);
    };
    audio.addEventListener('error', lost, { once: true });
    audio.addEventListener('ended', lost, { once: true });
  }

  _scheduleRetry(gen) {
    if (!this.reconnect) {
      this.onStatus('error');
      return;
    }
    const delayMs = backoffDelay(this.attempt++);
    this.onStatus('retrying', { delayMs });
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      if (gen === this.generation) this._connect();
    }, delayMs);
  }

  _clearRetry() {
    if (this.retryTimer !== null) {
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  _teardown() {
    if (this.audio) {
      discard(this.audio);
      this.audio = null;
    }
  }
}

function discard(audio) {
  try {
    audio.pause();
    audio.removeAttribute?.('src');
    audio.load?.();
  } catch {
    // already gone
  }
}
