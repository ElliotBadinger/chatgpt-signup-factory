const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { LocalToolRegistry, registerBuiltinTools } = require(path.join(
  __dirname,
  '..',
  'app.asar.extracted',
  'dist',
  'main',
  'local-tools.js'
));

test('LocalToolRegistry registers and lists tools', () => {
  const registry = new LocalToolRegistry();
  registry.register({
    name: 'demo',
    description: 'Demo tool',
    inputSchema: { type: 'object' },
    execute: async () => 'ok',
  });

  assert.deepEqual(registry.listTools(), [{
    name: 'demo',
    description: 'Demo tool',
    inputSchema: { type: 'object' },
  }]);
});

test('LocalToolRegistry unregister removes tools from discovery', () => {
  const registry = new LocalToolRegistry();
  registry.register({ name: 'demo', description: 'Demo tool', inputSchema: { type: 'object' }, execute: async () => 'ok' });
  registry.unregister('demo');
  assert.deepEqual(registry.listTools(), []);
});

test('LocalToolRegistry execute returns success result for known tools', async () => {
  const registry = new LocalToolRegistry();
  registry.register({
    name: 'echo',
    description: 'Echo',
    inputSchema: { type: 'object' },
    execute: async (args) => `hello ${args.name}`,
  });

  const result = await registry.execute('echo', { name: 'world' });
  assert.deepEqual(result, { success: true, result: 'hello world' });
});

test('LocalToolRegistry execute returns structured errors for unknown and throwing tools', async () => {
  const registry = new LocalToolRegistry();
  registry.register({
    name: 'boom',
    description: 'Boom',
    inputSchema: { type: 'object' },
    execute: async () => { throw new Error('kaboom'); },
  });

  assert.deepEqual(await registry.execute('missing', {}), {
    success: false,
    result: "ERROR: Unknown tool 'missing'",
  });
  assert.deepEqual(await registry.execute('boom', {}), {
    success: false,
    result: 'ERROR: kaboom',
  });
});

test('registerBuiltinTools adds the ping tool', async () => {
  const registry = new LocalToolRegistry();
  registerBuiltinTools(registry);

  const tools = registry.listTools();
  assert.equal(tools.some((tool) => tool.name === 'ping'), true);
  assert.deepEqual(await registry.execute('ping', { message: 'hi' }), {
    success: true,
    result: 'pong: hi',
  });
});
