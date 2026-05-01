import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_HEALTH_PATH = path.join(os.homedir(), '.pi', 'agent', 'account-router-health.json');
const DEFAULT_ROUTER_PATH = path.join(os.homedir(), '.pi', 'agent', 'account-router.json');

export const QUOTA_EXHAUSTED_THRESHOLD = 0.05;   // ≤5% remaining = exhausted
export const QUOTA_PREEMPTIVE_THRESHOLD = 0.15;  // ≤15% = at-risk, queue rotation early

function readJsonOrNull(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// NOTE: health.json stores ONE quotaRemainingFraction per model key (e.g. "greenleaf/gpt-5.4").
// This is already the minimum across all quota windows (5h PRIMARY and weekly SECONDARY)
// as computed by the codex-live adapter and stored via AccountHealthStore.recordQuotaProof().
//
// The per-window breakdown (windowMins=300 for 5h, windowMins=10080 for weekly) lives only
// in QuotaSignal.notes at runtime — it is never persisted to health.json. Therefore it is
// impossible to distinguish 5h vs weekly fractions from health.json alone.
//
// We expose BOTH fiveHour and weekly as the same effectiveFraction (the conservative minimum).
// This is the correct and honest thing to do: if either window is depleted, effectiveFraction
// will be 0 (or near-0), which is what matters for rotation decisions.

/**
 * Load all codex-provider aliases from account-router.json.
 */
function loadCodexAliases(routerPath = DEFAULT_ROUTER_PATH) {
  const config = readJsonOrNull(routerPath);
  if (!config) return [];
  return (config.aliases ?? []).filter(
    (alias) =>
      alias.cloneFrom === 'openai-codex' &&
      !alias.disabled &&
      typeof alias.id === 'string' &&
      typeof alias.email === 'string',
  );
}

/**
 * Read health data and return quota assessment for all codex aliases.
 *
 * Returns an array of objects sorted by remaining quota ascending (most exhausted first):
 * {
 *   aliasId, email, fiveHour, weekly, effectiveFraction,
 *   checkedAt, exhausted, atRisk, ambiguous
 * }
 */
export function assessCodexQuotas({
  healthPath = DEFAULT_HEALTH_PATH,
  routerPath = DEFAULT_ROUTER_PATH,
  exhaustedThreshold = QUOTA_EXHAUSTED_THRESHOLD,
  atRiskThreshold = QUOTA_PREEMPTIVE_THRESHOLD,
  nowMs = Date.now(),
  maxStaleMs = 10 * 60 * 1000, // 10 minutes before quota data is considered stale
} = {}) {
  const healthData = readJsonOrNull(healthPath);
  const aliases = loadCodexAliases(routerPath);

  if (!healthData || aliases.length === 0) {
    return { aliases: [], exhausted: [], atRisk: [], healthy: [] };
  }

  const allModels = healthData.models ?? {};

  // For each alias, find all model entries and compute the minimum fraction.
  // health.json stores one quotaRemainingFraction per model key — it is already
  // the minimum across all quota windows (5h and weekly). We cannot separate
  // them here; both fiveHour and weekly are set to effectiveFraction.
  const assessed = aliases.map((alias) => {
    const matchingKeys = Object.keys(allModels).filter((k) => k.startsWith(`${alias.id}/`));
    let minFraction = null;
    let latestCheckedAt = null;
    let anyAmbiguous = false;

    for (const modelKey of matchingKeys) {
      const mh = allModels[modelKey];
      const fraction = mh?.quotaRemainingFraction ?? null;
      const checkedAt = mh?.quotaCheckedAt ?? null;
      const ambiguous = mh?.quotaProofAmbiguous ?? false;

      if (fraction !== null) {
        minFraction = minFraction === null ? fraction : Math.min(minFraction, fraction);
      }
      if (checkedAt !== null) {
        latestCheckedAt = latestCheckedAt === null ? checkedAt : Math.max(latestCheckedAt, checkedAt);
      }
      if (ambiguous) anyAmbiguous = true;
    }

    const stale = latestCheckedAt === null || (nowMs - latestCheckedAt) > maxStaleMs;
    const exhausted = minFraction !== null && minFraction <= exhaustedThreshold && !anyAmbiguous;
    const atRisk = !exhausted && minFraction !== null && minFraction <= atRiskThreshold && !anyAmbiguous;

    return {
      aliasId: alias.id,
      email: alias.email,
      effectiveFraction: minFraction,
      // health.json collapses both windows into one value; expose it for both so
      // shouldTriggerBatch (TC-10) and other callers have the correct field names.
      fiveHour: minFraction,
      weekly: minFraction,
      checkedAt: latestCheckedAt,
      stale,
      exhausted,
      atRisk,
      ambiguous: anyAmbiguous,
    };
  });

  const sorted = assessed.sort((a, b) => {
    const fa = a.effectiveFraction ?? 1;
    const fb = b.effectiveFraction ?? 1;
    return fa - fb;
  });

  return {
    aliases: sorted,
    exhausted: sorted.filter((a) => a.exhausted),
    atRisk: sorted.filter((a) => a.atRisk),
    healthy: sorted.filter((a) => !a.exhausted && !a.atRisk),
    assessedAt: nowMs,
  };
}
