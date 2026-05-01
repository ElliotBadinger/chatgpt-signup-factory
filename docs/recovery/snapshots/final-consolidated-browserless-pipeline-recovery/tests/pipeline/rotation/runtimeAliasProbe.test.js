import { describe, test, expect, jest } from '@jest/globals';

import { createRuntimeVerifiedAliasProbe } from '../../../src/pipeline/rotation/runtimeAliasProbe.js';

describe('createRuntimeVerifiedAliasProbe', () => {
  test('builds a runtime probe that requires both browserless session/workspace checks and live pi codex proof', async () => {
    const workspaceClientFactory = jest.fn().mockReturnValue({
      getMe: jest.fn().mockResolvedValue({ email: 'replacement@agentmail.to', id: 'user-1' }),
      getAccounts: jest.fn().mockResolvedValue({ items: [{ id: 'workspace-123', structure: 'workspace' }] }),
      getUserGranularConsent: jest.fn().mockResolvedValue({ is_consent_required: false }),
    });
    const probeRunner = jest.fn().mockResolvedValue({ ok: true, exitCode: 0, eventCount: 3 });

    const probe = createRuntimeVerifiedAliasProbe({
      authLoader: () => ({ replacement: { access: 'tok_live', accountId: 'workspace-123' } }),
      workspaceClientFactory,
      probeRunner,
      authJsonPath: '/tmp/auth.json',
      routerPath: '/tmp/router.json',
      healthPath: '/tmp/health.json',
    });

    const result = await probe({
      aliasId: 'replacement',
      auth: { access: 'tok_live', accountId: 'workspace-123' },
    });

    expect(workspaceClientFactory).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'tok_live',
      accountId: 'workspace-123',
    }));
    expect(probeRunner).toHaveBeenCalledWith(expect.objectContaining({
      aliasId: 'replacement',
      modelId: 'gpt-5.4',
      routerPath: '/tmp/router.json',
      healthPath: '/tmp/health.json',
    }));
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      source: 'browserless-runtime-probe',
      meEmail: 'replacement@agentmail.to',
      accountCount: 1,
      codexUsabilityVerified: true,
      quotaSource: 'live-pi-probe',
      liveProbe: expect.objectContaining({ ok: true }),
    }));
  });

  test('fails closed with a typed blocker when runtime verification cannot be configured', async () => {
    const probe = createRuntimeVerifiedAliasProbe({ authLoader: () => ({}) });

    const result = await probe({ aliasId: 'missing', auth: null });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      blockerReason: 'verification-probe-not-configured',
    }));
  });

  test('fails closed when browserless session checks pass but live pi codex proof fails', async () => {
    const probe = createRuntimeVerifiedAliasProbe({
      authLoader: () => ({ replacement: { access: 'tok_live', accountId: 'workspace-123' } }),
      workspaceClientFactory: () => ({
        getMe: async () => ({ email: 'replacement@agentmail.to' }),
        getAccounts: async () => ({ items: [{ id: 'workspace-123', structure: 'workspace' }] }),
        getUserGranularConsent: async () => ({ is_consent_required: false }),
      }),
      probeRunner: async () => ({ ok: false, errorText: 'quota exceeded' }),
    });

    const result = await probe({ aliasId: 'replacement', auth: { access: 'tok_live', accountId: 'workspace-123' } });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      blockerReason: 'live-codex-probe-failed',
      codexUsabilityVerified: false,
      quotaSource: 'live-pi-probe-failed',
      liveProbe: expect.objectContaining({ ok: false, errorText: 'quota exceeded' }),
    }));
  });
});
