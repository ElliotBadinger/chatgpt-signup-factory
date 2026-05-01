import { normalizePath } from './endpointCatalog.js';

const AUTH_CRITICAL_HOSTS = ['auth.openai.com', 'sentinel.openai.com'];
const AUTH_CRITICAL_PATHS = ['/api/auth/session', '/backend-api/accounts/check'];

export function flagAuthCritical(pair) {
  try {
    const u = new URL(pair.request.url);
    if (AUTH_CRITICAL_HOSTS.includes(u.hostname)) return true;
    if (
      u.hostname === 'chatgpt.com' &&
      AUTH_CRITICAL_PATHS.some((p) => u.pathname.startsWith(p))
    ) {
      return true;
    }
  } catch {
    // ignore malformed URLs
  }
  return false;
}

function hasAccessToken(response) {
  return Array.isArray(response?.body?.keys) && response.body.keys.includes('accessToken');
}

function extractHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function buildFlowSequence(pairs) {
  const sorted = [...pairs].sort((a, b) => a.request.ts - b.request.ts);

  let accessTokenSeen = false;
  return sorted.map(({ id, request, response }) => {
    const isFirstAccessToken = !accessTokenSeen && hasAccessToken(response);
    if (isFirstAccessToken) accessTokenSeen = true;

    return {
      id,
      ts: request.ts,
      method: request.method,
      url: request.url,
      normalizedPath: normalizePath(new URL(request.url).pathname),
      host: extractHost(request.url),
      responseStatus: response?.status ?? null,
      redirectLocation: response?.headers?.location ?? null,
      authCritical: flagAuthCritical({ request, response }),
      firstAccessTokenOccurrence: isFirstAccessToken,
      requestHeaders: Object.keys(request.headers ?? {}),
      responseBodyKeys: response?.body?.keys ?? null,
    };
  });
}
