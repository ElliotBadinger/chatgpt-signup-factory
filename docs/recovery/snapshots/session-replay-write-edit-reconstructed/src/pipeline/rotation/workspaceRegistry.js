import fs from 'node:fs';
import path from 'node:path';

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function deriveLineage(ownerAliasId, ownerAuth = {}, workspace = {}) {
  return workspace.lineage
    ?? ownerAuth.lineage
    ?? ownerAuth.workspaceLineage
    ?? ownerAliasId;
}

function loadWorkspaceOwnerCandidates({ authPath, ownerFilter = () => true, nowMs = Date.now() } = {}) {
  const auth = readJson(authPath, {});
  return Object.entries(auth)
    .filter(([, entry]) => entry?.access && (entry?.expires == null || entry.expires > nowMs))
    .map(([ownerAliasId, ownerAuth], originalIndex) => ({ ownerAliasId, ownerAuth, originalIndex }))
    .filter(({ ownerAliasId, ownerAuth }) => ownerFilter({ ownerAliasId, ownerAuth }));
}

function candidatePriority({ ownerAliasId, ownerAuth = {} }) {
  let score = 100;
  if (ownerAuth.email) score -= 50;
  if (String(ownerAliasId).startsWith('workspace-owner-')) score -= 30;
  if (ownerAliasId === 'openai-codex') score -= 20;
  return score;
}

function workspaceAvailableSeats(workspace = {}) {
  if (typeof workspace.maxMembers !== 'number') return Number.POSITIVE_INFINITY;
  return (workspace.maxMembers ?? 0) - (workspace.currentMembers ?? 0);
}

function compareWorkspacePreference(left, right) {
  const healthyDelta = (right.healthyAccounts ?? 0) - (left.healthyAccounts ?? 0);
  if (healthyDelta !== 0) return healthyDelta;

  const seatDelta = workspaceAvailableSeats(right) - workspaceAvailableSeats(left);
  if (seatDelta !== 0) return seatDelta;

  return String(left.ownerAliasId ?? '').localeCompare(String(right.ownerAliasId ?? ''));
}

export function normalizeWorkspaceObservation({ workspace, ownerAliasId, ownerAuth = {}, nowMs = Date.now() } = {}) {
  const workspaceId = workspace?.workspaceId ?? workspace?.id ?? ownerAuth?.accountId ?? null;
  const eligibilityStatus = workspace?.eligibilityStatus
    ?? (workspace?.deactivated === true
      ? 'workspace-deactivated'
      : (workspace?.eligible === false ? 'workspace-ineligible' : 'usable'));
  const deactivated = workspace?.deactivated === true || eligibilityStatus === 'workspace-deactivated';
  const eligible = workspace?.eligible ?? (!deactivated && eligibilityStatus === 'usable');
  const usable = workspace?.usable ?? (eligible && !deactivated);
  const timestamp = new Date(nowMs).toISOString();

  return {
    workspaceId,
    workspaceName: workspace?.workspaceName ?? workspace?.name ?? null,
    ownerAliasId,
    ownerEmail: ownerAuth.email ?? null,
    ownerAccountId: ownerAuth.accountId ?? null,
    lineage: deriveLineage(ownerAliasId, ownerAuth, workspace ?? {}),
    currentMembers: workspace?.currentMembers ?? workspace?.memberCount ?? 0,
    maxMembers: workspace?.maxMembers ?? workspace?.capacity ?? null,
    healthyAccounts: workspace?.healthyAccounts ?? 0,
    observed: true,
    deactivated,
    eligible,
    usable,
    eligibilityStatus,
    verificationSource: workspace?.verificationSource ?? 'workspace-discovery',
    lastVerifiedAt: workspace?.lastVerifiedAt ?? workspace?.verifiedAt ?? timestamp,
    observedAt: workspace?.observedAt ?? timestamp,
    lastVerificationError: workspace?.lastVerificationError ?? null,
    raw: workspace ?? null,
  };
}

function sortObservedWorkspaces(observedWorkspaces = []) {
  return [...observedWorkspaces].sort((left, right) => {
    const lineageDelta = String(left.lineage ?? '').localeCompare(String(right.lineage ?? ''));
    if (lineageDelta !== 0) return lineageDelta;
    const usabilityDelta = Number(right.usable === true) - Number(left.usable === true);
    if (usabilityDelta !== 0) return usabilityDelta;
    return String(left.workspaceId ?? '').localeCompare(String(right.workspaceId ?? ''));
  });
}

