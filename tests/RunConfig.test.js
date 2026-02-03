import { getRunConfig, MAX_RUN_LIMIT_MS } from '../src/RunConfig.js';

describe('RunConfig', () => {
  const envVars = [
    'MAX_RUN_MS',
    'STEP_TIMEOUT_MS',
    'OTP_TIMEOUT_MS',
    'SNAPSHOT_RETRY_MS',
    'STATE_STUCK_LIMIT',
  ];

  beforeEach(() => {
    envVars.forEach((key) => {
      delete process.env[key];
    });
  });

  test('returns defaults when env vars are unset', () => {
    const config = getRunConfig();

    expect(config).toEqual({
      MAX_RUN_MS: 240000,
      STEP_TIMEOUT_MS: 5000,
      OTP_TIMEOUT_MS: 90000,
      SNAPSHOT_RETRY_MS: 1000,
      STATE_STUCK_LIMIT: 4,
    });
  });

  test('uses env overrides and clamps ms values to limit', () => {
    process.env.MAX_RUN_MS = '600000';
    process.env.STEP_TIMEOUT_MS = '12000';
    process.env.OTP_TIMEOUT_MS = '180000';
    process.env.SNAPSHOT_RETRY_MS = '7000';
    process.env.STATE_STUCK_LIMIT = '7';

    const config = getRunConfig();

    expect(config).toEqual({
      MAX_RUN_MS: MAX_RUN_LIMIT_MS,
      STEP_TIMEOUT_MS: 12000,
      OTP_TIMEOUT_MS: 180000,
      SNAPSHOT_RETRY_MS: 7000,
      STATE_STUCK_LIMIT: 7,
    });
  });
});
