import { hasRuntimeWorkspaceAccessProof } from '../pipeline/rotation/liveAuthorityHealth.js';

function normalizeString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeEmail(value) {
  const text = normalizeString(value);
  return text ? text.toLowerCase() : null;
}

function isRoleEligible(role = null) {
  const normalized = normalizeString(role);
  return normalized === 'account-admin' || normalized === 'account-owner';
}

function isStaleTimestamp(value, { nowMs = Date.now(), maxAgeMs = 10 * 60 * 1000 } = {}) {
  const parsed = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) return true;
  return (nowMs - parsed) > maxAgeMs;
}

function protectedOverlap(items = [], protectedAliasIds = new Set(), protectedEmails = new Set()) {
  return (items ?? []).filter((item) => (
    (item?.aliasId && protectedAliasIds.has(item.aliasId))
    || protectedEmails.has(normalizeEmail(item?.email))
  ));
}

function freshIdentityUnavailableBlocker(freshIdentityResult = null) {
  if (
    freshIdentityResult?.status !== 'fresh-identity-unavailable'
    && freshIdentityResult?.blockerReason !== 'fresh-identity-unavailable'
  ) {
    return null;
  }

  const reason = normalizeString(
    freshIdentityResult?.reason
    ?? freshIdentityResult?.freshIdentity?.reason
    ?? freshIdentityResult?.error
    ?? null,
  );
  return {
    code: 'fresh-identity-unavailable',
    message: reason
      ? `Preflight blocked: fresh identity is unavailable after canonical supply exhaustion (${reason}).`
      : 'Preflight blocked: fresh identity is unavailable after canonical supply exhaustion.',
    details: {
      freshIdentityResult,
    },
  };
}

function authorityUnsafeAliases({
  liveAuthorityFacts = {},
  protectedAliasIds = new Set(),
  protectedEmails = new Set(),
  targetWorkspaceId = null,
} = {}) {
  return (liveAuthorityFacts.aliases ?? []).filter((alias) => {
    const inTargetWorkspace = normalizeString(alias?.workspaceId) === normalizeString(targetWorkspaceId);
    if (!inTargetWorkspace) return false;

    const protectedAlias = protectedAliasIds.has(alias?.aliasId) || protectedEmails.has(normalizeEmail(alias?.email));
    if (alias?.parentAgreement?.ok === false || alias?.codexLbAgreement?.ok === false) {
      return true;
    }
    if (!protectedAlias) return false;
    return hasRuntimeWorkspaceAccessProof(alias?.live) !== true;
  });
}

function deriveMutationPathSummary({
  liveFixPreparation = {},
  cleanupCandidates = [],
  scrubTargets = [],
} = {}) {
  const replacementDemand = (liveFixPreparation.allowedAliasIds ?? []).length;
  const routerOnboardDemand = Number.isFinite(liveFixPreparation.routerOnboardDemandCount)
    ? Number(liveFixPreparation.routerOnboardDemandCount)
    : (liveFixPreparation.routerOnboardCandidates ?? []).length;
  const cleanupCandidateCount = (cleanupCandidates ?? []).length;
  const scrubTargetCount = (scrubTargets ?? []).length;
  const actionableDemand = replacementDemand + routerOnboardDemand;
  const hasMutationPath = actionableDemand > 0;

  return {
    replacementDemand,
    routerOnboardDemand,
    cleanupCandidateCount,
    scrubTargetCount,
    actionableDemand,
    hasMutationPath,
  };
}

