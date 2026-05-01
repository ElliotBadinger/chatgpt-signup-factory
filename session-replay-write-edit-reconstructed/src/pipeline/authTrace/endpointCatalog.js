export function normalizePath(rawPath) {
  return rawPath
    // UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':uuid')
    // Hex segment IDs (exactly 12 lowercase hex chars like ea2d291c0fdc)
    .replace(/\/[0-9a-f]{12}(?=\/|$)/g, '/:hexid');
}

function extractQueryParamKeys(url) {
  try {
    const u = new URL(url);
    return [...u.searchParams.keys()];
  } catch {
    return [];
  }
}

function extractPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function extractHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function cookieNamesFromHeader(headers = {}) {
  const cookieHeader = headers['cookie'] ?? headers['Cookie'] ?? '';
  if (!cookieHeader) return [];
  return cookieHeader.split(';').map((c) => c.trim().split('=')[0]).filter(Boolean);
}

function extractSetCookieNames(headers = {}) {
  const raw = headers['set-cookie'];
  if (!raw) return [];
  const entries = Array.isArray(raw) ? raw : [raw];
  return entries.map((s) => s.split('=')[0].trim()).filter(Boolean);
}

function inferBodySchema(postData) {
  if (!postData) return null;
  try {
    const parsed = JSON.parse(postData);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        type: 'object',
        keys: Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => [k, v === null ? 'null' : typeof v])
        ),
      };
    }
    return { type: typeof parsed };
  } catch {
    return { type: 'string', raw: '[non-json body]' };
  }
}

export function buildEndpointCatalog(pairs) {
  const map = new Map();

  for (const { id, request, response } of pairs) {
    const rawPath = extractPath(request.url);
    const normalizedPath = normalizePath(rawPath);
    const endpointId = `${request.method}:${normalizedPath}`;

    if (!map.has(endpointId)) {
      map.set(endpointId, {
        endpointId,
        method: request.method,
        url: request.url,
        normalizedPath,
        host: extractHost(request.url),
        queryParamKeys: extractQueryParamKeys(request.url),
        requestHeaders: request.headers ?? {},
        requestCookieNames: cookieNamesFromHeader(request.headers),
        requestBodySchema: request.postData ? inferBodySchema(request.postData) : null,
        responseStatus: response?.status ?? null,
        responseHeaders: response?.headers ?? {},
        redirectLocation: response?.headers?.location ?? null,
        setCookieNames: extractSetCookieNames(response?.headers),
        responseBodySchema: response?.body?.schema ?? null,
        responseBodyKeys: response?.body?.keys ?? null,
        authCritical: false,
        replayClassification: 'unknown',
        occurrences: 0,
        firstTs: request.ts,
        lastTs: request.ts,
        firstId: id,
        lastId: id,
      });
    }

    const entry = map.get(endpointId);
    entry.occurrences += 1;
    if (request.ts < entry.firstTs) {
      entry.firstTs = request.ts;
      entry.firstId = id;
    }
    if (request.ts > entry.lastTs) {
      entry.lastTs = request.ts;
      entry.lastId = id;
    }
    // merge query param keys from later occurrences
    for (const k of extractQueryParamKeys(request.url)) {
      if (!entry.queryParamKeys.includes(k)) entry.queryParamKeys.push(k);
    }
    // merge response schema keys if later response is richer
    if (
      response?.body?.keys &&
      (!entry.responseBodyKeys || response.body.keys.length > entry.responseBodyKeys.length)
    ) {
      entry.responseBodyKeys = response.body.keys;
      entry.responseBodySchema = response.body.schema ?? entry.responseBodySchema;
    }
  }

  return [...map.values()].sort((a, b) => a.firstTs - b.firstTs);
}
