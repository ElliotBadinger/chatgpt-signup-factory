export function summarizeClerkProbe(probe = {}) {
  return {
    loaded: Boolean(probe.loaded),
    hasClient: Boolean(probe.hasClient),
    signUpStatus: probe.signUpStatus ?? null,
    signInStatus: probe.signInStatus ?? null,
    sessionId: probe.sessionId ?? null,
  };
}

export function summarizeSessionPayload(session = {}) {
  const keys = Object.keys(session ?? {});
  return {
    hasAccessToken: Boolean(session?.accessToken ?? session?.access_token),
    hasRefreshToken: Boolean(session?.refreshToken ?? session?.refresh_token),
    userId: session?.user?.id ?? session?.sub ?? null,
    expires: session?.expires ?? null,
    keys,
  };
}

export function detectChallengeMarkers(page = {}) {
  const bodyText = String(page.bodyText ?? '').toLowerCase();
  return {
    hasCloudflareText: bodyText.includes('just a moment') || bodyText.includes('verify you are human'),
    hasTurnstileIframe: Boolean(page.hasTurnstileIframe),
    hasCaptchaContainer: Boolean(page.hasCaptchaContainer),
  };
}

export function normalizeCheckpoint(name, payload = {}) {
  return {
    name,
    ts: new Date().toISOString(),
    url: payload.url ?? '',
    title: payload.title ?? '',
    clerk: summarizeClerkProbe(payload.clerk),
    session: summarizeSessionPayload(payload.session),
    challenge: detectChallengeMarkers(payload.page),
    cookies: (payload.cookies ?? []).map((c) => ({ name: c.name, domain: c.domain })),
  };
}

export async function probePageCheckpoint(page) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const cookies = await page.cookies().catch(() => []);
  const payload = await page.evaluate(async () => {
    const bodyText = document.body?.innerText?.slice(0, 4000) ?? '';
    let clerk = { loaded: false, hasClient: false, signUpStatus: null, signInStatus: null, sessionId: null };
    try {
      const c = window.Clerk;
      clerk = {
        loaded: Boolean(c?.loaded),
        hasClient: Boolean(c?.client),
        signUpStatus: c?.client?.signUp?.status ?? null,
        signInStatus: c?.client?.signIn?.status ?? null,
        sessionId: c?.session?.id ?? null,
      };
    } catch {}
    let session = null;
    try {
      if (location.hostname === 'chatgpt.com') {
        const res = await fetch('/api/auth/session', { credentials: 'include' });
        if (res.ok) session = await res.json();
      }
    } catch {}
    return {
      clerk,
      session,
      page: {
        bodyText,
        hasTurnstileIframe: Boolean(document.querySelector('iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"]')),
        hasCaptchaContainer: Boolean(document.querySelector('#clerk-captcha, [name="cf-turnstile-response"]')),
      },
    };
  }).catch(() => ({ clerk: {}, session: null, page: {} }));
  return normalizeCheckpoint('unnamed', { url, title, cookies, ...payload });
}
