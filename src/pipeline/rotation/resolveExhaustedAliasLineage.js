function workspaceAvailableSeats(workspace = {}) {
  if (typeof workspace.maxMembers !== 'number') return Number.POSITIVE_INFINITY;
  return (workspace.maxMembers ?? 0) - (workspace.currentMembers ?? 0);
}

function compareWorkspaceEvidence(left, right) {
  const ownerEmailDelta = Number(Boolean(right.ownerEmail)) - Number(Boolean(left.ownerEmail));
  if (ownerEmailDelta !== 0) return ownerEmailDelta;

  const healthyDelta = (right.healthyAccounts ?? 0) - (left.healthyAccounts ?? 0);
  if (healthyDelta !== 0) return healthyDelta;

  const seatDelta = workspaceAvailableSeats(right) - workspaceAvailableSeats(left);
  if (seatDelta !== 0) return seatDelta;

  return String(left.ownerAliasId ?? '').localeCompare(String(right.ownerAliasId ?? ''));
}

function buildResolvedAlias(alias = {}, accountId = null, workspace = {}, resolutionSource = 'auth-account-workspace-match', confidence = 'high', extraPlacementContext = {}) {
  return {
    aliasId: alias.aliasId ?? null,
    email: alias.email ?? null,
    accountId,
    workspaceId: workspace.workspaceId ?? null,
    workspaceName: workspace.workspaceName ?? null,
    ownerAliasId: workspace.ownerAliasId ?? null,
    ownerEmail: workspace.ownerEmail ?? null,
    lineage: workspace.lineage ?? alias.lineage ?? alias.workspaceLineage ?? null,
    resolutionSource,
    confidence,
    placementContext: {
      aliasId: alias.aliasId ?? null,
      aliasEmail: alias.email ?? null,
      lineage: workspace.lineage ?? alias.lineage ?? alias.workspaceLineage ?? null,
      workspaceId: workspace.workspaceId ?? null,
      workspaceName: workspace.workspaceName ?? null,
      ownerAliasId: workspace.ownerAliasId ?? null,
      ownerEmail: workspace.ownerEmail ?? null,
      ...extraPlacementContext,
    },
    workspace,
  };
}

export async function resolveExhaustedAliasLineage({
  exhaustedAliases = [],
  auth = {},
  registry = {},
} = {}) {
  const resolved = [];
  const unresolved = [];
  const usableByLineage = registry.usableByLineage ?? {};
  const observedWorkspaces = registry.observedWorkspaces ?? [];

  for (const alias of exhaustedAliases) {
    const authEntry = auth?.[alias.aliasId] ?? null;
    const accountId = authEntry?.accountId ?? null;
    if (!accountId) {
      unresolved.push({
        aliasId: alias.aliasId ?? null,
        email: alias.email ?? null,
        reason: 'auth-account-id-missing',
      });
      continue;
    }

    const workspaceMatches = (registry.workspaces ?? [])
      .filter((workspace) => workspace.workspaceId === accountId)
      .sort(compareWorkspaceEvidence);

    if (workspaceMatches.length > 0) {
      const explicitOwnerMatch = workspaceMatches.find((workspace) => workspace.ownerAliasId === alias.aliasId)
        ?? workspaceMatches.find((workspace) => workspace.lineage && (workspace.lineage === alias.lineage || workspace.lineage === alias.workspaceLineage));
      if (explicitOwnerMatch) {
        resolved.push(buildResolvedAlias(alias, accountId, explicitOwnerMatch, 'auth-account-owner-alias-match', 'high'));
        continue;
      }

      const top = workspaceMatches[0];
      const runnerUp = workspaceMatches[1] ?? null;
      const topHealthy = top?.healthyAccounts ?? 0;
      const runnerUpHealthy = runnerUp?.healthyAccounts ?? null;
      const topSeats = workspaceAvailableSeats(top);
      const runnerUpSeats = runnerUp ? workspaceAvailableSeats(runnerUp) : null;
      const topHasOwnerEmail = Boolean(top?.ownerEmail);
      const runnerUpHasOwnerEmail = Boolean(runnerUp?.ownerEmail);
      if (runnerUp && runnerUpHasOwnerEmail === topHasOwnerEmail && runnerUpHealthy === topHealthy && runnerUpSeats === topSeats) {
        unresolved.push({
          aliasId: alias.aliasId ?? null,
          email: alias.email ?? null,
          accountId,
          reason: 'workspace-match-ambiguous',
          candidateOwnerAliasIds: workspaceMatches.map((workspace) => workspace.ownerAliasId ?? null),
        });
        continue;
      }

      resolved.push(buildResolvedAlias(alias, accountId, top, 'auth-account-workspace-match', 'high'));
      continue;
    }

    const observedMatch = observedWorkspaces
      .filter((workspace) => workspace.workspaceId === accountId)
      .sort(compareWorkspaceEvidence)[0] ?? null;
    const fallbackLineage = observedMatch?.lineage ?? alias.lineage ?? alias.workspaceLineage ?? null;
    const usableFallback = fallbackLineage ? usableByLineage[fallbackLineage] ?? null : null;

    if (observedMatch && usableFallback) {
      resolved.push(buildResolvedAlias(alias, accountId, usableFallback, 'observed-workspace-lineage-usable-fallback', 'medium', {
        observedWorkspaceId: observedMatch.workspaceId ?? null,
        observedWorkspaceName: observedMatch.workspaceName ?? null,
        observedWorkspaceDeactivated: observedMatch.deactivated === true,
      }));
      continue;
    }

    unresolved.push({
      aliasId: alias.aliasId ?? null,
      email: alias.email ?? null,
      accountId,
      observedWorkspaceId: observedMatch?.workspaceId ?? null,
      lineage: fallbackLineage,
      reason: observedMatch ? 'no-usable-workspace-for-lineage' : 'workspace-not-found-for-account-id',
    });
  }

  return {
    resolved,
    unresolved,
  };
}
