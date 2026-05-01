const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulePath = path.join(
  __dirname,
  '..',
  'app.asar.extracted',
  'dist',
  'main',
  'page-state.js'
);

function loadModule() {
  delete require.cache[modulePath];
  return require(modulePath);
}

test('classifyPageState flags X bootstrap splash as blocked bootstrap and recommends site reset', () => {
  const { classifyPageState } = loadModule();
  const result = classifyPageState({
    url: 'https://x.com/',
    title: 'X',
    bodyText: '',
    bodyTextLength: 0,
    bodyChildCount: 1,
  }, {
    consoleMessages: [
      'Failed to create WebGPU Context Provider',
    ],
    failedRequests: [
      { url: 'https://x.com/i/api/1.1/graphql/abc', statusCode: 403, resourceType: 'xhr' },
    ],
  }, [
    { name: 'X / Twitter', url: 'https://x.com', loggedInAt: '2026-03-30T00:00:00.000Z' },
  ]);

  assert.equal(result.usable, false);
  assert.equal(result.code, 'blocked_bootstrap');
  assert.equal(result.reason, 'bootstrap_forbidden');
  assert.equal(result.recovery.type, 'reset_site_state_and_reload');
  assert.equal(result.siteLoginAvailable, true);
});

test('classifyPageState flags generic blank bootstrap failures', () => {
  const { classifyPageState } = loadModule();
  const result = classifyPageState({
    url: 'https://example.com/app',
    title: 'Example',
    bodyText: '',
    bodyTextLength: 0,
    bodyChildCount: 1,
  }, {
    failedRequests: [
      { url: 'https://example.com/bootstrap', statusCode: 500, resourceType: 'xhr' },
    ],
  }, []);

  assert.equal(result.usable, false);
  assert.equal(result.code, 'blocked_bootstrap');
  assert.equal(result.recovery.type, 'reload');
});

test('classifyPageState leaves content-rich pages usable', () => {
  const { classifyPageState } = loadModule();
  const result = classifyPageState({
    url: 'https://github.com/trending',
    title: 'Trending repositories on GitHub today',
    bodyText: 'Repo one Repo two Repo three',
    bodyTextLength: 120,
    bodyChildCount: 8,
  }, { consoleMessages: [], failedRequests: [] }, []);

  assert.equal(result.usable, true);
  assert.equal(result.code, null);
  assert.equal(result.recovery.type, 'none');
});

test('shouldRecordSiteLogin rejects auth or unusable close states', () => {
  const { shouldRecordSiteLogin } = loadModule();
  assert.equal(shouldRecordSiteLogin({ usable: false, code: 'auth_required' }), false);
  assert.equal(shouldRecordSiteLogin({ usable: false, code: 'blocked_bootstrap' }), false);
  assert.equal(shouldRecordSiteLogin({ usable: true, code: null }), true);
});
