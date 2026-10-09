// Spotify playback through the Web Playback SDK (Premium only).
// https://developer.spotify.com/documentation/web-playback-sdk
//
// SpotifyAudio turns this browser tab into a Spotify Connect device and
// starts a playlist/album/artist on it. Like SoundCloudAudio, it exposes the
// subset of the HTMLAudioElement interface that Channel uses, so Spotify
// stations get the same fallback, retry, mute and volume handling.

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
const API = 'https://api.spotify.com/v1';

/** "https://open.spotify.com/playlist/ID?si=..." -> "spotify:playlist:ID" */
export function spotifyContextUri(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'open.spotify.com') return null;
    const m = /^\/(playlist|album|artist)\/([A-Za-z0-9]{10,40})\/?$/.exec(u.pathname);
    return m ? `spotify:${m[1]}:${m[2]}` : null;
  } catch {
    return null;
  }
}

let sdkPromise = null;

/** Load the Web Playback SDK once; resolves to window.Spotify. */
export function loadSpotifySdk(doc = globalThis.document) {
  if (globalThis.Spotify?.Player) return Promise.resolve(globalThis.Spotify);
  sdkPromise ??= new Promise((resolve, reject) => {
    // The SDK calls this global when it is ready.
    globalThis.onSpotifyWebPlaybackSDKReady = () => resolve(globalThis.Spotify);
    const script = doc.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error('could not load the Spotify player'));
    };
    doc.head.append(script);
  });
  return sdkPromise;
}

