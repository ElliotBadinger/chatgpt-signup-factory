import fs from 'node:fs';
import {
  writeAuthCredential,
  removeAuthCredential,
  promoteAuthCredentialAlias,
  removeAliasRouterState,
} from './piAccountRegistrar.js';

function isActiveLifecycleStatus(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'active' || normalized === 'reinstated';
}

export function evaluatePiCodexLbLifecycleAgreement({
  aliasId = null,
  email = null,
  piWorkspaceId = null,
  targetWorkspaceId = null,
  codexLbLifecycle = null,
  requireAgreement = false,
} = {}) {
  if (!requireAgreement) {
    return {
      ok: true,
      reason: null,
      codexLbActive: null,
      codexLbWorkspaceId: codexLbLifecycle?.workspaceId ?? null,
      codexLbLifecycleState: codexLbLifecycle?.lifecycleState ?? codexLbLifecycle?.status ?? null,
    };
  }

  const codexLbActive = isActiveLifecycleStatus(codexLbLifecycle?.lifecycleState ?? codexLbLifecycle?.status);
  const codexLbWorkspaceId = codexLbLifecycle?.workspaceId ?? null;
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  const codexLbEmail = String(codexLbLifecycle?.email ?? '').trim().toLowerCase();
  const codexLbAliasId = codexLbLifecycle?.aliasId ?? null;
  const workspaceToMatch = targetWorkspaceId ?? piWorkspaceId ?? null;

  if (!codexLbLifecycle) {
    return {
      ok: false,
      reason: 'store-disagreement',
      codexLbActive: false,
      codexLbWorkspaceId: null,
      codexLbLifecycleState: null,
      metadata: { missingCodexLbLifecycle: true },
    };
  }

  if (!codexLbActive) {
    return {
      ok: false,
      reason: 'store-disagreement',
      codexLbActive,
      codexLbWorkspaceId,
      codexLbLifecycleState: codexLbLifecycle?.lifecycleState ?? codexLbLifecycle?.status ?? null,
      metadata: { inactiveCodexLbLifecycle: true },
    };
  }

  if (workspaceToMatch && codexLbWorkspaceId !== workspaceToMatch) {
    return {
      ok: false,
      reason: 'store-disagreement',
      codexLbActive,
      codexLbWorkspaceId,
      codexLbLifecycleState: codexLbLifecycle?.lifecycleState ?? codexLbLifecycle?.status ?? null,
      metadata: { expectedWorkspaceId: workspaceToMatch },
    };
  }

  if (normalizedEmail && codexLbEmail && codexLbEmail !== normalizedEmail) {
    return {
      ok: false,
      reason: 'store-disagreement',
      codexLbActive,
      codexLbWorkspaceId,
      codexLbLifecycleState: codexLbLifecycle?.lifecycleState ?? codexLbLifecycle?.status ?? null,
      metadata: { expectedEmail: normalizedEmail },
    };
  }

  if (aliasId && codexLbAliasId && codexLbAliasId !== aliasId) {
    return {
      ok: false,
      reason: 'store-disagreement',
      codexLbActive,
      codexLbWorkspaceId,
      codexLbLifecycleState: codexLbLifecycle?.lifecycleState ?? codexLbLifecycle?.status ?? null,
      metadata: { expectedAliasId: aliasId },
    };
  }

  return {
    ok: true,
    reason: null,
    codexLbActive,
    codexLbWorkspaceId,
    codexLbLifecycleState: codexLbLifecycle?.lifecycleState ?? codexLbLifecycle?.status ?? null,
  };
}

