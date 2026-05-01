import { buildWorkspaceControlPlaneStatus } from '../../agentmail/controlPlane.js';

const LITERAL_PRESERVED_ALIAS = {
  aliasId: 'exciteditem179',
  email: 'exciteditem179@agentmail.to',
  provenance: 'literal-preserved',
  source: 'literal',
};

function normalizeString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeEmail(value) {
  const text = normalizeString(value);
  return text ? text.toLowerCase() : null;
}

function activeCodexAliasIds(routerData = {}) {
  const activeRouterAliases = (routerData.aliases ?? []).filter((alias) => (
    alias?.cloneFrom === 'openai-codex'
    && alias?.disabled !== true
    && normalizeString(alias?.id)
  ));
  const activeRouterAliasIdSet = new Set(activeRouterAliases.map((alias) => alias.id));
  const pool = (routerData.pools ?? []).find((entry) => entry?.name === 'openai-codex');
  if (Array.isArray(pool?.providers) && pool.providers.length > 0) {
    return new Set(pool.providers.filter((aliasId) => activeRouterAliasIdSet.has(aliasId)));
  }
  return activeRouterAliasIdSet;
}

function canonicalMismatch(candidate = {}, canonicalParent = null) {
  if (!canonicalParent) return false;
  const ownerAliasId = normalizeString(candidate.ownerAliasId);
  const lineage = normalizeString(candidate.lineage);
  if (canonicalParent.ownerAliasId && ownerAliasId && canonicalParent.ownerAliasId !== ownerAliasId) {
    return true;
  }
  return Boolean(canonicalParent.lineage && lineage && canonicalParent.lineage !== lineage);
}

function pushWrongLineageResidue(residueMap, candidate = {}, { reason = 'wrong-lineage-residue' } = {}) {
  const aliasId = normalizeString(candidate.aliasId ?? candidate.ownerAliasId);
  const email = normalizeEmail(candidate.email ?? candidate.ownerEmail ?? candidate.rootEmail);
  const key = aliasId ?? email;
  if (!key) return;
  if (residueMap.has(key)) return;
  residueMap.set(key, {
    aliasId,
    email,
    ownerAliasId: normalizeString(candidate.ownerAliasId),
    lineage: normalizeString(candidate.lineage),
    rootEmail: normalizeEmail(candidate.rootEmail),
    source: normalizeString(candidate.source) ?? 'unknown',
    reason,
  });
}

function selectCanonicalParentPoolCandidate(poolData = {}, canonicalParent = null, residueMap) {
  for (const entry of (poolData.entries ?? [])) {
    const candidate = {
      ownerAliasId: entry.ownerAliasId ?? null,
      lineage: entry.lineage ?? entry.workspaceGroupKey ?? null,
      email: entry.rootEmail ?? entry.ownerEmail ?? entry.inboxAddress ?? null,
      rootEmail: entry.rootEmail ?? null,
      source: 'pool',
    };
    if (canonicalMismatch(candidate, canonicalParent)) {
      pushWrongLineageResidue(residueMap, candidate);
      continue;
    }
    if (canonicalParent?.ownerAliasId && normalizeString(entry.ownerAliasId) !== canonicalParent.ownerAliasId) {
      continue;
    }
    return candidate;
  }
  return null;
}

function selectCanonicalParentRouterCandidate(routerData = {}, targetWorkspaceId = null, canonicalParent = null, residueMap) {
  const activeAliasIdSet = activeCodexAliasIds(routerData);
  for (const alias of (routerData.aliases ?? [])) {
    if (!activeAliasIdSet.has(alias?.id)) continue;
    const placementContext = alias?.placementContext ?? {};
    const candidate = {
      ownerAliasId: placementContext.ownerAliasId ?? alias.ownerAliasId ?? null,
      lineage: placementContext.lineage ?? alias.lineage ?? alias.workspaceLineage ?? null,
      email: placementContext.rootEmail ?? placementContext.ownerEmail ?? alias.rootEmail ?? alias.ownerEmail ?? alias.email ?? null,
      rootEmail: placementContext.rootEmail ?? alias.rootEmail ?? null,
      workspaceId: placementContext.workspaceId ?? alias.workspaceId ?? null,
      source: 'active-router',
    };
    if (normalizeString(candidate.workspaceId) !== normalizeString(targetWorkspaceId)) continue;
    if (canonicalMismatch(candidate, canonicalParent)) {
      pushWrongLineageResidue(residueMap, candidate);
      continue;
    }
    return candidate;
  }
  return null;
}

