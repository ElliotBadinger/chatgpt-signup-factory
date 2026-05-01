import { validateConfig } from '../config/manager.js';

/**
 * Mapping helper to apply a loaded/validated config object to the TUI state.
 * Currently, it just validates it to ensure defaults are populated, but
 * it provides a central place for any future transformations.
 */
export function mapLoadedConfigToState(config) {
  return validateConfig(config);
}

/**
 * Mapping helper to convert TUI state into the format expected by RunOrchestrator.
 */
export function mapStateToRunConfig({ state, provisioned, artifactManager }) {
  return {
    email: provisioned.address,
    agentMailInbox: provisioned.inboxId,
    password: state.identity.password || undefined,
    headless: state.run.headless,
    runConfig: {
      MAX_RUN_MS: state.run.maxRunMs,
      STEP_TIMEOUT_MS: state.run.stepTimeoutMs,
      OTP_TIMEOUT_MS: state.identity.otpTimeoutMs,
      SNAPSHOT_RETRY_MS: 3000,
      STATE_STUCK_LIMIT: 10,
    },
    userDataDir: process.env.USER_DATA_DIR || undefined,
    artifactDir: artifactManager.getRunDir(),
  };
}
