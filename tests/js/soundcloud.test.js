import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Channel } from '../../lofi_atc/static/player.js';
import { SoundCloudAudio, isSoundCloudUrl, widgetUrl } from '../../lofi_atc/static/soundcloud.js';

// ── test doubles ──

const Events = { READY: 'ready', ERROR: 'error', PLAY: 'play', PAUSE: 'pause', FINISH: 'finish' };

class FakeWidget {
  constructor(iframe) {
    this.iframe = iframe;
    this.handlers = {};
    this.calls = [];
    this.sounds = [{}, {}, {}, {}];
    this.index = 0;
    this.startsOnPlay = true; // false simulates autoplay being blocked
  }
  bind(ev, fn) { (this.handlers[ev] ??= []).push(fn); }
  fire(ev) { for (const fn of this.handlers[ev] ?? []) fn(); }
  setVolume(v) { this.calls.push(['setVolume', v]); }
  getSounds(cb) { cb(this.sounds); }
  getCurrentSoundIndex(cb) { cb(this.index); }
  skip(i) { this.calls.push(['skip', i]); }
  play() { this.calls.push(['play']); if (this.startsOnPlay) this.fire(Events.PLAY); }
  pause() { this.calls.push(['pause']); }
}

function fakeSC() {
  const widgets = [];
  const Widget = (iframe) => {
    const w = new FakeWidget(iframe);
    widgets.push(w);
    return w;
  };
  Widget.Events = Events;
  return { SC: { Widget }, widgets };
}

function fakeDom() {
  const host = {
    hidden: true,
    children: [],
    append(el) { el.parent = this; this.children.push(el); },
    querySelector() { return this.children[0] ?? null; },
  };
  const document = {
    createElement(tag) {
      return { tag, remove() { this.parent.children = this.parent.children.filter((c) => c !== this); } };
    },
  };
  return { host, document };
}

