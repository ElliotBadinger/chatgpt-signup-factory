export const DEFAULT_RUN_CONFIG = {
  MAX_RUN_MS: 300000,
  STEP_TIMEOUT_MS: 20000,
  OTP_TIMEOUT_MS: 90000,
  SNAPSHOT_RETRY_MS: 3000,
  STATE_STUCK_LIMIT: 10,
};

export function getRunConfig(env = process.env) {
  const cfg = { ...DEFAULT_RUN_CONFIG };
  for (const key of Object.keys(DEFAULT_RUN_CONFIG)) {
    if (env[key]) cfg[key] = Number(env[key]);
  }
  return cfg;
}
