import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ensureTraceRunDir, traceArtifactDir, traceRunId } from '../artifacts.js';
import { writeSummaryJson } from '../../evidence/artifacts.js';
import { runCatalogAnalysis as defaultRunCatalogAnalysis } from '../runCatalogAnalysis.js';
import { launchMitmproxy as defaultLaunchMitmproxy } from './launchMitmproxy.js';
import { buildMitmAddonSource, writeJsonArtifact } from './deepCaptureArtifacts.js';
import { buildCookieChronology, buildRedirectChains, mergeDeepEvidence } from './mergeDeepEvidence.js';
import { extractJsonSchemaShape } from '../schemaExtraction.js';

async function readJsonLinesDefault(filePath) {
  try {
    const content = await readFile(filePath, 'utf8');
    return content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function buildManualLaunchCommand({ chromeBin, proxyPort, profileDir, startUrl }) {
  return `${chromeBin} --user-data-dir=${profileDir} --proxy-server=127.0.0.1:${proxyPort} --ignore-certificate-errors --no-first-run --no-default-browser-check --disable-blink-features=AutomationControlled --window-size=1280,1024 --lang=en-US,en --disable-dev-shm-usage --no-sandbox ${startUrl}`;
}

function parseResponseBody(rawBody, headers = {}) {
  const contentType = headers['content-type'] ?? headers['Content-Type'] ?? '';
  if (typeof rawBody !== 'string' || rawBody.length === 0) return null;
  if (contentType.includes('application/json') || rawBody.trim().startsWith('{') || rawBody.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(rawBody);
      return {
        kind: 'json',
        keys: Array.isArray(parsed) ? [] : Object.keys(parsed),
        schema: extractJsonSchemaShape(parsed),
        preview: rawBody.slice(0, 2000),
      };
    } catch {
      // fall through
    }
  }
  return {
    kind: 'text',
    preview: rawBody.slice(0, 2000),
  };
}

function normalizeProxyFlows(flows = []) {
  return flows.map((flow, index) => {
    const responseHeaders = flow.responseheaders ?? flow.responseHeaders ?? {};
    const requestHeaders = flow.requestheaders ?? flow.requestHeaders ?? {};
    const location = responseHeaders.location ?? responseHeaders.Location ?? null;
    const setCookieRaw = responseHeaders['set-cookie'] ?? responseHeaders['Set-Cookie'];
    const setCookieNames = !setCookieRaw
      ? []
      : (Array.isArray(setCookieRaw) ? setCookieRaw : [setCookieRaw]).map((v) => String(v).split('=')[0].trim()).filter(Boolean);
    return {
      id: index + 1,
      ts: flow.ts ?? index + 1,
      url: flow.url,
      method: flow.method ?? 'GET',
      requestHeaders,
      responseHeaders,
      requestBody: flow.requestBody ?? '',
      responseBody: flow.responseBody ?? '',
      responseStatus: flow.status ?? flow.responseStatus ?? null,
      redirectLocation: location,
      setCookieNames,
    };
  });
}

async function writeProxyDerivedArtifacts(runDir, proxyFlows) {
  const reqDir = path.join(runDir, 'requests');
  const resDir = path.join(runDir, 'responses');
  await mkdir(reqDir, { recursive: true });
  await mkdir(resDir, { recursive: true });

  for (const flow of proxyFlows) {
    const requestPayload = {
      type: 'request',
      ts: flow.ts,
      url: flow.url,
      method: flow.method,
      headers: flow.requestHeaders,
      postData: flow.requestBody || null,
    };
    const responsePayload = {
      type: 'response',
      ts: flow.ts,
      url: flow.url,
      status: flow.responseStatus,
      headers: flow.responseHeaders,
      body: parseResponseBody(flow.responseBody, flow.responseHeaders),
    };
    await writeFile(path.join(reqDir, `request-${flow.id}.json`), `${JSON.stringify(requestPayload, null, 2)}\n`, 'utf8');
    await writeFile(path.join(resDir, `response-${flow.id}.json`), `${JSON.stringify(responsePayload, null, 2)}\n`, 'utf8');
  }
}

export async function runProxyOnlyAuthCapture(opts, deps = {}) {
  const {
    artifactDir = path.join(process.cwd(), 'artifacts', 'auth-traces'),
    scenario = 'unknown-auto',
    label = 'proxy-only-run',
    startUrl = 'https://auth.openai.com/log-in-or-create-account',
    proxyPort = 9988,
    mitmBin = 'mitmdump',
    chromeBin = '/usr/bin/google-chrome',
  } = opts;

  const now = deps.now ? deps.now() : new Date();
  const runId = traceRunId(label, now);
  const runDir = traceArtifactDir(artifactDir, runId);
  await ensureTraceRunDir(runDir);
  await mkdir(path.join(runDir, 'proxy'), { recursive: true });
  await mkdir(path.join(runDir, 'checkpoints'), { recursive: true });
  await mkdir(path.join(runDir, 'cookie-diffs'), { recursive: true });
  await mkdir(path.join(runDir, '.tmp'), { recursive: true });

  const waitForEnter = deps.waitForEnter ?? (async () => {});
  const launchMitmproxy = deps.launchMitmproxy ?? defaultLaunchMitmproxy;
  const runCatalogAnalysis = deps.runCatalogAnalysis ?? defaultRunCatalogAnalysis;
  const readJsonLines = deps.readJsonLines ?? readJsonLinesDefault;

  const mitmAddonPath = path.join(runDir, 'proxy', 'mitm-addon.py');
  const proxyFlowsPath = path.join(runDir, 'proxy', 'flows.jsonl');
  const profileDir = path.join(runDir, '.tmp', 'manual-browser-profile');
  await mkdir(profileDir, { recursive: true });
  await writeFile(mitmAddonPath, buildMitmAddonSource(), 'utf8');

  const proxy = await launchMitmproxy({ port: proxyPort, addonPath: mitmAddonPath, flowsPath: proxyFlowsPath, binary: mitmBin });
  const manualLaunchCommand = buildManualLaunchCommand({ chromeBin, proxyPort: proxy.port, profileDir, startUrl });

  const phasePrompts = [
    'Launch the browser with the printed command and press Enter once the target page is open',
    'Press Enter after the auth page fully loads',
    'Press Enter after email submission',
    'Press Enter after OTP page is visible (if any)',
    'Press Enter after OTP submission',
    'Press Enter after password page is visible',
    'Press Enter after password submission',
    'Press Enter after callback returns to ChatGPT',
    'Press Enter after the final authenticated state is stable',
  ];

  try {
    for (const prompt of phasePrompts) {
      await waitForEnter(prompt);
    }

    const proxyFlowsRaw = await readJsonLines(proxyFlowsPath);
    const proxyFlows = normalizeProxyFlows(proxyFlowsRaw);
    const redirectChains = buildRedirectChains(proxyFlows);
    const cookieChronology = buildCookieChronology(proxyFlows);
    const deepMerge = mergeDeepEvidence({ proxyFlows, cdpEvents: [], browserTrace: [] });

    await writeProxyDerivedArtifacts(runDir, proxyFlows);
    await writeJsonArtifact(path.join(runDir, 'redirect-chains.json'), redirectChains);
    await writeJsonArtifact(path.join(runDir, 'cookie-chronology.json'), cookieChronology);
    await writeJsonArtifact(path.join(runDir, 'deep-merge.json'), deepMerge);

    const summary = {
      runId,
      runDir,
      scenario,
      label,
      startUrl,
      createdAt: now.toISOString(),
      captureMode: 'proxy-only-manual',
      proxyPort: proxy.port,
      manualLaunchCommand,
    };
    await writeSummaryJson(runDir, summary);

    await runCatalogAnalysis(runDir, { dryRun: false });

    return { status: 'ok', runId, runDir, summary };
  } finally {
    await proxy.cleanup?.();
  }
}
