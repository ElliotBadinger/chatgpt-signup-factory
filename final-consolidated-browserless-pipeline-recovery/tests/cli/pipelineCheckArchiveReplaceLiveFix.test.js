import { describe, test, expect, jest } from '@jest/globals';

import { prepareLiveFixRuntime, collectFailedWorkspaceCleanupCandidates } from '../../src/cli/pipelineCheckArchiveReplaceLiveFix.js';

describe('collectFailedWorkspaceCleanupCandidates', () => {
  test('collects failed or chatgpt-used workspace occupants for the active actionable lineage while leaving active router aliases alone', () => {
    const result = collectFailedWorkspaceCleanupCandidates({
      poolEntries: [
        {
          inboxAddress: 'failed-a@agentmail.to',
          status: 'failed',
          lineage: 'lineage-a',
          workspaceId: 'workspace-a',
          workspaceName: 'Workspace A',
          rootEmail: 'root-a@example.com',
          rootOrgId: 'workspace-a',
          ownerAliasId: 'owner-a',
        },
        {
          inboxAddress: 'chatgpt-used-a@agentmail.to',
          status: 'chatgpt-used',
          workspaceGroupKey: 'lineage-a',
          rootOrgId: 'workspace-a',
        },
        {
          inboxAddress: 'other-lineage@agentmail.to',
          status: 'failed',
          lineage: 'lineage-b',
          rootOrgId: 'workspace-b',
        },
        {
          inboxAddress: 'active-router@agentmail.to',
          status: 'failed',
          lineage: 'lineage-a',
          rootOrgId: 'workspace-a',
        },
      ],
      routerAliases: [
        { id: 'active-router', email: 'active-router@agentmail.to' },
      ],
      allowedLineages: ['lineage-a'],
    });

    expect(result).toEqual([
      expect.objectContaining({
        email: 'failed-a@agentmail.to',
        lineage: 'lineage-a',
        workspaceId: 'workspace-a',
        placementContext: expect.objectContaining({ rootEmail: 'root-a@example.com' }),
      }),
      expect.objectContaining({
        email: 'chatgpt-used-a@agentmail.to',
        lineage: 'lineage-a',
        workspaceId: 'workspace-a',
      }),
    ]);
  });
});

