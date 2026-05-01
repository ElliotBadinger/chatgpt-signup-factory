import { describe, expect, test } from '@jest/globals';

import { normalizeWorkspaceOwnerRecaptureAuth } from '../../../src/pipeline/rotation/workspaceOwnerRecaptureAuth.js';

describe('normalizeWorkspaceOwnerRecaptureAuth', () => {
  test('normalizes refreshToken sessions into a persisted workspace-owner auth entry', () => {
    const auth = normalizeWorkspaceOwnerRecaptureAuth({
      aliasId: 'workspace-owner-a',
      email: 'owner@example.com',
      session: {
        accessToken: 'access-live',
        refreshToken: 'refresh-live',
        expires: '2026-06-15T03:24:16.088Z',
        user: { email: 'owner@example.com' },
        account: { id: 'workspace-123', planType: 'team' },
      },
      expectedWorkspaceId: 'workspace-123',
      expectedWorkspacePlan: 'team',
    });

    expect(auth).toEqual({
      type: 'oauth',
      access: 'access-live',
      refresh: 'refresh-live',
      expires: new Date('2026-06-15T03:24:16.088Z').getTime(),
      accountId: 'workspace-123',
      email: 'owner@example.com',
      lineage: 'workspace-owner-a',
    });
  });

  test('normalizes refresh_token sessions into a persisted workspace-owner auth entry', () => {
    const auth = normalizeWorkspaceOwnerRecaptureAuth({
      aliasId: 'workspace-owner-a',
      email: 'owner@example.com',
      session: {
        accessToken: 'access-live',
        refresh_token: 'refresh-live',
        expires: '2026-06-15T03:24:16.088Z',
        user: { email: 'owner@example.com' },
        account: { id: 'workspace-123', planType: 'team' },
      },
      expectedWorkspaceId: 'workspace-123',
      expectedWorkspacePlan: 'team',
    });

    expect(auth.refresh).toBe('refresh-live');
    expect(auth.accountId).toBe('workspace-123');
  });

  test('fails closed when refresh token is missing', () => {
    expect(() => normalizeWorkspaceOwnerRecaptureAuth({
      aliasId: 'workspace-owner-a',
      email: 'owner@example.com',
      session: {
        accessToken: 'access-live',
        expires: '2026-06-15T03:24:16.088Z',
        user: { email: 'owner@example.com' },
        account: { id: 'workspace-123', planType: 'team' },
      },
      expectedWorkspaceId: 'workspace-123',
      expectedWorkspacePlan: 'team',
    })).toThrow('workspace-owner-a recapture is missing refresh token; refusing to persist degraded auth');
  });

  test('fails closed when the session account is not the expected workspace account', () => {
    expect(() => normalizeWorkspaceOwnerRecaptureAuth({
      aliasId: 'workspace-owner-a',
      email: 'owner@example.com',
      session: {
        accessToken: 'access-live',
        refreshToken: 'refresh-live',
        expires: '2026-06-15T03:24:16.088Z',
        user: { email: 'owner@example.com' },
        account: { id: 'personal-123', planType: 'team' },
      },
      expectedWorkspaceId: 'workspace-123',
      expectedWorkspacePlan: 'team',
    })).toThrow('workspace-owner-a recapture stayed on account personal-123; expected workspace workspace-123');
  });

  test('fails closed when the session plan does not match the expected workspace plan', () => {
    expect(() => normalizeWorkspaceOwnerRecaptureAuth({
      aliasId: 'workspace-owner-a',
      email: 'owner@example.com',
      session: {
        accessToken: 'access-live',
        refreshToken: 'refresh-live',
        expires: '2026-06-15T03:24:16.088Z',
        user: { email: 'owner@example.com' },
        account: { id: 'workspace-123', planType: 'free' },
      },
      expectedWorkspaceId: 'workspace-123',
      expectedWorkspacePlan: 'team',
    })).toThrow('workspace-owner-a recapture returned plan free; expected workspace plan team');
  });
});