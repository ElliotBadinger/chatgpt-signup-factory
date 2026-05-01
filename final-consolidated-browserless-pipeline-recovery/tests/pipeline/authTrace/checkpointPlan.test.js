import { describe, expect, test } from '@jest/globals';

import { buildCheckpointPlan } from '../../../src/pipeline/authTrace/checkpointPlan.js';

describe('buildCheckpointPlan', () => {
  test('returns deep interactive signup-new manual plan', () => {
    expect(buildCheckpointPlan({ mode: 'manual', scenario: 'signup-new' }).map((step) => step.name)).toEqual([
      'landing',
      'auth-page-loaded',
      'email-submitted',
      'otp-page',
      'otp-submitted',
      'password-page',
      'password-submitted',
      'post-callback',
      'final',
    ]);
  });

  test('returns smaller assisted plan', () => {
    expect(buildCheckpointPlan({ mode: 'assisted', scenario: 'unknown-auto' }).map((step) => step.name)).toEqual([
      'landing',
      'auth-page-loaded',
      'final',
    ]);
  });
});
