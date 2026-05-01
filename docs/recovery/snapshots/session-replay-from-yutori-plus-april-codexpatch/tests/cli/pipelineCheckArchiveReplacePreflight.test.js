import { describe, test, expect } from '@jest/globals';

import { evaluateCanonicalPreflight } from '../../src/cli/pipelineCheckArchiveReplacePreflight.js';
import { buildProtectedAliasContract } from '../../src/pipeline/rotation/protectedAliases.js';

const TARGET_WORKSPACE_ID = 'd3d588b2-8a74-4acc-aa2e-94662ff0e025';

function makeBaseInput() {
  return {
    nowMs: Date.parse('2026-04-07T12:00:00.000Z'),
    registryMaxAgeMs: 10 * 60 * 1000,
    targetWorkspaceId: TARGET_WORKSPACE_ID,
    registrySource: 'operational',
    registry: {
      discoveredAt: Date.parse('2026-04-07T11:55:00.000Z'),
      workspaces: [{
        workspaceId: TARGET_WORKSPACE_ID,
        workspaceName: 'Canonical Workspace',
        ownerAliasId: 'workspace-owner-a',
        ownerEmail: 'root@example.com',
        ownerAccountId: TARGET_WORKSPACE_ID,
        lineage: 'workspace-owner-a',
        currentMembers: 2,
        maxMembers: 8,
        healthyAccounts: 4,
        provenOwnerCapable: true,
        ownerRole: 'account-owner',
        verificationSource: 'workspace-list-users',
        lastVerifiedAt: '2026-04-07T11:58:00.000Z',
      }],
    },
    liveFixPreparation: {
      exhaustedAliases: [{ aliasId: 'alias-replace', email: 'replace@agentmail.to' }],
      actionableResolvedAliases: [{ aliasId: 'alias-replace', email: 'replace@agentmail.to' }],
      allowedAliasIds: ['alias-replace'],
      protectedResolvedAliases: [],
      quarantineCandidates: [],
      workspaceSeatCapacityBlockers: [],
      usableCapacityBeforeBootstrap: 1,
      usableCapacityAfterBootstrap: 1,
      targetWorkspaceId: TARGET_WORKSPACE_ID,
      canonicalParent: {
        workspaceId: TARGET_WORKSPACE_ID,
        ownerAliasId: 'workspace-owner-a',
        ownerEmail: 'root@example.com',
        lineage: 'workspace-owner-a',
        rootEmail: 'root@example.com',
      },
    },
    cleanupCandidates: [],
    scrubTargets: [],
    liveAuthorityFacts: {
      codexLbStatus: { ready: true, reason: null },
      aliases: [
        {
          aliasId: 'cruelfigure620',
          email: 'cruelfigure620@agentmail.to',
          workspaceId: TARGET_WORKSPACE_ID,
          live: {
            ok: true,
            workspaceId: TARGET_WORKSPACE_ID,
            workspaceAccountSelected: true,
            sessionValid: true,
          },
          parentAgreement: { ok: true, reason: null },
          codexLbAgreement: { ok: true, reason: null },
        },
      ],
    },
    protectedAliasContract: {
      protectedAliasIds: ['workspace-owner-a', 'cruelfigure620', 'exciteditem179'],
      protectedEmails: ['root@example.com', 'cruelfigure620@agentmail.to', 'exciteditem179@agentmail.to'],
      wrongLineageResidue: [],
      controlPlaneStatus: {
        liveOwnerAdmin: {
          ownerAliasId: 'cruelfigure620',
          ownerRole: 'account-admin',
          usable: true,
        },
      },
    },
  };
}

