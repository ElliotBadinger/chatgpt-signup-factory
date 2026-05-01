import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureTraceRunDir, traceArtifactDir, traceRunId } from '../artifacts.js';
import { createTraceWriter } from '../traceWriter.js';
import { probePageCheckpoint } from '../checkpoints.js';
import { buildCheckpointPlan } from '../checkpointPlan.js';
import { attachChromeTraceSession as defaultAttachTraceSession } from '../chromeTraceSession.js';
import { launchLocalChrome as defaultLaunchLocalChrome } from '../launchLocalChrome.js';
import { inferActualScenario, summarizeCheckpointDiff, classifyReplayability } from '../analysis.js';
import { runCatalogAnalysis as defaultRunCatalogAnalysis } from '../runCatalogAnalysis.js';
import { writeSummaryJson } from '../../evidence/artifacts.js';
import { launchMitmproxy as defaultLaunchMitmproxy } from './launchMitmproxy.js';
import { attachCdpNetwork as defaultAttachCdpNetwork } from './attachCdpNetwork.js';
import { buildMitmAddonSource, writeJsonArtifact } from './deepCaptureArtifacts.js';
import { buildCookieChronology, buildRedirectChains, mergeDeepEvidence } from './mergeDeepEvidence.js';
import { ensureMitmCertificateTrusted, findCertutilBinary } from './trustMitmCertificate.js';
import { connectToBrowser as defaultConnectToBrowser } from './connectToBrowser.js';

