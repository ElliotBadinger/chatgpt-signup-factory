export function buildRunEnv({ config, baseEnv }) {
  const env = { ...baseEnv };
  if (config?.run?.headless !== undefined) env.HEADLESS = String(config.run.headless);
  if (config?.run?.maxRunMs) env.MAX_RUN_MS = String(config.run.maxRunMs);
  if (config?.run?.stepTimeoutMs) env.STEP_TIMEOUT_MS = String(config.run.stepTimeoutMs);
  if (config?.identity?.otpTimeoutMs) env.OTP_TIMEOUT_MS = String(config.identity.otpTimeoutMs);
  if (config?.identity?.email) env.SIGNUP_EMAIL = String(config.identity.email);
  return env;
}