describe('prepareLiveFixRuntime', () => {
  test('unresolved aliases are skipped explicitly and resolved aliases get placement context', async () => {
    const result = await prepareLiveFixRuntime({
      routerData: {
        aliases: [
          { id: 'aliasResolved', cloneFrom: 'openai-codex', email: 'resolved@agentmail.to', disabled: false },
          { id: 'aliasSkipped', cloneFrom: 'openai-codex', email: 'skipped@agentmail.to', disabled: false },
        ],
        pools: [{ name: 'openai-codex', providers: ['aliasResolved', 'aliasSkipped'], routes: [] }],
      },
      healthData: {
        providers: {
          aliasResolved: { status: 'cooldown' },
          aliasSkipped: { status: 'cooldown' },
        },
      },
      poolData: { entries: [{ inboxAddress: 'available@agentmail.to', status: 'available' }] },
      authData: {
        aliasResolved: { access: 'tok', accountId: 'workspace-a' },
      },
      registry: {
        workspaces: [
          { workspaceId: 'workspace-a', workspaceName: 'Workspace A', lineage: 'lineage-a', ownerAliasId: 'owner-a', ownerEmail: 'owner-a@example.com', healthyAccounts: 3, currentMembers: 2, maxMembers: 8 },
        ],
      },
      bootstrapLineage: jest.fn().mockResolvedValue({ ok: true, createdEntries: [] }),
    });

    expect(result.allowedAliasIds).toEqual(['aliasResolved']);
    expect(result.skippedAliasIds).toEqual(['aliasSkipped']);
    expect(result.placementContextByAliasId.aliasResolved).toEqual(expect.objectContaining({
      aliasId: 'aliasResolved',
      aliasEmail: 'resolved@agentmail.to',
      lineage: 'lineage-a',
      workspaceId: 'workspace-a',
    }));
  });

  test('zero-capacity pool triggers bootstrap before rerun and proceeds only when capacity exists', async () => {
    const bootstrapLineage = jest.fn().mockResolvedValue({
      ok: true,
      createdEntries: [{ inboxAddress: 'fresh@agentmail.to', workspaceGroupKey: 'lineage-a' }],
    });

    const result = await prepareLiveFixRuntime({
      routerData: {
        aliases: [
          { id: 'aliasResolved', cloneFrom: 'openai-codex', email: 'resolved@agentmail.to', disabled: false },
        ],
        pools: [{ name: 'openai-codex', providers: ['aliasResolved'], routes: [] }],
      },
      healthData: { providers: { aliasResolved: { status: 'cooldown' } } },
      poolData: { entries: [{ inboxAddress: 'busy@agentmail.to', status: 'in-use' }] },
      authData: { aliasResolved: { access: 'tok', accountId: 'workspace-a' } },
      registry: {
        workspaces: [
          { workspaceId: 'workspace-a', workspaceName: 'Workspace A', lineage: 'lineage-a', ownerAliasId: 'owner-a', ownerEmail: 'owner-a@example.com', healthyAccounts: 3, currentMembers: 2, maxMembers: 8 },
        ],
      },
      bootstrapLineage,
    });

    expect(bootstrapLineage).toHaveBeenCalledTimes(1);
    expect(result.bootstrapResult).toEqual(expect.objectContaining({ triggered: true, ok: true }));
    expect(result.canProceed).toBe(true);
    expect(result.usableCapacityBeforeBootstrap).toBe(0);
    expect(result.usableCapacityAfterBootstrap).toBe(1);
  });

  test('uses a usable cached lineage workspace even when the observed account workspace is deactivated', async () => {
    const result = await prepareLiveFixRuntime({
      routerData: {
        aliases: [
          { id: 'aliasResolved', cloneFrom: 'openai-codex', email: 'resolved@agentmail.to', disabled: false, lineage: 'lineage-a' },
        ],
        pools: [{ name: 'openai-codex', providers: ['aliasResolved'], routes: [] }],
      },
      healthData: { providers: { aliasResolved: { status: 'cooldown' } } },
      poolData: { entries: [{ inboxAddress: 'available@agentmail.to', status: 'available' }] },
      authData: { aliasResolved: { access: 'tok', accountId: 'workspace-dead' } },
      registry: {
        workspaces: [
          { workspaceId: 'workspace-live', workspaceName: 'Workspace Live', lineage: 'lineage-a', ownerAliasId: 'owner-a', ownerEmail: 'owner-a@example.com', healthyAccounts: 3, currentMembers: 2, maxMembers: 8 },
        ],
        observedWorkspaces: [
          { workspaceId: 'workspace-dead', workspaceName: 'Workspace Dead', lineage: 'lineage-a', ownerAliasId: 'owner-dead', ownerEmail: 'dead@example.com', healthyAccounts: 0, currentMembers: 0, maxMembers: 8, deactivated: true, usable: false, eligibilityStatus: 'workspace-deactivated' },
        ],
        usableByLineage: {
          'lineage-a': { workspaceId: 'workspace-live', workspaceName: 'Workspace Live', lineage: 'lineage-a', ownerAliasId: 'owner-a', ownerEmail: 'owner-a@example.com', healthyAccounts: 3, currentMembers: 2, maxMembers: 8 },
        },
      },
      bootstrapLineage: jest.fn().mockResolvedValue({ ok: true, createdEntries: [] }),
    });

    expect(result.allowedAliasIds).toEqual(['aliasResolved']);
    expect(result.skippedAliasIds).toEqual([]);
    expect(result.placementContextByAliasId.aliasResolved).toEqual(expect.objectContaining({
      lineage: 'lineage-a',
      workspaceId: 'workspace-live',
      ownerAliasId: 'owner-a',
      ownerEmail: 'owner-a@example.com',
    }));
  });

  test('rerun does not proceed when capacity stays zero after bootstrap', async () => {
    const result = await prepareLiveFixRuntime({
      routerData: {
        aliases: [
          { id: 'aliasResolved', cloneFrom: 'openai-codex', email: 'resolved@agentmail.to', disabled: false },
        ],
        pools: [{ name: 'openai-codex', providers: ['aliasResolved'], routes: [] }],
      },
      healthData: { providers: { aliasResolved: { status: 'cooldown' } } },
      poolData: { entries: [{ inboxAddress: 'busy@agentmail.to', status: 'in-use' }] },
      authData: { aliasResolved: { access: 'tok', accountId: 'workspace-a' } },
      registry: {
        workspaces: [
          { workspaceId: 'workspace-a', workspaceName: 'Workspace A', lineage: 'lineage-a', ownerAliasId: 'owner-a', ownerEmail: 'owner-a@example.com', healthyAccounts: 3, currentMembers: 2, maxMembers: 8 },
        ],
      },
      bootstrapLineage: jest.fn().mockResolvedValue({ ok: false, reason: 'owner-auth-expired', createdEntries: [] }),
    });

    expect(result.bootstrapResult).toEqual(expect.objectContaining({
      triggered: true,
      ok: false,
      blockerReason: 'insufficient-capacity-after-bootstrap',
    }));
    expect(result.canProceed).toBe(false);
  });

  test('carries new-root registry updates through live-fix preparation for cache persistence', async () => {
    const result = await prepareLiveFixRuntime({
      routerData: {
        aliases: [
          { id: 'aliasResolved', cloneFrom: 'openai-codex', email: 'resolved@agentmail.to', disabled: false },
        ],
        pools: [{ name: 'openai-codex', providers: ['aliasResolved'], routes: [] }],
      },
      healthData: { providers: { aliasResolved: { status: 'cooldown' } } },
      poolData: { entries: [{ inboxAddress: 'busy@agentmail.to', status: 'in-use' }] },
      authData: { aliasResolved: { access: 'tok', accountId: 'workspace-a' } },
      registry: {
        workspaces: [
          { workspaceId: 'workspace-a', workspaceName: 'Workspace A', lineage: 'lineage-a', ownerAliasId: 'owner-a', ownerEmail: 'owner-a@example.com', healthyAccounts: 3, currentMembers: 2, maxMembers: 8 },
        ],
      },
      bootstrapLineage: jest.fn().mockResolvedValue({
        ok: true,
        reason: 'bootstrap-escalated-new-root',
        createdEntries: [{ inboxAddress: 'fresh@agentmail.to', workspaceGroupKey: 'lineage-a' }],
        registryUpdates: {
          usableSupplyRoots: [{
            rootEmail: 'fresh-root@example.com',
            ownerAliasId: 'owner-a',
            lineage: 'lineage-a',
            workspaceId: 'workspace-a',
            workspaceName: 'Workspace A',
          }],
        },
      }),
    });

    expect(result.bootstrapResult.registryUpdates).toEqual({
      usableSupplyRoots: [expect.objectContaining({ rootEmail: 'fresh-root@example.com', lineage: 'lineage-a' })],
    });
    expect(result.canProceed).toBe(true);
  });
});
