import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SCOPES,
  SpotifyAuth,
  SpotifyAuthError,
  base64url,
  codeChallenge,
  randomString,
} from '../../lofi_atc/static/spotify-auth.js';

// ── test doubles ──

class MemoryStore {
  constructor() { this.data = new Map(); }
  get(k, fallback) { return this.data.has(k) ? structuredClone(this.data.get(k)) : fallback; }
  set(k, v) { this.data.set(k, structuredClone(v)); }
  remove(k) { this.data.delete(k); }
}

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, form: Object.fromEntries(new URLSearchParams(init.body)) });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

function setup({ responses = [], now = 1_000_000 } = {}) {
  const storage = new MemoryStore();
  const fetch = fakeFetch(responses);
  const clock = { now };
  const auth = new SpotifyAuth({
    clientId: 'client123',
    redirectUri: 'http://127.0.0.1:7331/spotify/callback',
    storage,
    fetch,
    now: () => clock.now,
  });
  return { auth, storage, fetch, clock };
}

async function login(auth, fetchResponseNote) {
  const url = new URL(await auth.loginUrl());
  const state = url.searchParams.get('state');
  return auth.handleCallback(new URLSearchParams({ code: 'the-code', state }), fetchResponseNote);
}

const TOKEN_OK = { status: 200, body: { access_token: 'access1', refresh_token: 'refresh1', expires_in: 3600 } };

// ── PKCE helpers ──

