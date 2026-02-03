const MAX_MS_LIMIT = 5 * 60 * 1000 - 1000;

export const DEFAULT_RUN_CONFIG = {
  MAX_RUN_MS: 240000,
  STEP_TIMEOUT_MS: 5000,
  OTP_TIMEOUT_MS: 90000,
  SNAPSHOT_RETRY_MS: 1000,
  STATE_STUCK_LIMIT: 4,
};

export const MAX_RUN_LIMIT_MS = MAX_MS_LIMIT;

const readMs = (envKey, fallback) => {
  const raw = process.env[envKey];
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, MAX_MS_LIMIT);
};

const readCount = (envKey, fallback) => {
  const raw = process.env[envKey];
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

export const getRunConfig = () => ({
  MAX_RUN_MS: readMs('MAX_RUN_MS', DEFAULT_RUN_CONFIG.MAX_RUN_MS),
  STEP_TIMEOUT_MS: readMs('STEP_TIMEOUT_MS', DEFAULT_RUN_CONFIG.STEP_TIMEOUT_MS),
  OTP_TIMEOUT_MS: readMs('OTP_TIMEOUT_MS', DEFAULT_RUN_CONFIG.OTP_TIMEOUT_MS),
  SNAPSHOT_RETRY_MS: readMs('SNAPSHOT_RETRY_MS', DEFAULT_RUN_CONFIG.SNAPSHOT_RETRY_MS),
  STATE_STUCK_LIMIT: readCount('STATE_STUCK_LIMIT', DEFAULT_RUN_CONFIG.STATE_STUCK_LIMIT),
});