export function evaluateCanonicalPreflight({
  liveFixPreparation = {},
  liveAuthorityFacts = {},
  protectedAliasContract = {},
  registry = {},
  registrySource = 'operational',
  cleanupCandidates = [],
  scrubTargets = [],
  targetWorkspaceId = null,
  nowMs = Date.now(),
  registryMaxAgeMs = 10 * 60 * 1000,
} = {}) {
  const mutationPaths = deriveMutationPathSummary({
    liveFixPreparation,
    cleanupCandidates,
    scrubTargets,
  });

  if (!mutationPaths.hasMutationPath) {
    return {
      ok: true,
      state: 'no-op',
      blockers: [],
      evidence: {
        targetWorkspaceId,
        registrySource,
        actionableDemand: mutationPaths.actionableDemand,
        replacementDemand: mutationPaths.replacementDemand,
        routerOnboardDemand: mutationPaths.routerOnboardDemand,
        usableCapacityBeforeBootstrap: Number(liveFixPreparation.usableCapacityBeforeBootstrap ?? 0),
        restorableArchivedCapacity: Number(liveFixPreparation.restorableArchivedCapacity ?? 0),
        cleanupCandidateCount: mutationPaths.cleanupCandidateCount,
        scrubTargetCount: mutationPaths.scrubTargetCount,
        hasMutationPath: mutationPaths.hasMutationPath,
        protectedAliasCount: (protectedAliasContract.protectedAliasIds ?? []).length,
        wrongLineageResidueCount: (protectedAliasContract.wrongLineageResidue ?? []).length,
      },
    };
  }

  const blockers = [];
  const protectedAliasIds = new Set((protectedAliasContract.protectedAliasIds ?? []).filter(Boolean));
  const protectedEmails = new Set((protectedAliasContract.protectedEmails ?? []).map((email) => normalizeEmail(email)).filter(Boolean));
  const targetWorkspace = (registry.workspaces ?? []).find((workspace) => normalizeString(workspace?.workspaceId) === normalizeString(targetWorkspaceId)) ?? null;
  const liveOwnerAdmin = protectedAliasContract.controlPlaneStatus?.liveOwnerAdmin ?? null;
  const ownerCapabilityProven = targetWorkspace?.provenOwnerCapable === true
    || (liveOwnerAdmin?.usable === true && isRoleEligible(liveOwnerAdmin?.ownerRole));

  if (registrySource !== 'operational') {
    blockers.push({
      code: 'registry-fallback-runtime',
      message: 'Preflight blocked: workspace registry source is fallback/runtime-only, not operational live discovery.',
    });
  }

  if (!targetWorkspace) {
    blockers.push({
      code: 'registry-target-workspace-missing',
      message: `Preflight blocked: target workspace ${targetWorkspaceId ?? '(missing)'} is absent from the live workspace registry.`,
    });
  } else {
    if (targetWorkspace.verificationSource === 'owner-auth-fallback') {
      blockers.push({
        code: 'registry-fallback-only',
        message: `Preflight blocked: target workspace ${targetWorkspace.workspaceId} is sourced only from owner-auth fallback.`,
      });
    }
    if (
      isStaleTimestamp(registry?.discoveredAt, { nowMs, maxAgeMs: registryMaxAgeMs })
      || isStaleTimestamp(targetWorkspace?.lastVerifiedAt, { nowMs, maxAgeMs: registryMaxAgeMs })
    ) {
      blockers.push({
        code: 'registry-stale',
        message: `Preflight blocked: target workspace ${targetWorkspace.workspaceId} registry evidence is stale.`,
      });
    }
    if (!ownerCapabilityProven) {
      blockers.push({
        code: 'owner-capability-unproven',
        message: `Preflight blocked: owner capability is unproven for target workspace ${targetWorkspace.workspaceId}.`,
      });
    }
  }

  if ((liveFixPreparation.quarantineCandidates ?? []).length > 0) {
    blockers.push({
      code: 'workspace-quarantine-required',
      message: `Preflight blocked: ${liveFixPreparation.quarantineCandidates.length} alias(es) require quarantine before any mutation.`,
      details: { quarantineCandidates: liveFixPreparation.quarantineCandidates },
    });
  }

  if ((liveFixPreparation.workspaceSeatCapacityBlockers ?? []).length > 0) {
    blockers.push({
      code: 'workspace-seat-cap-reached',
      message: `Preflight blocked: target workspace is at seat capacity and append-before-remove is unsafe.`,
      details: { workspaceSeatCapacityBlockers: liveFixPreparation.workspaceSeatCapacityBlockers },
    });
  }

  const freshIdentityBlocker = freshIdentityUnavailableBlocker(liveFixPreparation.freshIdentityResult);
  if (freshIdentityBlocker) {
    blockers.push(freshIdentityBlocker);
  }

  if (mutationPaths.replacementDemand > Number(liveFixPreparation.usableCapacityBeforeBootstrap ?? 0)) {
    blockers.push({
      code: 'replacement-supply-unproven',
      message: `Preflight blocked: actionable demand ${mutationPaths.replacementDemand} exceeds currently proven usable capacity ${Number(liveFixPreparation.usableCapacityBeforeBootstrap ?? 0)}.`,
    });
  }

  if ((scrubTargets ?? []).length > 0) {
    blockers.push({
      code: 'seat-hygiene-required',
      message: `Preflight blocked: ${scrubTargets.length} owner-admin scrub target(s) remain and residue scrub is not allowed in unattended preflight.`,
      details: { scrubTargets },
    });
  }

  const protectedTargets = [
    ...protectedOverlap(liveFixPreparation.actionableResolvedAliases ?? [], protectedAliasIds, protectedEmails),
    ...protectedOverlap(cleanupCandidates ?? [], protectedAliasIds, protectedEmails),
    ...protectedOverlap(scrubTargets ?? [], protectedAliasIds, protectedEmails),
  ];
  if (protectedTargets.length > 0) {
    blockers.push({
      code: 'protected-alias-targeted',
      message: `Preflight blocked: protected aliases are present in actionable or cleanup candidate sets.`,
      details: { protectedTargets },
    });
  }

  if ((protectedAliasContract.wrongLineageResidue ?? []).length > 0) {
    blockers.push({
      code: 'wrong-lineage-residue-present',
      message: `Preflight blocked: wrong-lineage residue remains in live authority inputs.`,
      details: { wrongLineageResidue: protectedAliasContract.wrongLineageResidue },
    });
  }

  if (liveAuthorityFacts?.codexLbStatus?.ready !== true) {
    blockers.push({
      code: 'authority-facts-unsafe',
      message: 'Preflight blocked: codex-lb lifecycle store is not ready for live authority verification.',
    });
  } else {
    const unsafeAliases = authorityUnsafeAliases({
      liveAuthorityFacts,
      protectedAliasIds,
      protectedEmails,
      targetWorkspaceId,
    });
    if (unsafeAliases.length > 0) {
      blockers.push({
        code: 'authority-facts-unsafe',
        message: `Preflight blocked: live authority facts show protected or target-workspace disagreement.`,
        details: { unsafeAliases },
      });
    }
  }

  const state = blockers.length > 0
    ? 'blocked'
    : (mutationPaths.hasMutationPath ? 'ready' : 'no-op');

  return {
    ok: blockers.length === 0,
    state,
    blockers,
    evidence: {
      targetWorkspaceId,
      registrySource,
      actionableDemand: mutationPaths.actionableDemand,
      replacementDemand: mutationPaths.replacementDemand,
      routerOnboardDemand: mutationPaths.routerOnboardDemand,
      usableCapacityBeforeBootstrap: Number(liveFixPreparation.usableCapacityBeforeBootstrap ?? 0),
      restorableArchivedCapacity: Number(liveFixPreparation.restorableArchivedCapacity ?? 0),
      cleanupCandidateCount: mutationPaths.cleanupCandidateCount,
      scrubTargetCount: mutationPaths.scrubTargetCount,
      hasMutationPath: mutationPaths.hasMutationPath,
      protectedAliasCount: (protectedAliasContract.protectedAliasIds ?? []).length,
      wrongLineageResidueCount: (protectedAliasContract.wrongLineageResidue ?? []).length,
    },
  };
}