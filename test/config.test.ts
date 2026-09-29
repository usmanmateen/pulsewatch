import { describe, expect, it } from 'vitest';
import { ConfigError, defaultConfig, parseConfig } from '../src/config/schema';
import { SettingsError, loadSettings, type WorkerEnv } from '../src/env';

describe('configuration', () => {
  it('has sensible defaults matching the documented thresholds', () => {
    expect(defaultConfig.rules.deviceOffWrist).toMatchObject({
      enabled: true,
      staleAfterMinutes: 30,
      confirmationChecks: 2,
      syncStaleAfterMinutes: 60,
    });
    expect(defaultConfig.rules.inactivity.thresholdMinutes).toBe(90);
    expect(defaultConfig.rules.sleep.minimumHours).toBe(6.5);
    expect(defaultConfig.rules.restingHeartRate).toMatchObject({ baselineDays: 30, minimumSamples: 14 });
    expect(defaultConfig.rules.hrv).toMatchObject({ baselineDays: 30, consecutiveDays: 3 });
  });

  it('deep-merges overrides from an object or JSON string', () => {
    const fromObject = parseConfig({ rules: { deviceOffWrist: { staleAfterMinutes: 45 } } });
    expect(fromObject.rules.deviceOffWrist.staleAfterMinutes).toBe(45);
    expect(fromObject.rules.deviceOffWrist.confirmationChecks).toBe(2);
    expect(parseConfig('{"rules":{"sleep":{"minimumHours":7}}}').rules.sleep.minimumHours).toBe(7);
    expect(parseConfig('').rules.sleep.minimumHours).toBe(6.5);
  });

  it('rejects typos, out-of-range values and contradictions with a path-level message', () => {
    expect(() => parseConfig({ rules: { deviceOffwrist: {} } })).toThrow(/rules: Unrecognized key/);
    expect(() => parseConfig({ rules: { inactivity: { thresholdMinutes: 5 } } })).toThrow(
      /rules.inactivity.thresholdMinutes/,
    );
    expect(() =>
      parseConfig({ rules: { deviceOffWrist: { emptyBatteryPercent: 20, lowBatteryPercent: 10 } } }),
    ).toThrow(ConfigError);
    expect(() => parseConfig({ rules: { morningBrief: { earliest: '11:00', latest: '09:00' } } })).toThrow(
      ConfigError,
    );
    expect(() => parseConfig({ rules: { hrv: { baselineDays: 20, minimumSamples: 30 } } })).toThrow(
      ConfigError,
    );
    expect(() => parseConfig('{not json')).toThrow('PULSEWATCH_CONFIG is not valid JSON');
  });
});

describe('environment settings', () => {
  const env = (overrides: Partial<WorkerEnv> = {}): WorkerEnv => ({
    DB: {} as D1Database,
    NOTIFICATIONS: {} as Queue,
    ...overrides,
  });

  it('defaults to live mode with no Google credentials until OAuth is done', () => {
    const settings = loadSettings(env());
    expect(settings).toMatchObject({ mode: 'live', timeZone: 'UTC', google: null, statusToken: null });
    expect(settings.ntfy.baseUrl).toBe('https://ntfy.sh');
  });

  it('needs all three Google secrets before using them', () => {
    expect(loadSettings(env({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' })).google).toBeNull();
    expect(
      loadSettings(
        env({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REFRESH_TOKEN: 'rt' }),
      ).google,
    ).toEqual({ clientId: 'id', clientSecret: 'secret', refreshToken: 'rt' });
  });

  it('validates values that affect security or correctness', () => {
    expect(() => loadSettings(env({ MODE: 'prod' }))).toThrow(SettingsError);
    expect(() => loadSettings(env({ TIME_ZONE: 'London' }))).toThrow(/IANA/);
    expect(() => loadSettings(env({ NTFY_URL: 'http://ntfy.example.com' }))).toThrow(/https/);
    expect(() => loadSettings(env({ NTFY_URL: 'https://user:pw@ntfy.sh' }))).toThrow(/credentials/);
    expect(() => loadSettings(env({ NTFY_TOPIC: 'short' }))).toThrow(/acts as a password/);
    expect(() => loadSettings(env({ STATUS_TOKEN: 'too-short' }))).toThrow(/at least 32/);
    expect(loadSettings(env({ NTFY_URL: 'https://ntfy.example.com///' })).ntfy.baseUrl).toBe(
      'https://ntfy.example.com',
    );
  });
});
