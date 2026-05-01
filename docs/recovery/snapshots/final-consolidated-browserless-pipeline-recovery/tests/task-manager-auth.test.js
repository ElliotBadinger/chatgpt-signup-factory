const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const taskManagerPath = path.join(
  __dirname,
  '..',
  'app.asar.extracted',
  'dist',
  'main',
  'task-manager.js'
);

function loadTaskManager() {
  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron' && parent && parent.filename === taskManagerPath) {
      return {
        Notification: {
          isSupported: () => false,
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };

  delete require.cache[taskManagerPath];
  try {
    return require(taskManagerPath).TaskManager;
  } finally {
    delete require.cache[taskManagerPath];
    Module._load = originalLoad;
  }
}

test('TaskManager initExecutor upgrades initial auth walls into auth_required browserError', async () => {
  const TaskManager = loadTaskManager();
  const manager = new TaskManager({}, 'ws://relay.example', 'api-key', () => {});
  manager.sessions.set('session-1', {
    summary: {
      sessionId: 'session-1',
      state: 'connecting',
      task: null,
      startUrl: null,
      currentUrl: null,
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      endedAt: null,
      endReason: null,
      actionCount: 0,
      lastActionType: null,
      lastError: null,
      showBrowser: false,
    },
    endReasonHint: null,
  });

  const sent = [];
  const ws = { send: (payload) => sent.push(JSON.parse(payload)) };
  const executor = { close: () => {} };

  await manager.initExecutor(
    'session-1',
    executor,
    async () => ({
      url: 'https://x.com/search?q=orca%20ai&f=live',
      screenshot: 'data:image/png;base64,abc',
      authState: {
        requiresAuth: true,
        code: 'auth_required',
        reason: 'x_search_splash_requires_login',
        siteLoginAvailable: true,
        siteLoginName: 'X / Twitter',
        siteLoginUrl: 'https://x.com',
        message: 'Authentication required for X search.',
      },
    }),
    ws,
    'browser'
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'browserError');
  assert.equal(sent[0].error_code, 'auth_required');
  assert.equal(sent[0].auth_state.reason, 'x_search_splash_requires_login');
  assert.equal(manager.sessions.has('session-1'), false);
});
