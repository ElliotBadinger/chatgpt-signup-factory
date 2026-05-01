import { describe, test, expect } from '@jest/globals';

import {
  buildUsableWorkspaceSelection,
  normalizeWorkspaceObservation,
} from '../../../src/pipeline/rotation/workspaceRegistry.js';

function makeObservation(overrides = {}) {
  return normalizeWorkspaceObservation({
    workspace: {
      workspaceId: 'workspace-a',
      workspaceName: 'Workspace A',
      lineage: 'lineage-a',
      currentMembers: 2,
      maxMembers: 8,
      healthyAccounts: 2,
      ...overrides,
    },
    ownerAliasId: overrides.ownerAliasId ?? 'workspace-owner-a',
    ownerAuth: {
      email: overrides.ownerEmail ?? 'root-a@example.com',
      accountId: overrides.ownerAccountId ?? 'personal-a',
      lineage: overrides.lineage ?? 'lineage-a',
    },
    nowMs: 1700000000000,
  });
}

describe('buildUsableWorkspaceSelection', () => {
  test('retains deactivated observations as evidence but excludes them from usable selection', () => {
    const registry = buildUsableWorkspaceSelection({
      observedWorkspaces: [
        makeObservation({
          workspaceId: 'workspace-dead',
          workspaceName: 'Dead Workspace',
          deactivated: true,
          eligible: false,
          usable: false,
          eligibilityStatus: 'workspace-deactivated',
        }),
        makeObservation({
          workspaceId: 'workspace-live',
          workspaceName: 'Live Workspace',
          healthyAccounts: 3,
          currentMembers: 1,
          maxMembers: 8,
        }),
      ],
    });

    expect(registry.observedWorkspaces.map((workspace) => workspace.workspaceId)).toEqual([
      'workspace-live',
      'workspace-dead',
    ]);
    expect(registry.usableWorkspaces).toEqual([
      expect.objectContaining({
        workspaceId: 'workspace-live',
        usable: true,
        deactivated: false,
      }),
    ]);
    expect(registry.usableByLineage['lineage-a']).toEqual(expect.objectContaining({
      workspaceId: 'workspace-live',
      ownerAliasId: 'workspace-owner-a',
      ownerEmail: 'root-a@example.com',
      lastVerifiedAt: expect.any(String),
    }));
  });

  test('chooses the healthiest highest-capacity usable workspace within a lineage', () => {
    const registry = buildUsableWorkspaceSelection({
      observedWorkspaces: [
        makeObservation({
          workspaceId: 'workspace-a',
          workspaceName: 'Workspace A',
          healthyAccounts: 2,
          currentMembers: 6,
          maxMembers: 8,
        }),
        makeObservation({
          workspaceId: 'workspace-b',
          workspaceName: 'Workspace B',
          healthyAccounts: 4,
          currentMembers: 2,
          maxMembers: 8,
        }),
      ],
    });

    expect(registry.usableWorkspaces.map((workspace) => workspace.workspaceId)).toEqual([
      'workspace-a',
      'workspace-b',
    ]);
    expect(registry.usableByLineage['lineage-a']).toEqual(expect.objectContaining({
      workspaceId: 'workspace-b',
      workspaceName: 'Workspace B',
      healthyAccounts: 4,
    }));
  });
});
