import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Channel,
  addCustomFeeds,
  atcSources,
  atcUrl,
  chosenFirst,
  backoffDelay,
  icaoFromMount,
  mergeAirports,
  mountFromAtcUrl,
  musicSources,
  nextMuteAll,
  parseFeedInput,
  shortcutFor,
} from '../../lofi_atc/static/player.js';

// ── test doubles ──

class FakeAudio extends EventTarget {
  // behaviour: 'ok' -> canplay; 'error' -> error; 'hang' -> nothing; 'reject-play'
  static behaviour = {};
  static instances = [];

  constructor() {
    super();
    this.volume = 1;
    this.paused = true;
    this.src = '';
    FakeAudio.instances.push(this);
  }

  addEventListener(type, fn, opts) {
    super.addEventListener(type, fn, opts);
  }

  load() {
    const b = FakeAudio.behaviour[this.src];
    if (b === 'ok' || b === 'reject-play') queueMicrotask(() => this.dispatchEvent(new Event('canplay')));
    else if (b === 'error') queueMicrotask(() => this.dispatchEvent(new Event('error')));
  }

  play() {
    if (FakeAudio.behaviour[this.src] === 'reject-play') return Promise.reject(new Error('NotAllowedError'));
    this.paused = false;
    return Promise.resolve();
  }

  pause() { this.paused = true; }
  removeAttribute() { this.src = ''; }
}

class FakeTimers {
  constructor() { this.pending = new Map(); this.next = 1; }
  setTimeout(fn, ms) { const id = this.next++; this.pending.set(id, { fn, ms }); return id; }
  clearTimeout(id) { this.pending.delete(id); }
  delays() { return [...this.pending.values()].map((t) => t.ms); }
  fire(ms) {
    for (const [id, t] of [...this.pending]) {
      if (t.ms === ms) { this.pending.delete(id); t.fn(); }
    }
  }
}

