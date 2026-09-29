import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../src/domain/types';
import { GoogleHealthClient, SLEEP_MAX_PAGES } from '../src/google/client';
import { GoogleApiError } from '../src/google/http';
import {
  OAuthError,
  REQUIRED_SCOPES,
  RefreshTokenAccessTokens,
  buildAuthorizationUrl,
  createPkcePair,
  credentialFingerprint,
  missingScopes,
  type AccessTokenCache,
  type AccessTokenSource,
} from '../src/google/oauth';
import { silentLogger } from '../src/observability/log';
import { fakeFetch, type RecordedRequest } from './helpers';

const credentials = { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' };
const tokenOk = () =>
  Response.json({
    access_token: 'at-1',
    expires_in: 3599,
    token_type: 'Bearer',
    scope: REQUIRED_SCOPES.join(' '),
  });

describe('OAuth refresh-token flow', () => {
  it('caches the access token until shortly before expiry', async () => {
    let now = 0;
    const { fetch, requests } = fakeFetch(tokenOk);
    const tokens = new RefreshTokenAccessTokens(credentials, fetch, () => now);
    expect(await tokens.getAccessToken()).toBe('at-1');
    now = 3_000_000;
    await tokens.getAccessToken();
    expect(requests).toHaveLength(1);
    now = 3_560_000; // within the 60 s refresh margin
    await tokens.getAccessToken();
    expect(requests).toHaveLength(2);
    expect(Object.fromEntries(new URLSearchParams(requests[0]!.body))).toEqual({
      grant_type: 'refresh_token',
      client_id: 'client',
      client_secret: 'secret',
      refresh_token: 'refresh',
    });
    expect(tokens.grantedScopes).toEqual(REQUIRED_SCOPES);
  });

  it('reuses a token kept in a shared cache (a warm isolate, invocation to invocation)', async () => {
    const { fetch, requests } = fakeFetch(tokenOk);
    const cache: AccessTokenCache = { value: null };
    await new RefreshTokenAccessTokens(credentials, fetch, () => 0, cache).getAccessToken();
    const next = new RefreshTokenAccessTokens(credentials, fetch, () => 60_000, cache);
    expect(await next.getAccessToken()).toBe('at-1');
    expect(requests).toHaveLength(1);
    next.invalidate();
    expect(cache.value).toBeNull();
  });

  it('shares one refresh between concurrent callers', async () => {
    const { fetch, requests } = fakeFetch(tokenOk);
    const tokens = new RefreshTokenAccessTokens(credentials, fetch);
    await Promise.all([tokens.getAccessToken(), tokens.getAccessToken(), tokens.getAccessToken()]);
    expect(requests).toHaveLength(1);
  });

  it.each([
    [400, { error: 'invalid_grant' }, 'reauthorization_required'],
    [401, { error: 'invalid_client' }, 'invalid_client'],
    [503, {}, 'transient'],
    [429, {}, 'transient'],
    [302, {}, 'invalid_response'],
  ])('maps token endpoint %i to %s', async (status, body, kind) => {
    const { fetch } = fakeFetch(() => Response.json(body, { status }));
    await expect(new RefreshTokenAccessTokens(credentials, fetch).getAccessToken()).rejects.toMatchObject({
      kind,
    });
  });

  it('rejects malformed token responses and network failures', async () => {
    const malformed = fakeFetch(() => Response.json({ token_type: 'Bearer' }));
    await expect(
      new RefreshTokenAccessTokens(credentials, malformed.fetch).getAccessToken(),
    ).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    const offline = new RefreshTokenAccessTokens(credentials, () => Promise.reject(new TypeError('network')));
    await expect(offline.getAccessToken()).rejects.toBeInstanceOf(OAuthError);
  });
});

describe('authorisation-code helpers', () => {
  it('builds a consent URL for offline access with PKCE and the minimum scopes', async () => {
    const pkce = await createPkcePair();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const expected = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pkce.verifier)),
    );
    const expectedChallenge = btoa(String.fromCharCode(...expected))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(pkce.challenge).toBe(expectedChallenge);

    const url = new URL(
      buildAuthorizationUrl({
        clientId: 'c',
        redirectUri: 'http://localhost:8976/oauth/callback',
        state: 's',
        codeChallenge: pkce.challenge,
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      access_type: 'offline',
      prompt: 'consent',
      response_type: 'code',
      code_challenge_method: 'S256',
      state: 's',
    });
    const scopes = url.searchParams.get('scope')!.split(' ');
    expect(scopes.every((s) => s.endsWith('.readonly'))).toBe(true);
    expect(scopes).toHaveLength(4);
  });

  it('detects partially granted scopes and changed credentials', async () => {
    expect(missingScopes(REQUIRED_SCOPES.slice(1))).toEqual([REQUIRED_SCOPES[0]]);
    const a = await credentialFingerprint(credentials);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await credentialFingerprint({ ...credentials, refreshToken: 'new' })).not.toBe(a);
    expect(await credentialFingerprint({ ...credentials, clientSecret: 'rotated' })).not.toBe(a);
  });
});