export function buildUsableWorkspaceSelection({ observedWorkspaces = [] } = {}) {
  const normalizedObserved = sortObservedWorkspaces(observedWorkspaces);
  const usableWorkspaces = normalizedObserved.filter((workspace) => workspace.usable === true);
  const usableByLineage = Object.fromEntries(
    Object.entries(usableWorkspaces.reduce((groups, workspace) => {
      const lineage = workspace.lineage ?? null;
      if (!lineage) return groups;
      (groups[lineage] ??= []).push(workspace);
      return groups;
    }, {})).map(([lineage, group]) => [lineage, [...group].sort(compareWorkspacePreference)[0]]),
  );

  const owners = Object.values(usableByLineage).map((workspace) => ({
    ownerAliasId: workspace.ownerAliasId ?? null,
    ownerEmail: workspace.ownerEmail ?? null,
    ownerAccountId: workspace.ownerAccountId ?? null,
    lineage: workspace.lineage ?? null,
    workspaceId: workspace.workspaceId ?? null,
    workspaceName: workspace.workspaceName ?? null,
    usable: true,
    lastVerifiedAt: workspace.lastVerifiedAt ?? null,
  }));

  return {
    observedWorkspaces: normalizedObserved,
    usableWorkspaces,
    usableByLineage,
    owners,
    workspaces: usableWorkspaces,
  };
}

function normalizeSupplyRootRecord(root = {}, { nowMs = Date.now() } = {}) {
  return {
    rootEmail: root.rootEmail ?? root.ownerEmail ?? null,
    ownerEmail: root.rootEmail ?? root.ownerEmail ?? null,
    ownerAliasId: root.ownerAliasId ?? null,
    lineage: root.lineage ?? null,
    workspaceId: root.workspaceId ?? null,
    workspaceName: root.workspaceName ?? null,
    healthyAccounts: root.healthyAccounts ?? 0,
    currentMembers: root.currentMembers ?? 0,
    maxMembers: root.maxMembers ?? null,
    usable: root.usable !== false,
    source: root.source ?? 'live-bootstrap-new-root',
    lastVerifiedAt: root.lastVerifiedAt ?? new Date(nowMs).toISOString(),
  };
}

