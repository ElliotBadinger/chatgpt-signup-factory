import crypto from 'node:crypto';

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

async function readResponsePayload(response) {
  try {
    const payload = await response.json();
    return {
      payload,
      message: payload?.error?.message ?? payload?.message ?? null,
      detail: buildImportErrorDetail(response.status, payload),
    };
  } catch {
    try {
      const text = String(await response.text()).trim();
      return {
        payload: null,
        message: text || null,
        detail: buildImportErrorDetail(response.status, null, text || null),
      };
    } catch {
      return {
        payload: null,
        message: null,
        detail: `HTTP ${response.status}`,
      };
    }
  }
}

async function readErrorResponse(response) {
  return (await readResponsePayload(response)).detail;
}

function synthesizeCodexLbAccountId({ email, workspaceId }) {
  const digest = crypto.createHash('sha256').update(String(email ?? '').toLowerCase()).digest('hex').slice(0, 8);
  return `${workspaceId ?? 'account'}_${digest}`;
}

function isMalformedExistingRowFailure(status, message) {
  return status >= 500 && /malformed existing row|merge-by-email failed/i.test(String(message ?? ''));
}

export function resolveCodexLbLocalImportConfig({
  env = process.env,
} = {}) {
  const baseUrl = env.PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_CODEX_LB_LOCAL_URL
    ?? env.CODEX_LB_LOCAL_URL
    ?? env.CODEX_LB_LOCAL_BASE_URL
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
  const importedAccounts = new Map();

  function headers() {
    return dashboardSession ? { cookie: `codex_lb_dashboard_session=${dashboardSession}` } : {};
  }

  async function postImport({
    email,
    aliasId = null,
    workspaceId = null,
    auth = null,
    onboarded = null,
  } = {}) {
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

    return fetchImpl(`${normalizedBaseUrl}/api/accounts/import`, {
      method: 'POST',
      headers: headers(),
      body,
    });
  }

  async function deleteAccount(accountId) {
    return fetchImpl(`${normalizedBaseUrl}/api/accounts/${encodeURIComponent(accountId)}`, {
      method: 'DELETE',
      headers: headers(),
    });
  }

  async function listAccounts() {
    return fetchImpl(`${normalizedBaseUrl}/api/accounts`, {
      method: 'GET',
      headers: headers(),
    });
  }

  async function parseImportSuccess(response, { email, workspaceId }) {
    const payload = await response.json();
    const result = {
      ok: true,
      accountId: payload?.accountId ?? null,
      email: payload?.email ?? email ?? null,
      planType: payload?.planType ?? null,
    };
    if (result.accountId) {
      importedAccounts.set(`${String(email ?? '').toLowerCase()}|${workspaceId ?? ''}`, result.accountId);
    }
    return result;
  }

  async function retryAfterMalformedRow({
    firstResponse,
    email,
    aliasId = null,
    workspaceId = null,
    auth = null,
    onboarded = null,
  }) {
    const firstPayload = await readResponsePayload(firstResponse);
    if (!isMalformedExistingRowFailure(firstResponse.status, firstPayload.message)) {
      throw new Error(`codex-lb-local import failed: ${firstPayload.detail}`);
    }

    const synthesizedAccountId = synthesizeCodexLbAccountId({ email, workspaceId });
    const deleteResponse = await deleteAccount(synthesizedAccountId);
    if (deleteResponse.ok) {
      const retryResponse = await postImport({ email, aliasId, workspaceId, auth, onboarded });
      if (retryResponse.ok) return parseImportSuccess(retryResponse, { email, workspaceId });
      throw new Error(`codex-lb-local import failed after malformed-row delete: ${await readErrorResponse(retryResponse)}`);
    }

    const deleteStatus = deleteResponse.status;
    const lookupResponse = await listAccounts();
    if (lookupResponse.ok) {
      await lookupResponse.json().catch(() => null);
    }

    const retryResponse = await postImport({ email, aliasId, workspaceId, auth, onboarded });
    if (retryResponse.ok) return parseImportSuccess(retryResponse, { email, workspaceId });
    const retryPayload = await readResponsePayload(retryResponse);
    throw new Error(
      `codex-lb-local import remediation-needed: malformed existing row may persist for accountId='${synthesizedAccountId}'; `
      + `auto-delete returned ${deleteStatus} and retry failed with status ${retryResponse.status}: ${retryPayload.message ?? retryPayload.detail}`,
    );
  }

  return {
    getStatus() {
      return {
        ready: Boolean(normalizedBaseUrl),
        reason: normalizedBaseUrl ? null : 'codex-lb-local-import-not-configured',
        baseUrl: normalizedBaseUrl,
        importMode: 'codex-lb-local',
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

      const response = await postImport({
        email,
        aliasId,
        workspaceId,
        auth,
        onboarded,
      });
      if (response.ok) return parseImportSuccess(response, { email, workspaceId });
      if (!response.ok) {
        return retryAfterMalformedRow({
          firstResponse: response,
          email,
          aliasId,
          workspaceId,
          auth,
          onboarded,
        });
      }
      throw new Error('codex-lb-local import reached unreachable state');
    },
    async clearActiveLifecycle({
      email,
      workspaceId = null,
    } = {}) {
      if (!normalizedBaseUrl) {
        throw new Error('codex-lb-local import client is not configured');
      }
      const accountId = importedAccounts.get(`${String(email ?? '').toLowerCase()}|${workspaceId ?? ''}`)
        ?? synthesizeCodexLbAccountId({ email, workspaceId });
      const response = await deleteAccount(accountId);
      if (!response.ok) {
        throw new Error(`codex-lb-local delete failed: ${await readErrorResponse(response)}`);
      }
      return {
        ok: true,
        deleted: true,
        accountId,
      };
    },
    async writeActiveLifecycle({
      email,
      aliasId = null,
      workspaceId = null,
      auth = null,
      onboarded = null,
    } = {}) {
      return this.importAccount({
        email,
        aliasId,
        workspaceId,
        auth,
        onboarded,
      });
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

export function createConfiguredCodexLbStore({
  env = process.env,
  fetchImpl = fetch,
  storePath = undefined,
} = {}) {
  const config = resolveCodexLbLocalImportConfig({ env });
  if (!config.baseUrl) return null;
  const client = createCodexLbLocalImportClient({
    ...config,
    fetchImpl,
  });
  return {
    ...client,
    storePath: null,
    importMode: 'codex-lb-local',
    async getLifecycle({ email } = {}) {
      return { email, status: 'unknown', lifecycleState: 'unknown' };
    },
    async writeActiveLifecycle(input = {}) {
      return client.importAccount(input);
    },
    async clearActiveLifecycle(input = {}) {
      return client.clearActiveLifecycle(input);
    },
  };
}
