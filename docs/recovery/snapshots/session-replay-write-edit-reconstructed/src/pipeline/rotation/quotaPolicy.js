export const DEFAULT_QUOTA_THRESHOLDS = {
  exhausted: 0.05,
  lowFiveHour: 0.2,
  lowWeekly: 0.3,
};

export function classifyQuotaState({
  source = 'none',
  windows = null,
  explicitState = null,
  coarseFraction = null,
  thresholds = DEFAULT_QUOTA_THRESHOLDS,
} = {}) {
  if (explicitState) return explicitState;

  const fiveHour = windows?.fiveHourRemainingFraction;
  const weekly = windows?.weeklyRemainingFraction;
  if (typeof fiveHour === 'number' && typeof weekly === 'number') {
    if (fiveHour <= thresholds.exhausted && weekly <= thresholds.exhausted) return 'both-exhausted';
    if (fiveHour <= thresholds.exhausted && weekly > thresholds.exhausted) return 'five-hour-exhausted-only';
    if (fiveHour <= thresholds.lowFiveHour && weekly <= thresholds.lowWeekly) return 'low-on-both';
    return 'healthy';
  }

  if (source === 'health-minimum' && typeof coarseFraction === 'number') {
    if (coarseFraction <= thresholds.exhausted) return 'exhausted-unknown-window';
    if (coarseFraction <= Math.min(thresholds.lowFiveHour, thresholds.lowWeekly)) return 'low-on-both';
    return 'healthy';
  }

  return 'unknown';
}

export function shouldPrewarmWorkspace({
  healthyAccounts = 0,
  totalAccounts = 0,
  minHealthyAccountsPerWorkspace = 2,
  minHealthyFraction = 0.5,
} = {}) {
  if (totalAccounts <= 0) return true;
  const healthyFraction = healthyAccounts / totalAccounts;
  return healthyAccounts < minHealthyAccountsPerWorkspace || healthyFraction < minHealthyFraction;
}

export function chooseWorkspaceAction({
  aliasQuotaStates = [],
  healthyAccounts = 0,
  totalAccounts = aliasQuotaStates.length,
  minHealthyAccountsPerWorkspace = 2,
  minHealthyFraction = 0.5,
} = {}) {
  const stateCounts = aliasQuotaStates.reduce((counts, state) => {
    counts[state] = (counts[state] ?? 0) + 1;
    return counts;
  }, {});

  if ((stateCounts['both-exhausted'] ?? 0) > 0) return 'replace';

  const needsPrewarm = shouldPrewarmWorkspace({
    healthyAccounts,
    totalAccounts,
    minHealthyAccountsPerWorkspace,
    minHealthyFraction,
  });

  if ((stateCounts['five-hour-exhausted-only'] ?? 0) > 0 && needsPrewarm) {
    return 'supplement-prewarm';
  }
  if ((stateCounts['low-on-both'] ?? 0) > 0 && needsPrewarm) {
    return 'prewarm';
  }
  return 'keep';
}
