import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ensureTraceRunDir, traceArtifactDir, traceRunId } from './artifacts.js';
import { createTraceWriter } from './traceWriter.js';
import { probePageCheckpoint } from './checkpoints.js';
import { buildCheckpointPlan } from './checkpointPlan.js';
import { attachChromeTraceSession as defaultAttachTraceSession } from './chromeTraceSession.js';
import { launchLocalChrome as defaultLaunchLocalChrome } from './launchLocalChrome.js';
import { inferActualScenario, summarizeCheckpointDiff, classifyReplayability } from './analysis.js';
import { runCatalogAnalysis as defaultRunCatalogAnalysis } from './runCatalogAnalysis.js';
import { writeSummaryJson } from '../evidence/artifacts.js';

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

export async function runAuthTrace(opts, deps = {}) {
  const {
    artifactDir = path.join(process.cwd(), 'artifacts', 'auth-traces'),
    mode = 'manual',
    scenario = 'unknown-auto',
    label = 'run',
    startUrl = 'https://chatgpt.com/',
  } = opts;

  const now = deps.now ? deps.now() : new Date();
  const runId = traceRunId(label, now);
  const runDir = traceArtifactDir(artifactDir, runId);
  await ensureTraceRunDir(runDir);
  await mkdir(path.join(runDir, 'cookie-diffs'), { recursive: true });

  const launchBrowserSession = deps.launchBrowserSession ?? deps.launchLocalChrome ?? defaultLaunchLocalChrome;
  const attachTraceSession = deps.attachTraceSession ?? defaultAttachTraceSession;
  const waitForEnter = deps.waitForEnter ?? (async () => {});

  const session = await launchBrowserSession(opts);
  const writer = createTraceWriter(path.join(runDir, 'trace.jsonl'));
  const trace = attachTraceSession({ page: session.page, writer, runDir });
  const recorder = deps.createCheckpointRecorder
    ? deps.createCheckpointRecorder({ page: session.page, runDir, writer })
    : defaultCheckpointRecorder(session.page, runDir);

  const checkpointPlan = deps.checkpointPlan ?? buildCheckpointPlan({ mode, scenario });

  await session.page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const checkpoints = [];
  let finalCheckpoint = null;

  for (const step of checkpointPlan) {
    if (step.name !== 'landing' && step.prompt) {
      await waitForEnter(step.prompt);
    }
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

  await writeFile(
    path.join(runDir, 'analysis.json'),
    `${JSON.stringify({ actualScenario, replayability }, null, 2)}\n`,
    'utf8',
  );

  const summary = {
    runId,
    runDir,
    mode,
    scenario,
    label,
    startUrl,
    finalUrl: finalCheckpoint?.url ?? startUrl,
    createdAt: now.toISOString(),
  };

  await writeSummaryJson(runDir, summary);

  const catalogAnalysisFn = deps.runCatalogAnalysis ?? defaultRunCatalogAnalysis;
  try {
    await catalogAnalysisFn(runDir, { dryRun: false });
  } catch (err) {
    await writer.write({ type: 'catalog-analysis-error', message: String(err) });
  }

  await trace.detach?.();
  await session.cleanup?.();

  return { status: 'ok', runId, runDir, summary };
}
