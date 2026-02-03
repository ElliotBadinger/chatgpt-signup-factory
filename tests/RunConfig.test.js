import { getRunConfig } from '../src/RunConfig.js';

test('getRunConfig uses defaults', () => {
  const cfg = getRunConfig({});
  expect(cfg.MAX_RUN_MS).toBe(300000);
  expect(cfg.STEP_TIMEOUT_MS).toBe(20000);
  expect(cfg.OTP_TIMEOUT_MS).toBe(90000);
  expect(cfg.SNAPSHOT_RETRY_MS).toBe(3000);
  expect(cfg.STATE_STUCK_LIMIT).toBe(10);
});

test('getRunConfig uses env overrides', () => {
  const cfg = getRunConfig({ MAX_RUN_MS: '1200', STEP_TIMEOUT_MS: '5000' });
  expect(cfg.MAX_RUN_MS).toBe(1200);
  expect(cfg.STEP_TIMEOUT_MS).toBe(5000);
});
