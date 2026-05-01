import crypto from 'node:crypto';

import {
  createCookieJar,
  renderCookieHeader,
  snapshotCookies,
  updateCookieJarFromHeader,
} from './httpCookies.js';

const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const DEFAULT_ORIGINATOR = 'codex_chatgpt_desktop';
const DEFAULT_SCOPE = 'openid profile email offline_access';

function toDate(now) {
  return typeof now === 'function' ? now() : new Date();
}

function serializeTimestamp(now) {
  return toDate(now).toISOString();
}

function parseJsonSafe(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function getSetCookieHeader(headers) {
  if (typeof headers?.getSetCookie === 'function') {
    const values = headers.getSetCookie();
    if (values.length > 0) return values;
  }
  return headers?.get?.('set-cookie') ?? null;
}

function finalizeHeaders(headers) {
  return {
    location: headers?.get?.('location') ?? null,
    'content-type': headers?.get?.('content-type') ?? null,
    'set-cookie': getSetCookieHeader(headers),
  };
}

function base64UrlSha256(input) {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

function buildPkceVerifier() {
  return crypto.randomBytes(48).toString('base64url');
}

function decodeJwtPayload(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function buildTokenSummary(responseJson) {
  if (!responseJson) return null;
  return {
    hasAccessToken: Boolean(responseJson.access_token),
    hasRefreshToken: Boolean(responseJson.refresh_token),
    hasIdToken: Boolean(responseJson.id_token),
    tokenType: responseJson.token_type ?? null,
    error: responseJson.error ?? null,
    errorDescription: responseJson.error_description ?? null,
  };
}

async function performRequest({
  jar,
  url,
  method = 'GET',
  headers = {},
  body = null,
  fetchImpl,
  now,
  stepName,
  summarizeJson = null,
  redactRequestBody = false,
  redactResponseBody = false,
}) {
  const mergedHeaders = {
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'accept-language': 'en-US,en;q=0.9',
    ...headers,
  };
  const cookieHeader = renderCookieHeader(jar, url);
  if (cookieHeader) mergedHeaders.cookie = cookieHeader;

  const startedAt = Date.now();
  const response = await fetchImpl(url, {
    method,
    headers: mergedHeaders,
    body,
    redirect: 'manual',
  });
  const text = await response.text();
  updateCookieJarFromHeader(jar, getSetCookieHeader(response.headers), url);
  const responseJson = parseJsonSafe(text, null);

  return {
    response,
    responseJson,
    step: {
      name: stepName,
      url,
      method,
      requestedAt: serializeTimestamp(now),
      elapsedMs: Date.now() - startedAt,
      status: response.status,
      requestHeaders: mergedHeaders,
      requestBody: redactRequestBody ? '[redacted]' : body,
      responseHeaders: finalizeHeaders(response.headers),
      responseJson: summarizeJson ? summarizeJson(responseJson) : responseJson,
      responseTextPreview: redactResponseBody ? '[redacted oauth token response]' : text.slice(0, 400),
    },
  };
}

export function buildOwnedOauthAuthorizeUrl({
  state,
  codeChallenge,
  clientId = DEFAULT_CLIENT_ID,
  redirectUri = DEFAULT_REDIRECT_URI,
  originator = DEFAULT_ORIGINATOR,
  scope = DEFAULT_SCOPE,
} = {}) {
  const url = new URL('https://auth.openai.com/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', originator);
  return url.toString();
}

export async function acquireOwnedOpenAiOauth({
  cookies = [],
  email = null,
  workspaceId = null,
  fetchImpl = fetch,
  now = () => new Date(),
  state = crypto.randomBytes(16).toString('base64url'),
  codeVerifier = buildPkceVerifier(),
  clientId = DEFAULT_CLIENT_ID,
  redirectUri = DEFAULT_REDIRECT_URI,
  originator = DEFAULT_ORIGINATOR,
  scope = DEFAULT_SCOPE,
} = {}) {
  const jar = createCookieJar(Array.isArray(cookies) ? cookies : []);
  const steps = [];

  if (workspaceId) {
    const workspaceSelect = await performRequest({
      jar,
      url: 'https://auth.openai.com/api/accounts/workspace/select',
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin: 'https://auth.openai.com',
        referer: 'https://auth.openai.com/workspace',
      },
      body: JSON.stringify({ workspace_id: workspaceId }),
      fetchImpl,
      now,
      stepName: 'owned_oauth_workspace_select',
    });
    steps.push(workspaceSelect.step);
  }

  const authorizeUrl = buildOwnedOauthAuthorizeUrl({
    state,
    codeChallenge: base64UrlSha256(codeVerifier),
    clientId,
    redirectUri,
    originator,
    scope,
  });
  const authorize = await performRequest({
    jar,
    url: authorizeUrl,
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      referer: 'https://chatgpt.com/',
    },
    fetchImpl,
    now,
    stepName: 'owned_oauth_authorize',
  });
  steps.push(authorize.step);

  const callbackUrl = authorize.response.headers.get('location');
  if (!callbackUrl?.startsWith(redirectUri)) {
    throw new Error(`Owned OAuth authorize did not return callback for ${email ?? 'unknown email'}: ${callbackUrl ?? 'missing location'}`);
  }

  const parsedCallback = new URL(callbackUrl);
  if (parsedCallback.searchParams.get('state') !== state) {
    throw new Error(`Owned OAuth state mismatch for ${email ?? 'unknown email'}`);
  }
  const code = parsedCallback.searchParams.get('code');
  if (!code) {
    throw new Error(`Owned OAuth callback code missing for ${email ?? 'unknown email'}`);
  }

  const tokenExchange = await performRequest({
    jar,
    url: 'https://auth.openai.com/oauth/token',
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://auth.openai.com',
      referer: 'https://auth.openai.com/',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }).toString(),
    fetchImpl,
    now,
    stepName: 'owned_oauth_token_exchange',
    summarizeJson: buildTokenSummary,
    redactRequestBody: false,
    redactResponseBody: true,
  });
  steps.push(tokenExchange.step);

  const accessToken = tokenExchange.responseJson?.access_token ?? null;
  const refreshToken = tokenExchange.responseJson?.refresh_token ?? null;
  if (!accessToken || !refreshToken) {
    throw new Error(
      `Owned OAuth token exchange failed for ${email ?? 'unknown email'}`
      + `: ${tokenExchange.responseJson?.error ?? tokenExchange.response.status}`,
    );
  }

  const payload = decodeJwtPayload(accessToken);
  const authClaims = payload?.['https://api.openai.com/auth'] ?? {};
  const profileClaims = payload?.['https://api.openai.com/profile'] ?? {};

  return {
    accessToken,
    refreshToken,
    idToken: tokenExchange.responseJson?.id_token ?? null,
    expiresAt: Number.isFinite(tokenExchange.responseJson?.expires_in)
      ? toDate(now).getTime() + (Number(tokenExchange.responseJson.expires_in) * 1000)
      : null,
    accountId: authClaims.chatgpt_account_id ?? null,
    planType: authClaims.chatgpt_plan_type ?? null,
    identityEmail: profileClaims.email ?? null,
    emailVerified: profileClaims.email_verified === true,
    steps,
    finalCookies: { cookies: snapshotCookies(jar) },
  };
}