// SoundCloud playback through the official embed widget
// (https://developers.soundcloud.com/docs/api/html5-widget).
//
// SoundCloudAudio wraps the widget in the small subset of the HTMLAudioElement
// interface that Channel uses (src, load, play, pause, volume, events), so a
// SoundCloud station gets the same retry, fallback, mute and volume handling
// as a plain audio stream.

const API_URL = 'https://w.soundcloud.com/player/api.js';

export function isSoundCloudUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)soundcloud\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

export function widgetUrl(url, { color = '7c6ff0' } = {}) {
  const params = new URLSearchParams({
    url,
    auto_play: 'false',
    visual: 'false',
    color,
    show_comments: 'false',
    show_reposts: 'false',
    show_teaser: 'false',
    hide_related: 'true',
    show_user: 'true',
    single_active: 'false', // don't pause other widgets/players
  });
  return `https://w.soundcloud.com/player/?${params}`;
}

let apiPromise = null;

/** Load SoundCloud's widget API script once; resolves to window.SC. */
export function loadSoundCloudApi(doc = globalThis.document) {
  if (globalThis.SC?.Widget) return Promise.resolve(globalThis.SC);
  apiPromise ??= new Promise((resolve, reject) => {
    const script = doc.createElement('script');
    script.src = API_URL;
    script.async = true;
    script.onload = () => (globalThis.SC?.Widget ? resolve(globalThis.SC) : reject(new Error('SC.Widget missing')));
    script.onerror = () => {
      apiPromise = null; // allow a later retry
      reject(new Error('could not load the SoundCloud widget API'));
    };
    doc.head.append(script);
  });
  return apiPromise;
}

export class SoundCloudAudio extends EventTarget {
  /**
   * @param {object} opts
   * @param {Element} opts.host       element the widget iframe is added to
   * @param {Function} opts.loadApi   resolves to the SC global (injectable for tests)
   * @param {Document} opts.document
   * @param {object} opts.timers      { setTimeout, clearTimeout }
   * @param {Function} opts.random    () => [0, 1), used to pick a starting track
   * @param {number} opts.playTimeoutMs  how long play() waits for the widget to start
   */
  constructor({
    host,
    loadApi = loadSoundCloudApi,
    document: doc = globalThis.document,
    timers = globalThis,
    random = Math.random,
    playTimeoutMs = 10000,
  }) {
    super();
    this.host = host;
    this.loadApi = loadApi;
    this.doc = doc;
    this.timers = timers;
    this.random = random;
    this.playTimeoutMs = playTimeoutMs;
    this._src = '';
    this._volume = 1;
    this.iframe = null;
    this.widget = null;
    this.paused = true;
    this.error = null;
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
    this.widget?.setVolume(Math.round(v * 100));
  }

  load() {
    this._destroy();
    if (!this._src) return;
    if (!isSoundCloudUrl(this._src)) {
      this._fail(new Error(`not a SoundCloud URL: ${this._src}`));
      return;
    }
    const iframe = this.doc.createElement('iframe');
    iframe.className = 'soundcloud-widget';
    iframe.title = 'SoundCloud player';
    iframe.allow = 'autoplay; encrypted-media';
    iframe.src = widgetUrl(this._src);
    this.iframe = iframe;
    this.host.append(iframe);
    this.host.hidden = false;

    this.loadApi(this.doc).then(
      (SC) => {
        if (this.iframe !== iframe) return; // replaced or discarded meanwhile
        const widget = SC.Widget(iframe);
        this.widget = widget;
        const E = SC.Widget.Events;
        widget.bind(E.READY, () => this._onReady(widget));
        widget.bind(E.ERROR, () => {
          if (widget === this.widget) this._fail(new Error('SoundCloud could not play this'));
        });
        widget.bind(E.PLAY, () => {
          this.paused = false;
          this.dispatchEvent(new Event('playing'));
        });
        widget.bind(E.PAUSE, () => {
          this.paused = true;
        });
        widget.bind(E.FINISH, () => this._onFinish(widget));
      },
      (err) => {
        if (this.iframe === iframe) this._fail(err);
      },
    );
  }

  _onReady(widget) {
    if (widget !== this.widget) return;
    widget.setVolume(Math.round(this._volume * 100));
    // Start somewhere random in the list so it isn't the same song every time.
    widget.getSounds((sounds) => {
      if (widget !== this.widget) return;
      if (sounds?.length > 1) widget.skip(Math.floor(this.random() * sounds.length));
      this.dispatchEvent(new Event('canplay'));
    });
  }

  _onFinish(widget) {
    // The widget advances through a list on its own; at the very end, loop.
    widget.getCurrentSoundIndex((i) => {
      widget.getSounds((sounds) => {
        if (widget === this.widget && i >= (sounds?.length ?? 0) - 1) widget.skip(0);
      });
    });
  }

  play() {
    const widget = this.widget;
    if (!widget) return Promise.reject(new Error('SoundCloud widget not ready'));
    return new Promise((resolve, reject) => {
      const onPlaying = () => {
        this.timers.clearTimeout(timer);
        resolve();
      };
      // A widget that never starts is most likely blocked by autoplay policy.
      const timer = this.timers.setTimeout(() => {
        this.removeEventListener('playing', onPlaying);
        const err = new Error('SoundCloud did not start playing');
        err.name = 'NotAllowedError';
        reject(err);
      }, this.playTimeoutMs);
      this.addEventListener('playing', onPlaying, { once: true });
      widget.play();
    });
  }

  pause() {
    this.widget?.pause();
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
    if (this.widget) {
      try {
        this.widget.pause();
      } catch {
        // iframe may already be gone
      }
    }
    this.widget = null;
    if (this.iframe) {
      this.iframe.remove();
      this.iframe = null;
      if (!this.host.querySelector('iframe')) this.host.hidden = true;
    }
    this.paused = true;
  }
}
