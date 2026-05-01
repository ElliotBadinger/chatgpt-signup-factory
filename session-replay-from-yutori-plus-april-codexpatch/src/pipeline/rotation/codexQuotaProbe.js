const DEFAULT_CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

function toFiniteNumber(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function normalizeResetAtMs(window = null, fetchedAt = Date.now()) {
  const resetAt = toFiniteNumber(window?.reset_at);
  if (resetAt !== null) return resetAt * 1000;

  const resetAfterSeconds = toFiniteNumber(window?.reset_after_seconds);
  if (resetAfterSeconds !== null) return fetchedAt + (resetAfterSeconds * 1000);

  return null;
}

function buildWindowEvidence(window = null, fetchedAt = Date.now()) {
  const usedPercent = toFiniteNumber(window?.used_percent);
  if (usedPercent === null) return null;

  const limitWindowSeconds = toFiniteNumber(window?.limit_window_seconds);
  return {
    remainingFraction: Math.max(0, Math.min(1, 1 - (usedPercent / 100))),
    resetAt: normalizeResetAtMs(window, fetchedAt),
    limitWindowSeconds,
  };
}

function classifyWindowType(windowEvidence = null, fallback = null) {
  const limitWindowSeconds = windowEvidence?.limitWindowSeconds ?? null;
  if (limitWindowSeconds === FIVE_HOUR_WINDOW_SECONDS) return 'five-hour';
  if (limitWindowSeconds === WEEKLY_WINDOW_SECONDS) return 'weekly';
  return fallback;
}

function usageErrorMessage(payload, status) {
  if (payload && typeof payload === 'object') {
    if (typeof payload.error === 'string' && payload.error.trim()) return payload.error.trim();
    if (payload.error && typeof payload.error === 'object' && typeof payload.error.message === 'string' && payload.error.message.trim()) {
      return payload.error.message.trim();
    }
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim();
  }
  return `codex wham/usage failed (${status})`;
}

export function parseCodexUsageQuotaPayload(payload, {
  fetchedAt = Date.now(),
} = {}) {
  if (!payload || typeof payload !== 'object' || !payload.rate_limit || typeof payload.rate_limit !== 'object') {
    return {
      quotaWindows: null,
      quotaCheckedAt: fetchedAt,
      quotaProofAmbiguous: true,
      rawWindowEvidence: null,
    };
  }

  const primary = buildWindowEvidence(payload.rate_limit.primary_window, fetchedAt);
  const secondary = buildWindowEvidence(payload.rate_limit.secondary_window, fetchedAt);
  const typedWindows = new Map();

  for (const [windowType, evidence] of [
    [classifyWindowType(primary, 'five-hour'), primary],
    [classifyWindowType(secondary, 'weekly'), secondary],
  ]) {
    if (!windowType || !evidence) continue;
    typedWindows.set(windowType, evidence);
  }

  const fiveHour = typedWindows.get('five-hour') ?? null;
  const weekly = typedWindows.get('weekly') ?? null;

  return {
    quotaWindows: fiveHour && weekly
      ? {
          fiveHourRemainingFraction: fiveHour.remainingFraction,
          weeklyRemainingFraction: weekly.remainingFraction,
        }
      : null,
    quotaCheckedAt: fetchedAt,
    quotaProofAmbiguous: !(fiveHour && weekly),
    rawWindowEvidence: {
      fiveHour,
      weekly,
      primary,
      secondary,
    },
  };
}

export async function fetchCodexUsageQuota({
  accessToken,
  accountId,
  fetchImpl = globalThis.fetch,
  usageUrl = DEFAULT_CODEX_USAGE_URL,
  fetchedAt = Date.now(),
} = {}) {
  const access = String(accessToken ?? '').trim();
  if (!access) throw new Error('missing access token for codex quota probe');

  const workspaceAccountId = String(accountId ?? '').trim();
  if (!workspaceAccountId) throw new Error('missing chatgpt account id for codex quota probe');

  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable for codex quota probe');

  const response = await fetchImpl(usageUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${access}`,
      Accept: 'application/json',
      'chatgpt-account-id': workspaceAccountId,
    },
  });

  const payload = await response.json().catch(async () => {
    const text = await response.text().catch(() => '');
    return { error: { message: text } };
  });

  if (!response.ok) {
    throw new Error(usageErrorMessage(payload, response.status));
  }

  return parseCodexUsageQuotaPayload(payload, { fetchedAt });
}