function parseJsonSafe(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function toDate(now) {
  return typeof now === 'function' ? now() : new Date();
}

function serializeTimestamp(now) {
  return toDate(now).toISOString();
}

function getSetCookieHeader(headers) {
  if (typeof headers.getSetCookie === 'function') {
    const values = headers.getSetCookie();
    if (values.length > 0) return values;
  }
  return headers.get('set-cookie');
}

function finalizeHeaders(headers) {
  const result = {};
  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }
  const setCookie = getSetCookieHeader(headers);
  return {
    location: result.location ?? null,
    'set-cookie': Array.isArray(setCookie) ? setCookie.join('\n') : setCookie,
    'content-type': result['content-type'] ?? null,
    'openai-processing-ms': result['openai-processing-ms'] ?? null,
    'openai-version': result['openai-version'] ?? null,
    'x-request-id': result['x-request-id'] ?? null,
    'x-oai-request-id': result['x-oai-request-id'] ?? null,
    'server-timing': result['server-timing'] ?? null,
    'cf-ray': result['cf-ray'] ?? null,
  };
}

function flowToStepName(flow) {
  if (flow === 'username_password_create') return 'sentinel_req_username_password_create';
  if (flow === 'oauth_create_account') return 'sentinel_req_oauth_create_account';
  return `sentinel_req_${String(flow ?? 'unknown')}`;
}

function mergeLiveToken(template, liveToken) {
  return JSON.stringify({
    ...(template ?? {}),
    c: liveToken,
  });
}

export function createOpenAiSentinelProvider({ sentinel, fetchImpl = fetch, now = null }) {
  async function buildHeadersForPath(requestPath) {
    const headerTemplates = sentinel?.headerTemplates?.[requestPath];
    if (!headerTemplates || Object.keys(headerTemplates).length === 0) {
      throw new Error(`No sentinel header templates found for ${requestPath}`);
    }

    const flow = Object.values(headerTemplates).find((value) => value?.flow)?.flow ?? null;
    if (!flow) {
      throw new Error(`No sentinel flow found for ${requestPath}`);
    }

    const requestTemplate = sentinel?.requestTemplates?.[flow];
    if (!requestTemplate) {
      throw new Error(`No sentinel request template found for flow ${flow}`);
    }

    const requestHeaders = {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
      ...(requestTemplate.headers ?? {}),
    };
    const requestBody = JSON.stringify(requestTemplate.body ?? {});
    const startedAtMs = Date.now();
    const response = await fetchImpl(requestTemplate.url, {
      method: requestTemplate.method ?? 'POST',
      headers: requestHeaders,
      body: requestBody,
      redirect: 'manual',
    });
    const text = await response.text();
    const elapsedMs = Date.now() - startedAtMs;
    const responseJson = parseJsonSafe(text, null);
    if (!responseJson?.token) {
      throw new Error(`Sentinel response missing token for flow ${flow}`);
    }

    const headers = {};
    for (const [headerName, template] of Object.entries(headerTemplates)) {
      headers[headerName] = mergeLiveToken(template, responseJson.token);
    }

    return {
      flow,
      headers,
      responseJson,
      step: {
        name: flowToStepName(flow),
        url: requestTemplate.url,
        method: requestTemplate.method ?? 'POST',
        requestedAt: serializeTimestamp(now),
        elapsedMs,
        status: response.status,
        requestHeaders,
        requestBody,
        responseHeaders: finalizeHeaders(response.headers),
        responseJson,
        responseTextPreview: text.slice(0, 400),
      },
    };
  }

  return {
    buildHeadersForPath,
  };
}