function selectCanonicalParentRegistryCandidate(registry = {}, targetWorkspaceId = null, canonicalParent = null, residueMap) {
  for (const workspace of [...(registry.workspaces ?? []), ...(registry.observedWorkspaces ?? [])]) {
    const candidate = {
      ownerAliasId: workspace.ownerAliasId ?? null,
      lineage: workspace.lineage ?? workspace.ownerAliasId ?? null,
      email: workspace.ownerEmail ?? null,
      rootEmail: workspace.ownerEmail ?? null,
      workspaceId: workspace.workspaceId ?? workspace.ownerAccountId ?? null,
      source: 'workspace-registry',
    };
    if (normalizeString(candidate.workspaceId) !== normalizeString(targetWorkspaceId)) continue;
    if (canonicalMismatch(candidate, canonicalParent)) {
      pushWrongLineageResidue(residueMap, candidate);
      continue;
    }
    return candidate;
  }
  return null;
}

function selectCanonicalParentOwnerCandidate(registry = {}, targetWorkspaceId = null, canonicalParent = null, residueMap) {
  for (const owner of (registry.ownerCandidates ?? [])) {
    const candidate = {
      ownerAliasId: owner.ownerAliasId ?? null,
      lineage: owner.lineage ?? owner.ownerAliasId ?? null,
      email: owner.ownerEmail ?? null,
      rootEmail: owner.ownerEmail ?? null,
      workspaceId: owner.ownerAccountId ?? null,
      source: 'owner-candidate',
    };
    if (normalizeString(candidate.workspaceId) !== normalizeString(targetWorkspaceId)) continue;
    if (canonicalMismatch(candidate, canonicalParent)) {
      pushWrongLineageResidue(residueMap, candidate);
      continue;
    }
    return candidate;
  }
  return null;
}

function ownerCandidateTargetsWorkspace(ownerCandidate = {}, targetWorkspaceId = null) {
  const ownerWorkspaceId = normalizeString(ownerCandidate.ownerAccountId ?? ownerCandidate.workspaceId);
  const normalizedTargetWorkspaceId = normalizeString(targetWorkspaceId);
  return Boolean(ownerWorkspaceId && normalizedTargetWorkspaceId && ownerWorkspaceId === normalizedTargetWorkspaceId);
}

function selectLiveOwnerAdminEmailCandidate({
  controlPlaneStatus = {},
  routerData = {},
  poolData = {},
  authData = {},
  registry = {},
  residueMap,
}) {
  const canonicalParent = controlPlaneStatus.canonicalParent ?? null;
  const liveOwnerAliasId = normalizeString(controlPlaneStatus.liveOwnerAdmin?.ownerAliasId);
  if (!liveOwnerAliasId) return null;

  const preservedAlias = (controlPlaneStatus.preservedActiveAliases ?? []).find((alias) => normalizeString(alias.aliasId) === liveOwnerAliasId);
  if (preservedAlias && !canonicalMismatch(preservedAlias, canonicalParent)) {
    return { email: preservedAlias.email ?? null, source: 'preserved-active-alias' };
  }
  if (preservedAlias) {
    pushWrongLineageResidue(residueMap, { ...preservedAlias, source: 'preserved-active-alias' });
  }

  const activeAliasIdSet = activeCodexAliasIds(routerData);
  const routerAlias = (routerData.aliases ?? []).find((alias) => activeAliasIdSet.has(alias?.id) && normalizeString(alias.id) === liveOwnerAliasId);
  if (routerAlias) {
    const candidate = {
      ownerAliasId: routerAlias?.placementContext?.ownerAliasId ?? routerAlias.ownerAliasId ?? null,
      lineage: routerAlias?.placementContext?.lineage ?? routerAlias.lineage ?? routerAlias.workspaceLineage ?? null,
      email: routerAlias.email ?? null,
      source: 'active-router',
    };
    if (!canonicalMismatch(candidate, canonicalParent)) {
      return candidate;
    }
    pushWrongLineageResidue(residueMap, candidate);
  }

  const poolEntry = (poolData.entries ?? []).find((entry) => normalizeString(entry.linkedAliasId) === liveOwnerAliasId);
  if (poolEntry) {
    const candidate = {
      ownerAliasId: poolEntry.ownerAliasId ?? null,
      lineage: poolEntry.lineage ?? poolEntry.workspaceGroupKey ?? null,
      email: poolEntry.inboxAddress ?? null,
      source: 'pool',
    };
    if (!canonicalMismatch(candidate, canonicalParent)) {
      return candidate;
    }
    pushWrongLineageResidue(residueMap, candidate);
  }

  const authEntry = authData?.[liveOwnerAliasId] ?? null;
  if (authEntry?.email) {
    return {
      email: normalizeEmail(authEntry.email),
      source: 'auth',
    };
  }

  for (const workspace of [...(registry.workspaces ?? []), ...(registry.observedWorkspaces ?? [])]) {
    if (normalizeString(workspace.ownerAliasId) !== liveOwnerAliasId) continue;
    const candidate = {
      ownerAliasId: workspace.ownerAliasId ?? null,
      lineage: workspace.lineage ?? workspace.ownerAliasId ?? null,
      email: workspace.ownerEmail ?? null,
      source: 'workspace-registry',
    };
    if (!canonicalMismatch(candidate, canonicalParent)) {
      return candidate;
    }
    pushWrongLineageResidue(residueMap, candidate);
  }

  return null;
}

