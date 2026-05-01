const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

const relayClientPath = path.join(
  __dirname,
  '..',
  'app.asar.extracted',
  'dist',
  'main',
  'relay-client.js'
);

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url, options = {}) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.closed = false;
    this.terminated = false;
    FakeWebSocket.instances.push(this);
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  terminate() {
    this.terminated = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  message(payload) {
    this.emit('message', Buffer.from(JSON.stringify(payload)));
  }

  end() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close');
  }
}

function withMockedWs(fn) {
  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'ws') {
      return FakeWebSocket;
    }
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[relayClientPath];
  FakeWebSocket.instances.length = 0;
  try {
    return fn(require(relayClientPath));
  } finally {
    delete require.cache[relayClientPath];
    Module._load = originalLoad;
  }
}

function withFakeTimers(fn) {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const timeouts = [];
  const intervals = [];

  global.setTimeout = (cb, delay) => {
    const handle = { cb, delay, active: true };
    timeouts.push(handle);
    return handle;
  };
  global.clearTimeout = (handle) => {
    if (handle) handle.active = false;
  };
  global.setInterval = (cb, delay) => {
    const handle = { cb, delay, active: true };
    intervals.push(handle);
    return handle;
  };
  global.clearInterval = (handle) => {
    if (handle) handle.active = false;
  };

  try {
    return fn({ timeouts, intervals });
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
}

test('RelayClient connects to the desktop relay with X-API-Key header', () => {
  withMockedWs(({ RelayClient }) => {
    const statuses = [];
    const client = new RelayClient('ws://relay.example', 'user-1', 'yt_test', () => {}, (status) => statuses.push(status));

    client.connect();

    assert.equal(FakeWebSocket.instances.length, 1);
    const socket = FakeWebSocket.instances[0];
    assert.equal(socket.url, 'ws://relay.example/ws/desktop/user-1');
    assert.equal(socket.options.headers['X-API-Key'], 'yt_test');
    assert.deepEqual(statuses, []);

    socket.open();
    assert.deepEqual(statuses, ['connected']);
  });
});

test('RelayClient forwards non-pong messages to the message handler', () => {
  withFakeTimers(({ intervals }) => withMockedWs(({ RelayClient }) => {
    const messages = [];
    const client = new RelayClient('ws://relay.example', 'user-1', 'yt_test', (message) => messages.push(message), () => {});
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    assert.equal(intervals.length, 1);
    socket.message({ type: 'newSession', sessionId: 'abc' });
    assert.deepEqual(messages, [{ type: 'newSession', sessionId: 'abc' }]);
  }));
});

test('RelayClient heartbeat sends ping and clears pong timeout after pong', () => {
  withFakeTimers(({ timeouts, intervals }) => withMockedWs(({ RelayClient }) => {
    const client = new RelayClient('ws://relay.example', 'user-1', 'yt_test', () => {}, () => {});
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    assert.equal(intervals[0].delay, 30000);
    intervals[0].cb();
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0], JSON.stringify({ type: 'ping' }));
    assert.equal(timeouts[0].delay, 10000);
    assert.equal(timeouts[0].active, true);

    socket.message({ type: 'pong' });
    assert.equal(timeouts[0].active, false);
  }));
});

test('RelayClient treats any inbound message as liveness while awaiting pong', () => {
  withFakeTimers(({ timeouts, intervals }) => withMockedWs(({ RelayClient }) => {
    const messages = [];
    const client = new RelayClient('ws://relay.example', 'user-1', 'yt_test', (message) => messages.push(message), () => {});
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    intervals[0].cb();
    assert.equal(timeouts[0].active, true);

    socket.message({ type: 'newSession', sessionId: 'burst-1' });

    assert.equal(timeouts[0].active, false);
    assert.deepEqual(messages, [{ type: 'newSession', sessionId: 'burst-1' }]);
  }));
});

test('RelayClient forceReconnect terminates the old socket and reconnects immediately', () => {
  withFakeTimers(() => withMockedWs(({ RelayClient }) => {
    const statuses = [];
    const client = new RelayClient('ws://relay.example', 'user-1', 'yt_test', () => {}, (status) => statuses.push(status));
    client.connect();
    const firstSocket = FakeWebSocket.instances[0];

    client.forceReconnect();

    assert.equal(firstSocket.terminated, true);
    assert.equal(FakeWebSocket.instances.length, 2);
    assert.equal(statuses.includes('reconnecting'), true);
  }));
});

test('RelayClient schedules reconnect with exponential backoff up to the max', () => {
  withFakeTimers(({ timeouts }) => withMockedWs(({ RelayClient }) => {
    const statuses = [];
    const client = new RelayClient('ws://relay.example', 'user-1', 'yt_test', () => {}, (status) => statuses.push(status));
    client.connect();
    const firstSocket = FakeWebSocket.instances[0];

    firstSocket.end();
    assert.equal(statuses.at(-2), 'disconnected');
    assert.equal(statuses.at(-1), 'reconnecting');
    assert.equal(timeouts[0].delay, 1000);
    timeouts[0].cb();

    FakeWebSocket.instances[1].end();
    assert.equal(timeouts[1].delay, 2000);
    timeouts[1].cb();

    FakeWebSocket.instances[2].end();
    assert.equal(timeouts[2].delay, 4000);
  }));
});

test('RelayClient disconnect stops reconnects and closes the socket', () => {
  withFakeTimers(({ timeouts }) => withMockedWs(({ RelayClient }) => {
    const statuses = [];
    const client = new RelayClient('ws://relay.example', 'user-1', 'yt_test', () => {}, (status) => statuses.push(status));
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    client.disconnect();

    assert.equal(socket.closed, true);
    assert.equal(client.isConnected(), false);
    assert.equal(statuses.at(-1), 'disconnected');
    assert.equal(timeouts.filter((handle) => handle.active).length, 0);
  }));
});
