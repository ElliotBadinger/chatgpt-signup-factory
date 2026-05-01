import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadTracePairs, loadCookieDiffs, loadCheckpoints } from './traceArtifactLoader.js';
import { buildEndpointCatalog } from './endpointCatalog.js';
import { buildFlowSequence, flagAuthCritical } from './flowSequence.js';
import { buildCookieEvolution } from './cookieEvolution.js';
import { buildReplayCandidates } from './replayCandidates.js';
import { buildCatalogAnalysis, inferActualScenario, classifyReplayability } from './analysis.js';

const PHASE_ORDER = ['landing', 'auth-page-loaded', 'email-submitted', 'otp-page', 'otp-submitted', 'password-page', 'password-submitted', 'post-callback', 'final'];

export async function runCatalogAnalysis(traceDir, opts = {}) {
  const { dryRun = false } = opts;

  const [pairs, cookieDiffs, checkpoints] = await Promise.all([
    loadTracePairs(traceDir),
    loadCookieDiffs(traceDir),
    loadCheckpoints(traceDir),
  ]);

  const rawCatalog = buildEndpointCatalog(pairs);
  const flowSequence = buildFlowSequence(pairs);

  const endpointCatalog = rawCatalog.map((entry) => ({
    ...entry,
    authCritical: flowSequence.some(
      (s) => s.normalizedPath === entry.normalizedPath && s.host === entry.host && s.authCritical,
    ),
  }));

  const presentPhases = PHASE_ORDER.filter((p) => cookieDiffs[p] !== undefined);
  const cookieEvolution = buildCookieEvolution(cookieDiffs, presentPhases.length > 0 ? presentPhases : PHASE_ORDER);

  const replayCandidates = buildReplayCandidates(endpointCatalog);

  const catalogAnalysis = buildCatalogAnalysis({
    flowSeq: flowSequence,
    candidates: replayCandidates,
    cookieEvo: cookieEvolution,
  });

  const actualScenario = inferActualScenario(checkpoints);
  const replayability = classifyReplayability({
    actualScenario,
    hasAuthenticatedSession: checkpoints.some((c) => c.session?.hasAccessToken),
    sawAuthOpenAi: checkpoints.some((c) => String(c.url ?? '').includes('auth.openai.com')),
    sawChatGptSession: checkpoints.some((c) => Boolean(c.session?.hasAccessToken)),
    sawPasswordPage: checkpoints.some((c) => String(c.url ?? '').includes('password')),
    sawSignupPage: checkpoints.some((c) => String(c.url ?? '').includes('create-account')),
  });

  const analysis = {
    actualScenario,
    replayability,
    ...catalogAnalysis,
  };

  if (!dryRun) {
    await Promise.all([
      writeFile(path.join(traceDir, 'endpoint-catalog.json'), `${JSON.stringify(endpointCatalog, null, 2)}\n`, 'utf8'),
      writeFile(path.join(traceDir, 'flow-sequence.json'), `${JSON.stringify(flowSequence, null, 2)}\n`, 'utf8'),
      writeFile(path.join(traceDir, 'cookie-evolution.json'), `${JSON.stringify(cookieEvolution, null, 2)}\n`, 'utf8'),
      writeFile(path.join(traceDir, 'replay-candidates.json'), `${JSON.stringify(replayCandidates, null, 2)}\n`, 'utf8'),
      writeFile(path.join(traceDir, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`, 'utf8'),
    ]);
  }

  return { endpointCatalog, flowSequence, cookieEvolution, replayCandidates, analysis };
}
