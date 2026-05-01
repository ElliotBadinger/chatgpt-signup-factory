const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const sessionStorePath = path.join(
  __dirname,
  '..',
  'app.asar.extracted',
  'dist',
  'main',
  'session-store.js'
);

class FakeElectronStore {
  constructor({ defaults }) {
    this.map = new Map(Object.entries(defaults || {}));
  }
  get(key) { return this.map.get(key); }
  set(key, value) { this.map.set(key, value); }
  delete(key) { this.map.delete(key); }
}

function withSessionStore(options, fn) {
  const originalLoad = Module._load;
  const fakeSafeStorage = {
    available: options.encryptionAvailable,
    isEncryptionAvailable() { return this.available; },
    encryptString(value) { return Buffer.from(`enc:${value}`, 'utf8'); },
    decryptString(buffer) { return Buffer.from(buffer).toString('utf8').replace(/^enc:/, ''); },
  };

  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') {
      return { safeStorage: fakeSafeStorage };
    }
    if (request === 'electron-store') {
      return { __esModule: true, default: FakeElectronStore };
    }
    return originalLoad.apply(this, arguments);
  };

  delete require.cache[sessionStorePath];
  try {
    return fn(require(sessionStorePath));
  } finally {
    delete require.cache[sessionStorePath];
    Module._load = originalLoad;
  }
}

test('session-store round-trips encrypted api keys when safeStorage is available', () => {
  withSessionStore({ encryptionAvailable: true }, (store) => {
    store.setApiKey('yt_secret');
    assert.equal(store.getApiKey(), 'yt_secret');
    assert.equal(store.getConfig().hasApiKey, true);
  });
});

test('session-store falls back to plaintext api keys when safeStorage is unavailable', () => {
  withSessionStore({ encryptionAvailable: false }, (store) => {
    store.setApiKey('yt_plaintext');
    assert.equal(store.getApiKey(), 'yt_plaintext');
  });
});

test('session-store stores and clears user credentials', () => {
  withSessionStore({ encryptionAvailable: true }, (store) => {
    store.setUserId('user-123');
    store.setApiKey('yt_secret');
    store.setEmail('user@example.com');

    assert.deepEqual(store.getConfig(), {
      userId: 'user-123',
      hasApiKey: true,
      email: 'user@example.com',
    });

    store.clearCredentials();
    assert.deepEqual(store.getConfig(), {
      userId: undefined,
      hasApiKey: false,
      email: undefined,
    });
  });
});

test('session-store get/set/remove site logins updates the tracked list', () => {
  withSessionStore({ encryptionAvailable: true }, (store) => {
    const github = { name: 'GitHub', url: 'https://github.com', loggedInAt: '2026-03-27T00:00:00.000Z' };
    const x = { name: 'X', url: 'https://x.com', loggedInAt: '2026-03-27T00:01:00.000Z' };

    store.addSiteLogin(github);
    store.addSiteLogin(x);
    assert.deepEqual(store.getSiteLogins(), [github, x]);

    store.removeSiteLogin(github.url);
    assert.deepEqual(store.getSiteLogins(), [x]);

    store.clearSiteLogins();
    assert.deepEqual(store.getSiteLogins(), []);
  });
});

test('session-store stores terminal folders and desktop toggle values', () => {
  withSessionStore({ encryptionAvailable: true }, (store) => {
    const folders = [
      { path: '/tmp/one', permission: 'read_only' },
      { path: '/tmp/two', permission: 'read_write' },
    ];

    store.setTerminalFolders(folders);
    store.setTerminalAccessEnabled(true);
    store.setLocalDesktopControlEnabled(true);

    assert.deepEqual(store.getTerminalFolders(), folders);
    assert.equal(store.getTerminalAccessEnabled(), true);
    assert.equal(store.getLocalDesktopControlEnabled(), true);
  });
});

test('session-store prunes retained history older than 14 days', () => {
  withSessionStore({ encryptionAvailable: true }, (store) => {
    const now = Date.now();
    const fresh = {
      sessionId: 'fresh',
      startedAt: new Date(now).toISOString(),
      lastActivityAt: new Date(now).toISOString(),
      endedAt: new Date(now).toISOString(),
    };
    const stale = {
      sessionId: 'stale',
      startedAt: new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString(),
      lastActivityAt: new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString(),
      endedAt: new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString(),
    };

    const pruned = store.setRecentSessionsHistory([fresh, stale]);
    assert.deepEqual(pruned, [fresh]);
    assert.deepEqual(store.getRecentSessionsHistory(), [fresh]);
  });
});
