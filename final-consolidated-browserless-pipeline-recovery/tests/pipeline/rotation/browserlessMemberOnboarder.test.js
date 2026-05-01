import { describe, test, expect, jest } from '@jest/globals';

import {
  onboardBrowserlessWorkspaceMember,
  pollWorkspaceInviteMessage,
} from '../../../src/pipeline/rotation/browserlessMemberOnboarder.js';

function makeReplay({
  email = 'member@example.com',
  verdict = 'authenticated',
  branch = 'signup-new',
  redirectLocation = 'https://auth.openai.com/email-verification',
} = {}) {
  return {
    verdict,
    branch,
    finalCookies: {
      cookies: [{ name: 'session', value: 'abc', domain: 'chatgpt.com', path: '/' }],
    },
    steps: [
      {
        name: 'authorize_with_login_hint',
        responseHeaders: { location: redirectLocation },
      },
      {
        name: 'chatgpt_session',
        responseJson: {
          accessToken: 'tok_live',
          expires: '2026-06-15T03:24:16.088Z',
          user: {
            email,
            id: 'user_123',
          },
          account: {
            id: 'personal-123',
          },
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

function makeClient(overrides = {}) {
  return {
    getSession: jest.fn().mockResolvedValue({
      accessToken: 'tok_live',
      expires: '2026-06-15T03:24:16.088Z',
      user: { email: 'member@example.com', id: 'user_123' },
      account: { id: 'personal-123' },
    }),
    getMe: jest.fn().mockResolvedValue({
      email: 'member@example.com',
      id: 'user_123',
    }),
    getAccounts: jest.fn()
      .mockResolvedValueOnce({ items: [{ id: 'personal-123', structure: 'personal' }] })
      .mockResolvedValueOnce({ items: [{ id: 'workspace-123', structure: 'workspace' }, { id: 'personal-123', structure: 'personal' }] }),
    getAccountCheck: jest.fn().mockResolvedValue({ accounts: { default: {} }, account_ordering: ['personal-123'] }),
    getUserGranularConsent: jest.fn().mockResolvedValue({ is_consent_required: true, granular_consent: null }),
    canAccessWorkspace: jest.fn().mockResolvedValue(true),
    acceptInvite: jest.fn().mockResolvedValue({ ok: true, status: 200, acceptedVia: 'invites-accept', body: { success: true } }),
    ...overrides,
  };
}

describe('pollWorkspaceInviteMessage', () => {
  test('skips non-invite messages until it finds the current workspace invite email', async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (String(url).includes('/messages?limit=10')) {
        return {
          ok: true,
          json: async () => ({
            messages: [
              { message_id: 'm1', timestamp: '2026-03-17T03:17:00.000Z', subject: 'Your ChatGPT code is 123456' },
              { message_id: 'm2', timestamp: '2026-03-17T03:18:00.000Z', subject: 'Root Mail_a has invited you to ChatGPT Business' },
            ],
          }),
        };
      }
      if (String(url).includes('/messages/m1')) {
        return {
          ok: true,
          json: async () => ({
            message_id: 'm1',
            subject: 'Your ChatGPT code is 123456',
            text: '123456',
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          message_id: 'm2',
          subject: 'Root Mail_a has invited you to ChatGPT Business',
          html: '<a href="https://chatgpt.com/auth/login?inv_ws_name=Root-Mail_a&amp;inv_email=member%40example.com&amp;wId=workspace-123&amp;accept_wId=workspace-123">Join workspace</a>',
        }),
      };
    });

    const result = await pollWorkspaceInviteMessage({
      inboxId: 'member@example.com',
      apiKey: 'am_us_test',
      fetchImpl,
      sinceMs: new Date('2026-03-17T03:16:00.000Z').getTime(),
      timeoutMs: 25,
      pollIntervalMs: 1,
    });

    expect(result.workspaceId).toBe('workspace-123');
    expect(result.inviteEmail).toBe('member@example.com');
  });
});

describe('onboardBrowserlessWorkspaceMember', () => {
  test('completes fresh signup -> invite parse -> join -> membership confirmation', async () => {
    const client = makeClient();
    const workspaceClientFactory = jest.fn().mockReturnValue(client);
    const inviteMember = jest.fn().mockResolvedValue({ id: 'invite-1' });
    const ownerClient = {
      listUsers: jest.fn().mockResolvedValue({ items: [{ email: 'member@example.com' }] }),
    };

    const result = await onboardBrowserlessWorkspaceMember({
      email: 'member@example.com',
      agentMailApiKey: 'am_us_test',
      replayAuth: jest.fn().mockResolvedValue(makeReplay()),
      analyzeAuthTrace: jest.fn().mockResolvedValue({ report: {}, plan: {} }),
      workspaceClientFactory,
      inviteMember,
      ownerClient,
      pollInviteMessage: jest.fn().mockResolvedValue({
        inviteUrl: 'https://chatgpt.com/auth/login?inv_ws_name=Root-Mail_a&inv_email=member%40example.com&wId=workspace-123&accept_wId=workspace-123',
        workspaceId: 'workspace-123',
        acceptWorkspaceId: 'workspace-123',
        inviteEmail: 'member@example.com',
        workspaceName: 'Root-Mail_a',
        rawMessage: { subject: 'Invite' },
      }),
    });

    expect(inviteMember).toHaveBeenCalledWith('member@example.com');
    expect(client.acceptInvite).toHaveBeenCalledWith({
      workspaceId: 'workspace-123',
      email: 'member@example.com',
    });
    expect(ownerClient.listUsers).toHaveBeenCalledWith('workspace-123');
    expect(result).toEqual(expect.objectContaining({
      identityEmail: 'member@example.com',
      personalAccountId: 'personal-123',
      workspaceId: 'workspace-123',
      accountId: 'workspace-123',
      accessToken: 'tok_live',
      joinedVia: 'invites-accept',
    }));
  });

  test('supports existing-account OTP login branch', async () => {
    const client = makeClient();

    const result = await onboardBrowserlessWorkspaceMember({
      email: 'member@example.com',
      agentMailApiKey: 'am_us_test',
      replayAuth: jest.fn().mockResolvedValue(makeReplay({ branch: 'existing-login-otp' })),
      analyzeAuthTrace: jest.fn().mockResolvedValue({ report: {}, plan: {} }),
      workspaceClientFactory: jest.fn().mockReturnValue(client),
      inviteMember: jest.fn().mockResolvedValue({ id: 'invite-1' }),
      ownerClient: { listUsers: jest.fn().mockResolvedValue({ items: [{ email: 'member@example.com' }] }) },
      pollInviteMessage: jest.fn().mockResolvedValue({
        inviteUrl: 'https://chatgpt.com/auth/login?inv_ws_name=Root-Mail_a&inv_email=member%40example.com&wId=workspace-123&accept_wId=workspace-123',
        workspaceId: 'workspace-123',
        acceptWorkspaceId: 'workspace-123',
        inviteEmail: 'member@example.com',
        workspaceName: 'Root-Mail_a',
      }),
    });

    expect(result.authBranch).toBe('existing-login-otp');
  });

  test('restarts auth replay after a transient transport failure', async () => {
    const client = makeClient();
    const replayAuth = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }))
      .mockResolvedValueOnce(makeReplay());

    const result = await onboardBrowserlessWorkspaceMember({
      email: 'member@example.com',
      agentMailApiKey: 'am_us_test',
      replayAuth,
      analyzeAuthTrace: jest.fn().mockResolvedValue({ report: {}, plan: {} }),
      workspaceClientFactory: jest.fn().mockReturnValue(client),
      inviteMember: jest.fn().mockResolvedValue({ id: 'invite-1' }),
      ownerClient: { listUsers: jest.fn().mockResolvedValue({ items: [{ email: 'member@example.com' }] }) },
      pollInviteMessage: jest.fn().mockResolvedValue({
        inviteUrl: 'https://chatgpt.com/auth/login?inv_ws_name=Root-Mail_a&inv_email=member%40example.com&wId=workspace-123&accept_wId=workspace-123',
        workspaceId: 'workspace-123',
        acceptWorkspaceId: 'workspace-123',
        inviteEmail: 'member@example.com',
        workspaceName: 'Root-Mail_a',
      }),
      sleepImpl: async () => {},
    });

    expect(replayAuth).toHaveBeenCalledTimes(2);
    expect(result.workspaceId).toBe('workspace-123');
  });

  test('allows Resend receiving addresses to rely on lower-level API key resolution', async () => {
    const client = makeClient({
      getSession: jest.fn().mockResolvedValue({
        accessToken: 'tok_live',
        user: { email: 'openai_6@epistemophile.store', id: 'user_123' },
        account: { id: 'personal-123' },
      }),
      getMe: jest.fn().mockResolvedValue({
        email: 'openai_6@epistemophile.store',
        id: 'user_123',
      }),
    });
    const replayAuth = jest.fn().mockResolvedValue(makeReplay({
      email: 'openai_6@epistemophile.store',
      branch: 'existing-login-otp',
    }));

    const result = await onboardBrowserlessWorkspaceMember({
      email: 'openai_6@epistemophile.store',
      agentMailApiKey: null,
      resendApiKey: null,
      replayAuth,
      analyzeAuthTrace: jest.fn().mockResolvedValue({ report: {}, plan: {} }),
      workspaceClientFactory: jest.fn().mockReturnValue(client),
      inviteMember: jest.fn().mockResolvedValue({ id: 'invite-1' }),
      ownerClient: { listUsers: jest.fn().mockResolvedValue({ items: [{ email: 'openai_6@epistemophile.store' }] }) },
      pollInviteMessage: jest.fn().mockResolvedValue({
        inviteUrl: 'https://chatgpt.com/auth/login?inv_ws_name=Root-Mail_a&inv_email=openai_6%40epistemophile.store&wId=workspace-123&accept_wId=workspace-123',
        workspaceId: 'workspace-123',
        acceptWorkspaceId: 'workspace-123',
        inviteEmail: 'openai_6@epistemophile.store',
        workspaceName: 'Root-Mail_a',
      }),
    });

    expect(replayAuth).toHaveBeenCalledWith(expect.objectContaining({
      email: 'openai_6@epistemophile.store',
      resendApiKey: null,
    }));
    expect(result.identityEmail).toBe('openai_6@epistemophile.store');
  });

  test('uses recovered golden sentinel summary when trace artifacts are missing', async () => {
    const client = makeClient();
    const analyzeAuthTrace = jest.fn(async () => {
      const error = new Error('missing trace fixture');
      error.code = 'ENOENT';
      throw error;
    });
    const replayAuth = jest.fn().mockResolvedValue(makeReplay({ branch: 'existing-login-otp' }));

    const result = await onboardBrowserlessWorkspaceMember({
      email: 'member@example.com',
      agentMailApiKey: 'am_us_test',
      replayAuth,
      analyzeAuthTrace,
      workspaceClientFactory: jest.fn().mockReturnValue(client),
      inviteMember: jest.fn().mockResolvedValue({ id: 'invite-1' }),
      ownerClient: { listUsers: jest.fn().mockResolvedValue({ items: [{ email: 'member@example.com' }] }) },
      pollInviteMessage: jest.fn().mockResolvedValue({
        inviteUrl: 'https://chatgpt.com/auth/login?inv_ws_name=Root-Mail_a&inv_email=member%40example.com&wId=workspace-123&accept_wId=workspace-123',
        workspaceId: 'workspace-123',
        acceptWorkspaceId: 'workspace-123',
        inviteEmail: 'member@example.com',
        workspaceName: 'Root-Mail_a',
      }),
    });

    expect(replayAuth).toHaveBeenCalledWith(expect.objectContaining({
      analysis: expect.objectContaining({
        report: expect.objectContaining({
          actualScenario: 'signup-new',
          recoveredFromSummary: true,
          sentinel: expect.objectContaining({
            requiredHeaders: expect.arrayContaining([
              'openai-sentinel-token',
              'openai-sentinel-so-token',
            ]),
          }),
        }),
      }),
    }));
    expect(result.authBranch).toBe('existing-login-otp');
  });

  test('treats invite acceptance as already complete when workspace access already exists', async () => {
    const client = makeClient({
      getAccounts: jest.fn().mockResolvedValue({ items: [{ id: 'workspace-123', structure: 'workspace' }, { id: 'personal-123', structure: 'personal' }] }),
      canAccessWorkspace: jest.fn().mockResolvedValue(true),
      acceptInvite: jest.fn(),
    });

    const result = await onboardBrowserlessWorkspaceMember({
      email: 'member@example.com',
      agentMailApiKey: 'am_us_test',
      replayAuth: jest.fn().mockResolvedValue(makeReplay()),
      analyzeAuthTrace: jest.fn().mockResolvedValue({ report: {}, plan: {} }),
      workspaceClientFactory: jest.fn().mockReturnValue(client),
      ownerClient: { listUsers: jest.fn().mockResolvedValue({ items: [{ email: 'member@example.com' }] }) },
      pollInviteMessage: jest.fn(),
    });

    expect(client.acceptInvite).not.toHaveBeenCalled();
    expect(result.joinedVia).toBe('already-member');
  });

  test('surfaces join fallback path when invites/accept is unavailable', async () => {
    const client = makeClient({
      acceptInvite: jest.fn().mockResolvedValue({ ok: true, status: 200, acceptedVia: 'join', body: { success: true } }),
    });

    const result = await onboardBrowserlessWorkspaceMember({
      email: 'member@example.com',
      agentMailApiKey: 'am_us_test',
      replayAuth: jest.fn().mockResolvedValue(makeReplay()),
      analyzeAuthTrace: jest.fn().mockResolvedValue({ report: {}, plan: {} }),
      workspaceClientFactory: jest.fn().mockReturnValue(client),
      inviteMember: jest.fn().mockResolvedValue({ id: 'invite-1' }),
      ownerClient: { listUsers: jest.fn().mockResolvedValue({ items: [{ email: 'member@example.com' }] }) },
      pollInviteMessage: jest.fn().mockResolvedValue({
        inviteUrl: 'https://chatgpt.com/auth/login?inv_ws_name=Root-Mail_a&inv_email=member%40example.com&wId=workspace-123&accept_wId=workspace-123',
        workspaceId: 'workspace-123',
        acceptWorkspaceId: 'workspace-123',
        inviteEmail: 'member@example.com',
        workspaceName: 'Root-Mail_a',
      }),
    });

    expect(result.joinedVia).toBe('join');
  });

  test('recovers password-only login when browserless recovery authenticates with the existing account', async () => {
    const client = makeClient();
    const replayAuth = jest.fn()
      .mockResolvedValueOnce(makeReplay({
        verdict: 'unsupported-authorize-redirect',
        branch: 'unknown',
        redirectLocation: 'https://auth.openai.com/log-in/password',
      }))
      .mockResolvedValueOnce(makeReplay({
        verdict: 'authenticated',
        branch: 'password-login',
      }));

    const result = await onboardBrowserlessWorkspaceMember({
      email: 'member@example.com',
      agentMailApiKey: 'am_us_test',
      replayAuth,
      analyzeAuthTrace: jest.fn().mockResolvedValue({ report: {}, plan: {} }),
      workspaceClientFactory: jest.fn().mockReturnValue(client),
      inviteMember: jest.fn().mockResolvedValue({ id: 'invite-1' }),
      ownerClient: { listUsers: jest.fn().mockResolvedValue({ items: [{ email: 'member@example.com' }] }) },
      pollInviteMessage: jest.fn().mockResolvedValue({
        inviteUrl: 'https://chatgpt.com/auth/login?inv_ws_name=Root-Mail_a&inv_email=member%40example.com&wId=workspace-123&accept_wId=workspace-123',
        workspaceId: 'workspace-123',
        acceptWorkspaceId: 'workspace-123',
        inviteEmail: 'member@example.com',
        workspaceName: 'Root-Mail_a',
      }),
    });

    expect(replayAuth).toHaveBeenCalledTimes(2);
    expect(result.authBranch).toBe('password-login');
  });

  test('recovers Resend aliases through existing-login OTP when signup register is rejected', async () => {
    const client = makeClient({
      getSession: jest.fn().mockResolvedValue({
        accessToken: 'tok_live',
        user: { email: 'openai_6@epistemophile.store', id: 'user_123' },
        account: { id: 'personal-123' },
      }),
      getMe: jest.fn().mockResolvedValue({ email: 'openai_6@epistemophile.store', id: 'user_123' }),
    });
    const replayAuth = jest.fn()
      .mockResolvedValueOnce({
        verdict: 'signup-register-failed',
        branch: 'signup-new',
        blockerReason: 'Failed to create account. Please try again.',
        steps: [],
        finalCookies: { cookies: [] },
      })
      .mockResolvedValueOnce(makeReplay({
        email: 'openai_6@epistemophile.store',
        branch: 'existing-login-otp',
      }));

    const result = await onboardBrowserlessWorkspaceMember({
      email: 'openai_6@epistemophile.store',
      agentMailApiKey: null,
      resendApiKey: 're_test',
      replayAuth,
      analyzeAuthTrace: jest.fn().mockResolvedValue({ report: {}, plan: {} }),
      workspaceClientFactory: jest.fn().mockReturnValue(client),
      inviteMember: jest.fn().mockResolvedValue({ id: 'invite-1' }),
      ownerClient: { listUsers: jest.fn().mockResolvedValue({ items: [{ email: 'openai_6@epistemophile.store' }] }) },
      pollInviteMessage: jest.fn().mockResolvedValue({
        inviteUrl: 'https://chatgpt.com/auth/login?inv_ws_name=Root-Mail_a&inv_email=openai_6%40epistemophile.store&wId=workspace-123&accept_wId=workspace-123',
        workspaceId: 'workspace-123',
        acceptWorkspaceId: 'workspace-123',
        inviteEmail: 'openai_6@epistemophile.store',
        workspaceName: 'Root-Mail_a',
      }),
    });

    expect(replayAuth).toHaveBeenNthCalledWith(2, expect.objectContaining({
      mode: 'existing-login-otp',
      resendApiKey: 're_test',
    }));
    expect(result.authBranch).toBe('existing-login-otp');
  });

  test('throws a deterministic NO_EMAIL_CODE_OPTION error when auth falls into password-only login', async () => {
    await expect(onboardBrowserlessWorkspaceMember({
      email: 'member@example.com',
      agentMailApiKey: 'am_us_test',
      replayAuth: jest.fn().mockResolvedValue(makeReplay({
        verdict: 'unsupported-authorize-redirect',
        branch: 'unknown',
        redirectLocation: 'https://auth.openai.com/log-in/password',
      })),
      analyzeAuthTrace: jest.fn().mockResolvedValue({ report: {}, plan: {} }),
      workspaceClientFactory: jest.fn(),
    })).rejects.toThrow(/NO_EMAIL_CODE_OPTION/);
  });

  test('waits for eventual workspace membership visibility after invite acceptance', async () => {
    const client = makeClient({
      getAccounts: jest.fn()
        .mockResolvedValueOnce({ items: [{ id: 'personal-123', structure: 'personal' }] })
        .mockResolvedValueOnce({ items: [{ id: 'personal-123', structure: 'personal' }] })
        .mockResolvedValueOnce({ items: [{ id: 'workspace-123', structure: 'workspace' }, { id: 'personal-123', structure: 'personal' }] }),
      canAccessWorkspace: jest.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    });
    const ownerClient = {
      listUsers: jest.fn()
        .mockResolvedValueOnce({ items: [] })
        .mockResolvedValueOnce({ items: [{ email: 'member@example.com' }] }),
    };

    const result = await onboardBrowserlessWorkspaceMember({
      email: 'member@example.com',
      agentMailApiKey: 'am_us_test',
      replayAuth: jest.fn().mockResolvedValue(makeReplay()),
      analyzeAuthTrace: jest.fn().mockResolvedValue({ report: {}, plan: {} }),
      workspaceClientFactory: jest.fn().mockReturnValue(client),
      inviteMember: jest.fn().mockResolvedValue({ id: 'invite-1' }),
      ownerClient,
      pollInviteMessage: jest.fn().mockResolvedValue({
        inviteUrl: 'https://chatgpt.com/auth/login?inv_ws_name=Root-Mail_a&inv_email=member%40example.com&wId=workspace-123&accept_wId=workspace-123',
        workspaceId: 'workspace-123',
        acceptWorkspaceId: 'workspace-123',
        inviteEmail: 'member@example.com',
        workspaceName: 'Root-Mail_a',
      }),
      membershipPollIntervalMs: 0,
      membershipTimeoutMs: 50,
      sleepImpl: async () => {},
    });

    expect(client.canAccessWorkspace).toHaveBeenCalledTimes(2);
    expect(ownerClient.listUsers).toHaveBeenCalledTimes(2);
    expect(result.workspaceId).toBe('workspace-123');
  });

  test('throws when invite acceptance succeeds but workspace membership is still missing', async () => {
    const client = makeClient({
      getAccounts: jest.fn()
        .mockResolvedValueOnce({ items: [{ id: 'personal-123', structure: 'personal' }] })
        .mockResolvedValueOnce({ items: [{ id: 'personal-123', structure: 'personal' }] }),
      canAccessWorkspace: jest.fn().mockResolvedValue(false),
    });

    await expect(onboardBrowserlessWorkspaceMember({
      email: 'member@example.com',
      agentMailApiKey: 'am_us_test',
      replayAuth: jest.fn().mockResolvedValue(makeReplay()),
      analyzeAuthTrace: jest.fn().mockResolvedValue({ report: {}, plan: {} }),
      workspaceClientFactory: jest.fn().mockReturnValue(client),
      inviteMember: jest.fn().mockResolvedValue({ id: 'invite-1' }),
      ownerClient: { listUsers: jest.fn().mockResolvedValue({ items: [] }) },
      pollInviteMessage: jest.fn().mockResolvedValue({
        inviteUrl: 'https://chatgpt.com/auth/login?inv_ws_name=Root-Mail_a&inv_email=member%40example.com&wId=workspace-123&accept_wId=workspace-123',
        workspaceId: 'workspace-123',
        acceptWorkspaceId: 'workspace-123',
        inviteEmail: 'member@example.com',
        workspaceName: 'Root-Mail_a',
      }),
      membershipPollIntervalMs: 0,
      membershipTimeoutMs: 1,
      sleepImpl: async () => {},
    })).rejects.toThrow(/membership/i);
  });
});
