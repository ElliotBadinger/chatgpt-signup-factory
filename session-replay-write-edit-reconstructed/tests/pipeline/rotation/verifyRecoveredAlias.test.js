import { describe, test, expect } from '@jest/globals';

import { verifyRecoveredAlias } from '../../../src/pipeline/rotation/verifyRecoveredAlias.js';

describe('verifyRecoveredAlias', () => {
  test('passes only when session, workspace membership, router/auth state, and live codex probe all pass', async () => {
    const result = await verifyRecoveredAlias({
      aliasId: 'replacement-1',
      auth: { access: 'tok_live', accountId: 'workspace-123' },
      sessionEvidence: { valid: true },
      workspaceEvidence: { memberConfirmed: true },
      routerEvidence: { aliasInAuth: true, aliasInRouter: true },
      probeCodex: async () => ({ ok: true, latencyMs: 120 }),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      checks: expect.objectContaining({
        sessionValid: true,
        workspaceMemberConfirmed: true,
        routerStatePresent: true,
        liveCodexProbe: true,
      }),
    }));
  });

  test('returns typed failure when any required check is missing', async () => {
    const result = await verifyRecoveredAlias({
      aliasId: 'replacement-2',
      auth: { access: 'tok_live', accountId: 'workspace-123' },
      sessionEvidence: { valid: true },
      workspaceEvidence: { memberConfirmed: false },
      routerEvidence: { aliasInAuth: true, aliasInRouter: false },
      probeCodex: async () => ({ ok: false, reason: 'quota-unreachable' }),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('verification-failed');
    expect(result.failures).toEqual(expect.arrayContaining([
      'workspace-membership-missing',
      'router-state-missing',
      'live-codex-probe-failed',
    ]));
  });
});
