function nowIso(nowFactory) {
  return (nowFactory ? nowFactory() : new Date()).toISOString();
}

export function isCriticalAuthUrl(url = '') {
  return /chatgpt\.com\/auth\/login_with|chatgpt\.com\/api\/auth\/|auth\.openai\.com\/api\/accounts\/(authorize|workspace\/select)|chatgpt\.com\/backend-api\/user_granular_consent|cdn-cgi\/challenge-platform/i.test(url);
}

function isChallengeUrl(url = '') {
  return /cdn-cgi\/challenge-platform|challenge-platform|cf-chl|turnstile/i.test(url);
}

export function createCriticalAuthTracker({ writeCriticalRecord, getResponseBody, now = null }) {
  const requests = new Map();
  const criticalRequests = [];
  const jsExceptions = [];
  const challengeSignals = [];

  async function finalizeRequest(requestId, extra = {}) {
    const record = requests.get(requestId);
    if (!record || record.finalized) return;
    record.finalized = true;
    let responseBody = null;
    try {
      if (record.response) {
        const body = await getResponseBody(requestId);
        responseBody = {
          text: body.base64Encoded ? null : body.body,
          base64Encoded: !!body.base64Encoded,
          length: body.body?.length ?? 0,
        };
      }
    } catch (error) {
      responseBody = { error: error.message };
    }
    const output = {
      capturedAt: nowIso(now),
      requestId,
      url: record.url,
      method: record.method,
      documentURL: record.documentURL,
      initiator: record.initiator,
      requestHeaders: record.requestHeaders,
      postData: record.postData ?? null,
      status: record.response?.status ?? null,
      mimeType: record.response?.mimeType ?? null,
      responseHeaders: {
        ...(record.response?.headers ?? {}),
        ...(record.responseExtraHeaders ?? {}),
      },
      responseBody,
      failureText: extra.failureText ?? null,
    };
    criticalRequests.push(output);
    await writeCriticalRecord(output);
  }

  async function onEvent(method, params) {
    if (method === 'Runtime.exceptionThrown') {
      jsExceptions.push({
        capturedAt: nowIso(now),
        text: params.exceptionDetails?.text || params.exceptionDetails?.exception?.description || 'Unknown exception',
        exception: params.exceptionDetails?.exception?.description ?? null,
      });
      return;
    }

    if (method === 'Network.requestWillBeSent') {
      const url = params.request?.url ?? '';
      if (!isCriticalAuthUrl(url)) return;
      requests.set(params.requestId, {
        url,
        method: params.request?.method ?? 'GET',
        documentURL: params.documentURL ?? null,
        initiator: params.initiator?.type ?? null,
        requestHeaders: params.request?.headers ?? {},
        postData: params.request?.postData ?? null,
      });
      if (isChallengeUrl(url)) {
        challengeSignals.push({ capturedAt: nowIso(now), kind: 'cloudflare-challenge-script', url });
      }
      return;
    }

    if (method === 'Network.responseReceived') {
      const record = requests.get(params.requestId);
      if (!record) return;
      record.response = {
        status: params.response?.status ?? null,
        mimeType: params.response?.mimeType ?? null,
        headers: params.response?.headers ?? {},
      };
      if ((params.response?.headers?.server || '').toString().toLowerCase().includes('cloudflare')) {
        challengeSignals.push({ capturedAt: nowIso(now), kind: 'cloudflare-response', url: record.url, status: params.response?.status ?? null });
      }
      return;
    }

    if (method === 'Network.responseReceivedExtraInfo') {
      const record = requests.get(params.requestId);
      if (!record) return;
      record.responseExtraHeaders = params.headers ?? {};
      return;
    }

    if (method === 'Network.loadingFinished') {
      await finalizeRequest(params.requestId);
      return;
    }

    if (method === 'Network.loadingFailed') {
      await finalizeRequest(params.requestId, { failureText: params.errorText ?? 'loading failed' });
    }
  }

  return {
    onEvent,
    summary() {
      return {
        criticalRequests,
        jsExceptions,
        challengeSignals,
      };
    },
  };
}