const staticTokens = (): AccessTokenSource & { invalidated: number } => ({
  invalidated: 0,
  getAccessToken: () => Promise.resolve('token'),
  invalidate() {
    this.invalidated += 1;
  },
});

const client = (handler: (r: RecordedRequest) => Response | Promise<Response>, tokens = staticTokens()) => {
  const fake = fakeFetch(handler);
  return {
    ...fake,
    tokens,
    client: new GoogleHealthClient({
      tokens,
      fetch: fake.fetch,
      log: silentLogger,
      sleep: () => Promise.resolve(),
    }),
  };
};

describe('Google Health client', () => {
  it('asks for the latest heart-rate timestamp only, with a snake_case filter and field mask', async () => {
    const now = Date.parse('2026-03-10T14:00:00Z');
    const { client: c, requests } = client(() =>
      Response.json({
        dataPoints: [{ heartRate: { sampleTime: { physicalTime: '2026-03-10T13:58:00Z' } } }],
      }),
    );
    expect(await c.latestHeartRateAt(now, 12 * 3_600_000)).toBe(Date.parse('2026-03-10T13:58:00Z'));
    const url = requests[0]!.url;
    expect(url.pathname).toBe('/v4/users/me/dataTypes/heart-rate/dataPoints');
    expect(url.searchParams.get('filter')).toBe(
      'heart_rate.sample_time.physical_time >= "2026-03-10T02:00:00.000Z"',
    );
    expect(url.searchParams.get('pageSize')).toBe('1');
    expect(url.searchParams.get('fields')).toBe(
      'dataPoints(heartRate(sampleTime(physicalTime))),nextPageToken',
    );
    expect(requests[0]!.headers.get('Authorization')).toBe('Bearer token');
  });

  it('never requests the device MAC address', async () => {
    const { client: c, requests } = client(() => Response.json({ pairedDevices: [] }));
    await c.pairedTracker();
    expect(requests[0]!.url.searchParams.get('fields')).not.toMatch(/mac/i);
  });

  it('refreshes the token once on 401', async () => {
    let calls = 0;
    const { client: c, tokens } = client(() =>
      ++calls === 1 ? new Response('{}', { status: 401 }) : Response.json({}),
    );
    await c.latestHeartRateAt(Date.now(), 1000);
    expect(tokens.invalidated).toBe(1);
    expect(calls).toBe(2);
  });

  it('retries a transient failure once, then reports a typed error', async () => {
    let calls = 0;
    const flaky = client(() => (++calls === 1 ? new Response('', { status: 503 }) : Response.json({})));
    await flaky.client.pairedTracker();
    expect(calls).toBe(2);

    const down = client(() => Response.json({ error: { status: 'UNAVAILABLE' } }, { status: 503 }));
    await expect(down.client.pairedTracker()).rejects.toMatchObject({
      kind: 'server',
      status: 503,
      googleStatus: 'UNAVAILABLE',
    });
    expect(down.requests).toHaveLength(2);
  });

  it('classifies permission, rate limit, timeout and network failures', async () => {
    const forbidden = client(() =>
      Response.json({ error: { status: 'PERMISSION_DENIED' } }, { status: 403 }),
    );
    await expect(forbidden.client.pairedTracker()).rejects.toMatchObject({
      kind: 'forbidden',
      retryable: false,
    });
    const limited = client(() => new Response('', { status: 429 }));
    await expect(limited.client.pairedTracker()).rejects.toMatchObject({ kind: 'rate_limited' });
    const timeout = client(() => Promise.reject(new DOMException('timed out', 'TimeoutError')));
    await expect(timeout.client.pairedTracker()).rejects.toMatchObject({ kind: 'timeout' });
    const offline = client(() => Promise.reject(new TypeError('fetch failed')));
    await expect(offline.client.pairedTracker()).rejects.toMatchObject({ kind: 'network' });
    const junk = client(() => new Response('<html>', { status: 200 }));
    await expect(junk.client.pairedTracker()).rejects.toBeInstanceOf(GoogleApiError);
  });

  it('falls back to a request without a field mask if Google rejects the mask', async () => {
    const { client: c, requests } = client((r) =>
      r.url.searchParams.has('fields')
        ? new Response('{}', { status: 400 })
        : Response.json({ pairedDevices: [] }),
    );
    await c.pairedTracker();
    await c.pairedTracker();
    expect(requests.map((r) => r.url.searchParams.has('fields'))).toEqual([true, false, false]);
  });

  it('keeps masks when the request itself is bad, and reports Google’s validation message', async () => {
    const invalid = {
      error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid value at range.start' },
    };
    const { client: c, requests } = client((r) =>
      r.url.pathname.endsWith(':dailyRollUp')
        ? Response.json(invalid, { status: 400 })
        : Response.json({ pairedDevices: [] }),
    );
    await expect(c.dailySteps('2026-03-01', '2026-03-10')).rejects.toMatchObject({
      kind: 'bad_request',
      googleStatus: 'INVALID_ARGUMENT',
      detail: 'Invalid value at range.start',
    });
    // Masked attempt, then one unmasked attempt to rule the mask out — no more.
    expect(requests.map((r) => r.url.searchParams.has('fields'))).toEqual([true, false]);
    // A genuine bad request must not switch masks off, here or elsewhere.
    await expect(c.dailySteps('2026-03-01', '2026-03-10')).rejects.toBeInstanceOf(GoogleApiError);
    await c.pairedTracker();
    expect(requests.map((r) => r.url.searchParams.has('fields'))).toEqual([true, false, true, false, true]);
  });

  it('only disables the mask for the endpoint that rejected it', async () => {
    const { client: c, requests } = client((r) =>
      r.url.pathname.endsWith('/pairedDevices') && r.url.searchParams.has('fields')
        ? new Response('{}', { status: 400 })
        : Response.json({ pairedDevices: [], dataPoints: [] }),
    );
    await c.pairedTracker();
    await c.latestHeartRateAt(Date.now(), 1000);
    const heartRate = requests.find((r) => r.url.pathname.endsWith('/heart-rate/dataPoints'));
    expect(heartRate?.url.searchParams.has('fields')).toBe(true);
  });

  it('follows pagination, and treats looping or endless pages as an error rather than partial data', async () => {
    const pages: Record<string, unknown> = {
      '': {
        dataPoints: [
          { dailyRestingHeartRate: { date: { year: 2026, month: 3, day: 10 }, beatsPerMinute: '58' } },
        ],
        nextPageToken: 'p2',
      },
      p2: {
        dataPoints: [
          { dailyRestingHeartRate: { date: { year: 2026, month: 3, day: 9 }, beatsPerMinute: '57' } },
        ],
      },
    };
    const paged = client((r) => Response.json(pages[r.url.searchParams.get('pageToken') ?? '']));
    expect(
      (await paged.client.dailyMetric('resting_hr', '2026-03-01', '2026-03-11')).map((v) => v.value),
    ).toEqual([58, 57]);
    expect(paged.requests[0]!.url.searchParams.get('filter')).toBe(
      'daily_resting_heart_rate.date >= "2026-03-01" AND daily_resting_heart_rate.date < "2026-03-11"',
    );

    const looping = client(() => Response.json({ dataPoints: [], nextPageToken: 'same' }));
    await expect(looping.client.dailyMetric('hrv', '2026-03-01', '2026-03-11')).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('sends the daily step roll-up without pageSize, which the live API rejects', async () => {
    const { client: c, requests } = client(() =>
      Response.json({
        rollupDataPoints: [
          { civilStartTime: { date: { year: 2026, month: 3, day: 9 } }, steps: { countSum: '1234' } },
        ],
      }),
    );
    expect((await c.dailySteps('2026-03-01', '2026-03-10')).map((v) => [v.day, v.value])).toEqual([
      ['2026-03-09', 1234],
    ]);
    expect(JSON.parse(requests[0]!.body)).toEqual({
      range: {
        start: { date: { year: 2026, month: 3, day: 1 } },
        end: { date: { year: 2026, month: 3, day: 10 } },
      },
      windowSizeDays: 1,
    });
    expect(requests[0]!.url.searchParams.get('fields')).toBe(
      'rollupDataPoints(civilStartTime(date),steps(countSum))',
    );
  });

  it('follows the short pages of a long sleep window, within a bound', async () => {
    const nextPage = (r: RecordedRequest) => Number(r.url.searchParams.get('pageToken') ?? '0') + 1;
    const seven = client((r) =>
      Response.json({ dataPoints: [], ...(nextPage(r) < 7 ? { nextPageToken: String(nextPage(r)) } : {}) }),
    );
    await seven.client.sleepSessions(0, 60 * DAY_MS);
    expect(seven.requests).toHaveLength(7);

    const endless = client((r) => Response.json({ dataPoints: [], nextPageToken: String(nextPage(r)) }));
    await expect(endless.client.sleepSessions(0, 60 * DAY_MS)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    expect(endless.requests).toHaveLength(SLEEP_MAX_PAGES);
  });

  it('propagates OAuth failures distinctly from API failures', async () => {
    const tokens: AccessTokenSource = {
      getAccessToken: () => Promise.reject(new OAuthError('reauthorization_required', 400)),
      invalidate: () => undefined,
    };
    const { client: c } = client(() => Response.json({}), tokens as ReturnType<typeof staticTokens>);
    await expect(c.pairedTracker()).rejects.toBeInstanceOf(OAuthError);
  });
});
