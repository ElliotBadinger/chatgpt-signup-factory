import { describe, expect, jest, test } from '@jest/globals';

import {
  buildCodexLbLocalImportAuthJson,
  createCodexLbLocalImportClient,
} from '../../../src/pipeline/rotation/codexLbLocalImportClient.js';

function decodeJwtPayload(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length < 2) return null;
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

describe('buildCodexLbLocalImportAuthJson', () => {
  test('uses current onboarded owned OAuth token material when available', () => {
    const authJson = buildCodexLbLocalImportAuthJson({
      email: 'member@example.com',
      workspaceId: 'workspace-123',
      auth: {
        access: 'access-live',
        refresh: 'refresh-live',
        accountId: 'workspace-123',
      },
      onboarded: {
        identityEmail: 'member@example.com',
        ownedOAuth: {
          idToken: 'header.eyJlbWFpbCI6Im1lbWJlckBleGFtcGxlLmNvbSIsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X3BsYW5fdHlwZSI6InRlYW0ifX0.sig',
          planType: 'team',
        },
      },
    });

    expect(authJson).toEqual({
      tokens: {
        idToken: 'header.eyJlbWFpbCI6Im1lbWJlckBleGFtcGxlLmNvbSIsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X3BsYW5fdHlwZSI6InRlYW0ifX0.sig',
        accessToken: 'access-live',
        refreshToken: 'refresh-live',
        accountId: 'workspace-123',
      },
    });
  });

  test('synthesizes a narrow idToken when only Pi auth and workspace context are available', () => {
    const authJson = buildCodexLbLocalImportAuthJson({
      email: 'member@example.com',
      workspaceId: 'workspace-123',
      auth: {
        access: 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9wbGFuX3R5cGUiOiJ0ZWFtIn19.sig',
        refresh: 'refresh-live',
        expires: 1_775_001_379_354,
        accountId: 'workspace-123',
      },
      onboarded: null,
    });

    expect(authJson.tokens.accessToken).toBe('header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9wbGFuX3R5cGUiOiJ0ZWFtIn19.sig');
    expect(authJson.tokens.refreshToken).toBe('refresh-live');
    expect(authJson.tokens.accountId).toBe('workspace-123');

    const claims = decodeJwtPayload(authJson.tokens.idToken);
    expect(claims).toEqual(expect.objectContaining({
      email: 'member@example.com',
      chatgpt_account_id: 'workspace-123',
      'https://api.openai.com/auth': expect.objectContaining({
        chatgpt_account_id: 'workspace-123',
        chatgpt_plan_type: 'team',
      }),
      exp: Math.floor(1_775_001_379_354 / 1000),
    }));
  });
});

