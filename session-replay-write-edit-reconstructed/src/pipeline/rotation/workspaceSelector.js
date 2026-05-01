export function workspaceHasCapacity(workspace = {}) {
  if (typeof workspace.maxMembers !== 'number') return true;
  return (workspace.currentMembers ?? 0) < workspace.maxMembers;
}

function compareWorkspaces(left, right) {
  const ownerEmailDelta = Number(Boolean(right.ownerEmail)) - Number(Boolean(left.ownerEmail));
  if (ownerEmailDelta !== 0) return ownerEmailDelta;

  const healthyDelta = (right.healthyAccounts ?? 0) - (left.healthyAccounts ?? 0);
  if (healthyDelta !== 0) return healthyDelta;

  const leftAvailable = typeof left.maxMembers === 'number' ? left.maxMembers - (left.currentMembers ?? 0) : Number.POSITIVE_INFINITY;
  const rightAvailable = typeof right.maxMembers === 'number' ? right.maxMembers - (right.currentMembers ?? 0) : Number.POSITIVE_INFINITY;
  if (rightAvailable !== leftAvailable) return rightAvailable - leftAvailable;

  return String(left.workspaceId).localeCompare(String(right.workspaceId));
}

export function selectWorkspaceForAlias({
  alias = {},
  workspaces = [],
} = {}) {
  const explicitWorkspaceId = alias.workspaceId ?? alias.rootOrgId ?? null;
  if (explicitWorkspaceId) {
    const explicitMatch = workspaces
      .filter((workspace) => workspace.workspaceId === explicitWorkspaceId)
      .sort(compareWorkspaces)[0] ?? null;
    if (explicitMatch) return explicitMatch;
  }

  const withCapacity = workspaces.filter((workspace) => workspaceHasCapacity(workspace));
  if (withCapacity.length === 0) return null;

  const preferredLineage = alias.lineage ?? alias.workspaceLineage ?? null;
  const sameLineage = preferredLineage
    ? withCapacity.filter((workspace) => workspace.lineage === preferredLineage)
    : [];
  const candidates = sameLineage.length > 0 ? sameLineage : withCapacity;
  return [...candidates].sort(compareWorkspaces)[0] ?? null;
}
