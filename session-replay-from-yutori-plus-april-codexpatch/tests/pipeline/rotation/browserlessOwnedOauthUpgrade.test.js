import { describe, test, expect, jest } from '@jest/globals';

import { onboardBrowserlessWorkspaceMember } from '../../../src/pipeline/rotation/browserlessMemberOnboarder.js';

function makeReplay({
  email = 'member@example.com',
  branch = 'existing-login-otp',
} = {}) {
  return {
    verdict: 'authenticated',
    branch,
    finalCookies: {
      cookies: [{ name: 'session', value: 'abc', domain: 'auth.openai.com', path: '/' }],
    },
    steps: [
      {
        name: 'chatgpt_session',
        responseJson: {
          accessToken: 'tok_personal',
          refreshToken: null,
          expires: '2026-06-15T03:24:16.088Z',
          user: { email, id: 'user_123' },
          account: { id: 'personal-123' },
        },
      },
    ],
    finalSession: {
      hasAccessToken: true,
      userEmail: email,
      userId: 'user_123',
      accountId: 'personal-123',
      expires: '2026-06-15T03:24:16.088Z',
      keys: ['user', 'expires', 'account', 'accessToken'],
    },
  };
}

function makeClient() {
  return {
    getSession: jest.fn()
      .mockResolvedValueOnce({
        accessToken: 'tok_personal',
        refreshToken: null,
        expires: '2026-06-15T03:24:16.088Z',
        user: { email: 'member@example.com', id: 'user_123' },
        account: { id: 'personal-123', planType: 'free', structure: 'personal' },
      })
      .mockResolvedValueOnce({
        accessToken: 'tok_workspace',
        refreshToken: null,
        expires: '2026-06-15T03:24:16.088Z',
        user: { email: 'member@example.com', id: 'user_123' },
        account: { id: 'workspace-123', planType: 'team', structure: 'workspace' },
      }),
    getMe: jest.fn().mockResolvedValue({
      email: 'member@example.com',
      id: 'user_123',
    }),
    getAccounts: jest.fn()
      .mockResolvedValueOnce({ items: [{ id: 'personal-123', structure: 'personal' }] })
      .mockResolvedValueOnce({ items: [{ id: 'workspace-123', structure: 'workspace', name: 'Root-Mail_a' }, { id: 'personal-123', structure: 'personal' }] }),
    getAccountCheck: jest.fn().mockResolvedValue({ accounts: { default: {} }, account_ordering: ['personal-123'] }),
    getUserGranularConsent: jest.fn().mockResolvedValue({ is_consent_required: true, granular_consent: null }),
    canAccessWorkspace: jest.fn().mockResolvedValue(true),
    acceptInvite: jest.fn().mockResolvedValue({ ok: true, status: 200, acceptedVia: 'invites-accept', body: { success: true } }),
    materializeInviteAcceptance: jest.fn().mockResolvedValue({ steps: [] }),
    selectWorkspace: jest.fn().mockResolvedValue({ success: true }),
  };
}

describe('browserlessMemberOnboarder owned OAuth upgrade', () => {
  test('upgrades a workspace-proven session to refresh-bearing auth before returning', async () => {
    const client = makeClient();
    const acquireOwnedOAuth = jest.fn().mockResolvedValue({
      accessToken: 'owned-access-123',
      refreshToken: 'owned-refresh-123',
      expiresAt: new Date('2026-06-16T00:00:00.000Z').getTime(),
      accountId: 'workspace-123',
      identityEmail: 'member@example.com',
      planType: 'team',
    });

    const result = await onboardBrowserlessWorkspaceMember({
      email: 'member@example.com',
      agentMailApiKey: 'am_us_test',
      replayAuth: jest.fn().mockResolvedValue(makeReplay()),
      analyzeAuthTrace: jest.fn().mockResolvedValue({ report: {}, plan: {} }),
      workspaceClientFactory: jest.fn().mockReturnValue(client),
      selectedWorkspace: {
        workspaceId: 'workspace-123',
        workspaceName: 'Root-Mail_a',
      },
      ownerClient: { listUsers: jest.fn().mockResolvedValue({ items: [{ email: 'member@example.com' }] }) },
      acquireOwnedOAuth,
    });

    expect(acquireOwnedOAuth).toHaveBeenCalledWith(expect.objectContaining({
      email: 'member@example.com',
      workspaceId: 'workspace-123',
      replay: expect.objectContaining({ branch: 'existing-login-otp' }),
      session: expect.objectContaining({
        accessToken: 'tok_workspace',
        account: expect.objectContaining({ id: 'workspace-123' }),
      }),
    }));
    expect(result).toEqual(expect.objectContaining({
      accessToken: 'owned-access-123',
      refreshToken: 'owned-refresh-123',
      accountId: 'workspace-123',
      workspaceId: 'workspace-123',
      identityEmail: 'member@example.com',
    }));
  });
});