describe('PKCE helpers', () => {
  it('matches the RFC 7636 appendix B test vector', async () => {
    assert.equal(
      await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('base64url has no padding or +/ characters', () => {
    assert.equal(base64url(new Uint8Array([251, 255, 191])), '-_-_');
    assert.equal(base64url(new Uint8Array([1])), 'AQ');
  });

  it('randomString uses only unreserved characters', () => {
    const s = randomString(128);
    assert.equal(s.length, 128);
    assert.match(s, /^[A-Za-z0-9\-._~]+$/);
    assert.notEqual(randomString(64), randomString(64));
  });
});

// ── login ──

describe('SpotifyAuth login', () => {
  it('builds an authorize URL with PKCE, scopes and state', async () => {
    const { auth, storage } = setup();
    const url = new URL(await auth.loginUrl());
    assert.equal(url.origin + url.pathname, 'https://accounts.spotify.com/authorize');
    const p = url.searchParams;
    assert.equal(p.get('client_id'), 'client123');
    assert.equal(p.get('response_type'), 'code');
    assert.equal(p.get('redirect_uri'), 'http://127.0.0.1:7331/spotify/callback');
    assert.equal(p.get('code_challenge_method'), 'S256');
    assert.deepEqual(p.get('scope').split(' '), SCOPES);
    const pending = storage.get('spotify:pending');
    assert.equal(p.get('state'), pending.state);
    assert.equal(p.get('code_challenge'), await codeChallenge(pending.verifier));
  });

  it('exchanges the code (with the verifier) for tokens', async () => {
    const { auth, storage, fetch } = setup({ responses: [TOKEN_OK] });
    assert.equal(auth.connected, false);
    const url = new URL(await auth.loginUrl());
    const { verifier } = storage.get('spotify:pending');
    const ok = await auth.handleCallback(new URLSearchParams({ code: 'the-code', state: url.searchParams.get('state') }));
    assert.equal(ok, true);
    assert.equal(auth.connected, true);
    assert.equal(fetch.calls[0].url, 'https://accounts.spotify.com/api/token');
    assert.deepEqual(fetch.calls[0].form, {
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'http://127.0.0.1:7331/spotify/callback',
      client_id: 'client123',
      code_verifier: verifier,
    });
    assert.equal(storage.get('spotify:pending', null), null, 'pending login cleared');
    assert.equal(await auth.accessToken(), 'access1');
  });

  it('ignores URLs that are not a Spotify callback', async () => {
    const { auth } = setup();
    assert.equal(await auth.handleCallback(new URLSearchParams('foo=bar')), false);
  });

  it('rejects a callback whose state does not match', async () => {
    const { auth, fetch } = setup({ responses: [TOKEN_OK] });
    await auth.loginUrl();
    await assert.rejects(
      auth.handleCallback(new URLSearchParams({ code: 'c', state: 'forged' })),
      (e) => e instanceof SpotifyAuthError && e.code === 'state_mismatch',
    );
    assert.equal(fetch.calls.length, 0);
    assert.equal(auth.connected, false);
  });

  it('rejects a callback with no login in progress', async () => {
    const { auth } = setup();
    await assert.rejects(auth.handleCallback(new URLSearchParams({ code: 'c', state: 's' })), { code: 'state_mismatch' });
  });

  it('reports a cancelled login', async () => {
    const { auth } = setup();
    await auth.loginUrl();
    await assert.rejects(auth.handleCallback(new URLSearchParams({ error: 'access_denied', state: 'x' })), { code: 'denied' });
  });

  it('reports a failed token exchange', async () => {
    const { auth } = setup({ responses: [{ status: 400, body: { error: 'invalid_grant', error_description: 'bad code' } }] });
    await assert.rejects(login(auth), (e) => e.code === 'token' && /bad code/.test(e.message));
    assert.equal(auth.connected, false);
  });

  it('reports a network failure', async () => {
    const { auth } = setup({ responses: [new TypeError('Failed to fetch')] });
    await assert.rejects(login(auth), (e) => e.code === 'token' && /could not reach Spotify/.test(e.message));
  });
});

// ── tokens ──

describe('SpotifyAuth tokens', () => {
  it('throws not_connected before login', async () => {
    const { auth } = setup();
    await assert.rejects(auth.accessToken(), { code: 'not_connected' });
  });

  it('reuses a fresh token without calling Spotify', async () => {
    const { auth, fetch } = setup({ responses: [TOKEN_OK] });
    await login(auth);
    await auth.accessToken();
    await auth.accessToken();
    assert.equal(fetch.calls.length, 1);
  });

  it('refreshes shortly before expiry and keeps the refresh token if not rotated', async () => {
    const { auth, fetch, clock, storage } = setup({
      responses: [TOKEN_OK, { status: 200, body: { access_token: 'access2', expires_in: 3600 } }],
    });
    await login(auth);
    clock.now += 3600_000 - 30_000; // inside the 60s safety margin
    assert.equal(await auth.accessToken(), 'access2');
    assert.deepEqual(fetch.calls[1].form, { grant_type: 'refresh_token', refresh_token: 'refresh1', client_id: 'client123' });
    assert.equal(storage.get('spotify:tokens').refresh_token, 'refresh1');
  });

  it('stores a rotated refresh token', async () => {
    const { auth, clock, storage } = setup({
      responses: [TOKEN_OK, { status: 200, body: { access_token: 'access2', refresh_token: 'refresh2', expires_in: 3600 } }],
    });
    await login(auth);
    clock.now += 7200_000;
    await auth.accessToken();
    assert.equal(storage.get('spotify:tokens').refresh_token, 'refresh2');
  });

  it('shares one refresh between concurrent callers', async () => {
    const { auth, fetch, clock } = setup({
      responses: [TOKEN_OK, { status: 200, body: { access_token: 'access2', expires_in: 3600 } }],
    });
    await login(auth);
    clock.now += 7200_000;
    const tokens = await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);
    assert.deepEqual(tokens, ['access2', 'access2', 'access2']);
    assert.equal(fetch.calls.length, 2);
  });

  it('disconnects when Spotify rejects the refresh token', async () => {
    const { auth, clock } = setup({ responses: [TOKEN_OK, { status: 400, body: { error: 'invalid_grant' } }] });
    await login(auth);
    clock.now += 7200_000;
    await assert.rejects(auth.accessToken(), { code: 'token' });
    assert.equal(auth.connected, false);
  });

  it('disconnect() forgets the tokens', async () => {
    const { auth } = setup({ responses: [TOKEN_OK] });
    await login(auth);
    auth.disconnect();
    assert.equal(auth.connected, false);
    await assert.rejects(auth.accessToken(), { code: 'not_connected' });
  });
});
