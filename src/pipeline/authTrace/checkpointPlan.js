/**
 * @typedef {{
 *   name: string;
 *   prompt: string | null;
 * }} TraceCheckpointStep
 */

/**
 * @param {{ mode?: string, scenario?: string }} opts
 * @returns {TraceCheckpointStep[]}
 */
export function buildCheckpointPlan(opts = {}) {
  const mode = opts.mode ?? 'manual';
  const scenario = opts.scenario ?? 'unknown-auto';

  if (mode !== 'manual') {
    return [
      { name: 'landing', prompt: null },
      { name: 'auth-page-loaded', prompt: null },
      { name: 'final', prompt: null },
    ];
  }

  if (scenario === 'signup-new') {
    return [
      { name: 'landing', prompt: null },
      { name: 'auth-page-loaded', prompt: 'Press Enter after the auth page fully loads' },
      { name: 'email-submitted', prompt: 'Press Enter after submitting the email step' },
      { name: 'otp-page', prompt: 'Press Enter when the OTP page is visible' },
      { name: 'otp-submitted', prompt: 'Press Enter after submitting OTP' },
      { name: 'password-page', prompt: 'Press Enter when the password page is visible' },
      { name: 'password-submitted', prompt: 'Press Enter after submitting the password step' },
      { name: 'post-callback', prompt: 'Press Enter after the auth callback/redirect completes' },
      { name: 'final', prompt: 'Press Enter when you want to finalize the trace' },
    ];
  }

  return [
    { name: 'landing', prompt: null },
    { name: 'auth-page-loaded', prompt: 'Press Enter after the auth page fully loads' },
    { name: 'final', prompt: 'Press Enter when you want to finalize the trace' },
  ];
}
