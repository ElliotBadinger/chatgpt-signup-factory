function getRefreshToken(value) {
  if (typeof value?.refreshToken === 'string') return value.refreshToken;
  if (typeof value?.refresh_token === 'string') return value.refresh_token;
  return null;
}

function decodeJwtPayload(token) {
  const raw = String(token ?? '').trim();
  if (!raw) return null;

  const parts = raw.split('.');
  if (parts.length < 2) return null;

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`;
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function resolvePlanType(session) {
  const accountPlanType = String(session?.account?.planType ?? '').trim();
  if (accountPlanType) return accountPlanType;
  return decodeJwtPayload(session?.accessToken)?.['https://api.openai.com/auth']?.chatgpt_plan_type ?? null;
}

export function normalizeWorkspaceOwnerRecaptureAuth({
  aliasId,
  email,
  session,
  expectedWorkspaceId,
  expectedWorkspacePlan,
}) {
  const accessToken = String(session?.accessToken ?? '').trim();
  if (!accessToken) {
    throw new Error(`${aliasId} recapture is missing access token; refusing to persist auth`);
  }

  const refreshToken = String(getRefreshToken(session) ?? '').trim();
  if (!refreshToken) {
    throw new Error(`${aliasId} recapture is missing refresh token; refusing to persist degraded auth`);
  }

  const accountId = String(session?.account?.id ?? '').trim();
  if (!accountId) {
    throw new Error(`${aliasId} recapture is missing session account id; refusing to persist auth`);
  }
  if (accountId !== expectedWorkspaceId) {
    throw new Error(`${aliasId} recapture stayed on account ${accountId}; expected workspace ${expectedWorkspaceId}`);
  }

  const planType = resolvePlanType(session);
  if (String(planType ?? '').trim() !== String(expectedWorkspacePlan ?? '').trim()) {
    throw new Error(`${aliasId} recapture returned plan ${planType ?? 'missing'}; expected workspace plan ${expectedWorkspacePlan}`);
  }

  return {
    type: 'oauth',
    access: accessToken,
    refresh: refreshToken,
    expires: session?.expires ? new Date(session.expires).getTime() : Date.now() + 3600_000,
    accountId,
    email: String(session?.user?.email ?? email ?? '').trim(),
    lineage: aliasId,
  };
}