function decodeJwtPayload(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function encodeJwtSection(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function synthesizeIdToken({
  email,
  workspaceId = null,
  planType = null,
  expiresAt = null,
} = {}) {
  const claims = {
    email,
    ...(workspaceId ? { chatgpt_account_id: workspaceId } : {}),
    ...(Number.isFinite(expiresAt) ? { exp: Math.floor(expiresAt / 1000) } : {}),
    'https://api.openai.com/auth': {
      ...(workspaceId ? { chatgpt_account_id: workspaceId } : {}),
      ...(planType ? { chatgpt_plan_type: planType } : {}),
    },
  };
  return `${encodeJwtSection({ alg: 'none', typ: 'JWT' })}.${encodeJwtSection(claims)}.sig`;
}

function resolveAccessClaims(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  return {
    email: payload?.['https://api.openai.com/profile']?.email ?? payload?.email ?? null,
    workspaceId: payload?.['https://api.openai.com/auth']?.chatgpt_account_id ?? payload?.chatgpt_account_id ?? null,
    planType: payload?.['https://api.openai.com/auth']?.chatgpt_plan_type ?? payload?.chatgpt_plan_type ?? null,
  };
}

function resolveTokenMaterial({
  email,
  workspaceId = null,
  auth = null,
  onboarded = null,
} = {}) {
  const accessToken = auth?.access
    ?? auth?.accessToken
    ?? onboarded?.ownedOAuth?.accessToken
    ?? onboarded?.accessToken
    ?? null;
  const refreshToken = auth?.refresh
    ?? auth?.refreshToken
    ?? onboarded?.ownedOAuth?.refreshToken
    ?? onboarded?.refreshToken
    ?? null;
  const accessClaims = resolveAccessClaims(accessToken);
  const resolvedWorkspaceId = workspaceId
    ?? auth?.accountId
    ?? auth?.workspaceId
    ?? onboarded?.ownedOAuth?.accountId
    ?? onboarded?.accountId
    ?? onboarded?.workspaceId
    ?? accessClaims.workspaceId
    ?? null;
  const resolvedEmail = email
    ?? onboarded?.ownedOAuth?.identityEmail
    ?? onboarded?.identityEmail
    ?? auth?.identityEmail
    ?? accessClaims.email
    ?? null;
  const resolvedPlanType = onboarded?.ownedOAuth?.planType
    ?? accessClaims.planType
    ?? (resolvedWorkspaceId ? 'team' : null);
  const idToken = auth?.idToken
    ?? auth?.id_token
    ?? onboarded?.ownedOAuth?.idToken
    ?? null;

  return {
    accessToken,
    refreshToken,
    idToken,
    email: resolvedEmail,
    workspaceId: resolvedWorkspaceId,
    planType: resolvedPlanType,
    expiresAt: auth?.expires ?? auth?.expiresAt ?? onboarded?.ownedOAuth?.expiresAt ?? onboarded?.expiresAt ?? null,
  };
}

export function buildCodexLbLocalImportAuthJson({
  email,
  workspaceId = null,
  auth = null,
  onboarded = null,
} = {}) {
  const material = resolveTokenMaterial({
    email,
    workspaceId,
    auth,
    onboarded,
  });

  if (!material.accessToken) {
    throw new Error('codex-lb-local import requires an access token');
  }
  if (!material.refreshToken) {
    throw new Error('codex-lb-local import requires a refresh token');
  }
  if (!material.email) {
    throw new Error('codex-lb-local import requires a stable email identity');
  }

  const idToken = material.idToken ?? synthesizeIdToken({
    email: material.email,
    workspaceId: material.workspaceId,
    planType: material.planType,
    expiresAt: material.expiresAt,
  });

  return {
    tokens: {
      idToken,
      accessToken: material.accessToken,
      refreshToken: material.refreshToken,
      ...(material.workspaceId ? { accountId: material.workspaceId } : {}),
    },
  };
}

function buildImportErrorDetail(status, payload, fallbackText = null) {
  const code = payload?.error?.code ?? null;
  const message = payload?.error?.message ?? payload?.message ?? fallbackText ?? null;
  if (message && code) return `HTTP ${status} ${code}: ${message}`;
  if (message) return `HTTP ${status} ${message}`;
  if (code) return `HTTP ${status} ${code}`;
  return `HTTP ${status}`;
}

async function readErrorResponse(response) {
  try {
    const payload = await response.json();
    return buildImportErrorDetail(response.status, payload);
  } catch {
    try {
      const text = String(await response.text()).trim();
      return buildImportErrorDetail(response.status, null, text || null);
    } catch {
      return `HTTP ${response.status}`;
    }
  }
}

export function resolveCodexLbLocalImportConfig({
  env = process.env,
} = {}) {
  const baseUrl = env.PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_CODEX_LB_LOCAL_URL
    ?? env.CODEX_LB_LOCAL_URL
    ?? null;
  const dashboardSession = env.PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_CODEX_LB_LOCAL_DASHBOARD_SESSION
    ?? env.CODEX_LB_LOCAL_DASHBOARD_SESSION
    ?? null;
  return {
    baseUrl: typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim().replace(/\/+$/, '') : null,
    dashboardSession: typeof dashboardSession === 'string' && dashboardSession.trim() ? dashboardSession.trim() : null,
  };
}

export function createCodexLbLocalImportClient({
  baseUrl = null,
  dashboardSession = null,
  fetchImpl = fetch,
} = {}) {
  const normalizedBaseUrl = typeof baseUrl === 'string' && baseUrl.trim()
    ? baseUrl.trim().replace(/\/+$/, '')
    : null;

  return {
    getStatus() {
      return {
        ready: Boolean(normalizedBaseUrl),
        reason: normalizedBaseUrl ? null : 'codex-lb-local-import-not-configured',
        baseUrl: normalizedBaseUrl,
      };
    },
    isConfigured() {
      return Boolean(normalizedBaseUrl);
    },
    async importAccount({
      email,
      aliasId = null,
      workspaceId = null,
      auth = null,
      onboarded = null,
    } = {}) {
      if (!normalizedBaseUrl) {
        throw new Error('codex-lb-local import client is not configured');
      }

      const authJson = buildCodexLbLocalImportAuthJson({
        email,
        workspaceId,
        auth,
        onboarded,
      });
      const body = new FormData();
      body.set(
        'auth_json',
        new Blob([JSON.stringify(authJson)], { type: 'application/json' }),
        `${aliasId ?? 'auth'}.json`,
      );

      const headers = {};
      if (dashboardSession) {
        headers.Cookie = `codex_lb_dashboard_session=${dashboardSession}`;
      }

      const response = await fetchImpl(`${normalizedBaseUrl}/api/accounts/import`, {
        method: 'POST',
        headers,
        body,
      });

      if (!response.ok) {
        throw new Error(`codex-lb-local import failed: ${await readErrorResponse(response)}`);
      }

      const payload = await response.json();
      return {
        ok: true,
        accountId: payload?.accountId ?? null,
        email: payload?.email ?? email ?? null,
        planType: payload?.planType ?? null,
      };
    },
  };
}

export function createCodexLbLocalImportClientFromEnv({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  return createCodexLbLocalImportClient({
    ...resolveCodexLbLocalImportConfig({ env }),
    fetchImpl,
  });
}