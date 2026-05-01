import { describe, test, expect, jest } from '@jest/globals';

import { WorkspaceClientError } from '../../../src/pipeline/rotation/browserlessWorkspaceClient.js';
import { preRemoveExhaustedMembers } from '../../../src/pipeline/rotation/preRemoveWorkspaceMembers.js';

describe('preRemoveExhaustedMembers', () => {
  test('resolves workspace per alias lineage and removes from the matching workspace only', async () => {
    const resolveWorkspace = jest.fn(async (alias) => ({
      workspaceId: alias.lineage === 'lineage-a' ? 'workspace-a' : 'workspace-b',
      ownerAliasId: alias.lineage === 'lineage-a' ? 'owner-a' : 'owner-b',
    }));
    const teamDriver = {
      listUsers: jest.fn(async (workspaceId) => ({
        items: workspaceId === 'workspace-a'
          ? [{ id: 'u-a', email: 'aliasA@agentmail.to' }]
          : [{ id: 'u-b', email: 'aliasB@agentmail.to' }],
      })),
      removeTeamMember: jest.fn().mockResolvedValue({ ok: true }),
    };

    const result = await preRemoveExhaustedMembers({
      exhaustedAliases: [
        { aliasId: 'aliasA', email: 'aliasA@agentmail.to', lineage: 'lineage-a' },
        { aliasId: 'aliasB', email: 'aliasB@agentmail.to', lineage: 'lineage-b' },
      ],
      resolveWorkspace,
      teamDriver,
    });

    expect(teamDriver.listUsers).toHaveBeenCalledWith('workspace-a', expect.any(Object));
    expect(teamDriver.listUsers).toHaveBeenCalledWith('workspace-b', expect.any(Object));
    expect(teamDriver.removeTeamMember).toHaveBeenCalledWith('aliasA@agentmail.to', expect.objectContaining({ workspace: expect.objectContaining({ workspaceId: 'workspace-a' }) }));
    expect(teamDriver.removeTeamMember).toHaveBeenCalledWith('aliasB@agentmail.to', expect.objectContaining({ workspace: expect.objectContaining({ workspaceId: 'workspace-b' }) }));
    expect(result.removed).toHaveLength(2);
  });

  test('skips aliases whose workspace cannot be resolved instead of mutating a global default workspace', async () => {
    const resolveWorkspace = jest.fn(async (alias) => {
      if (alias.aliasId === 'aliasSkip') throw new Error('unresolved');
      return { workspaceId: 'workspace-a', ownerAliasId: 'owner-a' };
    });
    const teamDriver = {
      listUsers: jest.fn(async () => ({ items: [{ id: 'u-a', email: 'aliasA@agentmail.to' }] })),
      removeTeamMember: jest.fn().mockResolvedValue({ ok: true }),
    };

    const result = await preRemoveExhaustedMembers({
      exhaustedAliases: [
        { aliasId: 'aliasA', email: 'aliasA@agentmail.to', lineage: 'lineage-a' },
        { aliasId: 'aliasSkip', email: 'aliasSkip@agentmail.to', lineage: 'lineage-x' },
      ],
      resolveWorkspace,
      teamDriver,
    });

    expect(teamDriver.removeTeamMember).toHaveBeenCalledTimes(1);
    expect(result.skipped).toContainEqual(expect.objectContaining({ aliasId: 'aliasSkip', reason: 'workspace-unresolved' }));
  });

  test('skips all aliases in a workspace when listUsers reports the workspace is deactivated', async () => {
    const resolveWorkspace = jest.fn(async () => ({ workspaceId: 'workspace-dead', workspaceName: 'Dead Workspace', ownerAliasId: 'owner-dead' }));
    const teamDriver = {
      listUsers: jest.fn(async () => {
        throw new WorkspaceClientError('Workspace is deactivated.', {
          status: 401,
          body: { detail: 'Workspace is deactivated.' },
        });
      }),
      removeTeamMember: jest.fn(),
    };

    const result = await preRemoveExhaustedMembers({
      exhaustedAliases: [
        { aliasId: 'aliasA', email: 'aliasA@agentmail.to' },
        { aliasId: 'aliasB', email: 'aliasB@agentmail.to' },
      ],
      resolveWorkspace,
      teamDriver,
    });

    expect(teamDriver.removeTeamMember).not.toHaveBeenCalled();
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ aliasId: 'aliasA', reason: 'workspace-deactivated', phase: 'listUsers', workspaceId: 'workspace-dead' }),
      expect.objectContaining({ aliasId: 'aliasB', reason: 'workspace-deactivated', phase: 'listUsers', workspaceId: 'workspace-dead' }),
    ]));
  });

  test('skips remaining aliases in a workspace when removeTeamMember reports the workspace is deactivated', async () => {
    const resolveWorkspace = jest.fn(async () => ({ workspaceId: 'workspace-dead', workspaceName: 'Dead Workspace', ownerAliasId: 'owner-dead' }));
    const teamDriver = {
      listUsers: jest.fn(async () => ({
        items: [
          { id: 'u-a', email: 'aliasA@agentmail.to' },
          { id: 'u-b', email: 'aliasB@agentmail.to' },
        ],
      })),
      removeTeamMember: jest.fn(async () => {
        throw new WorkspaceClientError('Workspace is deactivated.', {
          status: 401,
          body: { detail: 'Workspace is deactivated.' },
        });
      }),
    };

    const result = await preRemoveExhaustedMembers({
      exhaustedAliases: [
        { aliasId: 'aliasA', email: 'aliasA@agentmail.to' },
        { aliasId: 'aliasB', email: 'aliasB@agentmail.to' },
      ],
      resolveWorkspace,
      teamDriver,
    });

    expect(teamDriver.removeTeamMember).toHaveBeenCalledTimes(1);
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ aliasId: 'aliasA', reason: 'workspace-deactivated', phase: 'removeTeamMember', workspaceId: 'workspace-dead' }),
      expect.objectContaining({ aliasId: 'aliasB', reason: 'workspace-deactivated', phase: 'removeTeamMember', workspaceId: 'workspace-dead' }),
    ]));
  });

  test('skips owner aliases from listUsers metadata before mutation and continues to removable members', async () => {
    const resolveWorkspace = jest.fn(async () => ({ workspaceId: 'workspace-a', workspaceName: 'Workspace A', ownerAliasId: 'owner-a' }));
    const teamDriver = {
      listUsers: jest.fn(async () => ({
        items: [
          { id: 'u-owner', email: 'owner@agentmail.to', role: 'account-owner' },
          { id: 'u-member', email: 'member@agentmail.to', role: 'standard-user' },
        ],
      })),
      removeTeamMember: jest.fn().mockResolvedValue({ ok: true }),
    };

    const result = await preRemoveExhaustedMembers({
      exhaustedAliases: [
        { aliasId: 'ownerAlias', email: 'owner@agentmail.to' },
        { aliasId: 'memberAlias', email: 'member@agentmail.to' },
      ],
      resolveWorkspace,
      teamDriver,
    });

    expect(teamDriver.removeTeamMember).toHaveBeenCalledTimes(1);
    expect(teamDriver.removeTeamMember).toHaveBeenCalledWith('member@agentmail.to', expect.any(Object));
    expect(result.skipped).toContainEqual(expect.objectContaining({
      aliasId: 'ownerAlias',
      email: 'owner@agentmail.to',
      reason: 'last-owner-protected',
      phase: 'listUsers',
      role: 'account-owner',
      ownerCount: 1,
    }));
    expect(result.removed).toEqual([
      expect.objectContaining({ aliasId: 'memberAlias', email: 'member@agentmail.to', workspaceId: 'workspace-a', userId: 'u-member' }),
    ]);
  });

  test('skips current alias when removeTeamMember reveals a last-owner guard and continues to later aliases', async () => {
    const resolveWorkspace = jest.fn(async () => ({ workspaceId: 'workspace-a', workspaceName: 'Workspace A', ownerAliasId: 'owner-a' }));
    const teamDriver = {
      listUsers: jest.fn(async () => ({
        items: [
          { id: 'u-owner', email: 'owner@agentmail.to', role: null },
          { id: 'u-member', email: 'member@agentmail.to', role: 'standard-user' },
        ],
      })),
      removeTeamMember: jest.fn(async (email) => {
        if (email === 'owner@agentmail.to') {
          throw new WorkspaceClientError('Cannot remove the last owner from a workspace', {
            status: 400,
            body: { detail: 'Cannot remove the last owner from a workspace' },
          });
        }
        return { ok: true };
      }),
    };

    const result = await preRemoveExhaustedMembers({
      exhaustedAliases: [
        { aliasId: 'ownerAlias', email: 'owner@agentmail.to' },
        { aliasId: 'memberAlias', email: 'member@agentmail.to' },
      ],
      resolveWorkspace,
      teamDriver,
    });

    expect(teamDriver.removeTeamMember).toHaveBeenCalledTimes(2);
    expect(result.skipped).toContainEqual(expect.objectContaining({
      aliasId: 'ownerAlias',
      email: 'owner@agentmail.to',
      reason: 'last-owner-protected',
      phase: 'removeTeamMember',
      error: 'Cannot remove the last owner from a workspace',
    }));
    expect(result.removed).toEqual([
      expect.objectContaining({ aliasId: 'memberAlias', email: 'member@agentmail.to', workspaceId: 'workspace-a', userId: 'u-member' }),
    ]);
  });
});
