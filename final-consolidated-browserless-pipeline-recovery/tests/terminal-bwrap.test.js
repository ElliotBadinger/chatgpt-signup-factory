const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const terminalModulePath = path.join(
  __dirname,
  '..',
  'app.asar.extracted',
  'dist',
  'main',
  'tools',
  'terminal.js'
);

const workspaceRoot = path.join(__dirname, '..');
const tmpRoot = path.join(workspaceRoot, 'artifacts', 'verification', 'terminal-test-folders');
fs.mkdirSync(tmpRoot, { recursive: true });

function getModule() {
  delete require.cache[terminalModulePath];
  return require(terminalModulePath);
}

function findAll(args, flag) {
  const indexes = [];
  args.forEach((value, index) => {
    if (value === flag) indexes.push(index);
  });
  return indexes;
}

test('buildLinuxBwrapArgs is exported for direct verification', () => {
  const terminal = getModule();
  assert.equal(typeof terminal.buildLinuxBwrapArgs, 'function');
});

test('buildLinuxBwrapArgs includes network and env isolation by default', () => {
  const { buildLinuxBwrapArgs } = getModule();
  const args = buildLinuxBwrapArgs('pwd', workspaceRoot, [], path.join(tmpRoot, 'home-0'));

  assert.ok(args.includes('--unshare-net'));
  assert.ok(args.includes('--clearenv'));
});

test('buildLinuxBwrapArgs with zero allowed folders only binds the built-in Yutori home read-write', () => {
  const { buildLinuxBwrapArgs } = getModule();
  const args = buildLinuxBwrapArgs('pwd', workspaceRoot, [], path.join(tmpRoot, 'home-1'));

  const bindIndexes = findAll(args, '--bind');
  assert.equal(bindIndexes.length, 1);
  assert.ok(args.includes('--chdir'));
  assert.ok(args.includes('/bin/bash'));
});

test('buildLinuxBwrapArgs with one read-only allowed folder mounts it read-only', () => {
  const folder = path.join(tmpRoot, 'readonly-one');
  fs.mkdirSync(folder, { recursive: true });
  const { buildLinuxBwrapArgs } = getModule();
  const args = buildLinuxBwrapArgs('pwd', workspaceRoot, [{ path: folder, permission: 'read_only' }], path.join(tmpRoot, 'home-2'));

  const roBindIndexes = findAll(args, '--ro-bind');
  const roBindPairs = roBindIndexes.map((index) => [args[index + 1], args[index + 2]]);
  assert.ok(roBindPairs.some(([from, to]) => from === folder && to === folder));
});

test('buildLinuxBwrapArgs with three folders preserves read-only vs read-write mounts', () => {
  const readOnlyA = path.join(tmpRoot, 'ro-a');
  const readOnlyB = path.join(tmpRoot, 'ro-b');
  const readWrite = path.join(tmpRoot, 'rw-c');
  [readOnlyA, readOnlyB, readWrite].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));

  const { buildLinuxBwrapArgs } = getModule();
  const args = buildLinuxBwrapArgs(
    'pwd',
    workspaceRoot,
    [
      { path: readOnlyA, permission: 'read_only' },
      { path: readOnlyB, permission: 'read_only' },
      { path: readWrite, permission: 'read_write' },
    ],
    path.join(tmpRoot, 'home-3')
  );

  const roBindIndexes = findAll(args, '--ro-bind');
  const bindIndexes = findAll(args, '--bind');
  const roBindPairs = roBindIndexes.map((index) => [args[index + 1], args[index + 2]]);
  const bindPairs = bindIndexes.map((index) => [args[index + 1], args[index + 2]]);

  assert.ok(roBindPairs.some(([from, to]) => from === readOnlyA && to === readOnlyA));
  assert.ok(roBindPairs.some(([from, to]) => from === readOnlyB && to === readOnlyB));
  assert.ok(bindPairs.some(([from, to]) => from === readWrite && to === readWrite));
});
