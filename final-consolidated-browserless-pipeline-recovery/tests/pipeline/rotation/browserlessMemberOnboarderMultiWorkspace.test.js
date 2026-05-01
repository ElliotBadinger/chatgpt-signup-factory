import { describe, test, expect, jest } from '@jest/globals';

import { onboardBrowserlessWorkspaceMember } from '../../../src/pipeline/rotation/browserlessMemberOnboarder.js';

function makeReplay(email = 'member@example.com') {
  return {
    verdict: 'authenticated',
    branch: 'existing-login-otp',
    finalCookies: { cookies: [{ name: 'session', value: 'abc', domain: 'chatgpt.com', path: '/' }] },
    steps: [
      { name: 'authorize_with_login_hint', responseHeaders: { location: 'https://auth.openai.com/email-verification' } },
      {
        name: 'chatgpt_session',
        responseJson: {
          accessToken: 'tok_live',
          expires: '2026-06-15T03:24:16.088Z',
          user: { email, id: 'user_123' },
          account: { id: 'personal-123' },
        },
      },
    ],
  };
}

function makeClient() {
  return {
    getSession: jest.fn().mockResolvedValue({
      accessToken: 'tok_live',
      expires: '2026-06-15T03:24:16.088Z',
      user: { email: 'member@example.com', id: 'user_123' },
      account: { id: 'personal-123' },
    }),
    getMe: jest.fn().mockResolvedValue({ email: 'member@example.com', id: 'user_123' }),
    getAccounts: jest.fn()
      .mockResolvedValueOnce({ items: [{ id: 'personal-123', structure: 'personal' }] })
      .mockResolvedValueOnce({ items: [{ id: 'workspace-lineage-a-2', structure: 'workspace', name: 'Lineage A Two' }, { id: 'personal-123', structure: 'personal' }] }),
    getAccountCheck: jest.fn().mockResolvedValue({ accounts: { default: {} }, account_ordering: ['personal-123'] }),
    getUserGranularConsent: jest.fn().mockResolvedValue({ is_consent_required: true, granular_consent: null }),
    canAccessWorkspace: jest.fn().mockResolvedValue(true),
    acceptInvite: jest.fn().mockResolvedValue({ ok: true, status: 200, acceptedVia: 'invites-accept', body: { success: true } }),
  };
}

describe('onboardBrowserlessWorkspaceMember multi-workspace placement', () => {
  test('selects workspace from lineage context and uses that exact workspace for invite, accept, and owner verification', async () => {
    const client = makeClient();
    const selectedWorkspace = {
      workspaceId: 'workspace-lineage-a-2',
      workspaceName: 'Lineage A Two',
      ownerAliasId: 'owner-a',
      lineage: 'lineage-a',
    };
    const selectWorkspace = jest.fn().mockResolvedValue(selectedWorkspace);
    const inviteMember = jest.fn().mockResolvedValue({ id: 'invite-1', workspaceId: 'workspace-lineage-a-2' });
    const ownerClient = {
      listUsers: jest.fn().mockResolvedValue({ items: [{ email: 'member@example.com' }] }),
    };

    const result = await onboardBrowserlessWorkspaceMember({
      email: 'member@example.com',
      agentMailApiKey: 'am_us_test',
      replayAuth: jest.fn().mockResolvedValue(makeReplay()),
      analyzeAuthTrace: jest.fn().mockResolvedValue({ report: {}, plan: {} }),
      workspaceClientFactory: jest.fn().mockReturnValue(client),
      selectWorkspace,
      placementContext: {
        aliasId: 'exhausted-a1',
        lineage: 'lineage-a',
        rootEmail: 'root-a@example.com',
        rootOrgId: 'org-a',
      },
      inviteMember,
      ownerClient,
      pollInviteMessage: jest.fn().mockResolvedValue({
        inviteUrl: 'https://chatgpt.com/auth/login?inv_ws_name=Lineage%20A%20Two&inv_email=member%40example.com&wId=workspace-lineage-a-2&accept_wId=workspace-lineage-a-2',
        workspaceId: 'workspace-lineage-a-2',
        acceptWorkspaceId: 'workspace-lineage-a-2',
        inviteEmail: 'member@example.com',
        workspaceName: 'Lineage A Two',
      }),
    });

    expect(selectWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      email: 'member@example.com',
      placementContext: expect.objectContaining({ aliasId: 'exhausted-a1', lineage: 'lineage-a' }),
    }));
    expect(inviteMember).toHaveBeenCalledWith(
      'member@example.com',
      expect.objectContaining({
        workspace: selectedWorkspace,
        placementContext: expect.objectContaining({ aliasId: 'exhausted-a1', rootEmail: 'root-a@example.com' }),
      }),
    );
    expect(client.acceptInvite).toHaveBeenCalledWith({
      workspaceId: 'workspace-lineage-a-2',
      email: 'member@example.com',
    });
    expect(ownerClient.listUsers).toHaveBeenCalledWith('workspace-lineage-a-2', expect.objectContaining({
      workspace: selectedWorkspace,
      placementContext: expect.objectContaining({ lineage: 'lineage-a' }),
    }));
    expect(result.workspaceId).toBe('workspace-lineage-a-2');
    expect(result.selectedWorkspace).toEqual(selectedWorkspace);
  });

  test('rejects invite emails that target a different workspace than the selected placement', async () => {
    const client = makeClient();

    await expect(onboardBrowserlessWorkspaceMember({
      email: 'member@example.com',
      agentMailApiKey: 'am_us_test',
      replayAuth: jest.fn().mockResolvedValue(makeReplay()),
      analyzeAuthTrace: jest.fn().mockResolvedValue({ report: {}, plan: {} }),
      workspaceClientFactory: jest.fn().mockReturnValue(client),
      selectedWorkspace: {
        workspaceId: 'workspace-lineage-a-2',
        workspaceName: 'Lineage A Two',
        ownerAliasId: 'owner-a',
        lineage: 'lineage-a',
      },
      inviteMember: jest.fn().mockResolvedValue({ id: 'invite-1' }),
      ownerClient: { listUsers: jest.fn().mockResolvedValue({ items: [{ email: 'member@example.com' }] }) },
      pollInviteMessage: jest.fn().mockResolvedValue({
        inviteUrl: 'https://chatgpt.com/auth/login?inv_ws_name=Wrong&inv_email=member%40example.com&wId=workspace-other&accept_wId=workspace-other',
        workspaceId: 'workspace-other',
        acceptWorkspaceId: 'workspace-other',
        inviteEmail: 'member@example.com',
        workspaceName: 'Wrong',
      }),
    })).rejects.toThrow(/selected workspace/i);
  });
});