function problem(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export class SpotifyAudio extends EventTarget {
  /**
   * @param {object} opts
   * @param {SpotifyAuth} opts.auth
   * @param {Function} opts.loadSdk    resolves to the Spotify global (injectable for tests)
   * @param {Function} opts.getSdk     returns the Spotify global if already loaded, so the
   *                                   player can be created inside the click that started it
   * @param {Function} opts.fetch
   * @param {object} opts.timers       { setTimeout, clearTimeout }
   * @param {Function} opts.onTrack    called with { name, artists } when the track changes
   * @param {number} opts.playTimeoutMs
   * @param {number} opts.deviceRetryMs  wait before retrying a just-registered device
   */
  constructor({
    auth,
    loadSdk = loadSpotifySdk,
    getSdk = () => (globalThis.Spotify?.Player ? globalThis.Spotify : null),
    fetch = globalThis.fetch?.bind(globalThis),
    timers = globalThis,
    onTrack = () => {},
    name = 'lofi + atc',
    playTimeoutMs = 20000,
    deviceRetryMs = 1500,
  }) {
    super();
    Object.assign(this, { auth, loadSdk, getSdk, fetch, timers, onTrack, name, playTimeoutMs, deviceRetryMs });
    this._src = '';
    this._volume = 1;
    this.player = null;
    this.deviceId = null;
    this.paused = true;
    this.error = null;
    this._trackId = null;
  }

  get src() {
    return this._src;
  }

  set src(url) {
    this._src = url;
  }

  get volume() {
    return this._volume;
  }

  set volume(v) {
    this._volume = v;
    this.player?.setVolume(v)?.catch?.(() => {});
  }

  load() {
    this._destroy();
    if (!this._src) return;
    if (!this.auth?.connected) {
      this._fail(problem('Spotify is not connected', 'not_connected'));
      return;
    }
    this.contextUri = spotifyContextUri(this._src);
    if (!this.contextUri) {
      this._fail(problem(`not a Spotify playlist, album or artist link: ${this._src}`, 'bad_url'));
      return;
    }
    const sdk = this.getSdk();
    if (sdk) this._createPlayer(sdk);
    else {
      const src = this._src;
      this.loadSdk().then(
        (Spotify) => {
          if (this._src === src && !this.player) this._createPlayer(Spotify);
        },
        (err) => this._fail(problem(err.message, 'sdk')),
      );
    }
  }

  _createPlayer(Spotify) {
    const player = new Spotify.Player({
      name: this.name,
      volume: this._volume,
      getOAuthToken: (cb) => {
        this.auth.accessToken().then(cb, (err) => this._fail(err));
      },
    });
    this.player = player;
    const mine = (fn) => (arg) => {
      if (this.player === player) fn(arg);
    };
    player.addListener('ready', mine(({ device_id }) => {
      this.deviceId = device_id;
      this.dispatchEvent(new Event('canplay'));
    }));
    player.addListener('not_ready', mine(() => this._fail(problem('Spotify player went offline', 'offline'))));
    player.addListener('initialization_error', mine(({ message }) =>
      this._fail(problem(`Spotify can't play in this browser (${message})`, 'unsupported'))));
    player.addListener('authentication_error', mine(() => {
      this._fail(problem('Spotify login expired; please reconnect', 'auth'));
    }));
    player.addListener('account_error', mine(() =>
      this._fail(problem('Spotify Premium is required to play here', 'premium'))));
    player.addListener('playback_error', mine(({ message }) =>
      this._fail(problem(`Spotify playback error (${message})`, 'playback'))));
    player.addListener('autoplay_failed', mine(() => this.dispatchEvent(new Event('autoplayfailed'))));
    player.addListener('player_state_changed', mine((state) => this._onState(state)));
    // Lets browsers that gate audio on a user gesture allow playback; this
    // runs inside the play click when the SDK was already loaded.
    player.activateElement?.()?.catch?.(() => {});
    player.connect().then(
      mine((ok) => {
        if (!ok) this._fail(problem('could not connect to Spotify', 'connect'));
      }),
      mine((err) => this._fail(problem(`could not connect to Spotify (${err?.message ?? err})`, 'connect'))),
    );
  }

  _onState(state) {
    if (!state) return;
    const playing = !state.paused;
    if (playing && this.paused) {
      this.paused = false;
      this.dispatchEvent(new Event('playing'));
    } else if (!playing) {
      this.paused = true;
    }
    const track = state.track_window?.current_track;
    if (track && track.id !== this._trackId) {
      this._trackId = track.id;
      this.onTrack({ name: track.name, artists: (track.artists ?? []).map((a) => a.name).join(', ') });
    }
  }

  async play() {
    if (!this.player || !this.deviceId) throw problem('Spotify player not ready', 'not_ready');
    const player = this.player;
    const device = encodeURIComponent(this.deviceId);
    const started = this._waitForPlaying(player);
    try {
      // Make this tab the active device so shuffle/repeat apply to it, then
      // start the playlist. Shuffle/repeat are niceties: ignore failures.
      await this._api('PUT', '/me/player', { device_ids: [this.deviceId], play: false }).catch(() => {});
      await this._api('PUT', `/me/player/shuffle?state=true&device_id=${device}`).catch(() => {});
      await this._api('PUT', `/me/player/repeat?state=context&device_id=${device}`).catch(() => {});
      let res = await this._api('PUT', `/me/player/play?device_id=${device}`, { context_uri: this.contextUri });
      if (res.status === 404) {
        // A device that just reported ready is sometimes not known to the Web API yet.
        await new Promise((r) => this.timers.setTimeout(r, this.deviceRetryMs));
        if (this.player !== player) throw problem('Spotify player was closed', 'closed');
        res = await this._api('PUT', `/me/player/play?device_id=${device}`, { context_uri: this.contextUri });
      }
      if (!res.ok) throw await this._apiProblem(res);
    } catch (err) {
      started.cancel();
      throw err;
    }
    return started.promise;
  }

  _waitForPlaying(player) {
    let cancel;
    const promise = new Promise((resolve, reject) => {
      const done = () => {
        this.timers.clearTimeout(timer);
        this.removeEventListener('playing', onPlaying);
        this.removeEventListener('autoplayfailed', onBlocked);
        this.removeEventListener('error', onError);
      };
      const onPlaying = () => { done(); resolve(); };
      const onBlocked = () => {
        done();
        const err = problem('the browser blocked Spotify from starting', 'autoplay');
        err.name = 'NotAllowedError';
        reject(err);
      };
      const onError = () => { done(); reject(this.error); };
      const timer = this.timers.setTimeout(() => {
        done();
        reject(problem('Spotify did not start playing', 'timeout'));
      }, this.playTimeoutMs);
      this.addEventListener('playing', onPlaying);
      this.addEventListener('autoplayfailed', onBlocked);
      this.addEventListener('error', onError);
      cancel = () => { done(); };
    });
    promise.catch(() => {}); // a cancelled wait must not surface as unhandled
    if (this.player !== player) cancel();
    return { promise, cancel };
  }

  async _api(method, path, body) {
    const token = await this.auth.accessToken();
    return this.fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async _apiProblem(res) {
    const body = await res.json?.().catch(() => ({})) ?? {};
    const reason = body?.error?.reason;
    if (res.status === 403 && reason === 'PREMIUM_REQUIRED') {
      return problem('Spotify Premium is required to play here', 'premium');
    }
    if (res.status === 401) return problem('Spotify login expired; please reconnect', 'auth');
    return problem(`Spotify refused to play (${body?.error?.message ?? res.status})`, 'api');
  }

  pause() {
    this.player?.pause()?.catch?.(() => {});
    this.paused = true;
  }

  // Channel discards an element with removeAttribute('src') + load().
  removeAttribute(name) {
    if (name === 'src') {
      this._src = '';
      this._destroy();
    }
  }

  _fail(err) {
    this.error = err;
    this.dispatchEvent(new Event('error'));
  }

  _destroy() {
    const player = this.player;
    this.player = null;
    this.deviceId = null;
    this._trackId = null;
    this.paused = true;
    if (player) {
      try {
        player.disconnect();
      } catch {
        // already gone
      }
    }
  }
}
