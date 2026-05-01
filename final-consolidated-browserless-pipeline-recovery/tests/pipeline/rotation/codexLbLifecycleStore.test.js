import { afterEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCodexLbLifecycleStore } from '../../../src/pipeline/rotation/codexLbLifecycleStore.js';

const tmpDirs = [];

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lb-lifecycle-store-'));
  tmpDirs.push(dir);
  return dir;
}

function createStorePath({ schema }) {
  const filePath = path.join(createTempDir(), 'store.db');
  const sqliteResult = spawnSync('sqlite3', [filePath, schema], { encoding: 'utf8' });
  expect(sqliteResult.status).toBe(0);
  return filePath;
}

function queryRows(storePath, sql) {
  const result = spawnSync('sqlite3', ['-json', storePath, sql], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  return JSON.parse(String(result.stdout || '[]').trim() || '[]');
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe('createCodexLbLifecycleStore', () => {
  test('synthesizes required plan_type for active lifecycle inserts', async () => {
    const storePath = createStorePath({
      schema: `
CREATE TABLE accounts (
  id INTEGER NOT NULL UNIQUE,
  email TEXT UNIQUE,
  status TEXT,
  chatgpt_account_id TEXT,
  alias_id TEXT,
  lifecycle_state TEXT,
  plan_type TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER
);
`,
    });

    const store = createCodexLbLifecycleStore({
      storePath,
      now: () => 1_700_000_000_000,
    });

    await expect(store.writeActiveLifecycle({
      email: 'fresh@agentmail.to',
      aliasId: 'fresh',
      workspaceId: 'workspace-123',
      lifecycleState: 'active',
    })).resolves.toEqual({
      ok: true,
      email: 'fresh@agentmail.to',
      created: true,
    });

    expect(queryRows(
      storePath,
      'SELECT id, email, status, chatgpt_account_id, alias_id, lifecycle_state, plan_type FROM accounts;',
    )).toEqual([
      {
        id: 1,
        email: 'fresh@agentmail.to',
        status: 'active',
        chatgpt_account_id: 'workspace-123',
        alias_id: 'fresh',
        lifecycle_state: 'active',
        plan_type: 'team',
      },
    ]);
  });

  test('fails closed on unknown required accounts columns', async () => {
    const storePath = createStorePath({
      schema: `
CREATE TABLE accounts (
  id INTEGER NOT NULL UNIQUE,
  email TEXT UNIQUE,
  status TEXT,
  chatgpt_account_id TEXT,
  alias_id TEXT,
  lifecycle_state TEXT,
  mystery_required TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER
);
`,
    });

    const store = createCodexLbLifecycleStore({ storePath });

    await expect(store.writeActiveLifecycle({
      email: 'fresh@agentmail.to',
      aliasId: 'fresh',
      workspaceId: 'workspace-123',
    })).rejects.toThrow("codex-lb writeActiveLifecycle cannot synthesize required accounts column 'mystery_required'");

    expect(queryRows(storePath, 'SELECT COUNT(*) AS count FROM accounts;')).toEqual([{ count: 0 }]);
  });
});