export function createLifecycleReconciler({
  authPath,
  routerPath,
  archivePath,
  finalize,
  verifyRecoveredAliasImpl,
  probeVerifiedAlias = async () => ({ ok: false, reason: 'verification-probe-not-configured' }),
  codexLbStore = null,
  log = () => {},
  now = () => Date.now(),
} = {}) {
  async function rollbackReplacement({
    tempAliasId,
    finalAliasId,
    email,
    rollbackReason,
  }) {
    removeAliasRouterState(finalAliasId, { routerJsonPath: routerPath });
    removeAuthCredential(tempAliasId, authPath);
    removeAuthCredential(finalAliasId, authPath);

    if (codexLbStore?.clearActiveLifecycle) {
      try {
        await codexLbStore.clearActiveLifecycle({
          email,
          lifecycleState: 'archived',
        });
      } catch (error) {
        return {
          ok: false,
          rollbackReason,
          rollbackResidue: `rollback-residue-detected: ${String(error?.message ?? error)}`,
        };
      }
    }

    return {
      ok: true,
      rollbackReason,
    };
  }

  async function reinstateArchivedAlias(entry) {
    writeAuthCredential({
      aliasId: entry.aliasId,
      accessToken: entry.auth.access,
      refreshToken: entry.auth.refresh ?? null,
      expiresAt: entry.auth.expires ?? null,
      accountId: entry.auth.accountId ?? null,
      authJsonPath: authPath,
    });

    if (finalize) {
      await finalize({
        tempId: entry.aliasId,
        finalId: entry.aliasId,
        configPath: routerPath,
        poolName: 'openai-codex',
        baseProviderId: 'openai-codex',
        email: entry.email,
        label: entry.aliasId,
        modelId: 'gpt-5.4',
        now: now(),
        probeTimeoutMs: 30_000,
        defaultCooldownMs: 300_000,
        authPath,
        placementContext: entry.placementContext ?? null,
      });
    }

    if (codexLbStore?.writeActiveLifecycle) {
      await codexLbStore.writeActiveLifecycle({
        email: entry.email,
        aliasId: entry.aliasId,
        workspaceId: entry.auth?.accountId ?? entry.workspaceId ?? null,
        lifecycleState: 'active',
      });
    }
  }

  async function reconcileReplacement({
    alias,
    inbox,
    auth,
    newAliasId,
    tempAliasId,
    onboarded,
    placementContext = null,
    teamDriver = null,
  }) {
    writeAuthCredential({
      aliasId: tempAliasId,
      accessToken: auth.access,
      refreshToken: auth.refresh ?? null,
      expiresAt: auth.expires ?? null,
      accountId: auth.accountId ?? null,
      authJsonPath: authPath,
    });

    let finalizeResult;
    try {
      finalizeResult = await finalize({
        tempId: tempAliasId,
        finalId: newAliasId,
        configPath: routerPath,
        poolName: 'openai-codex',
        baseProviderId: 'openai-codex',
        email: inbox.inboxAddress,
        label: newAliasId,
        modelId: 'gpt-5.4',
        now: now(),
        probeTimeoutMs: 30_000,
        defaultCooldownMs: 300_000,
        authPath,
        placementContext,
      });
    } catch (error) {
      finalizeResult = { ok: false, error: String(error?.message ?? error) };
    }

    if (!finalizeResult?.ok) {
      const rollback = await rollbackReplacement({
        tempAliasId,
        finalAliasId: newAliasId,
        email: inbox.inboxAddress,
        rollbackReason: `finalize: ${finalizeResult?.error ?? 'unknown-finalize-error'}`,
      });
      return {
        ok: false,
        stage: 'finalize',
        error: rollback.rollbackResidue ?? rollback.rollbackReason,
        rollback,
      };
    }

    promoteAuthCredentialAlias({
      fromAliasId: tempAliasId,
      toAliasId: newAliasId,
      authJsonPath: authPath,
    });

    try {
      if (codexLbStore?.writeActiveLifecycle) {
        await codexLbStore.writeActiveLifecycle({
          email: inbox.inboxAddress,
          aliasId: newAliasId,
          workspaceId: auth.accountId ?? onboarded?.workspaceId ?? null,
          lifecycleState: 'active',
          auth,
          onboarded,
        });
      }
    } catch (error) {
      const rollback = await rollbackReplacement({
        tempAliasId,
        finalAliasId: newAliasId,
        email: inbox.inboxAddress,
        rollbackReason: `codex-lb: ${String(error?.message ?? error)}`,
      });
      return {
        ok: false,
        stage: 'codex-lb',
        error: rollback.rollbackResidue ?? rollback.rollbackReason,
        rollback,
      };
    }

    const verification = await verifyRecoveredAliasImpl({
      aliasId: newAliasId,
      auth,
      sessionEvidence: { valid: Boolean(auth.access) },
      workspaceEvidence: { memberConfirmed: Boolean(onboarded?.workspaceId ?? auth.accountId) },
      routerEvidence: { aliasInAuth: true, aliasInRouter: true },
      probeCodex: async () => probeVerifiedAlias({ aliasId: newAliasId, auth }),
    });

    if (!verification?.ok) {
      const rollback = await rollbackReplacement({
        tempAliasId,
        finalAliasId: newAliasId,
        email: inbox.inboxAddress,
        rollbackReason: `verification: ${verification?.failures?.join(', ') ?? verification?.reason ?? 'verification-failed'}`,
      });
      return {
        ok: false,
        stage: 'verification',
        error: rollback.rollbackResidue ?? rollback.rollbackReason,
        verification,
        rollback,
      };
    }

    const oldAuth = (() => {
      try {
        const authSnapshot = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        return authSnapshot[alias.aliasId] ?? null;
      } catch {
        return null;
      }
    })();

    removeAliasRouterState(alias.aliasId, { routerJsonPath: routerPath });
    removeAuthCredential(alias.aliasId, authPath);

    if (codexLbStore?.clearActiveLifecycle) {
      await codexLbStore.clearActiveLifecycle({
        email: alias.email ?? `${alias.aliasId}@agentmail.to`,
        lifecycleState: 'archived',
        workspaceId: auth.accountId ?? onboarded?.workspaceId ?? null,
      });
    }

    if (teamDriver?.removeTeamMember) {
      teamDriver.removeTeamMember(alias.email ?? `${alias.aliasId}@agentmail.to`).catch(() => {});
    }

    return {
      ok: true,
      verification,
      archiveEntry: {
        aliasId: alias.aliasId,
        email: alias.email ?? `${alias.aliasId}@agentmail.to`,
        auth: oldAuth ?? { type: 'oauth', access: '', refresh: '', expires: 0, accountId: '' },
        archivedAt: now(),
        archivedReason: 'both-exhausted',
        quotaRemainingFraction: alias.effectiveFraction ?? 0,
        reinstated: false,
        reinstatedAt: null,
        replacementAliasId: newAliasId,
        replacementEmail: inbox.inboxAddress,
        workspaceId: placementContext?.workspaceId ?? auth.accountId ?? onboarded?.workspaceId ?? null,
        placementContext,
        reconcileContext: {
          transition: 'replacement-archive',
          appendBeforeRemove: true,
          piAuthFinalAliasId: newAliasId,
          codexLbLifecycleWritten: Boolean(codexLbStore?.writeActiveLifecycle),
          codexLbArchivedEmail: alias.email ?? `${alias.aliasId}@agentmail.to`,
          verificationReason: verification?.reason ?? null,
        },
        codexLbStateSnapshot: {
          archivedAliasEmail: alias.email ?? `${alias.aliasId}@agentmail.to`,
          replacementAliasEmail: inbox.inboxAddress,
          workspaceId: auth.accountId ?? onboarded?.workspaceId ?? null,
          replacementAliasId: newAliasId,
        },
      },
    };
  }

  return {
    reinstateArchivedAlias,
    reconcileReplacement,
  };
}