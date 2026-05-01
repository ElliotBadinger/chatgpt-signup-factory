import {
  createCookieJar,
  renderCookieHeader,
  updateCookieJarFromHeader,
  snapshotCookies,
} from './httpCookies.js';

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getSetCookieHeader(headers) {
  if (typeof headers.getSetCookie === 'function') {
    const values = headers.getSetCookie();
    if (values.length > 0) return values;
  }
  return headers.get('set-cookie');
}

function extractResponseHeaders(headers) {
  const setCookie = getSetCookieHeader(headers);
  return {
    location: headers.get('location'),
    'set-cookie': Array.isArray(setCookie) ? setCookie.join('\n') : setCookie,
    'content-type': headers.get('content-type'),
  };
}

function renderBody(step, plan) {
  if (!step.bodyTemplate) return undefined;
  return step.bodyTemplate.replaceAll('{{csrfToken}}', encodeURIComponent(plan.csrfToken || ''));
}

function resolveStepUrl(step, previousStep = null) {
  if (step.usePreviousJsonUrl && previousStep?.responseJson?.url) {
    return previousStep.responseJson.url;
  }
  return step.url;
}

export async function replayBrowserlessBootstrap({ plan, fetchImpl = fetch, now = null }) {
  const jar = createCookieJar(plan.cookieJar?.cookies ?? []);
  const steps = [];

  for (const step of plan.sequence ?? []) {
    const url = resolveStepUrl(step, steps.at(-1));
    const headers = {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'accept-language': 'en-GB,en;q=0.9',
    };
    const cookieHeader = renderCookieHeader(jar, url);
    if (cookieHeader) headers.cookie = cookieHeader;
    if (step.contentType) headers['content-type'] = step.contentType;
    const body = renderBody(step, plan);
    const response = await fetchImpl(url, {
      method: step.method || 'GET',
      headers,
      body,
      redirect: 'manual',
    });
    const text = await response.text();
    updateCookieJarFromHeader(jar, getSetCookieHeader(response.headers), url);
    const responseJson = parseJsonSafe(text);
    if (step.name === 'csrf' && responseJson?.csrfToken) {
      plan.csrfToken = responseJson.csrfToken;
    }
    steps.push({
      name: step.name,
      url,
      method: step.method || 'GET',
      requestedAt: (now ? now() : new Date()).toISOString(),
      status: response.status,
      responseHeaders: extractResponseHeaders(response.headers),
      responseJson,
      responseTextPreview: text.slice(0, 400),
    });
  }

  return {
    generatedAt: (now ? now() : new Date()).toISOString(),
    steps,
    finalCookies: { cookies: snapshotCookies(jar) },
  };
}
