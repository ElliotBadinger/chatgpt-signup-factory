const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { WebSocketServer, WebSocket } = require(path.join(
  __dirname,
  '..',
  'app.asar.extracted',
  'node_modules',
  'ws'
));

const { createRelayProxyServer } = require(path.join(
  __dirname,
  '..',
  'relay-tunnel-service',
  'relay-proxy-server.js'
));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address())));
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

test('relay proxy forwards websocket path, api key header, and messages bidirectionally', async () => {
  const upstreamMessages = [];
  let upstreamRequestUrl = null;
  let upstreamApiKey = null;

  const upstreamWss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(upstreamWss, 'listening');
  const upstreamPort = upstreamWss.address().port;

  let upstreamSocket;
  upstreamWss.on('connection', (socket, request) => {
    upstreamSocket = socket;
    upstreamRequestUrl = request.url;
    upstreamApiKey = request.headers['x-api-key'];
    socket.on('message', (raw) => upstreamMessages.push(raw.toString()));
    socket.send(JSON.stringify({ type: 'hello-from-upstream' }));
  });

  const proxy = createRelayProxyServer({
    upstreamBaseUrl: `ws://127.0.0.1:${upstreamPort}`,
  });
  const proxyAddress = await listen(proxy.server);

  const client = new WebSocket(
    `ws://127.0.0.1:${proxyAddress.port}/ws/desktop/test-user`,
    { headers: { 'X-API-Key': 'yt_test_key' } }
  );

  const openPromise = once(client, 'open');
  const firstMessagePromise = once(client, 'message');
  await openPromise;
  const firstMessage = await firstMessagePromise;
  assert.equal(firstMessage.toString(), JSON.stringify({ type: 'hello-from-upstream' }));

  client.send(JSON.stringify({ type: 'hello-from-client' }));

  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(upstreamRequestUrl, '/ws/desktop/test-user');
  assert.equal(upstreamApiKey, 'yt_test_key');
  assert.deepEqual(upstreamMessages, [JSON.stringify({ type: 'hello-from-client' })]);

  const secondMessagePromise = once(client, 'message');
  upstreamSocket.send(JSON.stringify({ type: 'goodbye-from-upstream' }));
  const secondMessage = await secondMessagePromise;
  assert.equal(secondMessage.toString(), JSON.stringify({ type: 'goodbye-from-upstream' }));

  const closePromise = once(client, 'close');
  client.close();
  await closePromise;

  await proxy.close();
  await new Promise((resolve) => upstreamWss.close(resolve));
});

test('relay proxy does not report an open websocket when upstream handshake fails', async () => {
  const proxy = createRelayProxyServer({
    upstreamBaseUrl: 'ws://127.0.0.1:9',
  });
  const proxyAddress = await listen(proxy.server);

  const client = new WebSocket(`ws://127.0.0.1:${proxyAddress.port}/ws/desktop/test-user`);

  let opened = false;
  client.on('open', () => {
    opened = true;
  });

  const closePromise = once(client, 'close');
  const error = await once(client, 'error');
  assert.match(String(error.message || error), /(socket hang up|unexpected server response|ECONNREFUSED|Bad Gateway)/i);
  assert.equal(opened, false);

  await closePromise;
  await proxy.close();
});
