import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_CODEX_LB_STORE_PATH = path.join(os.homedir(), '.codex-lb', 'store.db');

function quoteSqlString(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function runSqlite({ storePath, sql, expectJson = false }) {
  const args = expectJson ? ['-json', storePath, sql] : [storePath, sql];
  const result = spawnSync('sqlite3', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    throw new Error(String(result.stderr ?? result.stdout ?? 'sqlite3 failed').trim() || 'sqlite3 failed');
  }

  if (!expectJson) {
    return String(result.stdout ?? '');
  }

  const output = String(result.stdout ?? '').trim();
  return output ? JSON.parse(output) : [];
}

function detectColumnInfo(storePath) {
  const rows = runSqlite({
    storePath,
    sql: "PRAGMA table_info(accounts);",
    expectJson: true,
  });
  return new Map(rows.map((row) => [String(row?.name ?? '').trim(), row]).filter(([name]) => Boolean(name)));
}

function detectColumns(storePath) {
  return new Set(detectColumnInfo(storePath).keys());
}

function nextIntegerId(storePath) {
  const rows = runSqlite({
    storePath,
    sql: 'SELECT COALESCE(MAX(id), 0) + 1 AS id FROM accounts;',
    expectJson: true,
  });
  return Number(rows[0]?.id ?? 1);
}

function synthesizeRequiredInsertValues({ storePath, columns, insertColumns, insertValues }) {
  for (const [name, column] of columns.entries()) {
    if (insertColumns.includes(name)) continue;

    const notNull = Number(column?.notnull ?? 0) === 1;
    const hasDefault = column?.dflt_value !== null && column?.dflt_value !== undefined;
    const isPrimaryKey = Number(column?.pk ?? 0) > 0;
    if (!notNull || hasDefault || isPrimaryKey) continue;

    if (name === 'id') {
      insertColumns.push(name);
      insertValues.push(String(nextIntegerId(storePath)));
      continue;
    }

    if (name === 'plan_type') {
      insertColumns.push(name);
      insertValues.push("'team'");
      continue;
    }

    throw new Error(`codex-lb writeActiveLifecycle cannot synthesize required accounts column '${name}'`);
  }
}

function ensureAccountsTable(storePath) {
  runSqlite({
    storePath,
    sql: `
CREATE TABLE IF NOT EXISTS accounts (
  email TEXT PRIMARY KEY,
  status TEXT,
  chatgpt_account_id TEXT,
  alias_id TEXT,
  lifecycle_state TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
`.trim(),
  });
}

export function createCodexLbLifecycleStore({
  storePath = DEFAULT_CODEX_LB_STORE_PATH,
  now = () => Date.now(),
} = {}) {
  async function getLifecycle({ email }) {
    if (!storePath || !fs.existsSync(storePath) || !email) return null;

    const rows = runSqlite({
      storePath,
      sql: `
SELECT
  email,
  status,
  chatgpt_account_id,
  alias_id,
  lifecycle_state
FROM accounts
WHERE LOWER(email) = LOWER(${quoteSqlString(email)})
LIMIT 1;
`.trim(),
      expectJson: true,
    });

    if (!rows[0]) return null;
    return {
      email: rows[0].email ?? null,
      status: rows[0].status ?? null,
      workspaceId: rows[0].chatgpt_account_id ?? null,
      aliasId: rows[0].alias_id ?? null,
      lifecycleState: rows[0].lifecycle_state ?? rows[0].status ?? null,
    };
  }

  async function writeActiveLifecycle({
    email,
    aliasId = null,
    workspaceId = null,
    lifecycleState = 'active',
  }) {
    if (!storePath || !email) return { ok: true, skipped: true };

    ensureAccountsTable(storePath);
    const columns = detectColumnInfo(storePath);
    const columnNames = new Set(columns.keys());
    const updates = [];

    if (columnNames.has('status')) updates.push(`status = 'active'`);
    if (columnNames.has('chatgpt_account_id')) updates.push(`chatgpt_account_id = ${quoteSqlString(workspaceId)}`);
    if (columnNames.has('alias_id')) updates.push(`alias_id = ${quoteSqlString(aliasId)}`);
    if (columnNames.has('lifecycle_state')) updates.push(`lifecycle_state = ${quoteSqlString(lifecycleState)}`);
    if (columnNames.has('updated_at')) updates.push(`updated_at = ${now()}`);

    if (updates.length > 0) {
      runSqlite({
        storePath,
        sql: `
UPDATE accounts
SET ${updates.join(', ')}
WHERE LOWER(email) = LOWER(${quoteSqlString(email)});
`.trim(),
      });
    }

    const existing = await getLifecycle({ email });
    if (existing) {
      return { ok: true, email, created: false };
    }

    const insertColumns = ['email'];
    const insertValues = [quoteSqlString(email)];
    if (columnNames.has('status')) {
      insertColumns.push('status');
      insertValues.push("'active'");
    }
    if (columnNames.has('chatgpt_account_id')) {
      insertColumns.push('chatgpt_account_id');
      insertValues.push(quoteSqlString(workspaceId));
    }
    if (columnNames.has('alias_id')) {
      insertColumns.push('alias_id');
      insertValues.push(quoteSqlString(aliasId));
    }
    if (columnNames.has('lifecycle_state')) {
      insertColumns.push('lifecycle_state');
      insertValues.push(quoteSqlString(lifecycleState));
    }
    if (columnNames.has('created_at')) {
      insertColumns.push('created_at');
      insertValues.push(String(now()));
    }
    if (columnNames.has('updated_at')) {
      insertColumns.push('updated_at');
      insertValues.push(String(now()));
    }

    synthesizeRequiredInsertValues({ storePath, columns, insertColumns, insertValues });

    runSqlite({
      storePath,
      sql: `
INSERT INTO accounts (${insertColumns.join(', ')})
VALUES (${insertValues.join(', ')});
`.trim(),
    });

    return { ok: true, email, created: true };
  }

  async function clearActiveLifecycle({
    email,
    lifecycleState = 'archived',
  }) {
    if (!storePath || !fs.existsSync(storePath) || !email) {
      return { ok: true, skipped: true };
    }

    const columns = detectColumns(storePath);
    const updates = [];
    if (columns.has('status')) updates.push(`status = ${quoteSqlString(lifecycleState)}`);
    if (columns.has('lifecycle_state')) updates.push(`lifecycle_state = ${quoteSqlString(lifecycleState)}`);
    if (columns.has('updated_at')) updates.push(`updated_at = ${now()}`);

    if (updates.length === 0) {
      runSqlite({
        storePath,
        sql: `
DELETE FROM accounts
WHERE LOWER(email) = LOWER(${quoteSqlString(email)});
`.trim(),
      });
      return { ok: true, deleted: true };
    }

    runSqlite({
      storePath,
      sql: `
UPDATE accounts
SET ${updates.join(', ')}
WHERE LOWER(email) = LOWER(${quoteSqlString(email)});
`.trim(),
    });
    return { ok: true, cleared: true };
  }

  return {
    storePath,
    isConfigured() {
      return Boolean(storePath);
    },
    getLifecycle,
    writeActiveLifecycle,
    clearActiveLifecycle,
  };
}