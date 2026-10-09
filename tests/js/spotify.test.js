import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Channel } from '../../lofi_atc/static/player.js';
import { SpotifyAudio, spotifyContextUri } from '../../lofi_atc/static/spotify.js';

// ── test doubles ──

class FakePlayer {
  static instances = [];
  constructor(opts) {
    this.opts = opts;
    this.listeners = {};
    this.calls = [];
    FakePlayer.instances.push(this);
  }
  addListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); }
  emit(ev, arg) { for (const fn of this.listeners[ev] ?? []) fn(arg); }
  connect() { this.calls.push(['connect']); return Promise.resolve(true); }
  disconnect() { this.calls.push(['disconnect']); }
  pause() { this.calls.push(['pause']); return Promise.resolve(); }
  setVolume(v) { this.calls.push(['setVolume', v]); return Promise.resolve(); }
  activateElement() { this.calls.push(['activateElement']); return Promise.resolve(); }
}

const FakeSpotify = { Player: FakePlayer };

class FakeTimers {
  constructor() { this.pending = new Map(); this.next = 1; }
  setTimeout(fn, ms) { const id = this.next++; this.pending.set(id, { fn, ms }); return id; }
  clearTimeout(id) { this.pending.delete(id); }
  fire(ms) {
    for (const [id, t] of [...this.pending]) if (t.ms === ms) { this.pending.delete(id); t.fn(); }
  }
}

/** Web API double: answers PUT /me/player/play from `playResponses`, everything else 204. */
function fakeApi({ playResponses = [{ status: 204 }], onPlay } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const path = url.replace('https://api.spotify.com/v1', '');
    calls.push({ method: init.method, path, auth: init.headers.Authorization, body: init.body && JSON.parse(init.body) });
    if (path.startsWith('/me/player/play')) {
      const r = playResponses.shift() ?? { status: 204 };
      onPlay?.();
      return { ok: r.status < 300, status: r.status, json: async () => r.body ?? {} };
    }
    return { ok: true, status: 204, json: async () => ({}) };
  };
  fetch.calls = calls;
  return fetch;
}

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const PLAYLIST = 'https://open.spotify.com/playlist/0vvXsWCC9xrXsKd4FyS8kM?si=abc';
const connectedAuth = { connected: true, accessToken: async () => 'tok' };

function setup({ auth = connectedAuth, sdkLoaded = true, api = fakeApi(), loadSdk } = {}) {
  FakePlayer.instances = [];
  const timers = new FakeTimers();
  const tracks = [];
  const audio = new SpotifyAudio({
    auth,
    fetch: api,
    timers,
    getSdk: () => (sdkLoaded ? FakeSpotify : null),
    loadSdk: loadSdk ?? (() => Promise.resolve(FakeSpotify)),
    onTrack: (t) => tracks.push(t),
    playTimeoutMs: 5000,
    deviceRetryMs: 100,
  });
  const events = [];
  for (const ev of ['canplay', 'error', 'playing']) audio.addEventListener(ev, () => events.push(ev));
  return { audio, api, timers, tracks, events };
}

function ready(audio, src = PLAYLIST) {
  audio.src = src;
  audio.load();
  const player = FakePlayer.instances.at(-1);
  player.emit('ready', { device_id: 'dev 1' });
  return player;
}

const playingState = (id = 't1', name = 'Snowman', artists = ['Wun Two']) => ({
  paused: false,
  track_window: { current_track: { id, name, artists: artists.map((n) => ({ name: n })) } },
});

// ── helpers ──

describe('spotifyContextUri', () => {
  for (const [url, uri] of [
    ['https://open.spotify.com/playlist/0vvXsWCC9xrXsKd4FyS8kM', 'spotify:playlist:0vvXsWCC9xrXsKd4FyS8kM'],
    [PLAYLIST, 'spotify:playlist:0vvXsWCC9xrXsKd4FyS8kM'],
    ['https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc', 'spotify:album:2noRn2Aes5aoNVsU6iWThc'],
    ['https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF/', 'spotify:artist:0OdUWJ0sBjDrqHygGUXeCF'],
    ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', null],
    ['http://open.spotify.com/playlist/0vvXsWCC9xrXsKd4FyS8kM', null],
    ['https://open.spotify.com.evil.example/playlist/0vvXsWCC9xrXsKd4FyS8kM', null],
    ['nope', null],
  ]) {
    it(`${url} -> ${uri}`, () => assert.equal(spotifyContextUri(url), uri));
  }
});

// ── SpotifyAudio ──

