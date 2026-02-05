// Friendly labels for low-level agent states.
// Keep these stable: operators learn them, and tests depend on readable output.

export const StateLabels = {
  LANDING: { phase: 'Auth', label: 'Landing' },
  LOGIN_EMAIL: { phase: 'Auth', label: 'Enter email' },
  LOGIN_PASSWORD: { phase: 'Auth', label: 'Enter password' },
  OTP_VERIFICATION: { phase: 'Auth', label: 'Verify email (OTP)' },

  ABOUT_YOU: { phase: 'Onboarding', label: 'About you' },
  ONBOARDING: { phase: 'Onboarding', label: 'Onboarding' },

  CHAT_INTERFACE: { phase: 'App', label: 'Chat interface' },

  PRICING: { phase: 'Upgrade', label: 'Pricing / upgrade modal' },
  BUSINESS_TRIAL_PLAN_PICKER: { phase: 'Upgrade', label: 'Business plan picker' },

  CHECKOUT: { phase: 'Billing', label: 'Checkout (Stripe)' },

  BLOCKED: { phase: 'Blocked', label: 'Bot / Cloudflare challenge' },
  ACCESS_DENIED: { phase: 'Blocked', label: 'Access denied' },
  AUTH_ERROR: { phase: 'Error', label: 'Authentication error' },
  UNKNOWN: { phase: 'Waiting', label: 'Loading / redirecting' },
};

export function formatAgentState(state) {
  if (!state) return { phase: '—', label: '—', raw: null };
  const meta = StateLabels[state];
  if (!meta) return { phase: 'Run', label: state, raw: state };
  return { phase: meta.phase, label: meta.label, raw: state };
}
