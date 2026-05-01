import fs from 'node:fs';

import { evaluateWorkspaceParentAgreement } from '../../agentmail/controlPlane.js';
import { createCodexLbLifecycleStore } from './codexLbLifecycleStore.js';
import { readPool } from './inboxPoolManager.js';
import { evaluatePiCodexLbLifecycleAgreement } from './lifecycleReconciler.js';
import { auditCodexFleetLive } from './liveFleetAudit.js';

const LIVE_POLICY_FIELDS = new Set([
  'blockedReason',
  'blockerReason',
  'classification',
  'recreateNeeded',
  'recoverable',
]);

function safeReadJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function stripLivePolicyFields(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stripLivePolicyFields(item));
  }
  if (!value || typeof value !== 'object') {
    return value ?? null;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !LIVE_POLICY_FIELDS.has(key))
      .map(([key, nestedValue]) => [key, stripLivePolicyFields(nestedValue)]),
  );
}

function buildPoolEntryByAliasId(poolData = {}) {
  return new Map(
    (poolData.entries ?? [])
      .filter((entry) => entry?.linkedAliasId)
      .map((entry) => [entry.linkedAliasId, entry]),
  );
}

function buildRouterAliasById(routerData = {}) {
  return new Map(
    (routerData.aliases ?? [])
      .filter((alias) => alias?.id)
      .map((alias) => [alias.id, alias]),
  );
}

function buildCounts(aliases = [], targetWorkspaceId = null) {
  return aliases.reduce((counts, alias) => {
    counts.totalAliases += 1;
    if ((alias.workspaceId ?? alias.evidence?.auth?.accountId ?? null) === targetWorkspaceId) {
      counts.targetWorkspaceAliases += 1;
    }
    if (alias.parentAgreement?.ok === false) {
      counts.parentAgreementFailures += 1;
    }
    if (alias.codexLbAgreement?.ok === false) {
      counts.codexLbAgreementFailures += 1;
    }
    return counts;
  }, {
    totalAliases: 0,
    targetWorkspaceAliases: 0,
    parentAgreementFailures: 0,
    codexLbAgreementFailures: 0,
  });
}

export async function collectLiveAuthorityFacts({
  routerPath,
  authPath,
  healthPath,
  poolPath,
  targetWorkspaceId = null,
  canonicalAgentMailParent = null,
  codexLbStore = null,
  codexLbStorePath = undefined,
  excludedAliases = [],
  liveProbeAlias = async () => null,
} = {}) {
  const currentRouterData = safeReadJson(routerPath, { aliases: [], pools: [] });
  const currentPoolData = readPool({ poolPath });
  const resolvedCodexLbStore = codexLbStore
    ?? (codexLbStorePath !== undefined ? createCodexLbLifecycleStore({ storePath: codexLbStorePath }) : null);
  const codexLbStatus = resolvedCodexLbStore?.getStatus?.() ?? { ready: false };
  const readExactLifecycle = resolvedCodexLbStore?.getExactLifecycle ?? resolvedCodexLbStore?.getLifecycle ?? null;

  const liveAudit = await auditCodexFleetLive({
    routerPath,
    authPath,
    healthPath,
    excludedAliases,
    probeAlias: liveProbeAlias,
  });
  const routerAliasById = buildRouterAliasById(currentRouterData);
  const poolEntryByAliasId = buildPoolEntryByAliasId(currentPoolData);

  const aliases = await Promise.all((liveAudit.aliases ?? []).map(async (alias) => {
    const workspaceId = alias.workspaceId ?? alias.evidence?.auth?.accountId ?? null;
    const codexLbLifecycle = readExactLifecycle
      ? await readExactLifecycle({
          email: alias.email,
          aliasId: alias.aliasId,
          workspaceId: workspaceId ?? targetWorkspaceId,
        })
      : null;
    const parentAgreement = evaluateWorkspaceParentAgreement({
      alias: routerAliasById.get(alias.aliasId) ?? {},
      poolEntry: poolEntryByAliasId.get(alias.aliasId) ?? null,
      canonicalParent: canonicalAgentMailParent,
      targetWorkspaceId,
    });
    const codexLbAgreement = evaluatePiCodexLbLifecycleAgreement({
      aliasId: alias.aliasId,
      email: alias.email,
      piWorkspaceId: workspaceId,
      targetWorkspaceId,
      codexLbLifecycle,
      requireAgreement: codexLbStatus.ready === true && Boolean(targetWorkspaceId),
    });
    const sanitizedLive = stripLivePolicyFields(alias.live);

    return {
      aliasId: alias.aliasId,
      email: alias.email,
      lineage: alias.lineage ?? null,
      workspaceId,
      workspaceGroupKey: alias.workspaceGroupKey ?? null,
      authPresent: alias.authPresent === true,
      authDurable: alias.authDurable === true,
      authExpiresAt: alias.authExpiresAt ?? null,
      quotaSource: alias.quotaSource ?? null,
      health: alias.health ?? null,
      live: sanitizedLive,
      evidence: {
        auth: alias.evidence?.auth ?? null,
        health: alias.evidence?.health ?? null,
        live: sanitizedLive,
      },
      routerAlias: routerAliasById.get(alias.aliasId) ?? null,
      poolEntry: poolEntryByAliasId.get(alias.aliasId) ?? null,
      codexLb: codexLbLifecycle,
      codexLbAgreement,
      parentAgreement,
    };
  }));

  return {
    auditedAt: liveAudit.auditedAt ?? Date.now(),
    excludedAliases: [...(liveAudit.excludedAliases ?? [])],
    targetWorkspaceId: targetWorkspaceId ?? null,
    codexLbStatus,
    aliases,
    counts: buildCounts(aliases, targetWorkspaceId),
  };
}