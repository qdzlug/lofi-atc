// Spotify login with the Authorization Code + PKCE flow, entirely in the
// browser: no client secret, and tokens never touch the lofi-atc server.
// https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

// streaming + user-read-* are what the Web Playback SDK needs; the playback
// scopes let us start a playlist on the browser's player.
export const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
];

const TOKENS_KEY = 'spotify:tokens';
const PENDING_KEY = 'spotify:pending';
// Refresh a little before expiry so a request never goes out with a stale token.
const EXPIRY_MARGIN_MS = 60_000;

export class SpotifyAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SpotifyAuthError';
    this.code = code; // 'not_connected' | 'denied' | 'state_mismatch' | 'token'
  }
}

export function base64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

export function randomString(length, crypto = globalThis.crypto) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => UNRESERVED[b % UNRESERVED.length]).join('');
}

/** S256 code challenge for a PKCE code verifier (RFC 7636 §4.2). */
export async function codeChallenge(verifier, crypto = globalThis.crypto) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(digest);
}

export class SpotifyAuth {
  /**
   * @param {object} opts
   * @param {string} opts.clientId
   * @param {string} opts.redirectUri  must exactly match the one registered with Spotify
   * @param {{get, set, remove}} opts.storage  persistent key/value store (JSON values)
   */
  constructor({ clientId, redirectUri, storage, fetch = globalThis.fetch?.bind(globalThis), crypto = globalThis.crypto, now = Date.now }) {
    this.clientId = clientId;
    this.redirectUri = redirectUri;
    this.storage = storage;
    this.fetch = fetch;
    this.crypto = crypto;
    this.now = now;
    this._refreshing = null;
  }

  get connected() {
    return Boolean(this.storage.get(TOKENS_KEY, null)?.refresh_token);
  }

  /** Build the Spotify login URL and remember the verifier/state for the callback. */
  async loginUrl() {
    const verifier = randomString(64, this.crypto);
    const state = randomString(16, this.crypto);
    this.storage.set(PENDING_KEY, { verifier, state });
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      code_challenge_method: 'S256',
      code_challenge: await codeChallenge(verifier, this.crypto),
      scope: SCOPES.join(' '),
      state,
    });
    return `${AUTHORIZE_URL}?${params}`;
  }

  /**
   * Finish a login from the callback URL's query string.
   * Returns false if the URL isn't a Spotify callback at all.
   */
  async handleCallback(params) {
    const code = params.get('code');
    const error = params.get('error');
    if (!code && !error) return false;
    const pending = this.storage.get(PENDING_KEY, null);
    this.storage.remove(PENDING_KEY);
    if (error) throw new SpotifyAuthError('denied', `Spotify login was cancelled (${error})`);
    if (!pending || params.get('state') !== pending.state) {
      throw new SpotifyAuthError('state_mismatch', 'Spotify login could not be verified; please try again');
    }
    await this._token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      code_verifier: pending.verifier,
    });
    return true;
  }

  /** A valid access token, refreshing it first if it is about to expire. */
  async accessToken() {
    const tokens = this.storage.get(TOKENS_KEY, null);
    if (!tokens?.refresh_token) throw new SpotifyAuthError('not_connected', 'Spotify is not connected');
    if (tokens.access_token && tokens.expires_at - EXPIRY_MARGIN_MS > this.now()) return tokens.access_token;
    // Concurrent callers share one refresh (refresh tokens may be single-use).
    this._refreshing ??= this._token({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: this.clientId,
    }).finally(() => {
      this._refreshing = null;
    });
    return (await this._refreshing).access_token;
  }

  disconnect() {
    this.storage.remove(TOKENS_KEY);
    this.storage.remove(PENDING_KEY);
  }

  async _token(form) {
    let res;
    try {
      res = await this.fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form),
      });
    } catch (e) {
      throw new SpotifyAuthError('token', `could not reach Spotify (${e.message})`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // A rejected refresh token means the user has to log in again.
      if (form.grant_type === 'refresh_token' && res.status === 400) this.disconnect();
      throw new SpotifyAuthError('token', `Spotify login failed: ${body.error_description || body.error || res.status}`);
    }
    const previous = this.storage.get(TOKENS_KEY, null);
    const tokens = {
      access_token: body.access_token,
      // Spotify may or may not rotate the refresh token; keep the old one if not.
      refresh_token: body.refresh_token || previous?.refresh_token,
      expires_at: this.now() + (body.expires_in ?? 3600) * 1000,
    };
    this.storage.set(TOKENS_KEY, tokens);
    return tokens;
  }
}
