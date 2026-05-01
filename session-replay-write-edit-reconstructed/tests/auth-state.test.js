const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const authStatePath = path.join(
  __dirname,
  '..',
  'app.asar.extracted',
  'dist',
  'main',
  'auth-state.js'
);

function loadModule() {
  delete require.cache[authStatePath];
  return require(authStatePath);
}

test('detectAuthState flags x search splash as auth-required when login is available', () => {
  const { detectAuthState } = loadModule();
  const authState = detectAuthState({
    url: 'https://x.com/search?q=orca%20ai%20referral&f=live',
    title: 'X',
    bodyText: '',
    bodyTextLength: 0,
    bodyChildCount: 1,
  }, [
    { name: 'X / Twitter', url: 'https://x.com', loggedInAt: '2026-03-30T00:00:00.000Z' },
  ]);

  assert.equal(authState.requiresAuth, true);
  assert.equal(authState.code, 'auth_required');
  assert.equal(authState.reason, 'x_search_splash_requires_login');
  assert.equal(authState.siteLoginAvailable, true);
  assert.match(authState.message, /use the site login/i);
});

test('detectAuthState flags generic sign-in pages', () => {
  const { detectAuthState } = loadModule();
  const authState = detectAuthState({
    url: 'https://example.com/sign-in',
    title: 'Sign in',
    bodyText: 'Sign in to continue with your account',
    bodyTextLength: 38,
    bodyChildCount: 3,
  }, []);

  assert.equal(authState.requiresAuth, true);
  assert.equal(authState.reason, 'login_page');
  assert.equal(authState.siteLoginAvailable, false);
});

test('detectAuthState ignores content-rich pages that are not auth walls', () => {
  const { detectAuthState } = loadModule();
  const authState = detectAuthState({
    url: 'https://github.com/trending',
    title: 'Trending repositories on GitHub today',
    bodyText: 'Repository one Repository two Repository three Sign in is in the header only',
    bodyTextLength: 120,
    bodyChildCount: 8,
  }, [
    { name: 'GitHub', url: 'https://github.com', loggedInAt: '2026-03-30T00:00:00.000Z' },
  ]);

  assert.equal(authState.requiresAuth, false);
});

test('buildSiteLoginEnv exposes auth inventory as terminal env vars', () => {
  const { buildSiteLoginEnv } = loadModule();
  const env = buildSiteLoginEnv([
    { name: 'X / Twitter', url: 'https://x.com', loggedInAt: '2026-03-30T00:00:00.000Z' },
    { name: 'GitHub', url: 'https://github.com', loggedInAt: '2026-03-29T00:00:00.000Z' },
  ]);

  assert.equal(env.YUTORI_AUTH_SITE_LOGIN_COUNT, '2');
  assert.equal(env.YUTORI_AUTH_SITE_X_COM, 'available');
  assert.equal(env.YUTORI_AUTH_SITE_GITHUB_COM, 'available');
  assert.match(env.YUTORI_AUTH_HINT, /auth_required/i);
  assert.doesNotThrow(() => JSON.parse(env.YUTORI_AUTH_SITE_LOGINS_JSON));
});