function mergeProtectedEntry(current = {}, next = {}) {
  const merged = {
    aliasId: current.aliasId ?? next.aliasId ?? null,
    email: current.email ?? next.email ?? null,
    provenance: current.provenance ?? next.provenance ?? null,
    source: current.source ?? next.source ?? 'unknown',
  };
  if (!current.email && next.email) {
    merged.email = next.email;
    merged.source = next.source ?? merged.source;
  }
  return merged;
}

function findExistingProtectedEntry(entryMap, { aliasId = null, email = null } = {}) {
  if (aliasId) {
    for (const [key, entry] of entryMap.entries()) {
      if (entry.aliasId === aliasId) {
        return { key, entry };
      }
    }
  }
  if (email) {
    for (const [key, entry] of entryMap.entries()) {
      if (entry.email === email) {
        return { key, entry };
      }
    }
  }
  return null;
}

function indexProtectedEntry(entryByAliasId, entryByEmail, entry = {}) {
  if (entry.aliasId) {
    entryByAliasId[entry.aliasId] = entry;
  }
  if (entry.email) {
    entryByEmail[entry.email] = entry;
  }
}

function addProtectedEntry(entryMap, entryByAliasId, entryByEmail, entry = {}) {
  const aliasId = normalizeString(entry.aliasId);
  const email = normalizeEmail(entry.email);
  const key = aliasId ?? email;
  if (!key) return;
  const normalized = {
    aliasId,
    email,
    provenance: normalizeString(entry.provenance),
    source: normalizeString(entry.source) ?? 'unknown',
  };
  const existingMatch = findExistingProtectedEntry(entryMap, normalized);
  if (existingMatch) {
    const merged = mergeProtectedEntry(existingMatch.entry, normalized);
    entryMap.set(existingMatch.key, merged);
    indexProtectedEntry(entryByAliasId, entryByEmail, merged);
    return;
  }
  entryMap.set(key, normalized);
  indexProtectedEntry(entryByAliasId, entryByEmail, normalized);
}

