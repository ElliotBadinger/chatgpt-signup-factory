import fs from 'node:fs';

const DEFAULT_POOL = 'openai-codex';

export function extractRouterAuthFromSession(session, expectedEmail) {
  const accessToken = String(session?.accessToken ?? '').trim();
  if (!accessToken) throw new Error('Session missing accessToken');

  const identityEmail = String(session?.user?.email ?? '').trim();
  if (!identityEmail) throw new Error('Session missing user.email');
  if (expectedEmail && identityEmail.toLowerCase() !== String(expectedEmail).toLowerCase()) {
    throw new Error(`Session email mismatch: expected ${expectedEmail}, got ${identityEmail}`);
  }

  return {
    accessToken,
    refreshToken: session?.refreshToken ?? session?.refresh_token ?? null,
    expiresAt: session?.expires ? new Date(session.expires).getTime() : null,
    accountId: session?.account?.id ?? null,
    identityEmail,
  };
}

function hasRefreshToken(value) {
  return typeof value?.refreshToken === 'string' && value.refreshToken.trim()
    || typeof value?.refresh_token === 'string' && value.refresh_token.trim()
    || typeof value?.refresh === 'string' && value.refresh.trim();
}

export function assertDurableAuth({ email, auth, source }) {
  if (!hasRefreshToken(auth)) {
    throw new Error(`${source} for ${email} is missing refresh token; refusing to register degraded auth`);
  }
}

export function verifyPiRouterOnboarding({ aliasId, email, authJsonPath, routerJsonPath, poolName = DEFAULT_POOL }) {
  const auth = JSON.parse(fs.readFileSync(authJsonPath, 'utf8'));
  const router = JSON.parse(fs.readFileSync(routerJsonPath, 'utf8'));
  const checks = {};
  const details = {};

  checks.aliasInAuth = Boolean(auth[aliasId]);
  checks.noTempAliases = !Object.keys(auth).some((key) => key.toLowerCase().includes('openai-codex-tmp'));
  checks.authHasDurableRefresh = typeof auth[aliasId]?.refresh === 'string' && auth[aliasId].refresh.trim() !== '';

  const alias = (router.aliases ?? []).find((entry) => entry.id === aliasId);
  checks.aliasInRouter = Boolean(alias);
  checks.aliasEmailMatches = String(alias?.email ?? '') === email;
  checks.aliasCloneFromCodex = String(alias?.cloneFrom ?? '') === 'openai-codex';

  const pool = (router.pools ?? []).find((entry) => entry.name === poolName) ?? { providers: [], routes: [] };
  checks.aliasInPoolProviders = (pool.providers ?? []).includes(aliasId);
  const route = (pool.routes ?? []).find((entry) => entry.provider === aliasId);
  checks.aliasHasPoolRoute = Boolean(route);

  const payload = decodeJwtPayload(auth[aliasId]?.access ?? '');
  const jwtEmail = payload?.['https://api.openai.com/profile']?.email ?? null;
  const jwtVerified = payload?.['https://api.openai.com/profile']?.email_verified === true;
  checks.jwtIdentityEmailMatches = jwtEmail === email;
  checks.jwtEmailVerified = jwtVerified;

  details.aliasEmail = alias?.email ?? null;
  details.aliasCloneFrom = alias?.cloneFrom ?? null;
  details.routeModel = route?.model ?? null;
  details.identityEmail = jwtEmail;
  details.identitySource = payload ? 'auth-jwt' : 'unknown';
  details.identityEmailVerified = jwtVerified;
  details.metadataMismatch = jwtEmail === email ? 'no' : 'yes';
  details.planType = payload?.['https://api.openai.com/auth']?.chatgpt_plan_type ?? null;

  return { pass: Object.values(checks).every(Boolean), aliasId, email, poolName, checks, details };
}

function decodeJwtPayload(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
