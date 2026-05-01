import { describe, expect, test } from '@jest/globals';

import {
  detectSeatCount,
  hasInviteFailurePattern,
  isUniversalHardCapActive,
  recordSeatObservation,
  shouldBlockFreshTargetConsumption,
} from '../../../src/pipeline/state/workspace.js';

describe('pipeline workspace state helpers', () => {
  test('detects seat counts and configured invite failure patterns from invite failure text', () => {
    const failure = 'invite rejected: seats_in_use=10 capacity reached';

    expect(detectSeatCount(failure)).toBe(10);
    expect(hasInviteFailurePattern(failure, 'seats_in_use=10')).toBe(true);
    expect(hasInviteFailurePattern(failure, /capacity reached/i)).toBe(true);
    expect(hasInviteFailurePattern(failure, 'workspace full')).toBe(false);
  });

  test('records a timestamped seat observation and marks a universal hard cap when the configured invite failure pattern is observed', () => {
    expect(
      recordSeatObservation({
        workspaceId: 'workspace-1',
        observedAt: '2026-03-13T16:10:00.000Z',
        inviteFailure: 'api_error seats_in_use=10 hard limit reached',
        inviteFailurePattern: 'seats_in_use=',
        inviteCount: 3,
      }),
    ).toEqual({
      workspaceId: 'workspace-1',
      observedAt: '2026-03-13T16:10:00.000Z',
      memberCount: 10,
      inviteCount: 3,
      hardCapReached: true,
    });
  });

  test('does not block consumption without a hard cap and allows override when a universal hard cap is active', () => {
    const inactiveObservation = recordSeatObservation({
      workspaceId: 'workspace-open',
      observedAt: '2026-03-13T16:11:00.000Z',
      inviteFailure: 'temporary network issue',
      inviteFailurePattern: 'seats_in_use=',
    });
    const activeObservation = recordSeatObservation({
      workspaceId: 'workspace-capped',
      observedAt: '2026-03-13T16:12:00.000Z',
      inviteFailure: 'seats_in_use=10',
      inviteFailurePattern: 'seats_in_use=',
    });

    expect(isUniversalHardCapActive(inactiveObservation)).toBe(false);
    expect(shouldBlockFreshTargetConsumption({ workspaceObservation: inactiveObservation })).toBe(false);

    expect(isUniversalHardCapActive(activeObservation)).toBe(true);
    expect(shouldBlockFreshTargetConsumption({ workspaceObservation: activeObservation })).toBe(true);
    expect(
      shouldBlockFreshTargetConsumption({ workspaceObservation: activeObservation, overrideUniversalHardCap: true }),
    ).toBe(false);
  });
});
