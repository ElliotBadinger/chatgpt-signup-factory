import { describe, test, expect, jest } from '@jest/globals';

import { bootstrapRuntimeCapacity } from '../../../src/pipeline/rotation/bootstrapRuntimeCapacity.js';

function makeWorkspace(overrides = {}) {
  return {
    workspaceId: 'workspace-a',
    workspaceName: 'Workspace A',
    lineage: 'lineage-a',
    ownerAliasId: 'owner-a',
    ownerEmail: 'owner-a@example.com',
    healthyAccounts: 2,
    currentMembers: 4,
    maxMembers: 8,
    ...overrides,
  };
}

describe('bootstrapRuntimeCapacity', () => {
  test('global usable capacity zero triggers bootstrap and known owners are ranked by viability', async () => {
    const bootstrapLineage = jest.fn(async ({ lineage }) => ({
      ok: true,
      createdEntries: [{ inboxAddress: `${lineage}-1@agentmail.to`, workspaceGroupKey: lineage }],
    }));

    const result = await bootstrapRuntimeCapacity({
      pool: { entries: [{ inboxAddress: 'used@agentmail.to', status: 'in-use' }] },
      exhaustedDemand: 1,
      registry: {
        workspaces: [
          makeWorkspace({ workspaceId: 'workspace-a', lineage: 'lineage-a', ownerAliasId: 'owner-a', healthyAccounts: 1, currentMembers: 6 }),
          makeWorkspace({ workspaceId: 'workspace-b', lineage: 'lineage-b', ownerAliasId: 'owner-b', healthyAccounts: 4, currentMembers: 2 }),
        ],
      },
      bootstrapLineage,
    });

    expect(bootstrapLineage).toHaveBeenCalledWith(expect.objectContaining({
      lineage: 'lineage-b',
      ownerAliasId: 'owner-b',
    }));
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      triggered: true,
      initialUsableCapacity: 0,
      createdCapacity: 1,
      remainingDemand: 0,
    }));
  });

  test('bootstrap continues until exhausted demand is covered', async () => {
    const bootstrapLineage = jest.fn()
      .mockResolvedValueOnce({ ok: true, createdEntries: [{ inboxAddress: 'a1@agentmail.to', workspaceGroupKey: 'lineage-a' }] })
      .mockResolvedValueOnce({ ok: true, createdEntries: [{ inboxAddress: 'b1@agentmail.to', workspaceGroupKey: 'lineage-b' }] });

    const result = await bootstrapRuntimeCapacity({
      pool: { entries: [] },
      exhaustedDemand: 2,
      registry: {
        workspaces: [
          makeWorkspace({ workspaceId: 'workspace-a', lineage: 'lineage-a', ownerAliasId: 'owner-a', healthyAccounts: 3, currentMembers: 4 }),
          makeWorkspace({ workspaceId: 'workspace-b', lineage: 'lineage-b', ownerAliasId: 'owner-b', healthyAccounts: 2, currentMembers: 2 }),
        ],
      },
      bootstrapLineage,
    });

    expect(bootstrapLineage).toHaveBeenCalledTimes(2);
    expect(result.createdEntries.map((entry) => entry.inboxAddress)).toEqual(['a1@agentmail.to', 'b1@agentmail.to']);
    expect(result.remainingDemand).toBe(0);
  });

  test('partial bootstrap failure returns an explicit blocker result', async () => {
    const bootstrapLineage = jest.fn()
      .mockResolvedValueOnce({ ok: true, createdEntries: [{ inboxAddress: 'a1@agentmail.to', workspaceGroupKey: 'lineage-a' }] })
      .mockResolvedValueOnce({ ok: false, reason: 'owner-auth-expired' });

    const result = await bootstrapRuntimeCapacity({
      pool: { entries: [] },
      exhaustedDemand: 3,
      registry: {
        workspaces: [
          makeWorkspace({ workspaceId: 'workspace-a', lineage: 'lineage-a', ownerAliasId: 'owner-a', healthyAccounts: 3, currentMembers: 4 }),
          makeWorkspace({ workspaceId: 'workspace-b', lineage: 'lineage-b', ownerAliasId: 'owner-b', healthyAccounts: 2, currentMembers: 2 }),
        ],
      },
      bootstrapLineage,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      triggered: true,
      blockerReason: 'insufficient-capacity-after-bootstrap',
      remainingDemand: 2,
    }));
    expect(result.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ lineage: 'lineage-a', ok: true }),
      expect.objectContaining({ lineage: 'lineage-b', ok: false, reason: 'owner-auth-expired' }),
    ]));
  });

  test('partial existing capacity still bootstraps until total usable capacity covers demand', async () => {
    const bootstrapLineage = jest.fn().mockResolvedValue({
      ok: true,
      createdEntries: [{ inboxAddress: 'fresh@agentmail.to', workspaceGroupKey: 'lineage-a' }],
    });

    const result = await bootstrapRuntimeCapacity({
      pool: { entries: [{ inboxAddress: 'existing@agentmail.to', status: 'available' }] },
      exhaustedDemand: 2,
      registry: {
        workspaces: [
          makeWorkspace({ workspaceId: 'workspace-a', lineage: 'lineage-a', ownerAliasId: 'owner-a', healthyAccounts: 3, currentMembers: 4 }),
        ],
      },
      bootstrapLineage,
    });

    expect(bootstrapLineage).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      triggered: true,
      initialUsableCapacity: 1,
      createdCapacity: 1,
      remainingDemand: 0,
    }));
  });

  test('restricts bootstrap attempts to actionable preferred lineages when provided', async () => {
    const bootstrapLineage = jest.fn().mockResolvedValue({
      ok: true,
      createdEntries: [{ inboxAddress: 'fresh@agentmail.to', workspaceGroupKey: 'workspace-owner-a' }],
    });

    const result = await bootstrapRuntimeCapacity({
      pool: { entries: [] },
      exhaustedDemand: 1,
      preferredLineages: ['workspace-owner-a'],
      registry: {
        workspaces: [
          makeWorkspace({ workspaceId: 'workspace-greasy', lineage: 'greasyhands', ownerAliasId: 'greasyhands', ownerEmail: null, currentMembers: 2, maxMembers: 8 }),
          makeWorkspace({ workspaceId: 'workspace-root', lineage: 'workspace-owner-a', ownerAliasId: 'workspace-owner-a', ownerEmail: 'root@example.com', currentMembers: 5, maxMembers: 8 }),
        ],
      },
      bootstrapLineage,
    });

    expect(bootstrapLineage).toHaveBeenCalledTimes(1);
    expect(bootstrapLineage).toHaveBeenCalledWith(expect.objectContaining({
      lineage: 'workspace-owner-a',
      ownerAliasId: 'workspace-owner-a',
      ownerEmail: 'root@example.com',
    }));
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      createdCapacity: 1,
      remainingDemand: 0,
    }));
  });

  test('prefers cached usable supply roots and returns registry updates from successful escalation', async () => {
    const bootstrapLineage = jest.fn().mockResolvedValue({
      ok: true,
      reason: 'bootstrap-escalated-new-root',
      createdEntries: [{ inboxAddress: 'fresh@agentmail.to', workspaceGroupKey: 'workspace-owner-a' }],
      registryUpdates: {
        usableSupplyRoots: [{
          rootEmail: 'fresh-root@example.com',
          ownerAliasId: 'workspace-owner-a',
          lineage: 'workspace-owner-a',
          workspaceId: 'workspace-root',
          workspaceName: 'Workspace Root',
        }],
      },
    });

    const result = await bootstrapRuntimeCapacity({
      pool: { entries: [] },
      exhaustedDemand: 1,
      preferredLineages: ['workspace-owner-a'],
      registry: {
        usableSupplyRoots: [{
          rootEmail: 'cached-root@example.com',
          ownerAliasId: 'workspace-owner-a',
          lineage: 'workspace-owner-a',
          workspaceId: 'workspace-root',
          workspaceName: 'Workspace Root',
        }],
        workspaces: [
          makeWorkspace({ workspaceId: 'workspace-root', lineage: 'workspace-owner-a', ownerAliasId: 'workspace-owner-a', ownerEmail: 'owner-root@example.com', currentMembers: 5, maxMembers: 8 }),
        ],
      },
      bootstrapLineage,
    });

    expect(bootstrapLineage).toHaveBeenCalledWith(expect.objectContaining({
      ownerEmail: 'cached-root@example.com',
      candidateType: 'supply-root',
    }));
    expect(result.registryUpdates).toEqual({
      usableSupplyRoots: [expect.objectContaining({ rootEmail: 'fresh-root@example.com' })],
    });
  });
});
