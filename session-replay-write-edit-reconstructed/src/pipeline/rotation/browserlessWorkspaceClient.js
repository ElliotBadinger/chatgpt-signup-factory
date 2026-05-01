import { createCookieJar, renderCookieHeader } from '../authTrace/httpCookies.js';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const DEFAULT_BUILD_NUMBER = '5298191';
const DEFAULT_CLIENT_VERSION = 'prod-fde562d53dfdac6c97aa00416b6c30fe21b1b8ec';
const DEFAULT_DEVICE_ID = '037bf0ab-6988-4f13-b7f4-802e2f3e0143';

function parseJsonSafe(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizeInviteUrl(url) {
  return String(url ?? '').replace(/&amp;/g, '&');
}

function buildTargetRoute(targetPath) {
  return String(targetPath ?? '').replace(/\/[0-9a-f-]{36}(?=\/|$)/gi, '/{account_id}');
}

function extractInviteUrl(text) {
  const match = String(text ?? '').match(/https:\/\/chatgpt\.com\/auth\/login\?[^\s"'<>]+/i);
  return match ? normalizeInviteUrl(match[0]) : null;
}

export function parseWorkspaceInviteLink(rawText) {
  const inviteUrl = extractInviteUrl(rawText);
  if (!inviteUrl) {
    throw new Error('Workspace invite link not found');
  }

  const url = new URL(inviteUrl);
  return {
    inviteUrl,
    workspaceId: url.searchParams.get('wId') ?? null,
    acceptWorkspaceId: url.searchParams.get('accept_wId') ?? null,
    inviteEmail: url.searchParams.get('inv_email') ?? null,
    workspaceName: url.searchParams.get('inv_ws_name') ?? null,
  };
}

export class WorkspaceClientError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'WorkspaceClientError';
    this.status = context.status ?? null;
    this.code = context.code ?? null;
    this.body = context.body ?? null;
    this.url = context.url ?? null;
  }
}

function errorText(error) {
  const message = String(error?.message ?? '');
  const body = typeof error?.body === 'string'
    ? error.body
    : (error?.body ? JSON.stringify(error.body) : '');
  return `${message}\n${body}`;
}

export function isWorkspaceDeactivatedError(error) {
  const text = errorText(error);
  return /workspace is deactivated\.?/i.test(text);
}

export function isLastOwnerRemovalError(error) {
  const text = errorText(error);
  return /cannot remove the last owner from a workspace\.?/i.test(text);
}

async function readResponseBody(response) {
  const text = await response.text();
  return {
    text,
    json: parseJsonSafe(text, null),
  };
}

export function createBrowserlessWorkspaceClient({
  accessToken = null,
  accountId = null,
  cookies = [],
  fetchImpl = fetch,
  userAgent = DEFAULT_USER_AGENT,
  deviceId = DEFAULT_DEVICE_ID,
  clientVersion = DEFAULT_CLIENT_VERSION,
  buildNumber = DEFAULT_BUILD_NUMBER,
} = {}) {
  const jar = createCookieJar(Array.isArray(cookies) ? cookies : []);

  async function request(url, {
    method = 'GET',
    body = null,
    bearer = false,
    accountIdOverride = accountId,
    targetPath = new URL(url).pathname,
    referer = 'https://chatgpt.com/',
    contentType = null,
  } = {}) {
    const headers = {
      accept: '*/*',
      'accept-language': 'en-US,en',
      referer,
      'user-agent': userAgent,
    };

    const cookieHeader = renderCookieHeader(jar, url);
    if (cookieHeader) headers.cookie = cookieHeader;

    if (contentType) headers['content-type'] = contentType;

    if (bearer) {
      if (!accessToken) throw new WorkspaceClientError('Access token is required for this request', { url });
      headers.authorization = `Bearer ${accessToken}`;
      headers['oai-language'] = 'en-US';
      headers['oai-client-build-number'] = buildNumber;
      headers['oai-device-id'] = deviceId;
      headers['oai-client-version'] = clientVersion;
      if (accountIdOverride) headers['chatgpt-account-id'] = accountIdOverride;
      if (targetPath) {
        headers['x-openai-target-path'] = targetPath;
        headers['x-openai-target-route'] = buildTargetRoute(targetPath);
      }
    }

    const response = await fetchImpl(url, {
      method,
      headers,
      body,
      redirect: 'manual',
    });
    const { text, json } = await readResponseBody(response);
    if (!response.ok) {
      const detail = json?.detail?.message ?? json?.error?.message ?? json?.detail ?? null;
      throw new WorkspaceClientError(detail || `Workspace request failed with status ${response.status}`, {
        status: response.status,
        code: json?.error?.code ?? null,
        body: json ?? text,
        url,
      });
    }
    return json ?? text;
  }

  async function getSession() {
    return request('https://chatgpt.com/api/auth/session', {
      referer: 'https://chatgpt.com/',
    });
  }

  async function getMe({ accountIdOverride = accountId } = {}) {
    return request('https://chatgpt.com/backend-api/me', {
      bearer: true,
      accountIdOverride,
      targetPath: '/backend-api/me',
    });
  }

  async function getAccounts({ accountIdOverride = accountId } = {}) {
    return request('https://chatgpt.com/backend-api/accounts', {
      bearer: true,
      accountIdOverride,
      targetPath: '/backend-api/accounts',
    });
  }

  async function getAccountCheck({ timezoneOffsetMin = -120 } = {}) {
    return request(`https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=${timezoneOffsetMin}`, {
      targetPath: '/backend-api/accounts/check/v4-2023-04-27',
    });
  }

  async function getUserGranularConsent({ accountIdOverride = accountId } = {}) {
    return request('https://chatgpt.com/backend-api/user_granular_consent', {
      bearer: true,
      accountIdOverride,
      targetPath: '/backend-api/user_granular_consent',
    });
  }

  async function listInvites(workspaceId, { accountIdOverride = workspaceId } = {}) {
    return request(`https://chatgpt.com/backend-api/accounts/${workspaceId}/invites`, {
      bearer: true,
      accountIdOverride,
      targetPath: `/backend-api/accounts/${workspaceId}/invites`,
    });
  }

  async function listUsers(workspaceId, { accountIdOverride = workspaceId } = {}) {
    return request(`https://chatgpt.com/backend-api/accounts/${workspaceId}/users`, {
      bearer: true,
      accountIdOverride,
      targetPath: `/backend-api/accounts/${workspaceId}/users`,
    });
  }

  async function createInvite(workspaceId, email, { role = 'standard-user', accountIdOverride = workspaceId } = {}) {
    return request(`https://chatgpt.com/backend-api/accounts/${workspaceId}/invites`, {
      method: 'POST',
      bearer: true,
      accountIdOverride,
      targetPath: `/backend-api/accounts/${workspaceId}/invites`,
      contentType: 'application/json',
      body: JSON.stringify({ email_addresses: [email], role }),
    });
  }

  async function cancelInvite(workspaceId, inviteId, { accountIdOverride = workspaceId } = {}) {
    return request(`https://chatgpt.com/backend-api/accounts/${workspaceId}/invites/${inviteId}`, {
      method: 'PATCH',
      bearer: true,
      accountIdOverride,
      targetPath: `/backend-api/accounts/${workspaceId}/invites/${inviteId}`,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'cancelled' }),
    });
  }

  async function removeUser(workspaceId, userId, { accountIdOverride = workspaceId } = {}) {
    return request(`https://chatgpt.com/backend-api/accounts/${workspaceId}/users/${userId}`, {
      method: 'DELETE',
      bearer: true,
      accountIdOverride,
      targetPath: `/backend-api/accounts/${workspaceId}/users/${userId}`,
    });
  }

  async function joinWorkspace({ workspaceId, email, accountIdOverride = accountId } = {}) {
    const body = await request(`https://chatgpt.com/backend-api/accounts/${workspaceId}/join`, {
      method: 'POST',
      bearer: true,
      accountIdOverride,
      targetPath: `/backend-api/accounts/${workspaceId}/join`,
      contentType: 'application/json',
      body: JSON.stringify({ email }),
    });
    return {
      ok: true,
      status: 200,
      acceptedVia: 'join',
      body,
    };
  }

  async function acceptInvite({ workspaceId, email, accountIdOverride = accountId } = {}) {
    const url = `https://chatgpt.com/backend-api/accounts/${workspaceId}/invites/accept`;
    try {
      const body = await request(url, {
        method: 'POST',
        bearer: true,
        accountIdOverride,
        targetPath: `/backend-api/accounts/${workspaceId}/invites/accept`,
        contentType: 'application/json',
        body: JSON.stringify({ email }),
      });
      return {
        ok: true,
        status: 200,
        acceptedVia: 'invites-accept',
        body,
      };
    } catch (error) {
      if (!(error instanceof WorkspaceClientError)) throw error;
      if (error.status === 404 || error.status === 405) {
        return joinWorkspace({ workspaceId, email, accountIdOverride });
      }
      throw error;
    }
  }

  async function selectWorkspace({ workspaceId } = {}) {
    return request('https://auth.openai.com/api/accounts/workspace/select', {
      method: 'POST',
      referer: 'https://auth.openai.com/workspace',
      contentType: 'application/json',
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
  }

  async function canAccessWorkspace(workspaceId) {
    try {
      await listUsers(workspaceId, { accountIdOverride: workspaceId });
      return true;
    } catch (error) {
      if (error instanceof WorkspaceClientError) return false;
      throw error;
    }
  }

  return {
    getSession,
    getMe,
    getAccounts,
    getAccountCheck,
    getUserGranularConsent,
    listInvites,
    listUsers,
    createInvite,
    cancelInvite,
    removeUser,
    acceptInvite,
    joinWorkspace,
    selectWorkspace,
    canAccessWorkspace,
  };
}
