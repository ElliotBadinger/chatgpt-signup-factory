import { describe, expect, test, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildWorkspaceSignupTargets,
  loadSignupRecords,
  provisionWorkspaceAliases,
  saveSignupRecords,
  verifyAccount,
} from '../../src/agentmail/agentWorkspaceSignup.js';

describe('agentWorkspaceSignup', () => {
  test('buildWorkspaceSignupTargets derives workspace-owner targets and excludes workspace-owner-b', () => {
    const targets = buildWorkspaceSignupTargets({
      registry: {
        ownerCandidates: [
          { ownerAliasId: 'workspace-owner-a', ownerEmail: 'owner-a@epistemophile.space', ownerAccountId: 'ws-a', lineage: 'workspace-owner-a' },
          { ownerAliasId: 'workspace-owner-b', ownerEmail: 'owner-b@agentmail.to', ownerAccountId: 'ws-b', lineage: 'workspace-owner-b' },
        ],
        workspaces: [
          { workspaceId: 'ws-a', workspaceName: 'Root-Mail_a', ownerAliasId: 'workspace-owner-a', ownerEmail: 'owner-a@epistemophile.space', lineage: 'workspace-owner-a' },
          { workspaceId: 'ws-b', workspaceName: 'Agentmail_nasty', ownerAliasId: 'workspace-owner-b', ownerEmail: 'owner-b@agentmail.to', lineage: 'workspace-owner-b' },
        ],
      },
      env: {},
      now: () => 1774757072000,
    });

    expect(targets).toEqual([
      expect.objectContaining({
        workspaceAlias: 'workspace-owner-a',
        workspaceKey: 'a',
        workspaceId: 'ws-a',
        workspaceName: 'Root-Mail_a',
        routingDomain: 'epistemophile.space',
        humanEmail: 'agentmailroota1774757072000@epistemophile.space',
        username: 'agentmailroota1774757072000',
      }),
      expect.objectContaining({
        workspaceAlias: 'workspace-owner-c',
        workspaceKey: 'c',
        routingDomain: 'epistemophile.store',
        humanEmail: 'agentmailrootc1774757072000@epistemophile.store',
        username: 'agentmailrootc1774757072000',
      }),
    ]);
  });

  test('provisionWorkspaceAliases is idempotent per workspace alias and persists new rows', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmail-workspace-signup-'));
    const csvPath = path.join(tmpDir, 'agentmail_accounts.csv');
    saveSignupRecords(csvPath, [
      {
        workspaceAlias: 'workspace-owner-a',
        workspaceKey: 'a',
        workspaceId: 'ws-a',
        workspaceName: 'Root-Mail_a',
        ownerEmail: 'owner-a@epistemophile.space',
        routingDomain: 'epistemophile.space',
        humanEmail: 'existing-a@epistemophile.space',
        username: 'existing-a',
        organizationId: 'org-a',
        inboxId: 'inbox-a@agentmail.to',
        apiKey: 'am_us_existing_a',
        verifyStatus: 'PENDING_OTP',
        createdAt: '2026-03-29T00:00:00.000Z',
        updatedAt: '2026-03-29T00:00:00.000Z',
      },
    ]);

    const fetchImpl = jest.fn(async (url, init = {}) => {
      if (!String(url).endsWith('/v0/agent/sign-up')) {
        throw new Error(`Unexpected URL: ${url}`);
      }
      const body = JSON.parse(init.body);
      expect(body.human_email).toBe('agentmailrootc1774757072000@epistemophile.store');
      expect(body.username).toBe('agentmailrootc1774757072000');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          organization_id: 'org-c',
          inbox_id: 'inbox-c@agentmail.to',
          api_key: 'am_us_created_c',
        }),
        text: async () => '',
      };
    });

    const result = await provisionWorkspaceAliases({
      registry: {
        ownerCandidates: [
          { ownerAliasId: 'workspace-owner-a', ownerEmail: 'owner-a@epistemophile.space', ownerAccountId: 'ws-a', lineage: 'workspace-owner-a' },
        ],
        workspaces: [
          { workspaceId: 'ws-a', workspaceName: 'Root-Mail_a', ownerAliasId: 'workspace-owner-a', ownerEmail: 'owner-a@epistemophile.space', lineage: 'workspace-owner-a' },
        ],
      },
      csvPath,
      fetchImpl,
      now: () => 1774757072000,
      env: {},
      log: () => {},
    });

    expect(result.created).toHaveLength(1);
    expect(result.skipped).toEqual([
      expect.objectContaining({ workspaceAlias: 'workspace-owner-a', reason: 'already-exists' }),
    ]);

    const saved = loadSignupRecords(csvPath);
    expect(saved).toHaveLength(2);
    expect(saved).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspaceAlias: 'workspace-owner-a', apiKey: 'am_us_existing_a' }),
      expect.objectContaining({
        workspaceAlias: 'workspace-owner-c',
        apiKey: 'am_us_created_c',
        verifyStatus: 'PENDING_OTP',
        organizationId: 'org-c',
        inboxId: 'inbox-c@agentmail.to',
      }),
    ]));
  });

  test('verifyAccount posts otp_code with bearer auth', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ authentication_type: 'agent_verified' }),
      text: async () => '',
    }));

    const result = await verifyAccount('am_us_verify_me', '123456', { fetchImpl });

    expect(result).toEqual({ authentication_type: 'agent_verified' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.agentmail.to/v0/agent/verify',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer am_us_verify_me',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ otp_code: '123456' }),
      }),
    );
  });
});
