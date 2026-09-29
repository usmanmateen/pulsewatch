import type { GoogleCredentials } from '../env';
import { discardBody, readJsonBounded, type FetchFn } from './http';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * The minimum read-only scopes PulseWatch needs. No write scopes, no
 * location, ECG, nutrition or profile access.
 */
export const HEALTH_SCOPES = {
  /** Heart rate, resting heart rate, HRV, respiratory rate. */
  healthMetrics: 'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  /** Steps (inactivity rule, yesterday's step count). */
  activity: 'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  /** Sleep sessions. */
  sleep: 'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  /** Paired devices: last sync time and battery, used to explain missing data. */
  settings: 'https://www.googleapis.com/auth/googlehealth.settings.readonly',
} as const;

export const REQUIRED_SCOPES: readonly string[] = Object.values(HEALTH_SCOPES);

export type OAuthErrorKind = 'reauthorization_required' | 'invalid_client' | 'transient' | 'invalid_response';

export class OAuthError extends Error {
  override readonly name = 'OAuthError';
  readonly code: string;

  constructor(
    readonly kind: OAuthErrorKind,
    readonly status?: number,
  ) {
    super(`oauth_${kind}`);
    this.code = `oauth_${kind}`;
  }
}

export interface AccessTokenSource {
  getAccessToken(): Promise<string>;
  /** Forget the cached token, e.g. after a 401 from the API. */
  invalidate(): void;
}

export interface TokenResponse {
  accessToken: string;
  expiresInSeconds: number;
  scopes: string[];
  refreshToken: string | null;
  /** Only present for time-limited grants (e.g. an OAuth app still in "Testing"). */
  refreshTokenExpiresInSeconds: number | null;
}

function parseTokenResponse(body: unknown): TokenResponse {
  if (!body || typeof body !== 'object') throw new OAuthError('invalid_response');
  const data = body as Record<string, unknown>;
  const expiresIn = Number(data.expires_in);
  if (
    typeof data.access_token !== 'string' ||
    data.access_token.length === 0 ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    (typeof data.token_type === 'string' && data.token_type.toLowerCase() !== 'bearer')
  ) {
    throw new OAuthError('invalid_response');
  }
  return {
    accessToken: data.access_token,
    expiresInSeconds: expiresIn,
    scopes: typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : [],
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
    refreshTokenExpiresInSeconds:
      typeof data.refresh_token_expires_in === 'number' ? data.refresh_token_expires_in : null,
  };
}

/** Maps a non-2xx token endpoint response to an actionable error kind. */
async function tokenError(response: Response): Promise<OAuthError> {
  if (response.status === 429 || response.status >= 500) {
    await discardBody(response);
    return new OAuthError('transient', response.status);
  }
  if (response.status >= 300 && response.status < 400) {
    await discardBody(response);
    return new OAuthError('invalid_response', response.status);
  }
  let code = '';
  try {
    const body = await readJsonBounded(response, 16_384);
    if (body && typeof body === 'object' && 'error' in body) {
      code = String(body.error);
    }
  } catch {
    // Fall through with an empty code.
  }
  if (code === 'invalid_grant') return new OAuthError('reauthorization_required', response.status);
  return new OAuthError('invalid_client', response.status);
}

async function postTokenRequest(fetchFn: FetchFn, params: URLSearchParams): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetchFn(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params,
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    });
  } catch {
    throw new OAuthError('transient');
  }
  if (!response.ok) throw await tokenError(response);
  return parseTokenResponse(await readJsonBounded(response, 32_768));
}

/**
 * Exchanges the long-lived refresh token (a Cloudflare secret) for a
 * short-lived access token. The access token lives only in memory, at most
 * until it expires; D1 never stores credentials.
 */
/**
 * Holds the current access token so it can outlive one source, e.g. across
 * invocations of a warm Worker isolate. Only the token string is shared,
 * never an in-flight request: Workers must not await I/O started by another
 * request.
 */
export interface AccessTokenCache {
  value: { token: string; expiresAt: number } | null;
}

export class RefreshTokenAccessTokens implements AccessTokenSource {
  private inFlight: Promise<string> | null = null;
  private scopes: readonly string[] | null = null;

  constructor(
    private readonly credentials: GoogleCredentials,
    private readonly fetchFn: FetchFn,
    private readonly now: () => number = Date.now,
    private readonly cache: AccessTokenCache = { value: null },
  ) {}

  /** Scopes granted to the refresh token, known after the first refresh. */
  get grantedScopes(): readonly string[] | null {
    return this.scopes;
  }

  invalidate(): void {
    this.cache.value = null;
  }

  async getAccessToken(): Promise<string> {
    const cached = this.cache.value;
    if (cached && cached.expiresAt - 60_000 > this.now()) return cached.token;
    // Parallel API calls share one refresh rather than each starting their own.
    this.inFlight ??= this.refresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async refresh(): Promise<string> {
    const token = await postTokenRequest(
      this.fetchFn,
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        refresh_token: this.credentials.refreshToken,
      }),
    );
    this.cache.value = { token: token.accessToken, expiresAt: this.now() + token.expiresInSeconds * 1000 };
    if (token.scopes.length > 0) this.scopes = token.scopes;
    return token.accessToken;
  }
}

/**
 * A short, non-reversible fingerprint of the refresh token. Stored with the
 * "re-authorisation required" flag so the Worker notices when the secret
 * has been replaced and can resume without manual intervention.
 */
export async function credentialFingerprint(credentials: GoogleCredentials): Promise<string> {
  const data = new TextEncoder().encode(
    `${credentials.clientId}\n${credentials.clientSecret}\n${credentials.refreshToken}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Authorisation-code flow helpers, used by the local `npm run oauth` script.
// ---------------------------------------------------------------------------

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomUrlSafe(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** RFC 7636 PKCE pair using the S256 method. */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomUrlSafe(48);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function buildAuthorizationUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: readonly string[];
}): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: (options.scopes ?? REQUIRED_SCOPES).join(' '),
    // offline + consent guarantees a refresh token is issued, even on re-runs.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

export async function exchangeAuthorizationCode(
  fetchFn: FetchFn,
  options: {
    clientId: string;
    clientSecret: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  },
): Promise<TokenResponse> {
  return postTokenRequest(
    fetchFn,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code: options.code,
      code_verifier: options.codeVerifier,
      redirect_uri: options.redirectUri,
    }),
  );
}

export function missingScopes(granted: readonly string[]): string[] {
  return REQUIRED_SCOPES.filter((scope) => !granted.includes(scope));
}
