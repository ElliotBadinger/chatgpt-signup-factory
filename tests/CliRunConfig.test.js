import { buildRunEnv } from '../src/cli/runConfig.js';

it('maps config into env for headless run', () => {
  const env = buildRunEnv({
    config: {
      run: { headless: true, maxRunMs: 1000, stepTimeoutMs: 2000 },
      identity: { otpTimeoutMs: 3000, email: 'test@example.com' }
    },
    baseEnv: { AGENTMAIL_API_KEY: 'x' }
  });

  expect(env.HEADLESS).toBe('true');
  expect(env.MAX_RUN_MS).toBe('1000');
  expect(env.STEP_TIMEOUT_MS).toBe('2000');
  expect(env.OTP_TIMEOUT_MS).toBe('3000');
  expect(env.SIGNUP_EMAIL).toBe('test@example.com');
});