function setup(behaviour, opts = {}) {
  FakeAudio.behaviour = behaviour;
  FakeAudio.instances = [];
  const timers = new FakeTimers();
  const statuses = [];
  const ch = new Channel({
    createAudio: () => new FakeAudio(),
    timers,
    connectTimeoutMs: 1000,
    onStatus: (s, d) => statuses.push(d?.delayMs ? `${s}:${d.delayMs}` : s),
    ...opts,
  });
  return { ch, timers, statuses };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ── Channel ──

describe('Channel', () => {
  it('plays the first working source', async () => {
    const { ch, statuses } = setup({ a: 'error', b: 'ok' });
    assert.equal(await ch.start(['a', 'b']), true);
    assert.equal(ch.audio.src, 'b');
    assert.equal(ch.audio.paused, false);
    assert.deepEqual(statuses, ['connecting', 'live']);
  });

  it('treats a rejected play() as a failed source', async () => {
    const { ch } = setup({ a: 'reject-play', b: 'ok' });
    assert.equal(await ch.start(['a', 'b']), true);
    assert.equal(ch.audio.src, 'b');
  });

  it('times out a source that never becomes playable', async () => {
    const { ch, timers } = setup({ a: 'hang', b: 'ok' });
    const p = ch.start(['a', 'b']);
    await flush();
    timers.fire(1000);
    assert.equal(await p, true);
    assert.equal(ch.audio.src, 'b');
  });

  it('applies volume and mute to the live element', async () => {
    const { ch } = setup({ a: 'ok' });
    ch.setVolume(0.4);
    await ch.start(['a']);
    assert.equal(ch.audio.volume, 0.4);
    ch.setMuted(true);
    assert.equal(ch.audio.volume, 0);
    ch.setVolume(0.8);
    assert.equal(ch.audio.volume, 0);
    ch.setMuted(false);
    assert.equal(ch.audio.volume, 0.8);
  });

  it('starts new elements at the muted volume', async () => {
    const { ch } = setup({ a: 'ok' });
    ch.setMuted(true);
    await ch.start(['a']);
    assert.equal(ch.audio.volume, 0);
  });

  it('retries with backoff when every source fails', async () => {
    const { ch, timers, statuses } = setup({ a: 'error' });
    assert.equal(await ch.start(['a']), false);
    assert.deepEqual(timers.delays(), [2000]);
    FakeAudio.behaviour.a = 'error';
    timers.fire(2000);
    await flush();
    assert.deepEqual(timers.delays(), [4000]);
    FakeAudio.behaviour.a = 'ok';
    timers.fire(4000);
    await flush();
    assert.equal(ch.audio?.src, 'a');
    assert.deepEqual(statuses, ['connecting', 'retrying:2000', 'connecting', 'retrying:4000', 'connecting', 'live']);
  });

  it('reports error instead of retrying when reconnect is off', async () => {
    const { ch, timers, statuses } = setup({ a: 'error' }, { reconnect: false });
    await ch.start(['a']);
    assert.deepEqual(timers.delays(), []);
    assert.equal(statuses.at(-1), 'error');
  });

  it('reconnects when a live stream drops, resetting the backoff', async () => {
    const { ch, timers } = setup({ a: 'ok' });
    await ch.start(['a']);
    const first = ch.audio;
    first.dispatchEvent(new Event('error'));
    assert.equal(ch.audio, null);
    assert.equal(first.paused, true);
    assert.deepEqual(timers.delays(), [2000]);
    timers.fire(2000);
    await flush();
    assert.notEqual(ch.audio, first);
    assert.equal(ch.attempt, 0);
  });

  it('stop() during connect discards the late stream', async () => {
    const { ch, statuses } = setup({ a: 'ok' });
    const p = ch.start(['a']);
    ch.stop();
    assert.equal(await p, false);
    assert.equal(ch.audio, null);
    assert.ok(FakeAudio.instances.every((a) => a.paused));
    assert.equal(statuses.at(-1), 'idle');
  });

  it('a newer start() wins over an older in-flight one', async () => {
    const { ch } = setup({ a: 'ok', b: 'ok' });
    const p1 = ch.start(['a']);
    const p2 = ch.start(['b']);
    assert.deepEqual(await Promise.all([p1, p2]), [false, true]);
    assert.equal(ch.audio.src, 'b');
    assert.equal(FakeAudio.instances.filter((a) => !a.paused).length, 1);
  });

  it('stop() cancels a pending retry', async () => {
    const { ch, timers } = setup({ a: 'error' });
    await ch.start(['a']);
    assert.equal(timers.delays().length, 1);
    ch.stop();
    assert.deepEqual(timers.delays(), []);
  });

  it('ignores events from a stream it already replaced', async () => {
    const { ch, timers } = setup({ a: 'ok', b: 'ok' });
    await ch.start(['a']);
    const old = ch.audio;
    await ch.start(['b']);
    old.dispatchEvent(new Event('ended'));
    assert.equal(ch.audio.src, 'b');
    assert.deepEqual(timers.delays(), []);
  });
});

// ── helpers ──

describe('backoffDelay', () => {
  it('doubles and caps', () => {
    assert.deepEqual([0, 1, 2, 3].map((n) => backoffDelay(n)), [2000, 4000, 8000, 16000]);
    assert.equal(backoffDelay(20), 60000);
  });
});

describe('atcUrl', () => {
  it('builds proxy URLs', () => assert.equal(atcUrl('kbos_twr'), '/atc/kbos_twr'));
});

describe('atcSources / mountFromAtcUrl', () => {
  const feeds = [{ mount: 'a' }, { mount: 'b' }, { mount: 'c' }];
  it('tries the chosen feed first, then the rest in order', () => {
    assert.deepEqual(atcSources(feeds, 'b'), ['/atc/b', '/atc/a', '/atc/c']);
  });
  it('falls back to config order for an unknown feed', () => {
    assert.deepEqual(atcSources(feeds, 'zzz'), ['/atc/a', '/atc/b', '/atc/c']);
  });
  it('round-trips mounts', () => {
    assert.equal(mountFromAtcUrl(atcUrl('kord1n1_app_133625')), 'kord1n1_app_133625');
    assert.equal(mountFromAtcUrl('https://stream.zeno.fm/x'), null);
    assert.equal(mountFromAtcUrl(undefined), null);
  });
});

describe('chosenFirst / musicSources', () => {
  const stations = [{ url: 'https://a' }, { url: 'https://b' }, { url: 'https://c' }];
  it('moves the chosen item to the front and keeps the rest in order', () => {
    assert.deepEqual(chosenFirst([1, 2, 3, 4], (x) => x === 3), [3, 1, 2, 4]);
  });
  it('tries the chosen station first, then the others as fallbacks', () => {
    assert.deepEqual(musicSources(stations, 'https://c').map((s) => s.url), ['https://c', 'https://a', 'https://b']);
  });
  it('uses config order when nothing (or something stale) is chosen', () => {
    assert.deepEqual(musicSources(stations, null).map((s) => s.url), ['https://a', 'https://b', 'https://c']);
    assert.deepEqual(musicSources(stations, 'https://gone').map((s) => s.url), ['https://a', 'https://b', 'https://c']);
  });
});

describe('icaoFromMount', () => {
  for (const [mount, icao] of [
    ['kbos_twr', 'KBOS'], ['kord7', 'KORD'], ['kden1_3', 'KDEN'],
    ['kjfk9_s', 'KJFK'], ['cyyz2', 'CYYZ'], ['twr', null], ['_x', null],
  ]) {
    it(`${mount} -> ${icao}`, () => assert.equal(icaoFromMount(mount), icao));
  }
});

describe('parseFeedInput', () => {
  const cases = [
    ['KBOS', { kind: 'icao', icao: 'KBOS' }],
    ['  kbos ', { kind: 'icao', icao: 'KBOS' }],
    ['jfk', { kind: 'icao', icao: 'JFK' }],
    ['kbos_twr', { kind: 'mount', mount: 'kbos_twr', icao: 'KBOS' }],
    ['KORD7', { kind: 'mount', mount: 'kord7', icao: 'KORD' }],
    ['https://www.liveatc.net/hlisten.php?mount=kbos_twr&icao=kbos',
      { kind: 'mount', mount: 'kbos_twr', icao: 'KBOS' }],
    ['https://www.liveatc.net/play/kbos_twr.pls', { kind: 'mount', mount: 'kbos_twr', icao: 'KBOS' }],
    ['https://d.liveatc.net/kord7', { kind: 'mount', mount: 'kord7', icao: 'KORD' }],
    ['https://www.liveatc.net/search/?icao=egll', { kind: 'icao', icao: 'EGLL' }],
    ['', null],
    ['hello world', null],
    ['../etc/passwd', null],
    ['https://evil.example.com/kbos_twr', null],
    ['https://liveatc.net.evil.com/kbos_twr', null],
    ['https://www.liveatc.net/', null],
    ['https://www.liveatc.net/hlisten.php?mount=../x', null],
  ];
  for (const [input, expected] of cases) {
    it(JSON.stringify(input), () => assert.deepEqual(parseFeedInput(input), expected));
  }
});

describe('mergeAirports / addCustomFeeds', () => {
  const builtin = [{ icao: 'KSFO', label: 'SFO', name: 'SF', feeds: [{ mount: 'ksfo_twr', label: 'Tower' }] }];

  it('appends new airports and merges feeds into existing ones', () => {
    const custom = [
      { icao: 'KSFO', label: 'SFO', name: 'SF', feeds: [{ mount: 'ksfo_twr', label: 'dup' }, { mount: 'ksfo_gnd', label: 'Gnd' }] },
      { icao: 'KBOS', label: 'BOS', name: 'KBOS', feeds: [{ mount: 'kbos_twr', label: 'Twr' }] },
    ];
    const merged = mergeAirports(builtin, custom);
    assert.deepEqual(merged.map((a) => [a.icao, a.custom, a.feeds.map((f) => f.mount)]), [
      ['KSFO', true, ['ksfo_twr', 'ksfo_gnd']],
      ['KBOS', true, ['kbos_twr']],
    ]);
    assert.equal(merged[0].feeds[0].label, 'Tower');
    assert.equal(builtin[0].feeds.length, 1, 'input not mutated');
  });

  it('marks untouched built-ins as not removable', () => {
    assert.equal(mergeAirports(builtin, [])[0].custom, false);
  });

  it('addCustomFeeds dedupes by mount and does not mutate', () => {
    const a = addCustomFeeds([], { icao: 'KBOS', feeds: [{ mount: 'kbos_twr' }] });
    const b = addCustomFeeds(a, { icao: 'KBOS', feeds: [{ mount: 'kbos_twr' }, { mount: 'kbos_app' }] });
    assert.equal(a[0].feeds.length, 1);
    assert.deepEqual(b[0].feeds.map((f) => f.mount), ['kbos_twr', 'kbos_app']);
  });
});

describe('nextMuteAll', () => {
  it('mutes all if anything is audible', () => {
    assert.equal(nextMuteAll([false, false]), true);
    assert.equal(nextMuteAll([true, false]), true);
    assert.equal(nextMuteAll([true, true]), false);
  });
});

describe('shortcutFor', () => {
  const body = { tagName: 'BODY' };
  it('maps keys on the page', () => {
    assert.equal(shortcutFor('Space', body), 'toggle');
    assert.equal(shortcutFor('KeyM', body), 'mute');
    assert.equal(shortcutFor('ArrowUp', body), 'volumeUp');
    assert.equal(shortcutFor('ArrowDown', body), 'volumeDown');
    assert.equal(shortcutFor('KeyQ', body), null);
  });
  it('leaves typing alone', () => {
    for (const t of [{ tagName: 'INPUT', type: 'text' }, { tagName: 'SELECT' }, { tagName: 'TEXTAREA' }]) {
      assert.equal(shortcutFor('KeyM', t), null);
      assert.equal(shortcutFor('Space', t), null);
    }
  });
  it('lets focused controls keep their native keys', () => {
    assert.equal(shortcutFor('Space', { tagName: 'BUTTON' }), null);
    assert.equal(shortcutFor('ArrowUp', { tagName: 'INPUT', type: 'range' }), null);
    assert.equal(shortcutFor('KeyM', { tagName: 'INPUT', type: 'range' }), 'mute');
  });
});

describe('Channel source objects', () => {
  it('passes the source to createAudio and reports it when live', async () => {
    FakeAudio.behaviour = { 'https://a': 'ok' };
    const seen = [];
    let live;
    const ch = new Channel({
      createAudio: (src) => { seen.push(src); return new FakeAudio(); },
      timers: new FakeTimers(),
      onStatus: (s, d) => { if (s === 'live') live = d; },
    });
    const station = { type: 'stream', label: 'A', url: 'https://a' };
    assert.equal(await ch.start([station]), true);
    assert.deepEqual(seen, [station]);
    assert.equal(ch.audio.src, 'https://a');
    assert.deepEqual(live, { url: 'https://a', source: station });
  });
});
