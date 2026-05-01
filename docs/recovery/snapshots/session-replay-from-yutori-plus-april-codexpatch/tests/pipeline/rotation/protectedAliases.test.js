import { describe, test, expect } from '@jest/globals';

import { buildProtectedAliasContract } from '../../../src/pipeline/rotation/protectedAliases.js';

describe('buildProtectedAliasContract', () => {
  test('protects canonical parent, live owner/admin, and literal exciteditem179 while surfacing wrong-lineage residue', () => {
    const contract = buildProtectedAliasContract({
      targetWorkspaceId: 'workspace-a',
      workspaceOwnerEmail: 'agentmailroot1773504739a@epistemophile.space',
      controlPlane: {
        version: 1,
        workspaces: {
          'workspace-a': {
            workspaceId: 'workspace-a',
            ownerAliasId: 'workspace-owner-a',
            ownerEmail: 'agentmailroot1773504739a@epistemophile.space',
            lineage: 'workspace-owner-a',
            preferredRootEmail: 'agentmailroot1773504739a@epistemophile.space',
            organizations: [],
          },
        },
      },
      routerData: {
        aliases: [
          {
            id: 'cruelfigure620',
            cloneFrom: 'openai-codex',
            email: 'cruelfigure620@agentmail.to',
            disabled: false,
            workspaceId: 'workspace-a',
            ownerAliasId: 'workspace-owner-a',
            lineage: 'workspace-owner-a',
          },
          {
            id: 'exciteditem179',
            cloneFrom: 'openai-codex',
            email: 'exciteditem179@agentmail.to',
            disabled: false,
            workspaceId: 'workspace-a',
            ownerAliasId: 'workspace-owner-a',
            lineage: 'workspace-owner-a',
          },
          {
            id: 'expensiveprogress582',
            cloneFrom: 'openai-codex',
            email: 'expensiveprogress582@agentmail.to',
            disabled: false,
            placementContext: {
              workspaceId: 'workspace-a',
              ownerAliasId: 'workspace-owner-b',
              ownerEmail: 'nastypolicy361@agentmail.to',
              lineage: 'workspace-owner-b',
              rootEmail: 'agentmailroot1773504739b@epistemophile.space',
            },
          },
        ],
        pools: [{
          name: 'openai-codex',
          providers: ['cruelfigure620', 'exciteditem179', 'expensiveprogress582'],
          routes: [],
        }],
      },
      poolData: {
        entries: [
          {
            inboxAddress: 'cruelfigure620@agentmail.to',
            linkedAliasId: 'cruelfigure620',
            workspaceId: 'workspace-a',
            rootOrgId: 'workspace-a',
            ownerAliasId: 'workspace-owner-a',
            ownerEmail: 'agentmailroot1773504739a@epistemophile.space',
            lineage: 'workspace-owner-a',
            rootEmail: 'agentmailroot1773504739a@epistemophile.space',
          },
          {
            inboxAddress: 'expensiveprogress582@agentmail.to',
            linkedAliasId: 'expensiveprogress582',
            workspaceId: 'workspace-a',
            rootOrgId: 'workspace-a',
            ownerAliasId: 'workspace-owner-b',
            ownerEmail: 'nastypolicy361@agentmail.to',
            lineage: 'workspace-owner-b',
            rootEmail: 'agentmailroot1773504739b@epistemophile.space',
          },
        ],
      },
      authData: {
        'workspace-owner-b': {
          email: 'nastypolicy361@agentmail.to',
          access: 'tok-wrong',
          refresh: 'ref-wrong',
          accountId: 'workspace-a',
        },
      },
      registry: {
        workspaces: [{
          workspaceId: 'workspace-a',
          workspaceName: 'Root-Mail_a',
          ownerAliasId: 'cruelfigure620',
          ownerEmail: 'cruelfigure620@agentmail.to',
          ownerAccountId: 'workspace-a',
          ownerRole: 'account-admin',
          usable: true,
          provenOwnerCapable: false,
        }],
        ownerCandidates: [{
          ownerAliasId: 'workspace-owner-b',
          ownerEmail: 'nastypolicy361@agentmail.to',
          ownerAccountId: 'workspace-a',
          lineage: 'workspace-owner-b',
        }],
      },
    });

    expect(contract.protectedAliasIds).toEqual([
      'workspace-owner-a',
      'cruelfigure620',
      'exciteditem179',
    ]);
    expect(contract.protectedEmails).toEqual([
      'agentmailroot1773504739a@epistemophile.space',
      'cruelfigure620@agentmail.to',
      'exciteditem179@agentmail.to',
    ]);
    expect(contract.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        aliasId: 'workspace-owner-a',
        email: 'agentmailroot1773504739a@epistemophile.space',
        provenance: 'canonical-parent',
      }),
      expect.objectContaining({
        aliasId: 'cruelfigure620',
        email: 'cruelfigure620@agentmail.to',
        provenance: 'live-owner-admin',
      }),
      expect.objectContaining({
        aliasId: 'exciteditem179',
        email: 'exciteditem179@agentmail.to',
        provenance: 'literal-preserved',
      }),
    ]));
    expect(contract.protectedAliasIds).not.toContain('workspace-owner-b');
    expect(contract.protectedEmails).not.toContain('nastypolicy361@agentmail.to');
    expect(contract.wrongLineageResidue).toEqual(expect.arrayContaining([
      expect.objectContaining({
        aliasId: 'expensiveprogress582',
        ownerAliasId: 'workspace-owner-b',
        email: 'expensiveprogress582@agentmail.to',
      }),
      expect.objectContaining({
        aliasId: 'workspace-owner-b',
        email: 'nastypolicy361@agentmail.to',
      }),
    ]));
    expect(contract.entryByAliasId['workspace-owner-a']).toEqual(expect.objectContaining({
      provenance: 'canonical-parent',
    }));
    expect(contract.entryByEmail['cruelfigure620@agentmail.to']).toEqual(expect.objectContaining({
      aliasId: 'cruelfigure620',
    }));
  });

  test('falls back to pool before router, registry, and owner-candidate for canonical parent email', () => {
    const contract = buildProtectedAliasContract({
      targetWorkspaceId: 'workspace-a',
      controlPlaneStatus: {
        canonicalParent: {
          workspaceId: 'workspace-a',
          ownerAliasId: 'workspace-owner-a',
          ownerEmail: null,
          rootEmail: null,
          lineage: 'workspace-owner-a',
        },
        liveOwnerAdmin: null,
        preservedActiveAliases: [],
        crossLineageResidueAliases: [],
      },
      routerData: {
        aliases: [{
          id: 'router-member',
          cloneFrom: 'openai-codex',
          email: 'router-root@example.com',
          disabled: false,
          placementContext: {
            workspaceId: 'workspace-a',
            ownerAliasId: 'workspace-owner-a',
            ownerEmail: 'router-root@example.com',
            lineage: 'workspace-owner-a',
            rootEmail: 'router-root@example.com',
          },
        }],
        pools: [{ name: 'openai-codex', providers: ['router-member'], routes: [] }],
      },
      poolData: {
        entries: [{
          inboxAddress: 'pool-root@example.com',
          linkedAliasId: 'pool-root',
          workspaceId: 'workspace-a',
          rootOrgId: 'workspace-a',
          ownerAliasId: 'workspace-owner-a',
          ownerEmail: 'pool-root@example.com',
          lineage: 'workspace-owner-a',
          rootEmail: 'pool-root@example.com',
        }],
      },
      authData: {},
      registry: {
        workspaces: [{
          workspaceId: 'workspace-a',
          ownerAliasId: 'workspace-owner-a',
          ownerEmail: 'registry-root@example.com',
          lineage: 'workspace-owner-a',
        }],
        ownerCandidates: [{
          ownerAliasId: 'workspace-owner-a',
          ownerEmail: 'owner-candidate-root@example.com',
          ownerAccountId: 'workspace-a',
          lineage: 'workspace-owner-a',
        }],
      },
    });

    expect(contract.entryByAliasId['workspace-owner-a']).toEqual(expect.objectContaining({
      email: 'pool-root@example.com',
      source: 'pool',
    }));
  });

  test('falls back from preserved active aliases to pool, auth, then registry for live owner/admin email', () => {
    const fromPool = buildProtectedAliasContract({
      targetWorkspaceId: 'workspace-a',
      controlPlaneStatus: {
        canonicalParent: null,
        liveOwnerAdmin: {
          ownerAliasId: 'cruelfigure620',
          ownerRole: 'account-admin',
          usable: true,
        },
        preservedActiveAliases: [],
        crossLineageResidueAliases: [],
      },
      routerData: { aliases: [], pools: [] },
      poolData: {
        entries: [{
          inboxAddress: 'pool-admin@agentmail.to',
          linkedAliasId: 'cruelfigure620',
          workspaceId: 'workspace-a',
          ownerAliasId: 'workspace-owner-a',
          ownerEmail: 'root@example.com',
          lineage: 'workspace-owner-a',
          rootEmail: 'root@example.com',
        }],
      },
      authData: {
        cruelfigure620: { email: 'auth-admin@agentmail.to', access: 'tok-a', refresh: 'ref-a' },
      },
      registry: {
        workspaces: [{
          workspaceId: 'workspace-a',
          ownerAliasId: 'cruelfigure620',
          ownerEmail: 'registry-admin@agentmail.to',
          ownerRole: 'account-admin',
          usable: true,
        }],
        ownerCandidates: [],
      },
    });
    expect(fromPool.entryByAliasId.cruelfigure620).toEqual(expect.objectContaining({
      email: 'pool-admin@agentmail.to',
      source: 'pool',
    }));

    const fromAuth = buildProtectedAliasContract({
      targetWorkspaceId: 'workspace-a',
      controlPlaneStatus: {
        canonicalParent: null,
        liveOwnerAdmin: {
          ownerAliasId: 'cruelfigure620',
          ownerRole: 'account-admin',
          usable: true,
        },
        preservedActiveAliases: [],
        crossLineageResidueAliases: [],
      },
      routerData: { aliases: [], pools: [] },
      poolData: { entries: [] },
      authData: {
        cruelfigure620: { email: 'auth-admin@agentmail.to', access: 'tok-a', refresh: 'ref-a' },
      },
      registry: {
        workspaces: [{
          workspaceId: 'workspace-a',
          ownerAliasId: 'cruelfigure620',
          ownerEmail: 'registry-admin@agentmail.to',
          ownerRole: 'account-admin',
          usable: true,
        }],
        ownerCandidates: [],
      },
    });
    expect(fromAuth.entryByAliasId.cruelfigure620).toEqual(expect.objectContaining({
      email: 'auth-admin@agentmail.to',
      source: 'auth',
    }));

    const fromRegistry = buildProtectedAliasContract({
      targetWorkspaceId: 'workspace-a',
      controlPlaneStatus: {
        canonicalParent: null,
        liveOwnerAdmin: {
          ownerAliasId: 'cruelfigure620',
          ownerRole: 'account-admin',
          usable: true,
        },
        preservedActiveAliases: [],
        crossLineageResidueAliases: [],
      },
      routerData: { aliases: [], pools: [] },
      poolData: { entries: [] },
      authData: {},
      registry: {
        workspaces: [{
          workspaceId: 'workspace-a',
          ownerAliasId: 'cruelfigure620',
          ownerEmail: 'registry-admin@agentmail.to',
          ownerRole: 'account-admin',
          usable: true,
        }],
        ownerCandidates: [],
      },
    });
    expect(fromRegistry.entryByAliasId.cruelfigure620).toEqual(expect.objectContaining({
      email: 'registry-admin@agentmail.to',
      source: 'workspace-registry',
    }));
  });

  test('merges duplicate protected identities when later discovery adds the email', () => {
    const contract = buildProtectedAliasContract({
      targetWorkspaceId: 'workspace-a',
      controlPlaneStatus: {
        canonicalParent: {
          workspaceId: 'workspace-a',
          ownerAliasId: 'workspace-owner-a',
          ownerEmail: null,
          rootEmail: null,
          lineage: 'workspace-owner-a',
        },
        liveOwnerAdmin: {
          ownerAliasId: 'workspace-owner-a',
          ownerRole: 'account-owner',
          usable: true,
        },
        preservedActiveAliases: [{
          aliasId: 'workspace-owner-a',
          email: 'root-a@example.com',
          workspaceId: 'workspace-a',
          ownerAliasId: 'workspace-owner-a',
          lineage: 'workspace-owner-a',
        }],
        crossLineageResidueAliases: [],
      },
      routerData: { aliases: [], pools: [] },
      poolData: { entries: [] },
      authData: {},
      registry: { workspaces: [], ownerCandidates: [] },
    });

    expect(contract.protectedAliasIds).toEqual(['workspace-owner-a', 'exciteditem179']);
    expect(contract.entryByAliasId['workspace-owner-a']).toEqual(expect.objectContaining({
      aliasId: 'workspace-owner-a',
      email: 'root-a@example.com',
    }));
    expect(contract.protectedEmails).toContain('root-a@example.com');
    expect(contract.entryByEmail['root-a@example.com']).toEqual(expect.objectContaining({
      aliasId: 'workspace-owner-a',
    }));
  });

  test('does not treat disabled aliases as active merely because they remain in the pool provider list', () => {
    const contract = buildProtectedAliasContract({
      targetWorkspaceId: 'workspace-a',
      controlPlaneStatus: {
        canonicalParent: null,
        liveOwnerAdmin: {
          ownerAliasId: 'cruelfigure620',
          ownerRole: 'account-admin',
          usable: true,
        },
        preservedActiveAliases: [],
        crossLineageResidueAliases: [],
      },
      routerData: {
        aliases: [{
          id: 'cruelfigure620',
          cloneFrom: 'openai-codex',
          email: 'disabled-admin@agentmail.to',
          disabled: true,
          placementContext: {
            workspaceId: 'workspace-a',
            ownerAliasId: 'workspace-owner-a',
            lineage: 'workspace-owner-a',
          },
        }],
        pools: [{ name: 'openai-codex', providers: ['cruelfigure620'], routes: [] }],
      },
      poolData: { entries: [] },
      authData: {},
      registry: {
        workspaces: [{
          workspaceId: 'workspace-a',
          ownerAliasId: 'cruelfigure620',
          ownerEmail: 'registry-admin@agentmail.to',
          ownerRole: 'account-admin',
          usable: true,
        }],
        ownerCandidates: [],
      },
    });

    expect(contract.entryByAliasId.cruelfigure620).toEqual(expect.objectContaining({
      email: 'registry-admin@agentmail.to',
      source: 'workspace-registry',
    }));
    expect(contract.protectedEmails).not.toContain('disabled-admin@agentmail.to');
  });

  test('ignores non-owner same-workspace member aliases when surfacing owner-candidate wrong-lineage residue', () => {
    const contract = buildProtectedAliasContract({
      targetWorkspaceId: 'workspace-a',
      controlPlane: {
        version: 1,
        workspaces: {
          'workspace-a': {
            workspaceId: 'workspace-a',
            ownerAliasId: 'workspace-owner-a',
            ownerEmail: 'root@example.com',
            lineage: 'workspace-owner-a',
            preferredRootEmail: 'root@example.com',
            organizations: [],
          },
        },
      },
      routerData: { aliases: [], pools: [] },
      poolData: { entries: [] },
      authData: {},
      registry: {
        workspaces: [{
          workspaceId: 'workspace-a',
          workspaceName: 'Workspace A',
          ownerAliasId: 'cruelfigure620',
          ownerEmail: 'cruelfigure620@agentmail.to',
          ownerAccountId: 'workspace-a',
          ownerRole: 'account-admin',
          usable: true,
          provenOwnerCapable: false,
        }],
        ownerCandidates: [
          {
            ownerAliasId: 'workspace-owner-b',
            ownerEmail: 'wrong-root@example.com',
            ownerAccountId: 'workspace-a',
            lineage: 'workspace-owner-b',
          },
          {
            ownerAliasId: 'enchantinglist306',
            ownerEmail: null,
            ownerAccountId: 'workspace-a',
            lineage: 'enchantinglist306',
          },
        ],
      },
    });

    expect(contract.wrongLineageResidue).toEqual([
      expect.objectContaining({
        aliasId: 'workspace-owner-b',
        email: 'wrong-root@example.com',
      }),
    ]);
  });

  test('ignores off-target owner-candidate residue that does not belong to the target workspace account', () => {
    const contract = buildProtectedAliasContract({
      targetWorkspaceId: 'workspace-a',
      controlPlane: {
        version: 1,
        workspaces: {
          'workspace-a': {
            workspaceId: 'workspace-a',
            ownerAliasId: 'workspace-owner-a',
            ownerEmail: 'root@example.com',
            lineage: 'workspace-owner-a',
            preferredRootEmail: 'root@example.com',
            organizations: [],
          },
        },
      },
      routerData: { aliases: [], pools: [] },
      poolData: { entries: [] },
      authData: {},
      registry: {
        workspaces: [],
        ownerCandidates: [
          {
            ownerAliasId: 'workspace-owner-b',
            ownerEmail: 'off-target-root@example.com',
            ownerAccountId: 'workspace-b',
            lineage: 'workspace-owner-b',
          },
          {
            ownerAliasId: 'openai-codex',
            ownerEmail: 'worker@example.com',
            ownerAccountId: 'workspace-b',
            lineage: 'openai-codex',
          },
        ],
      },
    });

    expect(contract.wrongLineageResidue).toEqual([]);
    expect(contract.protectedAliasIds).toEqual(['workspace-owner-a', 'exciteditem179']);
    expect(contract.protectedEmails).toEqual(['root@example.com', 'exciteditem179@agentmail.to']);
  });
});