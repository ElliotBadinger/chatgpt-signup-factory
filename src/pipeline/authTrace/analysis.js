function cookieKey(cookie) {
  return `${cookie.name}@${cookie.domain}`;
}

export function summarizeCheckpointDiff(prev = { cookies: [] }, next = { cookies: [] }) {
  const prevSet = new Set((prev.cookies ?? []).map(cookieKey));
  const nextSet = new Set((next.cookies ?? []).map(cookieKey));
  const addedCookies = [...nextSet].filter((k) => !prevSet.has(k)).sort();
  const removedCookies = [...prevSet].filter((k) => !nextSet.has(k)).sort();
  const persistedCookies = [...nextSet].filter((k) => prevSet.has(k)).sort();
  return { addedCookies, removedCookies, persistedCookies };
}

export function inferActualScenario(checkpoints = []) {
  const authCp = checkpoints.find((c) => String(c.url ?? '').includes('auth.openai.com/log-in/password'));
  const hasAccess = checkpoints.some((c) => c.session?.hasAccessToken);
  if (authCp && hasAccess) return 'signin-existing';
  if (checkpoints.some((c) => String(c.url ?? '').includes('create-account'))) return 'signup-new';
  return 'unknown-auto';
}

export function classifyReplayability(summary = {}) {
  if (summary.hasAuthenticatedSession && summary.sawAuthOpenAi && summary.sawChatGptSession) {
    return { classification: 'browser-bootstrap-only', confidence: 'medium' };
  }
  return { classification: 'browser-required', confidence: 'low' };
}

const POST_CALLBACK_PHASES = new Set(['post-callback', 'final']);

export function buildCatalogAnalysis({ flowSeq = [], candidates = [], cookieEvo = {} }) {
  const firstAuthSideRequest = flowSeq.find((e) => e.host === 'auth.openai.com');
  const firstAccessToken = flowSeq.find((e) => e.firstAccessTokenOccurrence);

  const firstAppearance = cookieEvo.firstAppearance ?? {};
  const preCallbackCookies = Object.entries(firstAppearance)
    .filter(([, phase]) => !POST_CALLBACK_PHASES.has(phase))
    .map(([cookie]) => cookie);
  const postCallbackCookies = Object.entries(firstAppearance)
    .filter(([, phase]) => POST_CALLBACK_PHASES.has(phase))
    .map(([cookie]) => cookie);

  const browserBoundEndpoints = candidates
    .filter((c) => c.replayClassification === 'browser-bound' || c.replayClassification === 'challenge-bound')
    .map((c) => c.endpointId);

  const likelyReplayCandidates = candidates
    .filter((c) => c.replayClassification === 'replayable-direct')
    .map((c) => c.endpointId);

  return {
    firstAuthSideSessionRequest: firstAuthSideRequest ?? null,
    firstAccessTokenRequest: firstAccessToken ?? null,
    preCallbackCookies,
    postCallbackCookies,
    browserBoundEndpoints,
    likelyReplayCandidates,
  };
}
