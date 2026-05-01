const CLASSIFICATION_RULES = [
  { match: (e) => e.normalizedPath.startsWith('/cdn-cgi/'), result: 'browser-bound' },
  { match: (e) => e.host === 'sentinel.openai.com', result: 'browser-bound' },
  { match: (e) => e.host === 'auth.openai.com' && e.normalizedPath.startsWith('/api/accounts/authorize'), result: 'browser-bound' },
  { match: (e) => e.normalizedPath.includes('email-otp'), result: 'challenge-bound' },
  {
    match: (e) => e.host === 'auth.openai.com' && (
      Object.keys(e.requestHeaders ?? {}).some((h) => h.toLowerCase().includes('sentinel')) ||
      ['/api/accounts/user/register', '/api/accounts/create_account'].includes(e.normalizedPath)
    ),
    result: 'replayable-with-dynamic-cookie-csrf-extraction',
  },
  { match: (e) => e.host === 'auth.openai.com', result: 'replayable-with-dynamic-cookie-csrf-extraction' },
  { match: (e) => e.host === 'chatgpt.com' || e.host.endsWith('.chatgpt.com'), result: 'replayable-direct' },
];

export function classifyEndpoint(entry) {
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.match(entry)) return rule.result;
  }
  return 'unknown';
}

export function buildReplayCandidates(catalog) {
  return catalog.map((entry) => ({
    endpointId: entry.endpointId,
    method: entry.method,
    normalizedPath: entry.normalizedPath,
    host: entry.host,
    authCritical: entry.authCritical ?? false,
    replayClassification: classifyEndpoint(entry),
    requestHeaderKeys: Object.keys(entry.requestHeaders ?? {}),
    responseStatus: entry.responseStatus,
    occurrences: entry.occurrences,
  }));
}
