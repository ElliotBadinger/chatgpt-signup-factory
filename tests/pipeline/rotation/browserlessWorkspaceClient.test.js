import { describe, test, expect, jest } from '@jest/globals';

import {
  WorkspaceClientError,
  createBrowserlessWorkspaceClient,
  parseWorkspaceInviteLink,
} from '../../../src/pipeline/rotation/browserlessWorkspaceClient.js';

function makeResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] ?? null;
      },
      entries() {
        return Object.entries(headers);
      },
      getSetCookie() {
        return [];
      },
    },
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  };
}

describe('parseWorkspaceInviteLink', () => {
  test('extracts invite params from current ChatGPT Business email format', () => {
    const parsed = parseWorkspaceInviteLink(`
      Root Mail_a has invited you.
      <a href="https://chatgpt.com/auth/login?inv_ws_name=Root-Mail_a&amp;inv_email=crowdedspirit765%40agentmail.to&amp;wId=d3d588b2-8a74-4acc-aa2e-94662ff0e025&amp;accept_wId=d3d588b2-8a74-4acc-aa2e-94662ff0e025">Join workspace</a>
    `);

    expect(parsed).toEqual({
      inviteUrl: 'https://chatgpt.com/auth/login?inv_ws_name=Root-Mail_a&inv_email=crowdedspirit765%40agentmail.to&wId=d3d588b2-8a74-4acc-aa2e-94662ff0e025&accept_wId=d3d588b2-8a74-4acc-aa2e-94662ff0e025',
      workspaceId: 'd3d588b2-8a74-4acc-aa2e-94662ff0e025',
      acceptWorkspaceId: 'd3d588b2-8a74-4acc-aa2e-94662ff0e025',
      inviteEmail: 'crowdedspirit765@agentmail.to',
      workspaceName: 'Root-Mail_a',
    });
  });

  test('throws when no invite link exists', () => {
    expect(() => parseWorkspaceInviteLink('hello world')).toThrow(/invite link/i);
  });
});

describe('createBrowserlessWorkspaceClient', () => {
  test('acceptInvite uses bearer auth and returns success for the live-proven endpoint', async () => {
    const fetchImpl = jest.fn(async (url, options) => {
      expect(url).toBe('https://chatgpt.com/backend-api/accounts/ws-123/invites/accept');
      expect(options.method).toBe('POST');
      expect(options.headers.authorization).toBe('Bearer tok_live');
      expect(options.headers['chatgpt-account-id']).toBe('personal-123');
      expect(options.headers['x-openai-target-path']).toBe('/backend-api/accounts/ws-123/invites/accept');
      expect(JSON.parse(options.body)).toEqual({ email: 'member@example.com' });
      return makeResponse(200, { success: true });
    });

    const client = createBrowserlessWorkspaceClient({
      accessToken: 'tok_live',
      accountId: 'personal-123',
      fetchImpl,
    });

    const result = await client.acceptInvite({
      workspaceId: 'ws-123',
      email: 'member@example.com',
    });

    expect(result).toEqual({
      ok: true,
      status: 200,
      acceptedVia: 'invites-accept',
      body: { success: true },
    });
  });

  test('acceptInvite falls back to joinWorkspace when invites/accept is unavailable', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(makeResponse(404, { detail: 'Not Found' }))
      .mockResolvedValueOnce(makeResponse(200, { success: true }));

    const client = createBrowserlessWorkspaceClient({
      accessToken: 'tok_live',
      accountId: 'personal-123',
      fetchImpl,
    });

    const result = await client.acceptInvite({
      workspaceId: 'ws-123',
      email: 'member@example.com',
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://chatgpt.com/backend-api/accounts/ws-123/join',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.acceptedVia).toBe('join');
  });

  test('workspace-select surfaces auth-step errors separately from ChatGPT join', async () => {
    const fetchImpl = jest.fn(async () => makeResponse(409, {
      error: {
        code: 'invalid_state',
        message: 'Invalid session. Please start over.',
      },
    }));

    const client = createBrowserlessWorkspaceClient({ fetchImpl });

    await expect(client.selectWorkspace({ workspaceId: 'ws-123' })).rejects.toEqual(
      expect.objectContaining({
        name: 'WorkspaceClientError',
        status: 409,
        code: 'invalid_state',
      }),
    );
  });

  test('listUsers can target workspace context with a workspace account id override', async () => {
    const fetchImpl = jest.fn(async (url, options) => {
      expect(url).toBe('https://chatgpt.com/backend-api/accounts/ws-123/users');
      expect(options.headers['chatgpt-account-id']).toBe('ws-123');
      return makeResponse(200, { items: [{ email: 'member@example.com' }] });
    });

    const client = createBrowserlessWorkspaceClient({
      accessToken: 'tok_live',
      accountId: 'personal-123',
      fetchImpl,
    });

    const result = await client.listUsers('ws-123');
    expect(result.items).toEqual([{ email: 'member@example.com' }]);
  });

  test('retries transient network failures before surfacing workspace responses', async () => {
    const fetchImpl = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }))
      .mockResolvedValueOnce(makeResponse(200, { items: [{ id: 'ws-123' }] }));

    const client = createBrowserlessWorkspaceClient({
      accessToken: 'tok_live',
      accountId: 'personal-123',
      fetchImpl,
    });

    const result = await client.getAccounts();
    expect(result.items).toEqual([{ id: 'ws-123' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('throws WorkspaceClientError on deactivated workspace failures', async () => {
    const fetchImpl = jest.fn(async () => makeResponse(401, {
      detail: { message: 'Workspace is deactivated.' },
    }));

    const client = createBrowserlessWorkspaceClient({
      accessToken: 'tok_live',
      accountId: 'ws-123',
      fetchImpl,
    });

    await expect(client.listUsers('ws-123')).rejects.toEqual(
      expect.objectContaining({
        name: 'WorkspaceClientError',
        status: 401,
      }),
    );
  });
});
