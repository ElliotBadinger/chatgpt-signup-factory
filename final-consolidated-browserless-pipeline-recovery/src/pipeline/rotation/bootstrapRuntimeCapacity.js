function countUsableCapacity(pool = {}) {
  return (pool.entries ?? []).filter((entry) => entry.status === 'available' || entry.status === 'prewarmed').length;
}

function workspaceAvailableSeats(workspace = {}) {
  if (typeof workspace.maxMembers !== 'number') return Number.POSITIVE_INFINITY;
  return (workspace.maxMembers ?? 0) - (workspace.currentMembers ?? 0);
}

function normalizedBootstrapSources(registry = {}) {
  const supplyRoots = (registry.usableSupplyRoots ?? []).map((root) => ({
    candidateType: 'supply-root',
    workspaceId: root.workspaceId ?? null,
    workspaceName: root.workspaceName ?? null,
    lineage: root.lineage ?? null,
    ownerAliasId: root.ownerAliasId ?? null,
    ownerEmail: root.rootEmail ?? root.ownerEmail ?? null,
    healthyAccounts: root.healthyAccounts ?? 0,
    currentMembers: root.currentMembers ?? 0,
    maxMembers: root.maxMembers ?? null,
    lastVerifiedAt: root.lastVerifiedAt ?? null,
  }));

  const workspaces = (registry.workspaces ?? []).map((workspace) => ({
    candidateType: 'workspace-owner',
    ...workspace,
  }));

  return [...supplyRoots, ...workspaces];
}

function rankBootstrapCandidates(registry = {}, { preferredLineages = null } = {}) {
  const preferredLineageSet = Array.isArray(preferredLineages) && preferredLineages.length > 0
    ? new Set(preferredLineages.filter(Boolean))
    : null;
  const byLineage = new Map();

  for (const workspace of normalizedBootstrapSources(registry)) {
    const lineage = workspace.lineage ?? null;
    if (!lineage) continue;
    if (preferredLineageSet && !preferredLineageSet.has(lineage)) continue;

    const existing = byLineage.get(lineage);
    if (!existing) {
      byLineage.set(lineage, workspace);
      continue;
    }

    if (existing.candidateType !== workspace.candidateType) {
      if (workspace.candidateType === 'supply-root') {
        byLineage.set(lineage, workspace);
      }
      continue;
    }

    const healthyDelta = (workspace.healthyAccounts ?? 0) - (existing.healthyAccounts ?? 0);
    if (healthyDelta > 0) {
      byLineage.set(lineage, workspace);
      continue;
    }
    if (healthyDelta === 0 && workspaceAvailableSeats(workspace) > workspaceAvailableSeats(existing)) {
      byLineage.set(lineage, workspace);
    }
  }

  return [...byLineage.values()].sort((left, right) => {
    const typeDelta = Number(right.candidateType === 'supply-root') - Number(left.candidateType === 'supply-root');
    if (typeDelta !== 0) return typeDelta;
    const healthyDelta = (right.healthyAccounts ?? 0) - (left.healthyAccounts ?? 0);
    if (healthyDelta !== 0) return healthyDelta;
    const seatsDelta = workspaceAvailableSeats(right) - workspaceAvailableSeats(left);
    if (seatsDelta !== 0) return seatsDelta;
    return String(left.ownerAliasId ?? '').localeCompare(String(right.ownerAliasId ?? ''));
  });
}

export async function bootstrapRuntimeCapacity({
  pool = {},
  exhaustedDemand = 0,
  registry = {},
  preferredLineages = null,
  bootstrapLineage,
} = {}) {
  if (typeof bootstrapLineage !== 'function') {
    throw new Error('bootstrapRuntimeCapacity requires bootstrapLineage');
  }

  const initialUsableCapacity = countUsableCapacity(pool);
  if (exhaustedDemand <= 0) {
    return {
      ok: true,
      triggered: false,
      initialUsableCapacity,
      createdCapacity: 0,
      remainingDemand: 0,
      createdEntries: [],
      excludedEntries: [],
      attempts: [],
      registryUpdates: {},
    };
  }

  if (initialUsableCapacity >= exhaustedDemand) {
    return {
      ok: true,
      triggered: false,
      initialUsableCapacity,
      createdCapacity: 0,
      remainingDemand: 0,
      createdEntries: [],
      excludedEntries: [],
      attempts: [],
      registryUpdates: {},
    };
  }

  let remainingDemand = Math.max(0, exhaustedDemand - initialUsableCapacity);
  const createdEntries = [];
  const excludedEntries = [];
  const attempts = [];
  const registryUpdates = { usableSupplyRoots: [] };
  const candidates = rankBootstrapCandidates(registry, { preferredLineages });

  for (const candidate of candidates) {
    if (remainingDemand <= 0) break;
    const result = await bootstrapLineage({
      lineage: candidate.lineage,
      ownerAliasId: candidate.ownerAliasId,
      ownerEmail: candidate.ownerEmail,
      workspaceId: candidate.workspaceId,
      workspaceName: candidate.workspaceName,
      knownPoolEntries: pool.entries ?? [],
      candidateType: candidate.candidateType,
    });
    const created = result?.createdEntries ?? [];
    excludedEntries.push(...(result?.excludedEntries ?? []));
    if (Array.isArray(result?.registryUpdates?.usableSupplyRoots)) {
      registryUpdates.usableSupplyRoots.push(...result.registryUpdates.usableSupplyRoots);
    }
    attempts.push({
      lineage: candidate.lineage,
      ownerAliasId: candidate.ownerAliasId,
      ownerEmail: candidate.ownerEmail,
      workspaceId: candidate.workspaceId,
      candidateType: candidate.candidateType,
      ok: result?.ok === true,
      reason: result?.reason ?? null,
      createdCapacity: created.length,
    });
    if (result?.ok === true) {
      createdEntries.push(...created);
      remainingDemand = Math.max(0, remainingDemand - created.length);
    }
  }

  return {
    ok: remainingDemand === 0,
    triggered: true,
    initialUsableCapacity,
    createdCapacity: createdEntries.length,
    remainingDemand,
    createdEntries,
    excludedEntries,
    attempts,
    registryUpdates,
    blockerReason: remainingDemand === 0 ? null : 'insufficient-capacity-after-bootstrap',
  };
}
