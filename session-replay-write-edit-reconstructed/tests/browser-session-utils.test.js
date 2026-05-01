const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulePath = path.join(
  __dirname,
  '..',
  'app.asar.extracted',
  'dist',
  'main',
  'browser-session-utils.js'
);

function loadModule() {
  delete require.cache[modulePath];
  return require(modulePath);
}

test('sanitizeUserAgent strips Electron and app tokens', () => {
  const { sanitizeUserAgent } = loadModule();
  const result = sanitizeUserAgent('Mozilla/5.0 Chrome/134.0.6998.205 Electron/35.7.5 Safari/537.36 yutori-local/1.0.0');
  assert.equal(result.includes('Electron/35.7.5'), false);
  assert.equal(result.includes('yutori-local/1.0.0'), false);
  assert.match(result, /Chrome\/134\.0\.6998\.205/);
});

test('rewriteChromeLikeHeaders forces sanitized user-agent and chrome-like client hints', () => {
  const { rewriteChromeLikeHeaders } = loadModule();
  const rewritten = rewriteChromeLikeHeaders({
    'User-Agent': 'Mozilla/5.0 Chrome/134.0.6998.205 Electron/35.7.5 Safari/537.36',
    'sec-ch-ua': '"Not:A-Brand";v="24", "Chromium";v="134"',
    'sec-ch-ua-full-version-list': '"Chromium";v="134.0.0.0"',
  }, {
    cleanUA: 'Mozilla/5.0 Chrome/134.0.6998.205 Safari/537.36',
    chromeMajor: '134',
    chromeVersion: '134.0.6998.205',
    platform: 'Linux',
  });

  assert.equal(rewritten['User-Agent'], 'Mozilla/5.0 Chrome/134.0.6998.205 Safari/537.36');
  assert.match(rewritten['sec-ch-ua'], /Google Chrome/);
  assert.equal('sec-ch-ua-full-version-list' in rewritten, false);
  assert.equal(rewritten['sec-ch-ua-mobile'], '?0');
  assert.equal(rewritten['sec-ch-ua-platform'], '"Linux"');
});
