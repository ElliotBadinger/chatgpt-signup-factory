import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ensureTraceRunDir, traceArtifactDir, traceRunId } from '../artifacts.js';
import { writeSummaryJson } from '../../evidence/artifacts.js';
import { runCdpCommand as defaultRunCdpCommand, selectTargetFromPages } from './cdpClient.js';
import { createNetworkRecorder as defaultCreateNetworkRecorder, listOpenPages as defaultListOpenPages } from './browserCdp.js';
import { buildBootstrapAnalysis } from './bootstrapAnalysis.js';

const PHASES = [
  'auth-page-loaded',
  'email-submitted',
  'otp-page',
  'otp-submitted',
  'password-page',
  'password-submitted',
  'post-callback',
  'final',
];

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function capturePhase(runDir, phase, targetIdPrefix, runCdpCommand, cdpOptions, recorder, phaseBoundaries) {
  const phaseDir = path.join(runDir, 'phases', phase);
  await mkdir(phaseDir, { recursive: true });

  const boundary = await recorder.captureBoundary(phase);
  const liveTargetPrefix = boundary.targetIdPrefix ?? targetIdPrefix;
  phaseBoundaries.push(boundary);
  await writeJson(path.join(runDir, 'phase-boundaries.json'), phaseBoundaries);
  await writeJson(path.join(phaseDir, 'cookies.json'), boundary.cookies);
  await writeJson(path.join(phaseDir, 'storage.json'), boundary.storage);
  await writeJson(path.join(phaseDir, 'boundary.json'), boundary);

  const [snapshot, html, net, pageMeta] = await Promise.all([
    recorder.snapshot ? recorder.snapshot() : runCdpCommand({ args: ['snap', liveTargetPrefix], ...cdpOptions }),
    recorder.html ? recorder.html() : runCdpCommand({ args: ['html', liveTargetPrefix], ...cdpOptions }),
    recorder.resourceEntries ? recorder.resourceEntries() : runCdpCommand({ args: ['net', liveTargetPrefix], ...cdpOptions }),
    recorder.pageMeta
      ? Promise.resolve(recorder.pageMeta()).then((data) => JSON.stringify(data, null, 2))
      : runCdpCommand({
          args: [
            'evalraw',
            liveTargetPrefix,
            'Runtime.evaluate',
            JSON.stringify({
              expression: '({url: location.href, title: document.title})',
              returnByValue: true,
              awaitPromise: true,
            }),
          ],
          ...cdpOptions,
        }),
  ]);

  await writeFile(path.join(phaseDir, 'snapshot.txt'), snapshot, 'utf8');
  await writeFile(path.join(phaseDir, 'page.html'), html, 'utf8');
  await writeFile(path.join(phaseDir, 'network.txt'), net, 'utf8');
  await writeFile(path.join(phaseDir, 'page-meta.json'), `${pageMeta}\n`, 'utf8');

  const screenshotPath = path.join(phaseDir, 'screenshot.png');
  if (recorder.screenshot) {
    await recorder.screenshot(screenshotPath);
  } else {
    await runCdpCommand({ args: ['shot', liveTargetPrefix, screenshotPath], ...cdpOptions });
  }

  return liveTargetPrefix;
}

export async function runAuthCdpCapture(opts, deps = {}) {
  const {
    artifactDir = path.join(process.cwd(), 'artifacts', 'auth-traces'),
    scenario = 'unknown-auto',
    label = 'cdp-run',
    startUrl = 'https://auth.openai.com/log-in-or-create-account',
    target = null,
    cdpPort = null,
    cdpWsUrl = null,
  } = opts;

  const now = deps.now ? deps.now() : new Date();
  const runId = traceRunId(label, now);
  const runDir = traceArtifactDir(artifactDir, runId);
  await ensureTraceRunDir(runDir);
  await mkdir(path.join(runDir, 'phases'), { recursive: true });

  const runCdpCommand = deps.runCdpCommand ?? defaultRunCdpCommand;
  const waitForEnter = deps.waitForEnter ?? (async () => {});
  const listPages = deps.listPages ?? defaultListOpenPages;
  const createRecorder = deps.createRecorder ?? defaultCreateNetworkRecorder;
  const cdpOptions = { cdpPort, cdpWsUrl };
  const phaseBoundaries = [];

  const pages = await listPages(cdpOptions);
  const selectedTarget = selectTargetFromPages(pages, target);
  const recorder = await createRecorder({
    targetId: selectedTarget.targetId ?? selectedTarget.targetIdPrefix,
    networkEventsPath: path.join(runDir, 'network-events.jsonl'),
    ...cdpOptions,
    now: deps.now ?? null,
  });

  let recorderSummary = null;
  let currentTargetPrefix = selectedTarget.targetIdPrefix;
  try {
    if (recorder.navigate) {
      await recorder.navigate(startUrl);
    } else {
      await runCdpCommand({ args: ['list'], ...cdpOptions });
      await runCdpCommand({ args: ['nav', currentTargetPrefix, startUrl], ...cdpOptions });
    }

    for (const phase of PHASES) {
      await waitForEnter(`Press Enter after ${phase.replaceAll('-', ' ')} is complete`);
      currentTargetPrefix = await capturePhase(runDir, phase, currentTargetPrefix, runCdpCommand, cdpOptions, recorder, phaseBoundaries);
    }
  } finally {
    recorderSummary = await recorder.stop();
    await writeJson(path.join(runDir, 'network-recorder-summary.json'), recorderSummary);
    await writeJson(path.join(runDir, 'js-exceptions.json'), recorderSummary.jsExceptions ?? []);
    await writeJson(path.join(runDir, 'challenge-signals.json'), recorderSummary.challengeSignals ?? []);
    await writeJson(path.join(runDir, 'critical-requests.json'), recorderSummary.criticalRequests ?? []);
    await writeJson(
      path.join(runDir, 'bootstrap-analysis.json'),
      buildBootstrapAnalysis({
        criticalRequests: recorderSummary.criticalRequests ?? [],
        jsExceptions: recorderSummary.jsExceptions ?? [],
        challengeSignals: recorderSummary.challengeSignals ?? [],
      }),
    );
  }

  const summary = {
    runId,
    runDir,
    scenario,
    label,
    startUrl,
    createdAt: now.toISOString(),
    captureMode: 'chrome-cdp-live',
    cdpPort,
    cdpWsUrl,
    target: selectedTarget,
    finalTargetPrefix: currentTargetPrefix,
    phaseCount: phaseBoundaries.length,
    recorderSummary,
  };
  await writeSummaryJson(runDir, summary);

  return { status: 'ok', runId, runDir, summary };
}
