import { describe, test, expect, jest } from '@jest/globals';

import { prepareLiveFixRuntime } from '../../src/cli/pipelineCheckArchiveReplaceLiveFix.js';

describe('prepareLiveFixRuntime partial bootstrap gating', () => {
  test('does not allow rerun when bootstrap creates some capacity but does not fully cover resolved demand', async () => {
    const result = await prepareLiveFixRuntime({
      routerData: {
        aliases: [
          { id: 'aliasA', cloneFrom: 'openai-codex', email: 'aliasA@agentmail.to', disabled: false },
          { id: 'aliasB', cloneFrom: 'openai-codex', email: 'aliasB@agentmail.to', disabled: false },
        ],
        pools: [{ name: 'openai-codex', providers: ['aliasA', 'aliasB'], routes: [] }],
      },
      healthData: {
        providers: {
          aliasA: { status: 'cooldown' },
          aliasB: { status: 'cooldown' },
        },
      },
      poolData: { entries: [{ inboxAddress: 'busy@agentmail.to', status: 'in-use' }] },
      authData: {
        aliasA: { access: 'tok-a', accountId: 'workspace-a' },
        aliasB: { access: 'tok-b', accountId: 'workspace-b' },
      },
      registry: {
        workspaces: [
          { workspaceId: 'workspace-a', workspaceName: 'Workspace A', lineage: 'lineage-a', ownerAliasId: 'owner-a', ownerEmail: 'owner-a@example.com', healthyAccounts: 3, currentMembers: 2, maxMembers: 8 },
          { workspaceId: 'workspace-b', workspaceName: 'Workspace B', lineage: 'lineage-b', ownerAliasId: 'owner-b', ownerEmail: 'owner-b@example.com', healthyAccounts: 2, currentMembers: 2, maxMembers: 8 },
        ],
      },
      bootstrapLineage: jest.fn().mockResolvedValue({
        ok: true,
        createdEntries: [{ inboxAddress: 'fresh@agentmail.to', workspaceGroupKey: 'lineage-a' }],
      }),
      bootstrapCapacity: jest.fn().mockResolvedValue({
        ok: false,
        triggered: true,
        createdEntries: [{ inboxAddress: 'fresh@agentmail.to', workspaceGroupKey: 'lineage-a' }],
        createdCapacity: 1,
        remainingDemand: 1,
        blockerReason: 'insufficient-capacity-after-bootstrap',
      }),
    });

    expect(result.usableCapacityBeforeBootstrap).toBe(0);
    expect(result.usableCapacityAfterBootstrap).toBe(1);
    expect(result.bootstrapResult).toEqual(expect.objectContaining({
      ok: false,
      remainingDemand: 1,
    }));
    expect(result.canProceed).toBe(false);
  });
});
