import { describe, expect, test } from '@jest/globals';

import {
  CANONICAL_ALIAS_LIFECYCLE_STATES,
  CANONICAL_BLOCKER_CLASSES,
  LIFECYCLE_RESTORE_EVENT,
  classifyBlockerReason,
  createOwnerAdminCleanupTarget,
  isCanonicalAliasLifecycleState,
} from '../../../src/pipeline/rotation/lifecycleModel.js';

describe('lifecycleModel', () => {
  test('exports the canonical lifecycle vocabulary and blocker taxonomy', () => {
    expect(CANONICAL_ALIAS_LIFECYCLE_STATES).toEqual([
      'candidate',
      'active',
      'queued-replacement',
      'archived',
      'restorable',
      'quarantined',
    ]);
    expect(LIFECYCLE_RESTORE_EVENT).toBe('reinstated');
    expect(CANONICAL_BLOCKER_CLASSES).toContain('workspace-identity-membership');
    expect(CANONICAL_BLOCKER_CLASSES).toContain('auth-durability');
    expect(CANONICAL_BLOCKER_CLASSES).toContain('verification-evidence');
  });

  test('recognizes steady states but not the reinstated event as a steady state', () => {
    expect(isCanonicalAliasLifecycleState('active')).toBe(true);
    expect(isCanonicalAliasLifecycleState('quarantined')).toBe(true);
    expect(isCanonicalAliasLifecycleState('reinstated')).toBe(false);
  });

  test('normalizes runtime reasons into canonical blocker classes', () => {
    expect(classifyBlockerReason('workspace-account-mismatch')).toEqual({
      blockerClass: 'workspace-identity-membership',
      rawReason: 'workspace-account-mismatch',
    });
    expect(classifyBlockerReason('MEMBERSHIP_NOT_MATERIALIZED')).toEqual({
      blockerClass: 'ingress-onboarding',
      rawReason: 'MEMBERSHIP_NOT_MATERIALIZED',
    });
    expect(classifyBlockerReason('verification-probe-not-configured')).toEqual({
      blockerClass: 'verification-evidence',
      rawReason: 'verification-probe-not-configured',
    });
    expect(classifyBlockerReason('quota-evidence-ambiguous')).toEqual({
      blockerClass: 'capacity-quota',
      rawReason: 'quota-evidence-ambiguous',
    });
    expect(classifyBlockerReason('unofficial-workspace-member')).toEqual({
      blockerClass: 'workspace-identity-membership',
      rawReason: 'unofficial-workspace-member',
    });
  });

  test('creates owner-admin cleanup targets for unofficial workspace members', () => {
    expect(
      createOwnerAdminCleanupTarget({
        email: 'ghost@agentmail.to',
        workspaceId: 'workspace-1',
      }),
    ).toEqual({
      aliasId: null,
      email: 'ghost@agentmail.to',
      workspaceId: 'workspace-1',
      status: 'scrub-candidate',
      source: 'workspace-owner-admin',
      blockerClass: 'workspace-identity-membership',
      rawReason: 'unofficial-workspace-member',
    });
  });
});