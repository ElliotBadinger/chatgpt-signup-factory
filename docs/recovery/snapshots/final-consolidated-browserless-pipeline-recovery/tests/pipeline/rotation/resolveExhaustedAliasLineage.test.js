import { describe, test, expect } from '@jest/globals';

import { resolveExhaustedAliasLineage } from '../../../src/pipeline/rotation/resolveExhaustedAliasLineage.js';

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

describe('resolveExhaustedAliasLineage', () => {
  test('resolves workspace from current auth account id and maps to owner/root lineage evidence', async () => {
    const result = await resolveExhaustedAliasLineage({
      exhaustedAliases: [
        { aliasId: 'aliasA', email: 'aliasA@agentmail.to' },
      ],
      auth: {
        aliasA: { access: 'tok-a', accountId: 'workspace-a' },
      },
      registry: {
        workspaces: [
          makeWorkspace({ workspaceId: 'workspace-a', lineage: 'lineage-a', ownerAliasId: 'owner-a', ownerEmail: 'owner-a@example.com' }),
        ],
      },
    });

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]).toEqual(expect.objectContaining({
      aliasId: 'aliasA',
      workspaceId: 'workspace-a',
      lineage: 'lineage-a',
      ownerAliasId: 'owner-a',
      resolutionSource: 'auth-account-workspace-match',
      confidence: 'high',
      placementContext: expect.objectContaining({
        aliasId: 'aliasA',
        aliasEmail: 'aliasA@agentmail.to',
        lineage: 'lineage-a',
        workspaceId: 'workspace-a',
      }),
    }));
  });

  test('chooses the healthiest owner when multiple registry entries match the same workspace evidence', async () => {
    const result = await resolveExhaustedAliasLineage({
      exhaustedAliases: [
        { aliasId: 'aliasA', email: 'aliasA@agentmail.to' },
      ],
      auth: {
        aliasA: { access: 'tok-a', accountId: 'workspace-a' },
      },
      registry: {
        workspaces: [
          makeWorkspace({ workspaceId: 'workspace-a', ownerAliasId: 'owner-weaker', ownerEmail: 'weak@example.com', healthyAccounts: 1, currentMembers: 6 }),
          makeWorkspace({ workspaceId: 'workspace-a', ownerAliasId: 'owner-stronger', ownerEmail: 'strong@example.com', healthyAccounts: 4, currentMembers: 3 }),
        ],
      },
    });

    expect(result.resolved[0]).toEqual(expect.objectContaining({
      ownerAliasId: 'owner-stronger',
      ownerEmail: 'strong@example.com',
    }));
  });

  test('falls back from a deactivated observed workspace to a usable cached lineage workspace', async () => {
    const result = await resolveExhaustedAliasLineage({
      exhaustedAliases: [
        { aliasId: 'aliasA', email: 'aliasA@agentmail.to', lineage: 'lineage-a' },
      ],
      auth: {
        aliasA: { access: 'tok-a', accountId: 'workspace-dead' },
      },
      registry: {
        workspaces: [
          makeWorkspace({ workspaceId: 'workspace-live', workspaceName: 'Live Workspace', ownerAliasId: 'owner-live', ownerEmail: 'live@example.com', healthyAccounts: 3, currentMembers: 2, lineage: 'lineage-a' }),
        ],
        observedWorkspaces: [
          makeWorkspace({ workspaceId: 'workspace-dead', workspaceName: 'Dead Workspace', ownerAliasId: 'owner-dead', ownerEmail: 'dead@example.com', lineage: 'lineage-a', deactivated: true, usable: false, eligibilityStatus: 'workspace-deactivated' }),
        ],
        usableByLineage: {
          'lineage-a': makeWorkspace({ workspaceId: 'workspace-live', workspaceName: 'Live Workspace', ownerAliasId: 'owner-live', ownerEmail: 'live@example.com', healthyAccounts: 3, currentMembers: 2, lineage: 'lineage-a' }),
        },
      },
    });

    expect(result.resolved).toEqual([
      expect.objectContaining({
        aliasId: 'aliasA',
        workspaceId: 'workspace-live',
        ownerAliasId: 'owner-live',
        ownerEmail: 'live@example.com',
        lineage: 'lineage-a',
        resolutionSource: 'observed-workspace-lineage-usable-fallback',
      }),
    ]);
  });

  test('prefers the evidence-backed owner record when duplicate workspace matches differ only by owner identity quality', async () => {
    const result = await resolveExhaustedAliasLineage({
      exhaustedAliases: [
        { aliasId: 'aliasA', email: 'aliasA@agentmail.to' },
      ],
      auth: {
        aliasA: { access: 'tok-a', accountId: 'workspace-a' },
      },
      registry: {
        workspaces: [
          makeWorkspace({ workspaceId: 'workspace-a', ownerAliasId: 'member-a', ownerEmail: null, healthyAccounts: 2, currentMembers: 4 }),
          makeWorkspace({ workspaceId: 'workspace-a', ownerAliasId: 'owner-a', ownerEmail: 'owner-a@example.com', healthyAccounts: 2, currentMembers: 4 }),
        ],
      },
    });

    expect(result.resolved).toEqual([
      expect.objectContaining({
        aliasId: 'aliasA',
        ownerAliasId: 'owner-a',
        ownerEmail: 'owner-a@example.com',
      }),
    ]);
    expect(result.unresolved).toEqual([]);
  });


  test('resolves duplicate workspace records by explicit owner alias match', async () => {
    const result = await resolveExhaustedAliasLineage({
      exhaustedAliases: [
        { aliasId: 'openai_1', email: 'openai_1@example.com' },
      ],
      auth: {
        openai_1: { access: 'tok-a', accountId: 'workspace-a' },
      },
      registry: {
        workspaces: [
          makeWorkspace({ workspaceId: 'workspace-a', ownerAliasId: 'openai_7', ownerEmail: null, healthyAccounts: 0, currentMembers: 6, lineage: 'openai_7' }),
          makeWorkspace({ workspaceId: 'workspace-a', ownerAliasId: 'openai_1', ownerEmail: null, healthyAccounts: 0, currentMembers: 6, lineage: 'openai_1' }),
          makeWorkspace({ workspaceId: 'workspace-a', ownerAliasId: 'openai-codex', ownerEmail: null, healthyAccounts: 0, currentMembers: 6, lineage: 'openai-codex' }),
        ],
      },
    });

    expect(result.unresolved).toEqual([]);
    expect(result.resolved[0]).toEqual(expect.objectContaining({
      aliasId: 'openai_1',
      ownerAliasId: 'openai_1',
      lineage: 'openai_1',
      resolutionSource: 'auth-account-owner-alias-match',
    }));
  });
  test('returns unresolved when no safe mapping exists instead of guessing', async () => {
    const result = await resolveExhaustedAliasLineage({
      exhaustedAliases: [
        { aliasId: 'aliasNoAuth', email: 'noauth@agentmail.to' },
        { aliasId: 'aliasNoWorkspace', email: 'noworkspace@agentmail.to' },
        { aliasId: 'aliasAmbiguous', email: 'ambiguous@agentmail.to' },
      ],
      auth: {
        aliasNoWorkspace: { access: 'tok-b', accountId: 'workspace-missing' },
        aliasAmbiguous: { access: 'tok-c', accountId: 'workspace-a' },
      },
      registry: {
        workspaces: [
          makeWorkspace({ workspaceId: 'workspace-a', ownerAliasId: 'owner-a', ownerEmail: null, healthyAccounts: 2, currentMembers: 4 }),
          makeWorkspace({ workspaceId: 'workspace-a', ownerAliasId: 'owner-b', ownerEmail: null, healthyAccounts: 2, currentMembers: 4 }),
        ],
      },
    });

    expect(result.resolved).toHaveLength(0);
    expect(result.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ aliasId: 'aliasNoAuth', reason: 'auth-account-id-missing' }),
      expect.objectContaining({ aliasId: 'aliasNoWorkspace', reason: 'workspace-not-found-for-account-id' }),
      expect.objectContaining({ aliasId: 'aliasAmbiguous', reason: 'workspace-match-ambiguous' }),
    ]));
  });
});
