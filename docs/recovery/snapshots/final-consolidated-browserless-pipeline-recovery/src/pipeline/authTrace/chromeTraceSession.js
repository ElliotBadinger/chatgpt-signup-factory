import path from 'node:path';

import { redactHeaders, redactValue } from './redaction.js';
import { writeDetailedArtifact } from './detailedArtifacts.js';
import { extractJsonSchemaShape } from './schemaExtraction.js';

function safePostData(request) {
  try { return redactValue(request.postData?.() ?? null); } catch { return null; }
}

export function isRelevantTraceUrl(url) {
  return /chatgpt\.com|openai\.com|clerk|challenges\.cloudflare\.com/.test(String(url ?? ''));
}

export function shouldCaptureResponseBody(url) {
  return /api\/auth\/session|backend-api|auth\.openai\.com|clerk/i.test(String(url ?? ''));
}

export async function summarizeResponseBody(response) {
  const url = response.url();
  if (!shouldCaptureResponseBody(url)) return null;
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      return {
        kind: 'json',
        keys: Object.keys(json),
        schema: extractJsonSchemaShape(json),
        preview: redactValue(JSON.stringify(json).slice(0, 500)),
      };
    } catch {
      return { kind: 'text', preview: redactValue(String(text).slice(0, 500)) };
    }
  } catch {
    return null;
  }
}

export function attachChromeTraceSession({ page, writer, runDir = null }) {
  let requestCounter = 0;
  let responseCounter = 0;

  const onRequest = async (request) => {
    const url = request.url();
    if (!isRelevantTraceUrl(url)) return;
    const event = {
      type: 'request',
      ts: Date.now(),
      url,
      method: request.method(),
      headers: redactHeaders(request.headers()),
      postData: safePostData(request),
    };
    await writer.write(event);
    if (runDir && shouldCaptureResponseBody(url)) {
      requestCounter += 1;
      await writeDetailedArtifact(path.join(runDir, 'requests'), `request-${requestCounter}`, event);
    }
  };

  const onResponse = async (response) => {
    const url = response.url();
    if (!isRelevantTraceUrl(url)) return;
    const body = await summarizeResponseBody(response);
    const event = {
      type: 'response',
      ts: Date.now(),
      url,
      status: response.status(),
      headers: redactHeaders(response.headers()),
      body,
    };
    await writer.write(event);
    if (runDir && shouldCaptureResponseBody(url)) {
      responseCounter += 1;
      await writeDetailedArtifact(path.join(runDir, 'responses'), `response-${responseCounter}`, event);
    }
  };

  const onNav = async (frame) => {
    const url = frame.url();
    if (!isRelevantTraceUrl(url)) return;
    await writer.write({ type: 'nav', ts: Date.now(), url });
  };

  const onConsole = async (msg) => {
    await writer.write({ type: 'console', ts: Date.now(), text: msg.text?.() ?? String(msg) });
  };

  const onPageError = async (err) => {
    await writer.write({ type: 'pageerror', ts: Date.now(), message: err.message ?? String(err) });
  };

  const onRequestFailed = async (req) => {
    const url = req.url();
    if (!isRelevantTraceUrl(url)) return;
    await writer.write({
      type: 'requestfailed',
      ts: Date.now(),
      url,
      method: req.method(),
      failure: req.failure?.() ?? null,
    });
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('framenavigated', onNav);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('requestfailed', onRequestFailed);

  return { detach: async () => {} };
}
