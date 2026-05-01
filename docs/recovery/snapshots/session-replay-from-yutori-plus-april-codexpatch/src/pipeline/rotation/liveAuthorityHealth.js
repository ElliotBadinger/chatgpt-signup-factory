function normalizeString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function hasBrowserlessWorkspaceEvidence(live = {}) {
  const accountCount = Number(live?.accountCount);
  return normalizeString(live?.meEmail) != null
    && Number.isFinite(accountCount)
    && accountCount > 0;
}

export function hasRuntimeWorkspaceAccessProof(live = null) {
  if (!live || typeof live !== 'object') {
    return false;
  }

  const browserlessWorkspaceEvidencePresent = hasBrowserlessWorkspaceEvidence(live);
  const verifiedLiveProbe = live?.ok === true;

  return (browserlessWorkspaceEvidencePresent || verifiedLiveProbe)
    && live?.workspaceAccountSelected !== false
    && live?.sessionValid !== false;
}