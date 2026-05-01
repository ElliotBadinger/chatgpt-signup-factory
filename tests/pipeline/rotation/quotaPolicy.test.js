import { describe, test, expect } from '@jest/globals';

import {
  classifyQuotaState,
  shouldPrewarmWorkspace,
  chooseWorkspaceAction,
} from '../../../src/pipeline/rotation/quotaPolicy.js';

describe('classifyQuotaState', () => {
  test('classifies healthy quota from explicit live windows', () => {
    expect(classifyQuotaState({
      source: 'live-probe',
      windows: { fiveHourRemainingFraction: 0.7, weeklyRemainingFraction: 0.8 },
    })).toBe('healthy');
  });

  test('classifies five-hour-exhausted-only from explicit live windows', () => {
    expect(classifyQuotaState({
      source: 'live-probe',
      windows: { fiveHourRemainingFraction: 0.0, weeklyRemainingFraction: 0.65 },
    })).toBe('five-hour-exhausted-only');
  });

  test('classifies both-exhausted from explicit live windows', () => {
    expect(classifyQuotaState({
      source: 'live-probe',
      windows: { fiveHourRemainingFraction: 0.0, weeklyRemainingFraction: 0.02 },
    })).toBe('both-exhausted');
  });

  test('classifies low-on-both when both windows are above exhausted but below healthy thresholds', () => {
    expect(classifyQuotaState({
      source: 'live-probe',
      windows: { fiveHourRemainingFraction: 0.18, weeklyRemainingFraction: 0.22 },
    })).toBe('low-on-both');
  });
});

describe('shouldPrewarmWorkspace', () => {
  test('uses hybrid absolute floor plus healthy-fraction threshold', () => {
    expect(shouldPrewarmWorkspace({
      healthyAccounts: 1,
      totalAccounts: 4,
      minHealthyAccountsPerWorkspace: 2,
      minHealthyFraction: 0.5,
    })).toBe(true);

    expect(shouldPrewarmWorkspace({
      healthyAccounts: 3,
      totalAccounts: 4,
      minHealthyAccountsPerWorkspace: 2,
      minHealthyFraction: 0.5,
    })).toBe(false);
  });
});

describe('chooseWorkspaceAction', () => {
  test('classifies workspace-wide five-hour exhaustion as supplement-prewarm instead of replace', () => {
    const action = chooseWorkspaceAction({
      aliasQuotaStates: [
        'five-hour-exhausted-only',
        'five-hour-exhausted-only',
        'healthy',
      ],
      healthyAccounts: 1,
      totalAccounts: 3,
      minHealthyAccountsPerWorkspace: 2,
      minHealthyFraction: 0.5,
    });

    expect(action).toBe('supplement-prewarm');
  });

  test('classifies both-exhausted pressure as replace', () => {
    const action = chooseWorkspaceAction({
      aliasQuotaStates: ['both-exhausted', 'healthy'],
      healthyAccounts: 1,
      totalAccounts: 2,
      minHealthyAccountsPerWorkspace: 1,
      minHealthyFraction: 0.4,
    });

    expect(action).toBe('replace');
  });
});
