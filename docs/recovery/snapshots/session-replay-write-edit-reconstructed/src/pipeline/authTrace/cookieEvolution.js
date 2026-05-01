const SESSION_COOKIE_PATTERNS = ['session-token', 'session_token', 'access_token'];
const AUTH_SIDE_DOMAINS = ['auth.openai.com', '.auth.openai.com', 'openai.com', '.openai.com'];

function isAuthSide(cookieKey) {
  return AUTH_SIDE_DOMAINS.some((d) => cookieKey.endsWith(`@${d}`));
}

function isChatGptSide(cookieKey) {
  return cookieKey.includes('@chatgpt.com') || cookieKey.includes('@.chatgpt.com');
}

function isSessionCookie(cookieKey) {
  return SESSION_COOKIE_PATTERNS.some((p) => cookieKey.toLowerCase().includes(p));
}

export function buildCookieEvolution(diffs, orderedPhases) {
  const firstAppearance = {};
  const allSeen = new Set();
  const phases = [];

  for (const phase of orderedPhases) {
    const diff = diffs[phase];
    if (!diff) {
      phases.push({ phase, status: 'data-missing', added: [], removed: [], present: [] });
      continue;
    }

    for (const c of diff.addedCookies ?? []) {
      if (!firstAppearance[c]) firstAppearance[c] = phase;
      allSeen.add(c);
    }
    for (const c of diff.persistedCookies ?? []) {
      allSeen.add(c);
    }

    phases.push({
      phase,
      status: 'ok',
      added: diff.addedCookies ?? [],
      removed: diff.removedCookies ?? [],
      present: [...new Set([...(diff.addedCookies ?? []), ...(diff.persistedCookies ?? [])])],
    });
  }

  const allCookies = [...allSeen];
  return {
    phases,
    firstAppearance,
    authSideCookies: allCookies.filter(isAuthSide),
    chatgptSideCookies: allCookies.filter(isChatGptSide),
    sessionCookies: allCookies.filter(isSessionCookie),
  };
}
