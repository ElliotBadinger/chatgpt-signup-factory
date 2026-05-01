export function splitSetCookieHeader(header = '') {
  if (Array.isArray(header)) {
    return header.map((line) => String(line).trim()).filter(Boolean);
  }

  const input = String(header || '');
  if (!input.trim()) return [];

  const parts = [];
  let start = 0;
  let inExpires = false;

  for (let index = 0; index < input.length; index += 1) {
    const maybeExpires = input.slice(index, index + 8).toLowerCase();
    if (maybeExpires === 'expires=') inExpires = true;

    const char = input[index];
    if (inExpires && char === ';') inExpires = false;

    if (char === ',' && !inExpires) {
      const next = input.slice(index + 1).trimStart();
      if (/^[^;,=\s]+=/i.test(next)) {
        parts.push(input.slice(start, index).trim());
        start = index + 1;
      }
    }
  }

  parts.push(input.slice(start).trim());
  return parts.filter(Boolean);
}

export function parseSetCookie(cookieLine) {
  const [pair, ...attrs] = String(cookieLine || '').split(';').map((part) => part.trim()).filter(Boolean);
  if (!pair || !pair.includes('=')) return null;

  const [name, ...valueParts] = pair.split('=');
  const cookie = {
    name,
    value: valueParts.join('='),
    domain: null,
    path: '/',
    secure: false,
    httpOnly: false,
    sameSite: null,
    expires: null,
    maxAge: null,
  };

  for (const attr of attrs) {
    const [rawKey, ...rawValue] = attr.split('=');
    const key = rawKey.toLowerCase();
    const value = rawValue.join('=');

    if (key === 'domain') cookie.domain = value.replace(/^\./, '');
    else if (key === 'path') cookie.path = value || '/';
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') cookie.sameSite = value || null;
    else if (key === 'expires') cookie.expires = value || null;
    else if (key === 'max-age') cookie.maxAge = value || null;
  }

  return cookie;
}

export function createCookieJar(initialCookies = []) {
  const jar = new Map();
  for (const cookie of initialCookies) {
    const normalized = normalizeCookie(cookie);
    jar.set(cookieJarKey(normalized), normalized);
  }
  return jar;
}

export function updateCookieJarFromHeader(jar, setCookieHeader, url) {
  for (const line of splitSetCookieHeader(String(setCookieHeader || ''))) {
    const parsed = parseSetCookie(line);
    if (!parsed) continue;
    if (!parsed.domain) parsed.domain = new URL(url).hostname;
    const normalized = normalizeCookie(parsed);
    jar.set(cookieJarKey(normalized), normalized);
  }
  return jar;
}

export function renderCookieHeader(jar, url) {
  const cookies = jar instanceof Map ? [...jar.values()] : Array.isArray(jar) ? jar : [];
  return cookies
    .filter((cookie) => cookieMatchesUrl(cookie, url))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

export function snapshotCookies(jar) {
  const cookies = jar instanceof Map ? [...jar.values()] : Array.isArray(jar) ? jar : [];
  return cookies.map((cookie) => ({ ...cookie }));
}

export function cookieMatchesUrl(cookie, url) {
  const target = new URL(url);
  const domain = normalizeCookieDomain(cookie.domain || target.hostname);
  const path = cookie.path || '/';
  return (
    target.hostname === domain ||
    target.hostname.endsWith(`.${domain}`) ||
    domain.endsWith(target.hostname)
  )
    ? target.pathname.startsWith(path)
    : false;
}

function cookieJarKey(cookie) {
  return `${cookie.domain || 'unknown'}|${cookie.path || '/'}|${cookie.name}`;
}

function normalizeCookieDomain(domain) {
  return String(domain || '').replace(/^\./, '');
}

function normalizeCookie(cookie) {
  return {
    ...cookie,
    domain: normalizeCookieDomain(cookie.domain),
    path: cookie.path || '/',
  };
}