function defaultCheckpointRecorder(page, runDir) {
  return {
    async record(name) {
      const payload = await probePageCheckpoint(page);
      const checkpoint = { ...payload, name };
      await writeFile(path.join(runDir, 'checkpoints', `${name}.json`), `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
      return checkpoint;
    },
  };
}

async function readJsonLinesDefault(filePath) {
  try {
    const content = await readFile(filePath, 'utf8');
    return content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function normalizeProxyFlows(flows = []) {
  return flows.map((flow, index) => {
    const responseHeaders = flow.responseheaders ?? flow.responseHeaders ?? {};
    const location = responseHeaders.location ?? responseHeaders.Location ?? null;
    const setCookieRaw = responseHeaders['set-cookie'] ?? responseHeaders['Set-Cookie'];
    const setCookieNames = !setCookieRaw
      ? []
      : (Array.isArray(setCookieRaw) ? setCookieRaw : [setCookieRaw]).map((v) => String(v).split('=')[0].trim()).filter(Boolean);
    return {
      id: index + 1,
      ts: flow.ts ?? index,
      url: flow.url,
      method: flow.method,
      responseStatus: flow.status ?? flow.responseStatus ?? null,
      redirectLocation: location,
      setCookieNames,
      requestHeaders: flow.requestheaders ?? flow.requestHeaders ?? {},
      responseHeaders,
    };
  });
}

export async function runDeepAuthCapture(opts, deps = {}) {
  const {
    artifactDir = path.join(process.cwd(), 'artifacts', 'auth-traces'),
    scenario = 'unknown-auto',
    label = 'deep-run',
    startUrl = 'https://chatgpt.com/',
    proxyPort = 8899,
  } = opts;

  const now = deps.now ? deps.now() : new Date();
  const runId = traceRunId(label, now);
  const runDir = traceArtifactDir(artifactDir, runId);
  await ensureTraceRunDir(runDir);
  await mkdir(path.join(runDir, 'cookie-diffs'), { recursive: true });
  await mkdir(path.join(runDir, 'proxy'), { recursive: true });
  await mkdir(path.join(runDir, 'cdp'), { recursive: true });
  await mkdir(path.join(runDir, '.tmp'), { recursive: true });

  const waitForEnter = deps.waitForEnter ?? (async () => {});
  const launchMitmproxy = deps.launchMitmproxy ?? defaultLaunchMitmproxy;
  const launchLocalChrome = deps.launchLocalChrome ?? defaultLaunchLocalChrome;
  const connectToBrowser = deps.connectToBrowser ?? defaultConnectToBrowser;
  const attachTraceSession = deps.attachTraceSession ?? defaultAttachTraceSession;
  const attachCdpNetwork = deps.attachCdpNetwork ?? defaultAttachCdpNetwork;
  const runCatalogAnalysis = deps.runCatalogAnalysis ?? defaultRunCatalogAnalysis;
  const readJsonLines = deps.readJsonLines ?? readJsonLinesDefault;

  const mitmAddonPath = path.join(runDir, 'proxy', 'mitm-addon.py');
  const proxyFlowsPath = path.join(runDir, 'proxy', 'flows.jsonl');
  await writeFile(mitmAddonPath, buildMitmAddonSource(), 'utf8');

  const proxy = await launchMitmproxy({ port: proxyPort, addonPath: mitmAddonPath, flowsPath: proxyFlowsPath, binary: opts.mitmBin });
  const tempProfileDir = path.join(runDir, '.tmp', 'chrome-profile');
  const tempHomeDir = path.join(runDir, '.tmp', 'chrome-home');
  await mkdir(tempProfileDir, { recursive: true });
  await mkdir(tempHomeDir, { recursive: true });

  const certPath = path.join(os.homedir(), '.mitmproxy', 'mitmproxy-ca-cert.pem');
  const certutilBin = opts.certutilBin || null;
  let certificateTrust = { ok: false, reason: 'disabled' };
  let chromeEnv = undefined;
  if (certutilBin) {
    try {
      const resolvedCertutilBin = certutilBin === 'auto' ? await findCertutilBinary() : certutilBin;
      if (!resolvedCertutilBin) {
        certificateTrust = { ok: false, reason: 'certutil-unavailable' };
      } else {
        certificateTrust = await ensureMitmCertificateTrusted({ homeDir: tempHomeDir, certPath, certutilBin: resolvedCertutilBin });
        chromeEnv = { ...process.env, HOME: tempHomeDir };
      }
    } catch (error) {
      certificateTrust = { ok: false, reason: 'certutil-import-failed', message: String(error) };
    }
  }

  const session = opts.browserUrl
    ? await connectToBrowser({ browserUrl: opts.browserUrl })
    : await launchLocalChrome({
      ...opts,
      proxyServer: `127.0.0.1:${proxy.port}`,
      ignoreCertificateErrors: true,
      userDataDir: tempProfileDir,
      env: chromeEnv,
    }, deps.launchLocalChromeDeps ?? {});

  const writer = createTraceWriter(path.join(runDir, 'trace.jsonl'));
  const cdpWriter = createTraceWriter(path.join(runDir, 'cdp', 'network.jsonl'));
  const trace = attachTraceSession({ page: session.page, writer, runDir });
  const cdp = await attachCdpNetwork({ page: session.page, writer: cdpWriter });
  const recorder = deps.createCheckpointRecorder
    ? deps.createCheckpointRecorder({ page: session.page, runDir, writer })
    : defaultCheckpointRecorder(session.page, runDir);

  const checkpointPlan = deps.checkpointPlan ?? buildCheckpointPlan({ mode: 'manual', scenario });
  await session.page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const checkpoints = [];
  let finalCheckpoint = null;

  try {
    for (const step of checkpointPlan) {
      if (step.name !== 'landing' && step.prompt) await waitForEnter(step.prompt);
      const cp = await recorder.record(step.name);
      checkpoints.push(cp);
      await writer.write({ type: 'checkpoint', name: step.name, url: cp.url });
      if (checkpoints.length >= 2) {
        const diff = summarizeCheckpointDiff(checkpoints[checkpoints.length - 2], cp);
        await writeFile(path.join(runDir, 'cookie-diffs', `${step.name}.json`), `${JSON.stringify(diff, null, 2)}\n`, 'utf8');
      }
      finalCheckpoint = cp;
    }

    const actualScenario = inferActualScenario(checkpoints);
    const replayability = classifyReplayability({
      actualScenario,
      hasAuthenticatedSession: Boolean(finalCheckpoint?.session?.hasAccessToken),
      sawAuthOpenAi: checkpoints.some((c) => String(c.url ?? '').includes('auth.openai.com')),
      sawChatGptSession: checkpoints.some((c) => Boolean(c.session?.hasAccessToken)),
      sawPasswordPage: checkpoints.some((c) => String(c.url ?? '').includes('password')),
      sawSignupPage: checkpoints.some((c) => String(c.url ?? '').includes('create-account')),
    });

    await writeFile(path.join(runDir, 'analysis.json'), `${JSON.stringify({ actualScenario, replayability }, null, 2)}\n`, 'utf8');

    const proxyFlowsRaw = await readJsonLines(proxyFlowsPath);
    const cdpEvents = await readJsonLines(path.join(runDir, 'cdp', 'network.jsonl'));
    const browserTrace = await readJsonLines(path.join(runDir, 'trace.jsonl'));
    const proxyFlows = normalizeProxyFlows(proxyFlowsRaw);
    const redirectChains = buildRedirectChains(proxyFlows);
    const cookieChronology = buildCookieChronology(proxyFlows);
    const deepMerge = mergeDeepEvidence({ proxyFlows, cdpEvents, browserTrace });

    await writeJsonArtifact(path.join(runDir, 'redirect-chains.json'), redirectChains);
    await writeJsonArtifact(path.join(runDir, 'cookie-chronology.json'), cookieChronology);
    await writeJsonArtifact(path.join(runDir, 'deep-merge.json'), deepMerge);

    const summary = {
      runId,
      runDir,
      scenario,
      label,
      startUrl,
      finalUrl: finalCheckpoint?.url ?? startUrl,
      createdAt: now.toISOString(),
      captureMode: 'deep-manual',
      proxyPort: proxy.port,
      certificateTrust,
    };
    await writeSummaryJson(runDir, summary);

    await runCatalogAnalysis(runDir, { dryRun: false });

    return { status: 'ok', runId, runDir, summary };
  } finally {
    await cdp.detach?.();
    await trace.detach?.();
    await session.cleanup?.();
    await proxy.cleanup?.();
  }
}
