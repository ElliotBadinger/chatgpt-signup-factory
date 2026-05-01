import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  emailToAliasId,
  writeAuthCredential,
  removeAuthCredential,
  registerAlias,
  deregisterAlias,
  registerNewMember,
  retireMember,
  listCodexAliases,
} from '../../../src/pipeline/rotation/piAccountRegistrar.js';

describe('emailToAliasId', () => {
  test('extracts local part', () => {
    expect(emailToAliasId('brainydesk135@agentmail.to')).toBe('brainydesk135');
  });
  test('lowercases', () => {
    expect(emailToAliasId('BrainyDesk135@agentmail.to')).toBe('brainydesk135');
  });
  test('normalizes special chars to underscore', () => {
    expect(emailToAliasId('foo.bar-baz@agentmail.to')).toBe('foo_bar_baz');
  });
});

describe('auth.json operations', () => {
  let tmpDir;
  let authPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-registrar-'));
    authPath = path.join(tmpDir, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({}));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writeAuthCredential writes oauth entry', () => {
    writeAuthCredential({
      aliasId: 'testuser',
      accessToken: 'tok-abc',
      refreshToken: 'ref-xyz',
      accountId: 'acct-123',
      authJsonPath: authPath,
    });
    const data = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    expect(data.testuser).toMatchObject({
      type: 'oauth',
      access: 'tok-abc',
      refresh: 'ref-xyz',
      accountId: 'acct-123',
    });
  });

  test('removeAuthCredential removes entry', () => {
    fs.writeFileSync(authPath, JSON.stringify({ testuser: { type: 'oauth', access: 'tok' } }));
    const removed = removeAuthCredential('testuser', authPath);
    expect(removed).toBe(true);
    const data = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    expect(data.testuser).toBeUndefined();
  });

  test('removeAuthCredential returns false for missing key', () => {
    const removed = removeAuthCredential('nonexistent', authPath);
    expect(removed).toBe(false);
  });
});

describe('account-router.json operations', () => {
  let tmpDir;
  let routerPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-router-'));
    routerPath = path.join(tmpDir, 'account-router.json');
    fs.writeFileSync(routerPath, JSON.stringify({
      version: 1,
      aliases: [],
      pools: [],
      policy: {},
    }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('registerAlias adds alias and route', () => {
    registerAlias({
      aliasId: 'brainydesk135',
      email: 'brainydesk135@agentmail.to',
      routerJsonPath: routerPath,
    });
    const data = JSON.parse(fs.readFileSync(routerPath, 'utf8'));
    const alias = data.aliases.find((a) => a.id === 'brainydesk135');
    expect(alias).toBeTruthy();
    expect(alias.email).toBe('brainydesk135@agentmail.to');
    expect(alias.cloneFrom).toBe('openai-codex');
    const pool = data.pools.find((p) => p.name === 'default');
    expect(pool.providers).toContain('brainydesk135');
    expect(pool.routes.some((r) => r.provider === 'brainydesk135')).toBe(true);
  });

  test('registerAlias updates existing alias', () => {
    registerAlias({ aliasId: 'foo', email: 'foo@agentmail.to', routerJsonPath: routerPath });
    registerAlias({ aliasId: 'foo', email: 'foo-new@agentmail.to', label: 'updated', routerJsonPath: routerPath });
    const data = JSON.parse(fs.readFileSync(routerPath, 'utf8'));
    const aliases = data.aliases.filter((a) => a.id === 'foo');
    expect(aliases.length).toBe(1);
    expect(aliases[0].email).toBe('foo-new@agentmail.to');
  });

  test('deregisterAlias removes alias and route', () => {
    registerAlias({ aliasId: 'oldmember', email: 'old@agentmail.to', routerJsonPath: routerPath });
    deregisterAlias('oldmember', { routerJsonPath: routerPath });
    const data = JSON.parse(fs.readFileSync(routerPath, 'utf8'));
    expect(data.aliases.find((a) => a.id === 'oldmember')).toBeUndefined();
    const pool = data.pools.find((p) => p.name === 'default');
    expect(pool?.providers ?? []).not.toContain('oldmember');
  });

  test('listCodexAliases returns only openai-codex, non-disabled', () => {
    fs.writeFileSync(routerPath, JSON.stringify({
      version: 1,
      aliases: [
        { id: 'a', cloneFrom: 'openai-codex', email: 'a@x.to', disabled: false },
        { id: 'b', cloneFrom: 'openai-codex', email: 'b@x.to', disabled: true },
        { id: 'c', cloneFrom: 'anthropic', email: 'c@x.to', disabled: false },
      ],
      pools: [], policy: {},
    }));
    const aliases = listCodexAliases(routerPath);
    expect(aliases.length).toBe(1);
    expect(aliases[0].id).toBe('a');
  });
});

describe('registerNewMember / retireMember', () => {
  let tmpDir;
  let authPath;
  let routerPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-full-'));
    authPath = path.join(tmpDir, 'auth.json');
    routerPath = path.join(tmpDir, 'router.json');
    fs.writeFileSync(authPath, JSON.stringify({}));
    fs.writeFileSync(routerPath, JSON.stringify({ version: 1, aliases: [], pools: [], policy: {} }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('registerNewMember writes both files', () => {
    const result = registerNewMember({
      email: 'newuser123@agentmail.to',
      accessToken: 'tok-new',
      authJsonPath: authPath,
      routerJsonPath: routerPath,
    });
    expect(result.aliasId).toBe('newuser123');
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    expect(auth.newuser123?.access).toBe('tok-new');
    const router = JSON.parse(fs.readFileSync(routerPath, 'utf8'));
    expect(router.aliases.find((a) => a.id === 'newuser123')).toBeTruthy();
  });

  test('retireMember removes from both files', () => {
    registerNewMember({
      email: 'retiring@agentmail.to',
      accessToken: 'tok-old',
      authJsonPath: authPath,
      routerJsonPath: routerPath,
    });
    retireMember({ email: 'retiring@agentmail.to', authJsonPath: authPath, routerJsonPath: routerPath });
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    expect(auth.retiring).toBeUndefined();
    const router = JSON.parse(fs.readFileSync(routerPath, 'utf8'));
    expect(router.aliases.find((a) => a.id === 'retiring')).toBeUndefined();
  });
});