describe('SpotifyAudio', () => {
  it('fails fast when Spotify is not connected', () => {
    const { audio, events } = setup({ auth: { connected: false } });
    audio.src = PLAYLIST;
    audio.load();
    assert.deepEqual(events, ['error']);
    assert.equal(audio.error.code, 'not_connected');
    assert.equal(FakePlayer.instances.length, 0);
  });

  it('rejects links it cannot play', () => {
    const { audio, events } = setup();
    audio.src = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC';
    audio.load();
    assert.deepEqual(events, ['error']);
    assert.equal(audio.error.code, 'bad_url');
  });

  it('creates the player synchronously when the SDK is loaded, and is playable once ready', async () => {
    const { audio, events } = setup();
    audio.volume = 0.4;
    audio.src = PLAYLIST;
    audio.load();
    const player = FakePlayer.instances[0];
    assert.equal(player.opts.name, 'lofi + atc');
    assert.equal(player.opts.volume, 0.4);
    assert.deepEqual(player.calls.slice(0, 2), [['activateElement'], ['connect']]);
    const token = await new Promise((r) => player.opts.getOAuthToken(r));
    assert.equal(token, 'tok');
    player.emit('ready', { device_id: 'dev 1' });
    assert.deepEqual(events, ['canplay']);
    assert.equal(audio.deviceId, 'dev 1');
  });

  it('loads the SDK first when needed', async () => {
    let loads = 0;
    const { audio } = setup({ sdkLoaded: false, loadSdk: () => { loads++; return Promise.resolve(FakeSpotify); } });
    audio.src = PLAYLIST;
    audio.load();
    assert.equal(FakePlayer.instances.length, 0);
    await flush();
    assert.equal(loads, 1);
    assert.equal(FakePlayer.instances.length, 1);
  });

  it('reports an SDK that fails to load', async () => {
    const { audio, events } = setup({ sdkLoaded: false, loadSdk: () => Promise.reject(new Error('blocked')) });
    audio.src = PLAYLIST;
    audio.load();
    await flush();
    assert.deepEqual(events, ['error']);
    assert.equal(audio.error.code, 'sdk');
  });

  it('play() activates the device, shuffles, repeats and starts the playlist', async () => {
    const { audio, api, events, tracks } = setup();
    const player = ready(audio);
    const p = audio.play();
    await flush();
    player.emit('player_state_changed', playingState());
    await p;
    assert.deepEqual(api.calls.map((c) => [c.method, c.path]), [
      ['PUT', '/me/player'],
      ['PUT', '/me/player/shuffle?state=true&device_id=dev%201'],
      ['PUT', '/me/player/repeat?state=context&device_id=dev%201'],
      ['PUT', '/me/player/play?device_id=dev%201'],
    ]);
    assert.deepEqual(api.calls[0].body, { device_ids: ['dev 1'], play: false });
    assert.deepEqual(api.calls[3].body, { context_uri: 'spotify:playlist:0vvXsWCC9xrXsKd4FyS8kM' });
    assert.ok(api.calls.every((c) => c.auth === 'Bearer tok'));
    assert.equal(audio.paused, false);
    assert.deepEqual(events, ['canplay', 'playing']);
    assert.deepEqual(tracks, [{ name: 'Snowman', artists: 'Wun Two' }]);
  });

  it('reports each new track once', () => {
    const { audio, tracks } = setup();
    const player = ready(audio);
    player.emit('player_state_changed', playingState('t1', 'A', ['X', 'Y']));
    player.emit('player_state_changed', playingState('t1', 'A', ['X', 'Y']));
    player.emit('player_state_changed', playingState('t2', 'B'));
    player.emit('player_state_changed', null);
    assert.deepEqual(tracks, [{ name: 'A', artists: 'X, Y' }, { name: 'B', artists: 'Wun Two' }]);
  });

  it('retries once when the new device is not known to the Web API yet', async () => {
    const api = fakeApi({ playResponses: [{ status: 404 }, { status: 204 }] });
    const { audio, timers } = setup({ api });
    const player = ready(audio);
    const p = audio.play();
    await flush();
    timers.fire(100);
    await flush();
    assert.equal(api.calls.filter((c) => c.path.startsWith('/me/player/play')).length, 2);
    player.emit('player_state_changed', playingState());
    await p;
  });

  it('turns PREMIUM_REQUIRED into a clear error', async () => {
    const api = fakeApi({ playResponses: [{ status: 403, body: { error: { reason: 'PREMIUM_REQUIRED', message: 'x' } } }] });
    const { audio } = setup({ api });
    ready(audio);
    await assert.rejects(audio.play(), { code: 'premium' });
  });

  it('reports other Web API failures', async () => {
    const api = fakeApi({ playResponses: [{ status: 500, body: { error: { message: 'boom' } } }] });
    const { audio } = setup({ api });
    ready(audio);
    await assert.rejects(audio.play(), (e) => e.code === 'api' && /boom/.test(e.message));
  });

  it('play() rejects as NotAllowedError when the browser blocks autoplay', async () => {
    const { audio } = setup();
    const player = ready(audio);
    const p = audio.play();
    await flush();
    player.emit('autoplay_failed');
    await assert.rejects(p, { name: 'NotAllowedError' });
  });

  it('play() times out if playback never starts', async () => {
    const { audio, timers } = setup();
    ready(audio);
    const p = audio.play();
    await flush();
    timers.fire(5000);
    await assert.rejects(p, { code: 'timeout' });
  });

  it('play() rejects before the device is ready', async () => {
    const { audio } = setup();
    audio.src = PLAYLIST;
    audio.load();
    await assert.rejects(audio.play(), { code: 'not_ready' });
  });

  for (const [event, arg, code] of [
    ['account_error', { message: 'premium' }, 'premium'],
    ['authentication_error', { message: 'bad token' }, 'auth'],
    ['initialization_error', { message: 'no EME' }, 'unsupported'],
    ['playback_error', { message: 'failed' }, 'playback'],
    ['not_ready', { device_id: 'dev 1' }, 'offline'],
  ]) {
    it(`${event} becomes an error event (${code})`, () => {
      const { audio, events } = setup();
      const player = ready(audio);
      player.emit(event, arg);
      assert.deepEqual(events, ['canplay', 'error']);
      assert.equal(audio.error.code, code);
    });
  }

  it('reports a failed connect', async () => {
    const original = FakePlayer.prototype.connect;
    FakePlayer.prototype.connect = () => Promise.resolve(false);
    try {
      const { audio, events } = setup();
      audio.src = PLAYLIST;
      audio.load();
      await flush();
      assert.deepEqual(events, ['error']);
      assert.equal(audio.error.code, 'connect');
    } finally {
      FakePlayer.prototype.connect = original;
    }
  });

  it('forwards volume changes to the player (0-1)', () => {
    const { audio } = setup();
    const player = ready(audio);
    audio.volume = 0.25;
    assert.deepEqual(player.calls.at(-1), ['setVolume', 0.25]);
  });

  it('removeAttribute("src") disconnects the player and ignores its late events', () => {
    const { audio, events } = setup();
    const player = ready(audio);
    audio.removeAttribute('src');
    assert.deepEqual(player.calls.at(-1), ['disconnect']);
    assert.equal(audio.player, null);
    player.emit('playback_error', { message: 'late' });
    player.emit('ready', { device_id: 'x' });
    assert.deepEqual(events, ['canplay']);
  });

  it('an SDK that loads after the element was discarded creates no player', async () => {
    let resolveSdk;
    const { audio } = setup({ sdkLoaded: false, loadSdk: () => new Promise((r) => { resolveSdk = r; }) });
    audio.src = PLAYLIST;
    audio.load();
    audio.removeAttribute('src');
    resolveSdk(FakeSpotify);
    await flush();
    assert.equal(FakePlayer.instances.length, 0);
  });
});

