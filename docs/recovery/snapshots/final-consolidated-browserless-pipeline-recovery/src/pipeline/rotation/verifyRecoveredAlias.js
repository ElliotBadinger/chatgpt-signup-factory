export async function verifyRecoveredAlias({
  aliasId,
  auth = null,
  sessionEvidence = null,
  workspaceEvidence = null,
  routerEvidence = null,
  probeCodex = async () => ({ ok: false, blockerReason: 'verification-probe-not-configured' }),
} = {}) {
  let codexProbe;
  try {
    codexProbe = await probeCodex({ aliasId, auth, sessionEvidence, workspaceEvidence, routerEvidence });
  } catch (error) {
    codexProbe = {
      ok: false,
      blockerReason: 'live-browserless-probe-failed',
      reason: String(error?.message ?? error),
    };
  }

  const checks = {
    sessionValid: Boolean(auth?.access) && sessionEvidence?.valid === true,
    workspaceMemberConfirmed: workspaceEvidence?.memberConfirmed === true,
    routerStatePresent: Boolean(routerEvidence?.aliasInAuth) && Boolean(routerEvidence?.aliasInRouter),
    liveCodexProbe: codexProbe?.ok === true,
  };

  const failures = [];
  if (!checks.sessionValid) failures.push('session-invalid');
  if (!checks.workspaceMemberConfirmed) failures.push('workspace-membership-missing');
  if (!checks.routerStatePresent) failures.push('router-state-missing');
  if (!checks.liveCodexProbe) failures.push('live-codex-probe-failed');

  return {
    ok: failures.length === 0,
    reason: failures.length === 0 ? 'verified' : (codexProbe?.blockerReason ?? 'verification-failed'),
    aliasId,
    checks,
    failures,
    codexProbe,
  };
}
