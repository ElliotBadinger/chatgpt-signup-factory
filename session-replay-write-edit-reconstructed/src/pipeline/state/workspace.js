function normalizePatternInput(pattern) {
  if (pattern === undefined || pattern === null) {
    return [];
  }

  return Array.isArray(pattern) ? pattern : [pattern];
}

export function detectSeatCount(value) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const match = value.match(/seats_in_use=(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

export function hasInviteFailurePattern(inviteFailure, inviteFailurePattern) {
  if (typeof inviteFailure !== 'string' || inviteFailure.length === 0) {
    return false;
  }

  return normalizePatternInput(inviteFailurePattern).some((pattern) => {
    if (pattern instanceof RegExp) {
      return pattern.test(inviteFailure);
    }

    return typeof pattern === 'string' && pattern.length > 0 ? inviteFailure.includes(pattern) : false;
  });
}

export function recordSeatObservation({
  workspaceId,
  observedAt,
  memberCount,
  inviteCount,
  inviteFailure,
  inviteFailurePattern,
  hardCapReached,
} = {}) {
  const detectedSeatCount = detectSeatCount(inviteFailure);
  const detectedHardCap = hasInviteFailurePattern(inviteFailure, inviteFailurePattern);

  const resolvedMemberCount = memberCount ?? detectedSeatCount;

  return {
    workspaceId,
    observedAt,
    ...(resolvedMemberCount !== undefined ? { memberCount: resolvedMemberCount } : {}),
    ...(inviteCount !== undefined ? { inviteCount } : {}),
    hardCapReached: hardCapReached ?? detectedHardCap,
  };
}

export function isUniversalHardCapActive(workspaceObservation) {
  return workspaceObservation?.hardCapReached === true;
}

export function shouldBlockFreshTargetConsumption({ workspaceObservation, overrideUniversalHardCap = false } = {}) {
  return isUniversalHardCapActive(workspaceObservation) && !overrideUniversalHardCap;
}
