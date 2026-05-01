import fs from 'node:fs';

import { assessCodexQuotas } from './quotaDetector.js';

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function listActiveCodexAliases(router = {}) {
  return (router.aliases ?? []).filter((alias) => (
    alias?.cloneFrom === 'openai-codex'
    && alias?.disabled !== true
    && typeof alias?.id === 'string'
    && typeof alias?.email === 'string'
  ));
}

function deriveClassification({ authPresent, health, probe }) {
  if (probe?.classification) return probe.classification;
  if (probe?.blockedReason) return 'blocked';

  const liveHealthy = probe?.codexReachable === true
    && probe?.workspaceMembership !== false
    && probe?.sessionValid !== false;
  if (liveHealthy) return 'keep-live';

  if (probe?.recreateNeeded === true) return 'recreate-browserless';
  if (!authPresent) return 'recreate-browserless';

  const liveNeedsRecovery = probe?.recoverable === true
    || probe?.codexReachable === false
    || probe?.workspaceMembership === false
    || probe?.sessionValid === false;
  if (liveNeedsRecovery) return 'recover-browserless';

  if (health?.stale) return 'recover-browserless';
  return 'keep-live';
}

export async function auditCodexFleetLive({
  routerPath,
  authPath,
  healthPath,
  excludedAliases = [],
  probeAlias = async () => null,
  nowMs = Date.now(),
} = {}) {
  const router = readJson(routerPath, { aliases: [], pools: [], policy: {} });
  const auth = readJson(authPath, {});
  const excluded = new Set(excludedAliases.map((aliasId) => String(aliasId ?? '').trim()).filter(Boolean));
  const healthAssessment = assessCodexQuotas({ healthPath, routerPath, nowMs });
  const healthByAliasId = new Map((healthAssessment.aliases ?? []).map((alias) => [alias.aliasId, alias]));

  const aliases = [];
  for (const alias of listActiveCodexAliases(router)) {
    if (excluded.has(alias.id)) continue;

    const authEntry = auth?.[alias.id] ?? null;
    const health = healthByAliasId.get(alias.id) ?? null;
    const probe = await probeAlias({
      aliasId: alias.id,
      alias,
      auth: authEntry,
      health,
    });

    const lineage = probe?.lineage ?? alias.lineage ?? alias.workspaceLineage ?? null;
    const workspaceId = probe?.workspaceId ?? null;
    const workspaceGroupKey = workspaceId ?? lineage ?? 'fleet:default';

    aliases.push({
      aliasId: alias.id,
      email: alias.email,
      lineage,
      workspaceId,
      workspaceGroupKey,
      authPresent: Boolean(authEntry?.access),
      authExpiresAt: authEntry?.expires ?? null,
      quotaSource: probe?.quotaSource ?? (health?.effectiveFraction != null ? 'health-minimum' : 'none'),
      health: health
        ? {
            effectiveFraction: health.effectiveFraction ?? null,
            exhausted: Boolean(health.exhausted),
            atRisk: Boolean(health.atRisk),
            stale: Boolean(health.stale),
            checkedAt: health.checkedAt ?? null,
          }
        : null,
      live: probe ?? null,
      blockerReason: probe?.blockedReason ?? null,
      classification: deriveClassification({
        authPresent: Boolean(authEntry?.access),
        health,
        probe,
      }),
      evidence: {
        auth: authEntry ? { accountId: authEntry.accountId ?? null, expires: authEntry.expires ?? null } : null,
        health: health ?? null,
        live: probe ?? null,
      },
    });
  }

  return {
    auditedAt: nowMs,
    excludedAliases: [...excluded],
    aliases,
    counts: aliases.reduce((counts, alias) => {
      counts[alias.classification] = (counts[alias.classification] ?? 0) + 1;
      return counts;
    }, {}),
  };
}