describe('createCodexLbLocalImportClient', () => {
  test('treats dashboard session auth as optional and omits the cookie header when not configured', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        accountId: 'workspace-123_abcdef12',
        email: 'member@example.com',
        planType: 'team',
      }),
    });
    const client = createCodexLbLocalImportClient({
      baseUrl: 'http://127.0.0.1:2455',
      fetchImpl,
    });

    expect(client.getStatus()).toEqual(expect.objectContaining({
      ready: true,
      reason: null,
      importMode: 'codex-lb-local',
    }));

    await expect(client.importAccount({
      email: 'member@example.com',
      aliasId: 'member',
      workspaceId: 'workspace-123',
      auth: {
        access: 'access-live',
        refresh: 'refresh-live',
        accountId: 'workspace-123',
      },
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      accountId: 'workspace-123_abcdef12',
    }));

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:2455/api/accounts/import',
      expect.objectContaining({
        method: 'POST',
        headers: expect.not.objectContaining({
          cookie: expect.anything(),
        }),
      }),
    );
  });

  test('posts auth_json multipart payload and forwards dashboard session cookie when configured', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        accountId: 'workspace-123_abcdef12',
        email: 'member@example.com',
        planType: 'team',
      }),
    });
    const client = createCodexLbLocalImportClient({
      baseUrl: 'http://127.0.0.1:8080',
      dashboardSession: 'sess_123',
      fetchImpl,
    });

    const result = await client.importAccount({
      email: 'member@example.com',
      aliasId: 'member',
      workspaceId: 'workspace-123',
      auth: {
        access: 'access-live',
        refresh: 'refresh-live',
        accountId: 'workspace-123',
      },
      onboarded: {
        identityEmail: 'member@example.com',
        ownedOAuth: {
          idToken: 'header.eyJlbWFpbCI6Im1lbWJlckBleGFtcGxlLmNvbSJ9.sig',
        },
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      accountId: 'workspace-123_abcdef12',
      email: 'member@example.com',
      planType: 'team',
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8080/api/accounts/import');
    expect(options).toEqual(expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        cookie: 'codex_lb_dashboard_session=sess_123',
      }),
    }));
    expect(options.body).toBeInstanceOf(FormData);

    const authJsonFile = options.body.get('auth_json');
    expect(authJsonFile).toBeTruthy();
    expect(JSON.parse(await authJsonFile.text())).toEqual({
      tokens: {
        idToken: 'header.eyJlbWFpbCI6Im1lbWJlckBleGFtcGxlLmNvbSJ9.sig',
        accessToken: 'access-live',
        refreshToken: 'refresh-live',
        accountId: 'workspace-123',
      },
    });
  });

  test('provides rollback-compatible clear/archive operations via account deletion', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          accountId: 'workspace-123_abcdef12',
          email: 'member@example.com',
          planType: 'team',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'deleted' }),
        text: async () => '',
      });

    const client = createCodexLbLocalImportClient({
      baseUrl: 'http://127.0.0.1:8080',
      dashboardSession: 'sess_123',
      fetchImpl,
    });

    await client.importAccount({
      email: 'member@example.com',
      aliasId: 'member',
      workspaceId: 'workspace-123',
      auth: {
        access: 'access-live',
        refresh: 'refresh-live',
        accountId: 'workspace-123',
      },
      onboarded: {
        identityEmail: 'member@example.com',
        ownedOAuth: {
          idToken: 'header.eyJlbWFpbCI6Im1lbWJlckBleGFtcGxlLmNvbSJ9.sig',
        },
      },
    });

    await expect(client.clearActiveLifecycle({
      email: 'member@example.com',
      workspaceId: 'workspace-123',
      lifecycleState: 'archived',
    })).resolves.toEqual({
      ok: true,
      deleted: true,
      accountId: 'workspace-123_abcdef12',
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:8080/api/accounts/workspace-123_abcdef12',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          cookie: 'codex_lb_dashboard_session=sess_123',
        }),
      }),
    );
  });

  test('deletes a resolvable malformed legacy row and retries import once after a 500 merge failure', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ error: { message: 'merge-by-email failed on malformed existing row' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ status: 'deleted' }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          accountId: 'workspace-123_5e3088f4',
          email: 'enchantinglist306@agentmail.to',
          planType: 'team',
        }),
      });

    const client = createCodexLbLocalImportClient({
      baseUrl: 'http://127.0.0.1:2455',
      fetchImpl,
    });

    await expect(client.importAccount({
      email: 'enchantinglist306@agentmail.to',
      aliasId: 'enchantinglist306',
      workspaceId: 'workspace-123',
      auth: {
        access: 'access-live',
        refresh: 'refresh-live',
        accountId: 'workspace-123',
      },
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      accountId: 'workspace-123_5e3088f4',
      email: 'enchantinglist306@agentmail.to',
    }));

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:2455/api/accounts/workspace-123_5e3088f4',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test('fails with explicit remediation-needed metadata when malformed-row auto-delete cannot be completed and retry still fails', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ error: { message: 'merge-by-email failed on malformed existing row' } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ error: { message: 'account not found' } }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ accounts: [] }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ error: { message: 'merge-by-email still failing' } }),
      });

    const client = createCodexLbLocalImportClient({
      baseUrl: 'http://127.0.0.1:2455',
      fetchImpl,
    });

    await expect(client.importAccount({
      email: 'enchantinglist306@agentmail.to',
      aliasId: 'enchantinglist306',
      workspaceId: 'workspace-123',
      auth: {
        access: 'access-live',
        refresh: 'refresh-live',
        accountId: 'workspace-123',
      },
    })).rejects.toThrow(
      "codex-lb-local import remediation-needed: malformed existing row may persist for accountId='workspace-123_5e3088f4'; auto-delete returned 404 and retry failed with status 500: merge-by-email still failing",
    );
  });

  test('retries import once when synthesized remediation lookup returns 5xx', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ error: { message: 'merge-by-email failed on malformed existing row' } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ error: { message: 'account not found' } }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ error: { message: 'temporary upstream failure' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          accountId: 'workspace-123_5e3088f4',
          email: 'enchantinglist306@agentmail.to',
          planType: 'team',
        }),
      });

    const client = createCodexLbLocalImportClient({
      baseUrl: 'http://127.0.0.1:2455',
      fetchImpl,
    });

    await expect(client.importAccount({
      email: 'enchantinglist306@agentmail.to',
      aliasId: 'enchantinglist306',
      workspaceId: 'workspace-123',
      auth: {
        access: 'access-live',
        refresh: 'refresh-live',
        accountId: 'workspace-123',
      },
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      accountId: 'workspace-123_5e3088f4',
      email: 'enchantinglist306@agentmail.to',
    }));

    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:2455/api/accounts',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      4,
      'http://127.0.0.1:2455/api/accounts/import',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('does not delete a unique active mismatched email row when synthesized remediation delete returns 404', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ error: { message: 'merge-by-email failed on malformed existing row' } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ error: { message: 'account not found' } }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          accounts: [{
            accountId: 'expensiveprogress582',
            email: 'enchantinglist306@agentmail.to',
            status: 'active',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          accountId: 'workspace-123_5e3088f4',
          email: 'enchantinglist306@agentmail.to',
          planType: 'team',
        }),
      });

    const client = createCodexLbLocalImportClient({
      baseUrl: 'http://127.0.0.1:2455',
      fetchImpl,
    });

    await expect(client.importAccount({
      email: 'enchantinglist306@agentmail.to',
      aliasId: 'enchantinglist306',
      workspaceId: 'workspace-123',
      auth: {
        access: 'access-live',
        refresh: 'refresh-live',
        accountId: 'workspace-123',
      },
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      accountId: 'workspace-123_5e3088f4',
      email: 'enchantinglist306@agentmail.to',
    }));

    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:2455/api/accounts',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      4,
      'http://127.0.0.1:2455/api/accounts/import',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});