export function mergeUsableSupplyRoots(registry = {}, supplyRoots = [], { nowMs = Date.now() } = {}) {
  const merged = new Map();
  for (const root of [...(registry.usableSupplyRoots ?? []), ...supplyRoots]) {
    const normalized = normalizeSupplyRootRecord(root, { nowMs });
    if (!normalized.rootEmail || !normalized.lineage) continue;
    const key = `${normalized.lineage}::${normalized.rootEmail}::${normalized.workspaceId ?? ''}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, normalized);
      continue;
    }
    if (String(normalized.lastVerifiedAt ?? '') > String(existing.lastVerifiedAt ?? '')) {
      merged.set(key, normalized);
    }
  }

  const usableSupplyRoots = [...merged.values()].sort((left, right) => {
    const lineageDelta = String(left.lineage ?? '').localeCompare(String(right.lineage ?? ''));
    if (lineageDelta !== 0) return lineageDelta;
    return String(left.rootEmail ?? '').localeCompare(String(right.rootEmail ?? ''));
  });
  const usableSupplyRootsByLineage = Object.fromEntries(
    Object.entries(usableSupplyRoots.reduce((groups, root) => {
      const lineage = root.lineage ?? null;
      if (!lineage) return groups;
      (groups[lineage] ??= []).push(root);
      return groups;
    }, {})).map(([lineage, group]) => {
      const selected = [...group].sort((left, right) => String(right.lastVerifiedAt ?? '').localeCompare(String(left.lastVerifiedAt ?? '')))[0];
      return [lineage, selected];
    }),
  );

  return {
    ...registry,
    usableSupplyRoots,
    usableSupplyRootsByLineage,
  };
}

function persistRegistryCache(cachePath, registry) {
  if (!cachePath) return;
  writeJson(cachePath, registry);
}

export async function discoverWorkspaceRegistry({
  authPath,
  listWorkspacesForOwner,
  ownerFilter = () => true,
  nowMs = Date.now(),
  cachePath = null,
} = {}) {
  if (typeof listWorkspacesForOwner !== 'function') {
    throw new Error('discoverWorkspaceRegistry requires listWorkspacesForOwner');
  }

  const owners = loadWorkspaceOwnerCandidates({ authPath, ownerFilter, nowMs })
    .map(({ ownerAliasId, ownerAuth }) => ({ ownerAliasId, ownerAuth }));

  const observedWorkspaces = [];
  for (const { ownerAliasId, ownerAuth } of owners) {
    const discovered = await listWorkspacesForOwner({ ownerAliasId, ownerAuth });
    for (const workspace of discovered ?? []) {
      if (!workspace?.workspaceId && !workspace?.id && !ownerAuth?.accountId) continue;
      observedWorkspaces.push(normalizeWorkspaceObservation({ workspace, ownerAliasId, ownerAuth, nowMs }));
    }
  }

  const selection = buildUsableWorkspaceSelection({ observedWorkspaces });
  const registry = {
    discoveredAt: nowMs,
    owners: owners.map(({ ownerAliasId, ownerAuth }) => ({
      ownerAliasId,
      ownerEmail: ownerAuth.email ?? null,
      ownerAccountId: ownerAuth.accountId ?? null,
      lineage: deriveLineage(ownerAliasId, ownerAuth, {}),
    })),
    ...selection,
  };
  persistRegistryCache(cachePath, registry);
  return registry;
}

export async function discoverOperationalWorkspaceRegistry({
  authPath,
  listWorkspacesForOwner,
  ownerFilter = () => true,
  nowMs = Date.now(),
  cachePath = null,
} = {}) {
  if (typeof listWorkspacesForOwner !== 'function') {
    throw new Error('discoverOperationalWorkspaceRegistry requires listWorkspacesForOwner');
  }

  const candidates = loadWorkspaceOwnerCandidates({ authPath, ownerFilter, nowMs });
  const ordered = [...candidates].sort((left, right) => {
    const scoreDelta = candidatePriority(left) - candidatePriority(right);
    if (scoreDelta !== 0) return scoreDelta;
    return left.originalIndex - right.originalIndex;
  });

  const observedWorkspaces = [];
  const attempts = [];

  for (const candidate of ordered) {
    try {
      const discovered = await listWorkspacesForOwner({ ownerAliasId: candidate.ownerAliasId, ownerAuth: candidate.ownerAuth });
      for (const workspace of discovered ?? []) {
        if (!workspace?.workspaceId && !workspace?.id && !candidate.ownerAuth?.accountId) continue;
        observedWorkspaces.push(normalizeWorkspaceObservation({
          workspace,
          ownerAliasId: candidate.ownerAliasId,
          ownerAuth: candidate.ownerAuth,
          nowMs,
        }));
      }
    } catch (error) {
      attempts.push({
        ownerAliasId: candidate.ownerAliasId,
        ownerEmail: candidate.ownerAuth?.email ?? null,
        ownerAccountId: candidate.ownerAuth?.accountId ?? null,
        error: String(error?.message ?? error),
      });
    }
  }

  const selection = buildUsableWorkspaceSelection({ observedWorkspaces });
  const registry = {
    discoveredAt: nowMs,
    ownerCandidates: ordered.map(({ ownerAliasId, ownerAuth }) => ({
      ownerAliasId,
      ownerEmail: ownerAuth?.email ?? null,
      ownerAccountId: ownerAuth?.accountId ?? null,
      lineage: deriveLineage(ownerAliasId, ownerAuth, {}),
    })),
    authAttempts: attempts,
    ...selection,
  };

  persistRegistryCache(cachePath, registry);

  if ((registry.workspaces ?? []).length === 0) {
    const failure = new Error(`No valid operational workspace auth for usable workspace selection: ${attempts.map((item) => item.ownerAliasId).join(', ')}`);
    failure.codePath = 'workspace-registry-operational-auth';
    failure.ownerAccountId = [...new Set(ordered.map((candidate) => candidate.ownerAuth?.accountId ?? null))].length === 1
      ? (ordered[0]?.ownerAuth?.accountId ?? null)
      : null;
    failure.attemptedOwnerAliasIds = attempts.map((item) => item.ownerAliasId);
    failure.attempts = attempts;
    throw failure;
  }

  return registry;
}