export function buildProtectedAliasContract({
  targetWorkspaceId,
  workspaceOwnerEmail = null,
  routerData = {},
  poolData = {},
  authData = {},
  registry = {},
  controlPlane = { version: 1, workspaces: {} },
  controlPlaneStatus = null,
} = {}) {
  const status = controlPlaneStatus ?? buildWorkspaceControlPlaneStatus({
    controlPlane,
    routerData,
    poolData,
    registry,
    targetWorkspaceId,
    workspaceOwnerEmail,
  });
  const canonicalParent = status.canonicalParent ?? null;
  const wrongLineageResidueMap = new Map();
  for (const residue of (status.crossLineageResidueAliases ?? [])) {
    pushWrongLineageResidue(wrongLineageResidueMap, { ...residue, source: residue.source ?? 'router' });
  }

  for (const ownerCandidate of (registry.ownerCandidates ?? [])) {
    const candidateAliasId = normalizeString(ownerCandidate.ownerAliasId);
    if (!candidateAliasId || (
      !candidateAliasId.startsWith('workspace-owner-')
      && candidateAliasId !== 'openai-codex'
    )) {
      continue;
    }
    if (!ownerCandidateTargetsWorkspace(ownerCandidate, targetWorkspaceId)) {
      continue;
    }
    if (canonicalMismatch(ownerCandidate, canonicalParent)) {
      pushWrongLineageResidue(wrongLineageResidueMap, {
        aliasId: ownerCandidate.ownerAliasId ?? null,
        email: ownerCandidate.ownerEmail ?? null,
        ownerAliasId: ownerCandidate.ownerAliasId ?? null,
        lineage: ownerCandidate.lineage ?? null,
        source: 'owner-candidate',
      });
    }
  }

  const entries = new Map();
  const entryByAliasId = {};
  const entryByEmail = {};

  if (canonicalParent?.ownerAliasId) {
    const canonicalSource = (() => {
      const canonicalEmail = normalizeEmail(canonicalParent.rootEmail ?? canonicalParent.ownerEmail);
      if (canonicalEmail) {
        return { email: canonicalEmail, source: 'control-plane-status' };
      }
      return selectCanonicalParentPoolCandidate(poolData, canonicalParent, wrongLineageResidueMap)
        ?? selectCanonicalParentRouterCandidate(routerData, targetWorkspaceId, canonicalParent, wrongLineageResidueMap)
        ?? selectCanonicalParentRegistryCandidate(registry, targetWorkspaceId, canonicalParent, wrongLineageResidueMap)
        ?? selectCanonicalParentOwnerCandidate(registry, targetWorkspaceId, canonicalParent, wrongLineageResidueMap);
    })();
    addProtectedEntry(entries, entryByAliasId, entryByEmail, {
      aliasId: canonicalParent.ownerAliasId,
      email: canonicalSource?.email ?? null,
      provenance: 'canonical-parent',
      source: canonicalSource?.source ?? 'control-plane-status',
    });
  }

  const liveOwnerAdmin = status.liveOwnerAdmin ?? null;
  const liveOwnerRole = normalizeString(liveOwnerAdmin?.ownerRole);
  const liveOwnerEligible = liveOwnerAdmin?.usable === true
    && (liveOwnerRole === 'account-admin' || liveOwnerRole === 'account-owner');
  if (liveOwnerEligible && liveOwnerAdmin?.ownerAliasId) {
    const liveOwnerEmailCandidate = selectLiveOwnerAdminEmailCandidate({
      controlPlaneStatus: status,
      routerData,
      poolData,
      authData,
      registry,
      residueMap: wrongLineageResidueMap,
    });
    addProtectedEntry(entries, entryByAliasId, entryByEmail, {
      aliasId: liveOwnerAdmin.ownerAliasId,
      email: liveOwnerEmailCandidate?.email ?? null,
      provenance: 'live-owner-admin',
      source: liveOwnerEmailCandidate?.source ?? 'workspace-registry',
    });
    for (const [key, residue] of wrongLineageResidueMap.entries()) {
      if (
        normalizeString(residue?.aliasId) === normalizeString(liveOwnerAdmin.ownerAliasId)
        || (
          liveOwnerEmailCandidate?.email
          && normalizeEmail(residue?.email) === normalizeEmail(liveOwnerEmailCandidate.email)
        )
      ) {
        wrongLineageResidueMap.delete(key);
      }
    }
  }

  addProtectedEntry(entries, entryByAliasId, entryByEmail, LITERAL_PRESERVED_ALIAS);

  const protectedAliasIds = [];
  const protectedEmails = [];
  for (const entry of entries.values()) {
    if (entry.aliasId) protectedAliasIds.push(entry.aliasId);
    if (entry.email) protectedEmails.push(entry.email);
  }

  return {
    protectedAliasIds,
    protectedEmails,
    entries: [...entries.values()],
    wrongLineageResidue: [...wrongLineageResidueMap.values()],
    entryByAliasId,
    entryByEmail,
    controlPlaneStatus: status,
  };
}