class FakeTimers {
  constructor() { this.pending = new Map(); this.next = 1; }
  setTimeout(fn, ms) { const id = this.next++; this.pending.set(id, { fn, ms }); return id; }
  clearTimeout(id) { this.pending.delete(id); }
  fire(ms) {
    for (const [id, t] of [...this.pending]) if (t.ms === ms) { this.pending.delete(id); t.fn(); }
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const URL_OK = 'https://soundcloud.com/chillhopdotcom';

function setup({ loadApi, random = () => 0.5 } = {}) {
  const { SC, widgets } = fakeSC();
  const { host, document } = fakeDom();
  const timers = new FakeTimers();
  const audio = new SoundCloudAudio({
    host,
    document,
    timers,
    random,
    playTimeoutMs: 5000,
    loadApi: loadApi ?? (() => Promise.resolve(SC)),
  });
  const events = [];
  for (const ev of ['canplay', 'error', 'playing']) audio.addEventListener(ev, () => events.push(ev));
  return { audio, host, widgets, timers, events };
}

// ── helpers ──

describe('isSoundCloudUrl', () => {
  for (const [url, ok] of [
    ['https://soundcloud.com/chillhopdotcom', true],
    ['https://soundcloud.com/chillhopdotcom/sets/x', true],
    ['https://m.soundcloud.com/lofi_girl', true],
    ['http://soundcloud.com/x', false],
    ['https://soundcloud.com.evil.example/x', false],
    ['https://evil.example/soundcloud.com', false],
    ['not a url', false],
  ]) {
    it(`${url} -> ${ok}`, () => assert.equal(isSoundCloudUrl(url), ok));
  }
});

describe('widgetUrl', () => {
  it('embeds the URL without autoplay and without pausing other players', () => {
    const u = new URL(widgetUrl(URL_OK));
    assert.equal(u.origin + u.pathname, 'https://w.soundcloud.com/player/');
    assert.equal(u.searchParams.get('url'), URL_OK);
    assert.equal(u.searchParams.get('auto_play'), 'false');
    assert.equal(u.searchParams.get('single_active'), 'false');
  });
});

// ── SoundCloudAudio ──

describe('SoundCloudAudio', () => {
  it('shows the widget and becomes playable at a random track', async () => {
    const { audio, host, widgets, events } = setup({ random: () => 0.6 });
    audio.volume = 0.42;
    audio.src = URL_OK;
    audio.load();
    assert.equal(host.hidden, false);
    assert.equal(host.children.length, 1);
    assert.match(host.children[0].src, /^https:\/\/w\.soundcloud\.com\/player\//);
    assert.match(host.children[0].allow, /autoplay/);
    await flush();
    widgets[0].fire(Events.READY);
    assert.deepEqual(widgets[0].calls, [['setVolume', 42], ['skip', 2]]);
    assert.deepEqual(events, ['canplay']);
  });

  it('does not skip when there is a single track', async () => {
    const { audio, widgets } = setup();
    audio.src = URL_OK;
    audio.load();
    await flush();
    widgets[0].sounds = [{}];
    widgets[0].fire(Events.READY);
    assert.deepEqual(widgets[0].calls, [['setVolume', 100]]);
  });

  it('play() resolves once the widget reports PLAY', async () => {
    const { audio, widgets, events } = setup();
    audio.src = URL_OK;
    audio.load();
    await flush();
    widgets[0].fire(Events.READY);
    await audio.play();
    assert.equal(audio.paused, false);
    assert.deepEqual(events, ['canplay', 'playing']);
  });

  it('play() rejects with NotAllowedError when the widget never starts', async () => {
    const { audio, widgets, timers } = setup();
    audio.src = URL_OK;
    audio.load();
    await flush();
    widgets[0].startsOnPlay = false;
    widgets[0].fire(Events.READY);
    const p = audio.play();
    timers.fire(5000);
    await assert.rejects(p, { name: 'NotAllowedError' });
  });

  it('play() rejects before the widget exists', async () => {
    const { audio } = setup();
    await assert.rejects(audio.play());
  });

  it('forwards volume changes to the widget as 0-100', async () => {
    const { audio, widgets } = setup();
    audio.src = URL_OK;
    audio.load();
    await flush();
    audio.volume = 0.255;
    audio.volume = 0;
    assert.deepEqual(widgets[0].calls, [['setVolume', 26], ['setVolume', 0]]);
  });

  it('reports widget errors', async () => {
    const { audio, widgets, events } = setup();
    audio.src = URL_OK;
    audio.load();
    await flush();
    widgets[0].fire(Events.ERROR);
    assert.deepEqual(events, ['error']);
    assert.ok(audio.error);
  });

  it('rejects non-SoundCloud URLs without creating a widget', () => {
    const { audio, host, events } = setup();
    audio.src = 'https://evil.example/track';
    audio.load();
    assert.deepEqual(events, ['error']);
    assert.equal(host.children.length, 0);
  });

  it('reports a failure to load the widget API', async () => {
    const { audio, events } = setup({ loadApi: () => Promise.reject(new Error('blocked')) });
    audio.src = URL_OK;
    audio.load();
    await flush();
    assert.deepEqual(events, ['error']);
  });

  it('removeAttribute("src") tears the widget down and hides the host', async () => {
    const { audio, host, widgets, events } = setup();
    audio.src = URL_OK;
    audio.load();
    await flush();
    const widget = widgets[0];
    audio.removeAttribute('src');
    assert.equal(host.children.length, 0);
    assert.equal(host.hidden, true);
    assert.deepEqual(widget.calls.at(-1), ['pause']);
    // Late events from the old widget are ignored.
    widget.fire(Events.ERROR);
    widget.fire(Events.READY);
    assert.deepEqual(events, []);
  });

  it('ignores an API that resolves after the widget was discarded', async () => {
    let resolveApi;
    const { SC } = fakeSC();
    const { audio, events } = setup({ loadApi: () => new Promise((r) => { resolveApi = r; }) });
    audio.src = URL_OK;
    audio.load();
    audio.removeAttribute('src');
    resolveApi(SC);
    await flush();
    assert.equal(audio.widget, null);
    assert.deepEqual(events, []);
  });

  it('loops back to the first track after the last one finishes', async () => {
    const { audio, widgets } = setup();
    audio.src = URL_OK;
    audio.load();
    await flush();
    const w = widgets[0];
    w.index = 1;
    w.fire(Events.FINISH);
    assert.equal(w.calls.filter(([c]) => c === 'skip').length, 0);
    w.index = 3;
    w.fire(Events.FINISH);
    assert.deepEqual(w.calls.at(-1), ['skip', 0]);
  });
});

// ── Channel integration: streams and SoundCloud in one fallback list ──

describe('Channel with mixed source types', () => {
  it('falls back from a failing stream to a SoundCloud station', async () => {
    const { SC, widgets } = fakeSC();
    const { host, document } = fakeDom();
    const statuses = [];
    const created = [];

    class DeadAudio extends EventTarget {
      load() { queueMicrotask(() => this.dispatchEvent(new Event('error'))); }
      pause() {}
      removeAttribute() {}
    }

    const ch = new Channel({
      timers: new FakeTimers(),
      createAudio: (station) => {
        created.push(station.type);
        return station.type === 'soundcloud'
          ? new SoundCloudAudio({ host, document, loadApi: () => Promise.resolve(SC), random: () => 0 })
          : new DeadAudio();
      },
      onStatus: (s, d) => statuses.push([s, d?.source?.label]),
    });

    const p = ch.start([
      { type: 'stream', label: 'Radio', url: 'https://radio.example/stream' },
      { type: 'soundcloud', label: 'Chillhop', url: URL_OK },
    ]);
    await flush();
    await flush();
    widgets[0].fire(Events.READY);
    assert.equal(await p, true);
    assert.deepEqual(created, ['stream', 'soundcloud']);
    assert.deepEqual(statuses.at(-1), ['live', 'Chillhop']);

    ch.setMuted(true);
    assert.deepEqual(widgets[0].calls.at(-1), ['setVolume', 0]);
    ch.stop();
    assert.equal(host.children.length, 0);
  });
});