describe('evaluateCanonicalPreflight', () => {
  test('returns explicit no-op success when there is no actionable demand and no cleanup mutation path', () => {
    const verdict = evaluateCanonicalPreflight({
      ...makeBaseInput(),
      registrySource: 'fallback-runtime',
      registry: { discoveredAt: Date.parse('2026-04-07T00:00:00.000Z'), workspaces: [] },
      liveFixPreparation: {
        ...makeBaseInput().liveFixPreparation,
        exhaustedAliases: [],
        actionableResolvedAliases: [],
        allowedAliasIds: [],
        quarantineCandidates: [],
        workspaceSeatCapacityBlockers: [],
        usableCapacityBeforeBootstrap: 0,
        usableCapacityAfterBootstrap: 0,
      },
      cleanupCandidates: [],
      scrubTargets: [],
      liveAuthorityFacts: {
        codexLbStatus: { ready: false, reason: 'unavailable' },
        aliases: [],
      },
      protectedAliasContract: {
        protectedAliasIds: [],
        protectedEmails: [],
        wrongLineageResidue: [{ aliasId: 'workspace-owner-b', email: 'nastypolicy361@agentmail.to' }],
        controlPlaneStatus: {},
      },
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.state).toBe('no-op');
    expect(verdict.blockers).toEqual([]);
  });

  test('treats deferred cleanup-only residue as no-op when canonical actionable demand is zero', () => {
    const verdict = evaluateCanonicalPreflight({
      ...makeBaseInput(),
      liveFixPreparation: {
        ...makeBaseInput().liveFixPreparation,
        exhaustedAliases: [],
        actionableResolvedAliases: [],
        allowedAliasIds: [],
        usableCapacityBeforeBootstrap: 0,
        usableCapacityAfterBootstrap: 0,
        workspaceSeatCapacityBlockers: [{
          workspaceId: TARGET_WORKSPACE_ID,
          reason: 'workspace-seat-cap-reached',
          currentMembers: 8,
          maxMembers: 8,
        }],
      },
      cleanupCandidates: [{ aliasId: 'failed-member-1', email: 'failed-member-1@agentmail.to' }],
      scrubTargets: [],
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.state).toBe('no-op');
    expect(verdict.blockers).toEqual([]);
    expect(verdict.evidence).toEqual(expect.objectContaining({
      actionableDemand: 0,
      replacementDemand: 0,
      routerOnboardDemand: 0,
      cleanupCandidateCount: 1,
      hasMutationPath: false,
    }));
  });

  test('treats standalone router-onboard demand as an actionable preflight mutation path', () => {
    const verdict = evaluateCanonicalPreflight({
      ...makeBaseInput(),
      liveFixPreparation: {
        ...makeBaseInput().liveFixPreparation,
        exhaustedAliases: [],
        actionableResolvedAliases: [],
        allowedAliasIds: [],
        usableCapacityBeforeBootstrap: 0,
        usableCapacityAfterBootstrap: 0,
        routerOnboardDemandCount: 1,
        routerOnboardCandidates: [{ email: 'recover-me@agentmail.to' }],
      },
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.state).toBe('ready');
    expect(verdict.blockers).toEqual([]);
    expect(verdict.evidence).toEqual(expect.objectContaining({
      actionableDemand: 1,
      replacementDemand: 0,
      routerOnboardDemand: 1,
      hasMutationPath: true,
    }));
  });

  test('does not block protected aliases when codex-lb agrees and browserless runtime workspace access is still proven despite Pi lag', () => {
    const verdict = evaluateCanonicalPreflight({
      ...makeBaseInput(),
      liveAuthorityFacts: {
        codexLbStatus: { ready: true, reason: null },
        aliases: [
          {
            aliasId: 'exciteditem179',
            email: 'exciteditem179@agentmail.to',
            workspaceId: TARGET_WORKSPACE_ID,
            live: {
              ok: false,
              meEmail: 'exciteditem179@agentmail.to',
              accountCount: 1,
              workspaceId: TARGET_WORKSPACE_ID,
              workspaceAccountSelected: true,
              sessionValid: true,
              blockerReason: 'live-codex-probe-failed',
              reason: 'live pi probe exited with code 1',
              liveProbe: {
                ok: true,
                exitCode: 1,
                stderr: 'Error: No API key found for provider',
              },
            },
            parentAgreement: { ok: true, reason: null },
            codexLbAgreement: { ok: true, reason: null },
          },
        ],
      },
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.state).toBe('ready');
    expect(verdict.blockers).toEqual([]);
  });

  test('does not surface off-target owner-candidate residue as a wrong-lineage blocker in the ready path', () => {
    const protectedAliasContract = buildProtectedAliasContract({
      targetWorkspaceId: TARGET_WORKSPACE_ID,
      controlPlane: {
        version: 1,
        workspaces: {
          [TARGET_WORKSPACE_ID]: {
            workspaceId: TARGET_WORKSPACE_ID,
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
            ownerAccountId: 'workspace-off-target',
            lineage: 'workspace-owner-b',
          },
          {
            ownerAliasId: 'openai-codex',
            ownerEmail: 'worker@example.com',
            ownerAccountId: 'workspace-off-target',
            lineage: 'openai-codex',
          },
        ],
      },
    });

    const verdict = evaluateCanonicalPreflight({
      ...makeBaseInput(),
      protectedAliasContract,
    });

    expect(protectedAliasContract.wrongLineageResidue).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.state).toBe('ready');
    expect(verdict.blockers).toEqual([]);
  });

  test('blocks fallback-only registry sources and stale registry observations', () => {
    const fallbackVerdict = evaluateCanonicalPreflight({
      ...makeBaseInput(),
      registrySource: 'fallback-runtime',
    });
    expect(fallbackVerdict.ok).toBe(false);
    expect(fallbackVerdict.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'registry-fallback-runtime' }),
    ]));

    const staleVerdict = evaluateCanonicalPreflight({
      ...makeBaseInput(),
      registry: {
        discoveredAt: Date.parse('2026-04-07T11:00:00.000Z'),
        workspaces: [{
          workspaceId: TARGET_WORKSPACE_ID,
          verificationSource: 'workspace-list-users',
          lastVerifiedAt: '2026-04-07T10:59:00.000Z',
          provenOwnerCapable: true,
          currentMembers: 2,
          maxMembers: 8,
        }],
      },
    });
    expect(staleVerdict.ok).toBe(false);
    expect(staleVerdict.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'registry-stale' }),
    ]));
  });

  test('still blocks real runtime workspace mismatch and codex-lb disagreement', () => {
    const mismatchVerdict = evaluateCanonicalPreflight({
      ...makeBaseInput(),
      liveAuthorityFacts: {
        codexLbStatus: { ready: true, reason: null },
        aliases: [
          {
            aliasId: 'exciteditem179',
            email: 'exciteditem179@agentmail.to',
            workspaceId: TARGET_WORKSPACE_ID,
            live: {
              ok: false,
              meEmail: 'exciteditem179@agentmail.to',
              accountCount: 1,
              workspaceId: TARGET_WORKSPACE_ID,
              workspaceAccountSelected: false,
              sessionValid: true,
            },
            parentAgreement: { ok: true, reason: null },
            codexLbAgreement: { ok: true, reason: null },
          },
        ],
      },
    });

    expect(mismatchVerdict.ok).toBe(false);
    expect(mismatchVerdict.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'authority-facts-unsafe' }),
    ]));

    const disagreementVerdict = evaluateCanonicalPreflight({
      ...makeBaseInput(),
      liveAuthorityFacts: {
        codexLbStatus: { ready: true, reason: null },
        aliases: [
          {
            aliasId: 'exciteditem179',
            email: 'exciteditem179@agentmail.to',
            workspaceId: TARGET_WORKSPACE_ID,
            live: {
              ok: false,
              meEmail: 'exciteditem179@agentmail.to',
              accountCount: 1,
              workspaceId: TARGET_WORKSPACE_ID,
              workspaceAccountSelected: true,
              sessionValid: true,
            },
            parentAgreement: { ok: true, reason: null },
            codexLbAgreement: { ok: false, reason: 'store-disagreement' },
          },
        ],
      },
    });

    expect(disagreementVerdict.ok).toBe(false);
    expect(disagreementVerdict.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'authority-facts-unsafe' }),
    ]));
  });

  test('blocks unproven owner capability, scrub targets, protected alias overlap, wrong-lineage residue, and authority disagreement', () => {
    const verdict = evaluateCanonicalPreflight({
      ...makeBaseInput(),
      registry: {
        discoveredAt: Date.parse('2026-04-07T11:55:00.000Z'),
        workspaces: [{
          workspaceId: TARGET_WORKSPACE_ID,
          verificationSource: 'workspace-list-users',
          lastVerifiedAt: '2026-04-07T11:58:00.000Z',
          provenOwnerCapable: false,
          currentMembers: 8,
          maxMembers: 8,
        }],
      },
      liveFixPreparation: {
        ...makeBaseInput().liveFixPreparation,
        allowedAliasIds: ['exciteditem179'],
        actionableResolvedAliases: [{ aliasId: 'exciteditem179', email: 'exciteditem179@agentmail.to' }],
        usableCapacityBeforeBootstrap: 0,
        workspaceSeatCapacityBlockers: [{
          workspaceId: TARGET_WORKSPACE_ID,
          reason: 'workspace-seat-cap-reached',
          currentMembers: 8,
          maxMembers: 8,
        }],
      },
      cleanupCandidates: [{ aliasId: 'exciteditem179', email: 'exciteditem179@agentmail.to' }],
      scrubTargets: [{ aliasId: 'scrub-me', email: 'scrub@agentmail.to' }],
      protectedAliasContract: {
        ...makeBaseInput().protectedAliasContract,
        wrongLineageResidue: [{ aliasId: 'workspace-owner-b', email: 'nastypolicy361@agentmail.to' }],
        controlPlaneStatus: {
          liveOwnerAdmin: null,
        },
      },
      liveAuthorityFacts: {
        codexLbStatus: { ready: true, reason: null },
        aliases: [
          {
            aliasId: 'cruelfigure620',
            email: 'cruelfigure620@agentmail.to',
            workspaceId: TARGET_WORKSPACE_ID,
            live: {
              ok: false,
              workspaceId: TARGET_WORKSPACE_ID,
              workspaceAccountSelected: false,
              sessionValid: false,
            },
            parentAgreement: { ok: false, reason: 'agentmail-parent-lineage-mismatch' },
            codexLbAgreement: { ok: false, reason: 'store-disagreement' },
          },
        ],
      },
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'owner-capability-unproven' }),
      expect.objectContaining({ code: 'workspace-seat-cap-reached' }),
      expect.objectContaining({ code: 'replacement-supply-unproven' }),
      expect.objectContaining({ code: 'seat-hygiene-required' }),
      expect.objectContaining({ code: 'protected-alias-targeted' }),
      expect.objectContaining({ code: 'wrong-lineage-residue-present' }),
      expect.objectContaining({ code: 'authority-facts-unsafe' }),
    ]));
  });

  test('surfaces a structured fresh-identity blocker alongside replacement supply uncertainty', () => {
    const verdict = evaluateCanonicalPreflight({
      ...makeBaseInput(),
      liveFixPreparation: {
        ...makeBaseInput().liveFixPreparation,
        usableCapacityBeforeBootstrap: 0,
        freshIdentityResult: {
          status: 'fresh-identity-unavailable',
          blockerReason: 'fresh-identity-unavailable',
          reason: 'agentmail-inbox-capacity-exhausted',
          error: 'LimitExceededError: inbox capacity exhausted',
          freshIdentity: {
            required: true,
            acquired: false,
            source: null,
            persisted: false,
            reason: 'agentmail-inbox-capacity-exhausted',
          },
        },
      },
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'fresh-identity-unavailable',
        message: expect.stringContaining('agentmail-inbox-capacity-exhausted'),
      }),
      expect.objectContaining({ code: 'replacement-supply-unproven' }),
    ]));
  });
});