// ── Channel integration ──

describe('Channel with a Spotify station', () => {
  it('falls back to the next station when Spotify is not connected', async () => {
    FakePlayer.instances = [];
    const statuses = [];
    class OkAudio extends EventTarget {
      load() { queueMicrotask(() => this.dispatchEvent(new Event('canplay'))); }
      play() { return Promise.resolve(); }
      pause() {}
      removeAttribute() {}
    }
    const ch = new Channel({
      timers: new FakeTimers(),
      createAudio: (s) =>
        s.type === 'spotify'
          ? new SpotifyAudio({ auth: { connected: false }, getSdk: () => FakeSpotify })
          : new OkAudio(),
      onStatus: (s, d) => statuses.push([s, d?.source?.label]),
    });
    const ok = await ch.start([
      { type: 'spotify', label: 'Spotify', url: PLAYLIST },
      { type: 'stream', label: 'Radio', url: 'https://radio.example/stream' },
    ]);
    assert.equal(ok, true);
    assert.deepEqual(statuses.at(-1), ['live', 'Radio']);
  });

  it('plays Spotify through the channel and applies mute', async () => {
    const { audio } = setup();
    const ch = new Channel({ timers: new FakeTimers(), createAudio: () => audio });
    const p = ch.start([{ type: 'spotify', label: 'Spotify', url: PLAYLIST }]);
    const player = FakePlayer.instances.at(-1);
    player.emit('ready', { device_id: 'dev' });
    await flush();
    player.emit('player_state_changed', playingState());
    assert.equal(await p, true);
    ch.setMuted(true);
    assert.deepEqual(player.calls.at(-1), ['setVolume', 0]);
    ch.stop();
    assert.deepEqual(player.calls.at(-2), ['pause']);
    assert.deepEqual(player.calls.at(-1), ['disconnect']);
  });
});
