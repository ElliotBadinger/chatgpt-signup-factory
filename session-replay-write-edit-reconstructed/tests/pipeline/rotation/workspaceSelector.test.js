import { describe, test, expect } from '@jest/globals';

import { selectWorkspaceForAlias } from '../../../src/pipeline/rotation/workspaceSelector.js';

function makeWorkspace(overrides = {}) {
  return {
    workspaceId: 'workspace-x',
    workspaceName: 'Workspace X',
    lineage: 'lineage-a',
    ownerAliasId: 'owner-a',
    healthyAccounts: 2,
    currentMembers: 4,
    maxMembers: 8,
    ...overrides,
  };
}

describe('selectWorkspaceForAlias', () => {
  test('placement prefers same lineage first', () => {
    const selected = selectWorkspaceForAlias({
      alias: { aliasId: 'candidate-1', lineage: 'lineage-a' },
      workspaces: [
        makeWorkspace({ workspaceId: 'workspace-other', lineage: 'lineage-b', healthyAccounts: 10, currentMembers: 1 }),
        makeWorkspace({ workspaceId: 'workspace-same', lineage: 'lineage-a', healthyAccounts: 2, currentMembers: 4 }),
      ],
    });

    expect(selected.workspaceId).toBe('workspace-same');
  });

  test('within a lineage, selector picks the healthiest workspace with capacity', () => {
    const selected = selectWorkspaceForAlias({
      alias: { aliasId: 'candidate-2', lineage: 'lineage-a' },
      workspaces: [
        makeWorkspace({ workspaceId: 'workspace-a1', healthyAccounts: 1, currentMembers: 3 }),
        makeWorkspace({ workspaceId: 'workspace-a2', healthyAccounts: 4, currentMembers: 5 }),
        makeWorkspace({ workspaceId: 'workspace-a3', healthyAccounts: 2, currentMembers: 2 }),
      ],
    });

    expect(selected.workspaceId).toBe('workspace-a2');
  });

  test('if preferred workspace is full, it spills to another workspace in the same lineage', () => {
    const selected = selectWorkspaceForAlias({
      alias: { aliasId: 'candidate-3', lineage: 'lineage-a' },
      workspaces: [
        makeWorkspace({ workspaceId: 'workspace-full', healthyAccounts: 10, currentMembers: 8, maxMembers: 8 }),
        makeWorkspace({ workspaceId: 'workspace-spill', healthyAccounts: 3, currentMembers: 6, maxMembers: 8 }),
        makeWorkspace({ workspaceId: 'workspace-other-lineage', lineage: 'lineage-b', healthyAccounts: 8, currentMembers: 1, maxMembers: 8 }),
      ],
    });

    expect(selected.workspaceId).toBe('workspace-spill');
  });

  test('honors an explicitly targeted workspace id even when that workspace is full', () => {
    const selected = selectWorkspaceForAlias({
      alias: { aliasId: 'candidate-4', lineage: 'lineage-a', rootOrgId: 'workspace-full' },
      workspaces: [
        makeWorkspace({ workspaceId: 'workspace-full', healthyAccounts: 10, currentMembers: 8, maxMembers: 8 }),
        makeWorkspace({ workspaceId: 'workspace-spill', healthyAccounts: 3, currentMembers: 6, maxMembers: 8 }),
      ],
    });

    expect(selected.workspaceId).toBe('workspace-full');
  });

  test('when multiple records share the explicit workspace id, prefers the evidence-backed owner record', () => {
    const selected = selectWorkspaceForAlias({
      alias: { aliasId: 'candidate-5', lineage: 'lineage-a', rootOrgId: 'workspace-full' },
      workspaces: [
        makeWorkspace({ workspaceId: 'workspace-full', ownerAliasId: 'temp-owner', ownerEmail: null, healthyAccounts: 0, currentMembers: 8, maxMembers: 8 }),
        makeWorkspace({ workspaceId: 'workspace-full', ownerAliasId: 'workspace-owner-a', ownerEmail: 'owner@example.com', healthyAccounts: 0, currentMembers: 8, maxMembers: 8 }),
      ],
    });

    expect(selected.ownerAliasId).toBe('workspace-owner-a');
    expect(selected.ownerEmail).toBe('owner@example.com');
  });
});
