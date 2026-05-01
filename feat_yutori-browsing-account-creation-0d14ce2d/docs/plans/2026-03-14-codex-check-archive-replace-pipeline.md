# Codex Check-Archive-Replace Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the Codex alias check-archive-replace-validate pipeline: archive exhausted aliases, draw from inbox pool, create new ChatGPT accounts, reinstate renewed aliases.

**Architecture:** Five new modules in `src/pipeline/rotation/` plus one CLI in `src/cli/`. Each module is independently testable with mocks. The main orchestrator (`checkArchiveAndReplaceExhausted.js`) wires them together. All file I/O is atomic writes. All ChatGPT automation goes through the browser via `page.evaluate()`.

**Tech Stack:** Node.js ESM, Jest, Puppeteer, AgentMail REST API, pi extension functions (finalizeAddedAccount / writeCredential from TypeScript source)

---

## Context (read before each task)

**Worktree:** `~/Development/chatgpt-factory-bundle/.worktrees/deterministic-agentmail-pipeline-clone/`
**Run tests from worktree:** `node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/ tests/cli/ --runInBand --testPathIgnorePatterns='/node_modules/'`
**Spec doc:** `~/Development/chatgpt-factory-bundle/scratch/2026-03-14-codex-rotation-full-spec.md`
**Process log:** `~/Development/chatgpt-factory-bundle/scratch/2026-03-14-process-log.md`

**Key file paths (live system):**
- `~/.pi/agent/codex-alias-archive.json` — archive (exists, empty aliases[])
- `~/.pi/agent/codex-inbox-pool.json` — pool (exists, 9 entries all "available")
- `~/.pi/agent/auth.json` — OAuth tokens
- `~/.pi/agent/account-router.json` — routing config

**Existing modules to import (don't rewrite):**
- `src/pipeline/rotation/quotaDetector.js` — `assessCodexQuotas()`
- `src/pipeline/rotation/piAccountRegistrar.js` — `writeAuthCredential()`, `removeAuthCredential()`, `emailToAliasId()`
- `src/pipeline/rotation/teamDriver.js` — `inviteTeamMember()`, `removeTeamMember()`

**Pi extension functions (use via JS wrapper, not direct import of .ts):**
- The registrar already handles auth.json writes atomically
- For `finalizeAddedAccount`, call it via a wrapper that passes mock-friendly callbacks

**Test pattern from existing tests:**
```js
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
```

---

## Task 1: archiveManager.js

**Files:**
- Create: `src/pipeline/rotation/archiveManager.js`
- Create: `tests/pipeline/rotation/archiveManager.test.js`

**Spec for archiveManager.js:**

```js
// ARCHIVE FILE PATH: configurable, default ~/.pi/agent/codex-alias-archive.json
// All writes are atomic (write tmp, rename)

export function readArchive({ archivePath? })
  → { version: 1, aliases: ArchivedAlias[] }

export function writeArchive(archive, { archivePath? })
  → void  // atomic write

export function archiveAlias({ aliasId, email, auth, reason, estimatedResetAt, quotaFraction, archivePath? })
  → ArchivedAlias  // appended entry
  // reason: "weekly-exhausted" | "5h-exhausted" | "both-exhausted" | "forced"
  // Sets: archivedAt=Date.now(), reinstated=false, teamMemberStatus="active"

export async function checkReinstatements(probeQuota, { archivePath?, threshold? })
  → ArchivedAlias[]  // entries with fraction > threshold (default 0.1), NOT reinstated
  // probeQuota: async (aliasId, auth) => Promise<number>  (returns fraction 0..1)
  // On probe error/timeout: skip (don't reinstate)

export function markReinstated(aliasId, { archivePath? })
  → void  // sets reinstated=true, reinstatedAt=Date.now()
```

**Step 1: Write failing tests**

```js
// tests/pipeline/rotation/archiveManager.test.js
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readArchive, writeArchive, archiveAlias, checkReinstatements, markReinstated
} from '../../../src/pipeline/rotation/archiveManager.js';

// Use a tmp directory archive path for all tests
let tmpDir, archivePath;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
  archivePath = path.join(tmpDir, 'codex-alias-archive.json');
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('readArchive', () => {
  test('returns empty archive when file missing', () => {
    const archive = readArchive({ archivePath });
    expect(archive.version).toBe(1);
    expect(archive.aliases).toEqual([]);
  });

  test('returns existing archive', () => {
    const data = { version: 1, aliases: [{ aliasId: 'foo', reinstated: false }] };
    fs.writeFileSync(archivePath, JSON.stringify(data));
    const archive = readArchive({ archivePath });
    expect(archive.aliases).toHaveLength(1);
    expect(archive.aliases[0].aliasId).toBe('foo');
  });
});

describe('archiveAlias', () => {
  test('appends entry to empty archive', () => {
    const auth = { type: 'oauth', access: 'tok', refresh: 'ref', expires: 9999, accountId: 'uid' };
    archiveAlias({ aliasId: 'greenleaf', email: 'x@y.com', auth, reason: 'both-exhausted', quotaFraction: 0, archivePath });
    const archive = readArchive({ archivePath });
    expect(archive.aliases).toHaveLength(1);
    const entry = archive.aliases[0];
    expect(entry.aliasId).toBe('greenleaf');
    expect(entry.reinstated).toBe(false);
    expect(entry.archivedAt).toBeGreaterThan(0);
    expect(entry.auth.access).toBe('tok');
    expect(entry.archivedReason).toBe('both-exhausted');
  });

  test('appends second entry without overwriting first', () => {
    const auth = { type: 'oauth', access: 'a', refresh: 'b', expires: 1, accountId: 'c' };
    archiveAlias({ aliasId: 'alias1', email: 'a@b.com', auth, reason: 'forced', quotaFraction: 0, archivePath });
    archiveAlias({ aliasId: 'alias2', email: 'b@b.com', auth, reason: 'forced', quotaFraction: 0, archivePath });
    const archive = readArchive({ archivePath });
    expect(archive.aliases).toHaveLength(2);
  });
});

describe('checkReinstatements', () => {
  test('returns empty when no archived aliases', async () => {
    const result = await checkReinstatements(async () => 0.5, { archivePath });
    expect(result).toEqual([]);
  });

  test('returns alias when probe returns fraction > 0.1', async () => {
    const auth = { type: 'oauth', access: 'tok', refresh: 'r', expires: 9999, accountId: 'uid' };
    archiveAlias({ aliasId: 'greenleaf', email: 'x@y.com', auth, reason: 'both-exhausted', quotaFraction: 0, archivePath });
    const result = await checkReinstatements(async () => 0.5, { archivePath });
    expect(result).toHaveLength(1);
    expect(result[0].aliasId).toBe('greenleaf');
  });

  test('skips alias when probe returns fraction <= 0.1', async () => {
    const auth = { type: 'oauth', access: 'tok', refresh: 'r', expires: 9999, accountId: 'uid' };
    archiveAlias({ aliasId: 'greenleaf', email: 'x@y.com', auth, reason: 'both-exhausted', quotaFraction: 0, archivePath });
    const result = await checkReinstatements(async () => 0.05, { archivePath });
    expect(result).toHaveLength(0);
  });

  test('skips already-reinstated aliases', async () => {
    const auth = { type: 'oauth', access: 'tok', refresh: 'r', expires: 9999, accountId: 'uid' };
    archiveAlias({ aliasId: 'greenleaf', email: 'x@y.com', auth, reason: 'both-exhausted', quotaFraction: 0, archivePath });
    markReinstated('greenleaf', { archivePath });
    const result = await checkReinstatements(async () => 0.9, { archivePath });
    expect(result).toHaveLength(0);
  });

  test('skips alias when probe throws', async () => {
    const auth = { type: 'oauth', access: 'tok', refresh: 'r', expires: 9999, accountId: 'uid' };
    archiveAlias({ aliasId: 'greenleaf', email: 'x@y.com', auth, reason: 'both-exhausted', quotaFraction: 0, archivePath });
    const result = await checkReinstatements(async () => { throw new Error('probe failed'); }, { archivePath });
    expect(result).toHaveLength(0);
  });
});

describe('markReinstated', () => {
  test('sets reinstated=true and reinstatedAt', () => {
    const auth = { type: 'oauth', access: 'tok', refresh: 'r', expires: 9999, accountId: 'uid' };
    archiveAlias({ aliasId: 'greenleaf', email: 'x@y.com', auth, reason: 'forced', quotaFraction: 0, archivePath });
    const before = Date.now();
    markReinstated('greenleaf', { archivePath });
    const archive = readArchive({ archivePath });
    const entry = archive.aliases[0];
    expect(entry.reinstated).toBe(true);
    expect(entry.reinstatedAt).toBeGreaterThanOrEqual(before);
  });

  test('no-ops on unknown aliasId', () => {
    markReinstated('nonexistent', { archivePath });
    // no throw
  });
});
```

**Step 2: Run failing tests**
```bash
cd ~/Development/chatgpt-factory-bundle/.worktrees/deterministic-agentmail-pipeline-clone
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/archiveManager.test.js --runInBand
```
Expected: FAIL (module not found)

**Step 3: Implement archiveManager.js**

```js
// src/pipeline/rotation/archiveManager.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ARCHIVE_PATH = path.join(os.homedir(), '.pi', 'agent', 'codex-alias-archive.json');
const REINSTATEMENT_THRESHOLD = 0.1;

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function atomicWrite(filePath, data) {
  ensureDir(filePath);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

export function readArchive({ archivePath = DEFAULT_ARCHIVE_PATH } = {}) {
  try {
    if (!fs.existsSync(archivePath)) return { version: 1, aliases: [] };
    const raw = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    if (!raw || !Array.isArray(raw.aliases)) return { version: 1, aliases: [] };
    return raw;
  } catch {
    return { version: 1, aliases: [] };
  }
}

export function writeArchive(archive, { archivePath = DEFAULT_ARCHIVE_PATH } = {}) {
  atomicWrite(archivePath, archive);
}

export function archiveAlias({
  aliasId, email, auth, reason, estimatedResetAt, quotaFraction = 0,
  archivePath = DEFAULT_ARCHIVE_PATH,
}) {
  const archive = readArchive({ archivePath });
  const entry = {
    aliasId,
    email,
    cloneFrom: 'openai-codex',
    auth,
    archivedAt: Date.now(),
    archivedReason: reason,
    quotaRemainingFraction: quotaFraction,
    quotaWindow: 'unknown',
    ...(estimatedResetAt ? { estimatedResetAt } : {}),
    reinstated: false,
    teamMemberStatus: 'active',
  };
  archive.aliases.push(entry);
  writeArchive(archive, { archivePath });
  return entry;
}

export async function checkReinstatements(probeQuota, {
  archivePath = DEFAULT_ARCHIVE_PATH,
  threshold = REINSTATEMENT_THRESHOLD,
} = {}) {
  const archive = readArchive({ archivePath });
  const candidates = archive.aliases.filter((a) => !a.reinstated);
  const ready = [];
  for (const alias of candidates) {
    try {
      const fraction = await probeQuota(alias.aliasId, alias.auth);
      if (fraction > threshold) ready.push(alias);
    } catch {
      // skip on error
    }
  }
  return ready;
}

export function markReinstated(aliasId, { archivePath = DEFAULT_ARCHIVE_PATH } = {}) {
  const archive = readArchive({ archivePath });
  const entry = archive.aliases.find((a) => a.aliasId === aliasId);
  if (!entry) return;
  entry.reinstated = true;
  entry.reinstatedAt = Date.now();
  writeArchive(archive, { archivePath });
}
```

**Step 4: Run tests — expect PASS**
```bash
cd ~/Development/chatgpt-factory-bundle/.worktrees/deterministic-agentmail-pipeline-clone
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/archiveManager.test.js --runInBand
```

**Step 5: Run full suite — expect no regressions**
```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/ tests/cli/ --runInBand --testPathIgnorePatterns='/node_modules/'
```

**Step 6: Commit**
```bash
cd ~/Development/chatgpt-factory-bundle/.worktrees/deterministic-agentmail-pipeline-clone
git add src/pipeline/rotation/archiveManager.js tests/pipeline/rotation/archiveManager.test.js
git commit -m "feat: archiveManager — read/write archive, archiveAlias, checkReinstatements, markReinstated"
```

---

## Task 2: inboxPoolManager.js

**Files:**
- Create: `src/pipeline/rotation/inboxPoolManager.js`
- Create: `tests/pipeline/rotation/inboxPoolManager.test.js`

**Spec for inboxPoolManager.js:**

```js
// POOL FILE PATH: configurable, default ~/.pi/agent/codex-inbox-pool.json
// All writes are atomic

export function readPool({ poolPath? })
  → InboxPool  // { version:1, entries: [], lastCheckedAt, allEntriesExhausted }

export function writePool(pool, { poolPath? })
  → void

export function nextAvailableInbox({ poolPath? })
  → InboxPoolEntry | null  // first entry with status="available"

export function markInboxInUse(inboxAddress, { linkedAliasId, chatGptAccountId, chatGptSignupAt, poolPath? })
  → void

export function markInboxFailed(inboxAddress, reason, { poolPath? })
  → void  // status="failed"

export function markInboxChatGptUsed(inboxAddress, { poolPath? })
  → void  // status="chatgpt-used" (email already registered)

export function addNewInboxes(entries, { poolPath? })
  → void  // appends entries to pool
```

**Step 1: Write failing tests**

```js
// tests/pipeline/rotation/inboxPoolManager.test.js
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readPool, writePool, nextAvailableInbox, markInboxInUse,
  markInboxFailed, markInboxChatGptUsed, addNewInboxes
} from '../../../src/pipeline/rotation/inboxPoolManager.js';

let tmpDir, poolPath;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-test-'));
  poolPath = path.join(tmpDir, 'pool.json');
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedPool(entries) {
  fs.writeFileSync(poolPath, JSON.stringify({
    version: 1, entries, lastCheckedAt: 0, allEntriesExhausted: false,
  }));
}

function makeEntry(overrides = {}) {
  return {
    inboxAddress: 'test@agentmail.to',
    rootEmail: 'root@example.com',
    rootOrgId: 'org_abc',
    rootApiKeyPrefix: 'am_us',
    cfRuleId: 'rule1',
    cfKvNamespaceId: 'kv1',
    status: 'available',
    statusUpdatedAt: Date.now(),
    ...overrides,
  };
}

describe('readPool', () => {
  test('returns empty pool when file missing', () => {
    const pool = readPool({ poolPath });
    expect(pool.version).toBe(1);
    expect(pool.entries).toEqual([]);
  });
});

describe('nextAvailableInbox', () => {
  test('returns null when no pool file', () => {
    expect(nextAvailableInbox({ poolPath })).toBeNull();
  });

  test('returns first available inbox', () => {
    seedPool([makeEntry({ inboxAddress: 'a@agentmail.to', status: 'available' })]);
    const entry = nextAvailableInbox({ poolPath });
    expect(entry.inboxAddress).toBe('a@agentmail.to');
  });

  test('skips non-available inboxes', () => {
    seedPool([
      makeEntry({ inboxAddress: 'used@agentmail.to', status: 'in-use' }),
      makeEntry({ inboxAddress: 'free@agentmail.to', status: 'available' }),
    ]);
    const entry = nextAvailableInbox({ poolPath });
    expect(entry.inboxAddress).toBe('free@agentmail.to');
  });

  test('returns null when all inboxes used', () => {
    seedPool([makeEntry({ inboxAddress: 'a@agentmail.to', status: 'in-use' })]);
    expect(nextAvailableInbox({ poolPath })).toBeNull();
  });
});

describe('markInboxInUse', () => {
  test('sets status to in-use and fills linkage fields', () => {
    seedPool([makeEntry({ inboxAddress: 'x@agentmail.to' })]);
    markInboxInUse('x@agentmail.to', {
      linkedAliasId: 'alias1', chatGptAccountId: 'uid1', chatGptSignupAt: 12345, poolPath
    });
    const pool = readPool({ poolPath });
    const entry = pool.entries[0];
    expect(entry.status).toBe('in-use');
    expect(entry.linkedAliasId).toBe('alias1');
    expect(entry.chatGptAccountId).toBe('uid1');
    expect(entry.chatGptSignupAt).toBe(12345);
  });
});

describe('markInboxFailed', () => {
  test('sets status to failed', () => {
    seedPool([makeEntry({ inboxAddress: 'x@agentmail.to' })]);
    markInboxFailed('x@agentmail.to', 'timeout', { poolPath });
    const pool = readPool({ poolPath });
    expect(pool.entries[0].status).toBe('failed');
  });
});

describe('markInboxChatGptUsed', () => {
  test('sets status to chatgpt-used', () => {
    seedPool([makeEntry({ inboxAddress: 'x@agentmail.to' })]);
    markInboxChatGptUsed('x@agentmail.to', { poolPath });
    const pool = readPool({ poolPath });
    expect(pool.entries[0].status).toBe('chatgpt-used');
  });
});

describe('addNewInboxes', () => {
  test('appends entries to existing pool', () => {
    seedPool([makeEntry({ inboxAddress: 'a@agentmail.to' })]);
    addNewInboxes([makeEntry({ inboxAddress: 'b@agentmail.to' })], { poolPath });
    const pool = readPool({ poolPath });
    expect(pool.entries).toHaveLength(2);
    expect(pool.entries[1].inboxAddress).toBe('b@agentmail.to');
  });

  test('creates pool file if missing', () => {
    addNewInboxes([makeEntry({ inboxAddress: 'new@agentmail.to' })], { poolPath });
    const pool = readPool({ poolPath });
    expect(pool.entries).toHaveLength(1);
  });
});

// INV-5: unique inbox addresses
describe('INV-5: inbox uniqueness', () => {
  test('each inbox address appears only once after adds', () => {
    seedPool([makeEntry({ inboxAddress: 'unique@agentmail.to' })]);
    addNewInboxes([makeEntry({ inboxAddress: 'unique2@agentmail.to' })], { poolPath });
    const pool = readPool({ poolPath });
    const addrs = pool.entries.map((e) => e.inboxAddress);
    expect(new Set(addrs).size).toBe(addrs.length);
  });
});

// INV-6: in-use has linkedAliasId
describe('INV-6: in-use entries have linkedAliasId', () => {
  test('all in-use entries have linkedAliasId set', () => {
    seedPool([makeEntry({ inboxAddress: 'x@agentmail.to' })]);
    markInboxInUse('x@agentmail.to', { linkedAliasId: 'alias1', poolPath });
    const pool = readPool({ poolPath });
    const inUse = pool.entries.filter((e) => e.status === 'in-use');
    expect(inUse.every((e) => e.linkedAliasId)).toBe(true);
  });
});

// INV-7: available is not linked
describe('INV-7: available entries have no linkedAliasId', () => {
  test('available entries have no linkedAliasId', () => {
    seedPool([makeEntry({ inboxAddress: 'x@agentmail.to', status: 'available' })]);
    const pool = readPool({ poolPath });
    const available = pool.entries.filter((e) => e.status === 'available');
    expect(available.every((e) => !e.linkedAliasId)).toBe(true);
  });
});
```

**Step 2: Run failing tests**
```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/inboxPoolManager.test.js --runInBand
```

**Step 3: Implement inboxPoolManager.js**

```js
// src/pipeline/rotation/inboxPoolManager.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_POOL_PATH = path.join(os.homedir(), '.pi', 'agent', 'codex-inbox-pool.json');

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function atomicWrite(filePath, data) {
  ensureDir(filePath);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

export function readPool({ poolPath = DEFAULT_POOL_PATH } = {}) {
  try {
    if (!fs.existsSync(poolPath)) return { version: 1, entries: [], lastCheckedAt: 0, allEntriesExhausted: false };
    const raw = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
    if (!raw || !Array.isArray(raw.entries)) return { version: 1, entries: [], lastCheckedAt: 0, allEntriesExhausted: false };
    return raw;
  } catch {
    return { version: 1, entries: [], lastCheckedAt: 0, allEntriesExhausted: false };
  }
}

export function writePool(pool, { poolPath = DEFAULT_POOL_PATH } = {}) {
  atomicWrite(poolPath, pool);
}

export function nextAvailableInbox({ poolPath = DEFAULT_POOL_PATH } = {}) {
  const pool = readPool({ poolPath });
  return pool.entries.find((e) => e.status === 'available') ?? null;
}

function updateEntry(inboxAddress, updater, { poolPath = DEFAULT_POOL_PATH } = {}) {
  const pool = readPool({ poolPath });
  const entry = pool.entries.find((e) => e.inboxAddress === inboxAddress);
  if (!entry) return;
  updater(entry);
  entry.statusUpdatedAt = Date.now();
  writePool(pool, { poolPath });
}

export function markInboxInUse(inboxAddress, {
  linkedAliasId, chatGptAccountId, chatGptSignupAt, poolPath = DEFAULT_POOL_PATH
} = {}) {
  updateEntry(inboxAddress, (e) => {
    e.status = 'in-use';
    if (linkedAliasId !== undefined) e.linkedAliasId = linkedAliasId;
    if (chatGptAccountId !== undefined) e.chatGptAccountId = chatGptAccountId;
    if (chatGptSignupAt !== undefined) e.chatGptSignupAt = chatGptSignupAt;
  }, { poolPath });
}

export function markInboxFailed(inboxAddress, reason, { poolPath = DEFAULT_POOL_PATH } = {}) {
  updateEntry(inboxAddress, (e) => {
    e.status = 'failed';
    e.failReason = reason;
  }, { poolPath });
}

export function markInboxChatGptUsed(inboxAddress, { poolPath = DEFAULT_POOL_PATH } = {}) {
  updateEntry(inboxAddress, (e) => {
    e.status = 'chatgpt-used';
  }, { poolPath });
}

export function addNewInboxes(entries, { poolPath = DEFAULT_POOL_PATH } = {}) {
  const pool = readPool({ poolPath });
  pool.entries.push(...entries);
  writePool(pool, { poolPath });
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Run full suite — expect no regressions**

**Step 6: Commit**
```bash
git add src/pipeline/rotation/inboxPoolManager.js tests/pipeline/rotation/inboxPoolManager.test.js
git commit -m "feat: inboxPoolManager — pool CRUD, nextAvailableInbox, status transitions"
```

---

## Task 3: chatGptAccountCreator.js

**Files:**
- Create: `src/pipeline/rotation/chatGptAccountCreator.js`
- Create: `tests/pipeline/rotation/chatGptAccountCreator.test.js`

**Spec:** Full ChatGPT account creation via Puppeteer. Tests use mock `page` object.

The function signature:
```js
export async function createChatGptAccount(page, {
  email,
  agentMailApiKey,
  agentMailInboxId,
  teamInviteCallback,  // async fn(email) → called after account created
  agentMailPollIntervalMs?,  // default 5000
  agentMailTimeoutMs?,       // default 300000 (5 min)
  name?,                     // default "Codex Agent"
})
→ { success: true, auth: { type, access, refresh, expires, accountId } }
| { success: false, error: 'already-registered' | 'otp-timeout' | 'invite-timeout' | 'token-extraction-failed' | string }
```

**Agentmail API polling** (pure Node.js fetch — NOT via browser, since it's our server-side API):
```js
// GET https://api.agentmail.to/v0/inboxes/{inboxId}/messages?limit=10
// Headers: { Authorization: `Bearer ${agentMailApiKey}` }
// Filter messages received after sinceMs
// Look for subject containing "verification" or body containing 6-digit OTP
// OTP regex: /\b(\d{6})\b/
```

**ChatGPT flow** (ALL via page.evaluate):
1. `page.goto('https://chatgpt.com/auth/login')` — then click Sign up button
2. Fill email → Continue → check "already registered" signal
3. Fill name → Continue
4. `sinceMs = Date.now()` → trigger OTP send (clicking Continue on email step triggers OTP)
5. Poll AgentMail API for OTP (server-side fetch)
6. Fill OTP on page
7. Call `teamInviteCallback(email)` 
8. Poll AgentMail for invite email (server-side fetch)
9. Extract invite link from email body
10. `page.goto(inviteLink)` → accept workspace invite
11. Extract token via `page.evaluate(() => fetch('/api/auth/session').then(r => r.json()))`

**Step 1: Write failing tests (mock page)**

Tests must cover:
- TC-3: successful full flow
- TC-4: email already registered → returns already-registered
- TC-6: OTP timeout → returns otp-timeout  
- TC-9: invite timeout → returns invite-timeout

```js
// tests/pipeline/rotation/chatGptAccountCreator.test.js
import { describe, test, expect, jest } from '@jest/globals';
import { createChatGptAccount } from '../../../src/pipeline/rotation/chatGptAccountCreator.js';

// Mock fetch for agentmail API polling
const originalFetch = global.fetch;

function mockPage(overrides = {}) {
  return {
    goto: jest.fn().mockResolvedValue({}),
    waitForSelector: jest.fn().mockResolvedValue({ click: jest.fn() }),
    click: jest.fn().mockResolvedValue({}),
    type: jest.fn().mockResolvedValue({}),
    $: jest.fn().mockResolvedValue(null),
    $$: jest.fn().mockResolvedValue([]),
    waitForNavigation: jest.fn().mockResolvedValue({}),
    evaluate: jest.fn(),
    url: jest.fn().mockReturnValue('https://chatgpt.com/'),
    ...overrides,
  };
}

describe('createChatGptAccount', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('TC-3: returns success with auth on happy path', async () => {
    const page = mockPage();

    // page.evaluate calls:
    // 1. navigate to signup, fill email → returns { alreadyRegistered: false }
    // 2. fill name → returns {}
    // 3. fill OTP → returns {}
    // 4. accept invite → returns {}
    // 5. /api/auth/session → returns token
    let evaluateCall = 0;
    page.evaluate.mockImplementation(async (fn, ...args) => {
      evaluateCall++;
      if (evaluateCall === 1) return { alreadyRegistered: false }; // check signup
      if (evaluateCall === 5) return { // session token
        accessToken: 'access123',
        user: { id: 'user_abc' },
        expires: new Date(Date.now() + 3600_000).toISOString(),
      };
      return {};
    });

    // Mock agentmail fetch: first call returns OTP email, second returns invite email
    let fetchCall = 0;
    global.fetch = jest.fn().mockImplementation(async (url) => {
      fetchCall++;
      if (url.includes('/messages') && fetchCall === 1) {
        return { ok: true, json: async () => ({ messages: [{ subject: 'Verify your email', body: 'Your code is 123456', receivedAt: Date.now() }] }) };
      }
      if (url.includes('/messages') && fetchCall === 2) {
        return { ok: true, json: async () => ({ messages: [{ subject: 'You were invited', body: 'invited you to join https://chatgpt.com/invitations/abc123', receivedAt: Date.now() }] }) };
      }
      return { ok: true, json: async () => ({ messages: [] }) };
    });

    const result = await createChatGptAccount(page, {
      email: 'test@agentmail.to',
      agentMailApiKey: 'am_testkey',
      agentMailInboxId: 'inbox_abc',
      teamInviteCallback: jest.fn().mockResolvedValue({}),
      agentMailPollIntervalMs: 10,
      agentMailTimeoutMs: 500,
    });

    expect(result.success).toBe(true);
    expect(result.auth.type).toBe('oauth');
    expect(result.auth.access).toBe('access123');
    expect(result.auth.accountId).toBe('user_abc');
  });

  test('TC-4: returns already-registered when signup page indicates email taken', async () => {
    const page = mockPage();
    page.evaluate.mockImplementation(async () => ({ alreadyRegistered: true }));

    const result = await createChatGptAccount(page, {
      email: 'existing@agentmail.to',
      agentMailApiKey: 'am_testkey',
      agentMailInboxId: 'inbox_abc',
      teamInviteCallback: jest.fn(),
      agentMailPollIntervalMs: 10,
      agentMailTimeoutMs: 500,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('already-registered');
  });

  test('TC-6: returns otp-timeout when agentmail never delivers OTP', async () => {
    const page = mockPage();
    page.evaluate.mockImplementation(async () => ({ alreadyRegistered: false }));
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ messages: [] }),
    });

    const result = await createChatGptAccount(page, {
      email: 'test@agentmail.to',
      agentMailApiKey: 'am_testkey',
      agentMailInboxId: 'inbox_abc',
      teamInviteCallback: jest.fn(),
      agentMailPollIntervalMs: 10,
      agentMailTimeoutMs: 50, // very short timeout
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('otp-timeout');
  });

  test('TC-9: returns invite-timeout when invite email never arrives', async () => {
    const page = mockPage();
    let evaluateCall = 0;
    page.evaluate.mockImplementation(async () => {
      evaluateCall++;
      if (evaluateCall === 1) return { alreadyRegistered: false };
      return {};
    });

    let fetchCall = 0;
    global.fetch = jest.fn().mockImplementation(async (url) => {
      fetchCall++;
      // OTP arrives on first call, invite never arrives
      if (fetchCall === 1) {
        return { ok: true, json: async () => ({ messages: [{ subject: 'Verify', body: '654321', receivedAt: Date.now() }] }) };
      }
      return { ok: true, json: async () => ({ messages: [] }) };
    });

    const result = await createChatGptAccount(page, {
      email: 'test@agentmail.to',
      agentMailApiKey: 'am_testkey',
      agentMailInboxId: 'inbox_abc',
      teamInviteCallback: jest.fn().mockResolvedValue({}),
      agentMailPollIntervalMs: 10,
      agentMailTimeoutMs: 100,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('invite-timeout');
  });
});
```

**Step 2: Run failing tests**
```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/rotation/chatGptAccountCreator.test.js --runInBand
```

**Step 3: Implement chatGptAccountCreator.js**

Key implementation notes:
- `pollAgentMail(inboxId, apiKey, { sinceMs, timeoutMs, pollIntervalMs, matcher })` — pure Node.js fetch loop
- All ChatGPT DOM interactions wrapped in `try/catch` — return `{ success: false, error }` on any failure
- OTP extraction regex: `/\b(\d{6})\b/`
- Invite link regex: `/https:\/\/chatgpt\.com\/invitations\/[^\s"'<>]+/`
- Token fallbacks: `/api/auth/session` first, then cookie extraction via `page.evaluate`

```js
// src/pipeline/rotation/chatGptAccountCreator.js

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OTP_REGEX = /\b(\d{6})\b/;
const INVITE_LINK_REGEX = /https:\/\/chatgpt\.com\/invitations\/[^\s"'<>]+/;

async function pollAgentMailMessages(inboxId, apiKey, {
  sinceMs = 0,
  timeoutMs = 300_000,
  pollIntervalMs = 5_000,
  matcher = () => true,
} = {}) {
  const url = `https://api.agentmail.to/v0/inboxes/${inboxId}/messages?limit=20`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        const messages = (data.messages ?? []).filter(
          (m) => (m.receivedAt ?? 0) >= sinceMs && matcher(m),
        );
        if (messages.length > 0) return messages[0];
      }
    } catch { /* ignore, retry */ }
    if (Date.now() < deadline) await sleep(pollIntervalMs);
  }
  return null;
}

function extractOtp(message) {
  const text = `${message.subject ?? ''} ${message.body ?? ''}`;
  const match = OTP_REGEX.exec(text);
  return match ? match[1] : null;
}

function extractInviteLink(message) {
  const text = `${message.subject ?? ''} ${message.body ?? ''}`;
  const match = INVITE_LINK_REGEX.exec(text);
  return match ? match[0] : null;
}

export async function createChatGptAccount(page, {
  email,
  agentMailApiKey,
  agentMailInboxId,
  teamInviteCallback,
  agentMailPollIntervalMs = 5_000,
  agentMailTimeoutMs = 300_000,
  name = 'Codex Agent',
}) {
  try {
    // Step 1-3: Navigate to signup, fill email, check if already registered
    const signupCheck = await page.evaluate(async (emailArg, nameArg) => {
      // Navigate to ChatGPT login and attempt signup flow
      // This runs inside browser context
      try {
        // Check for "already registered" indicator on signup page
        const emailInput = document.querySelector('input[type="email"], input[name="email"], input[autocomplete="email"]');
        if (emailInput) {
          emailInput.value = emailArg;
          emailInput.dispatchEvent(new Event('input', { bubbles: true }));
          emailInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // Look for "already registered" signal
        const alreadyMsg = document.body.innerText ?? '';
        if (alreadyMsg.includes('already') && alreadyMsg.includes('use')) {
          return { alreadyRegistered: true };
        }
        return { alreadyRegistered: false };
      } catch (e) {
        return { alreadyRegistered: false, error: String(e) };
      }
    }, email, name);

    if (signupCheck?.alreadyRegistered) {
      return { success: false, error: 'already-registered' };
    }

    // Step 4: Capture sinceMs before triggering OTP
    const sinceMs = Date.now();

    // Step 5: Poll AgentMail for OTP email
    const otpMessage = await pollAgentMailMessages(agentMailInboxId, agentMailApiKey, {
      sinceMs,
      timeoutMs: agentMailTimeoutMs,
      pollIntervalMs: agentMailPollIntervalMs,
      matcher: (m) => OTP_REGEX.test(`${m.subject ?? ''} ${m.body ?? ''}`),
    });

    if (!otpMessage) {
      return { success: false, error: 'otp-timeout' };
    }

    const otp = extractOtp(otpMessage);
    if (!otp) {
      return { success: false, error: 'otp-extraction-failed' };
    }

    // Step 6: Fill OTP on page
    await page.evaluate(async (otpArg) => {
      const inputs = document.querySelectorAll('input[maxlength="1"], input[inputmode="numeric"]');
      if (inputs.length >= 6) {
        for (let i = 0; i < 6; i++) {
          inputs[i].value = otpArg[i];
          inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
        }
        return;
      }
      const single = document.querySelector('input[autocomplete="one-time-code"], input[name*="code"]');
      if (single) {
        single.value = otpArg;
        single.dispatchEvent(new Event('input', { bubbles: true }));
        single.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, otp);

    // Step 7: Trigger team invite
    if (teamInviteCallback) {
      await teamInviteCallback(email);
    }

    // Step 8: Poll AgentMail for invite email
    const inviteSinceMs = Date.now();
    const inviteMessage = await pollAgentMailMessages(agentMailInboxId, agentMailApiKey, {
      sinceMs: inviteSinceMs,
      timeoutMs: agentMailTimeoutMs,
      pollIntervalMs: agentMailPollIntervalMs,
      matcher: (m) => {
        const text = `${m.subject ?? ''} ${m.body ?? ''}`;
        return text.includes('invited you to join') || INVITE_LINK_REGEX.test(text);
      },
    });

    if (!inviteMessage) {
      return { success: false, error: 'invite-timeout' };
    }

    // Step 9: Extract invite link
    const inviteLink = extractInviteLink(inviteMessage);
    if (!inviteLink) {
      return { success: false, error: 'invite-link-extraction-failed' };
    }

    // Step 10: Navigate to invite link
    await page.goto(inviteLink, { waitUntil: 'domcontentloaded' });

    // Step 11: Accept invite (click accept button if present)
    await page.evaluate(async () => {
      const buttons = [...document.querySelectorAll('button')];
      const acceptBtn = buttons.find((b) => /accept|join/i.test(b.textContent ?? ''));
      if (acceptBtn) acceptBtn.click();
    });

    // Step 12: Extract OAuth token
    const session = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/auth/session');
        return await res.json();
      } catch {
        return null;
      }
    });

    if (!session?.accessToken && !session?.access_token) {
      return { success: false, error: 'token-extraction-failed' };
    }

    const access = session.accessToken ?? session.access_token;
    const refresh = session.refreshToken ?? session.refresh_token ?? null;
    const expires = session.expires ? Date.parse(session.expires) : Date.now() + 3600_000;
    const accountId = session.user?.id ?? session.sub ?? null;

    return {
      success: true,
      auth: { type: 'oauth', access, refresh, expires, accountId },
    };
  } catch (e) {
    return { success: false, error: String(e?.message ?? e) };
  }
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Run full suite — expect no regressions**

**Step 6: Commit**
```bash
git add src/pipeline/rotation/chatGptAccountCreator.js tests/pipeline/rotation/chatGptAccountCreator.test.js
git commit -m "feat: chatGptAccountCreator — signup, OTP, invite acceptance, token extraction"
```

---

## Task 4: checkArchiveAndReplaceExhausted.js

**Files:**
- Create: `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`
- Create: `tests/pipeline/rotation/checkArchiveAndReplaceExhausted.test.js`

**Spec:** Main orchestration. All external dependencies (finalizeAddedAccount, browser, teamDriver) injected for testability.

```js
export async function runCheckArchiveAndReplace({
  dryRun = false,
  forceReplaceAll9 = false,
  log = console.log,
  // Injectable for testing:
  archivePath?,
  poolPath?,
  healthPath?,
  routerPath?,
  authPath?,
  // Injectable browser/finalizer factories:
  createBrowserSession?,   // async (profileDir) => { page, browser, proc, cleanup }
  finalize?,               // async (input) => FinalizeResult
  teamDriver?,             // { inviteTeamMember, removeTeamMember }
  bootstrapNewRoot?,       // async () => InboxPoolEntry[]
}) → {
  exhaustedProcessed: number,
  reinstated: number,
  newAccountsCreated: number,
  failed: number,
  dryRun: boolean,
  details: Array<{ aliasId, status, inbox?, error? }>
}
```

**Algorithm (from spec Section 8):**
1. `assessCodexQuotas()` → get exhausted/atRisk/healthy
2. `checkReinstatements(probeQuota)` → reinstate renewed archived aliases
3. For each exhausted alias (or all 9 if forceReplaceAll9):
   a. `nextAvailableInbox()` → get inbox
   b. If null → call `bootstrapNewRoot()` → `addNewInboxes()`
   c. `createChatGptAccount(page, ...)` 
   d. If already-registered → `markInboxChatGptUsed()`, retry next inbox
   e. Write temp auth → `finalize()` → `upsertAliasAndAddRoute()`
   f. `archiveAlias()` for exhausted alias + `removeAuthCredential()`
   g. `markInboxInUse()`
4. Write ledger to `state/rotation/`
5. Return summary

**Dryrun mode:** Log what WOULD happen. No writes to auth.json, pool, or archive.

**Step 1: Write tests covering TC-1, TC-2, TC-3, TC-5, TC-7, TC-10**

```js
// tests/pipeline/rotation/checkArchiveAndReplaceExhausted.test.js
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheckArchiveAndReplace } from '../../../src/pipeline/rotation/checkArchiveAndReplaceExhausted.js';

let tmpDir, archivePath, poolPath, healthPath, routerPath, authPath;

function seedFile(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2)); }

function makePoolEntry(inboxAddress, status = 'available') {
  return {
    inboxAddress, rootEmail: 'root@example.com', rootOrgId: 'org1',
    rootApiKeyPrefix: 'am_us', cfRuleId: 'r1', cfKvNamespaceId: 'kv1',
    status, statusUpdatedAt: Date.now(),
  };
}

function makeHealthFile(aliases) {
  const models = {};
  for (const [id, fraction] of Object.entries(aliases)) {
    models[`${id}/gpt-5.4`] = {
      quotaRemainingFraction: fraction, quotaProofAmbiguous: false,
      quotaCheckedAt: Date.now(),
    };
  }
  return { version: 1, providers: {}, models };
}

function makeRouterFile(aliasIds) {
  return {
    version: 1,
    aliases: aliasIds.map((id) => ({ id, cloneFrom: 'openai-codex', apiKey: 'unused', email: `${id}@agentmail.to`, label: id, disabled: false })),
    pools: [{ name: 'openai-codex', providers: aliasIds, routes: aliasIds.map((id) => ({ provider: id, model: 'gpt-5.4' })) }],
    policy: {},
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-archive-test-'));
  archivePath = path.join(tmpDir, 'archive.json');
  poolPath = path.join(tmpDir, 'pool.json');
  healthPath = path.join(tmpDir, 'health.json');
  routerPath = path.join(tmpDir, 'router.json');
  authPath = path.join(tmpDir, 'auth.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const noopLog = () => {};

// TC-1: No exhausted aliases → IDLE, no changes
describe('TC-1: no exhausted aliases', () => {
  test('returns zero processed when all healthy', async () => {
    seedFile(healthPath, makeHealthFile({ alias1: 0.9, alias2: 0.8 }));
    seedFile(routerPath, makeRouterFile(['alias1', 'alias2']));
    seedFile(poolPath, { version: 1, entries: [makePoolEntry('a@agentmail.to')], lastCheckedAt: 0, allEntriesExhausted: false });
    seedFile(authPath, {});

    const result = await runCheckArchiveAndReplace({
      archivePath, poolPath, healthPath, routerPath, authPath,
      log: noopLog,
      createBrowserSession: jest.fn(),
      finalize: jest.fn(),
      teamDriver: { inviteTeamMember: jest.fn(), removeTeamMember: jest.fn() },
    });

    expect(result.exhaustedProcessed).toBe(0);
    expect(result.newAccountsCreated).toBe(0);
  });
});

// TC-2: One archived alias has renewed quota → reinstate, no new account needed
describe('TC-2: archive reinstatement', () => {
  test('reinstates alias and removes from exhausted list', async () => {
    seedFile(healthPath, makeHealthFile({ alias_exhausted: 0 }));
    seedFile(routerPath, makeRouterFile(['alias_exhausted']));
    seedFile(authPath, { alias_exhausted: { type: 'oauth', access: 'old', refresh: 'r', expires: 1, accountId: 'u' } });
    seedFile(poolPath, { version: 1, entries: [makePoolEntry('a@agentmail.to')], lastCheckedAt: 0, allEntriesExhausted: false });

    // Seed archive with an alias that has renewed quota
    const archiveData = {
      version: 1, aliases: [{
        aliasId: 'renewed_alias', email: 'renewed@agentmail.to', cloneFrom: 'openai-codex',
        auth: { type: 'oauth', access: 'fresh_tok', refresh: 'r', expires: Date.now() + 3600_000, accountId: 'uid_renewed' },
        archivedAt: Date.now() - 86400_000, archivedReason: 'both-exhausted',
        quotaRemainingFraction: 0, reinstated: false, teamMemberStatus: 'active',
      }],
    };
    seedFile(archivePath, archiveData);

    const mockFinalize = jest.fn().mockResolvedValue({ ok: true, validation: 'ok' });

    const result = await runCheckArchiveAndReplace({
      archivePath, poolPath, healthPath, routerPath, authPath,
      log: noopLog,
      // probeQuota returns fraction > 0.1 for the archived alias
      _probeQuotaOverride: async () => 0.5,
      finalize: mockFinalize,
      teamDriver: { inviteTeamMember: jest.fn(), removeTeamMember: jest.fn() },
      createBrowserSession: jest.fn(),
    });

    expect(result.reinstated).toBeGreaterThanOrEqual(1);
  });
});

// TC-3: Exhausted alias, available inbox → full rotation
describe('TC-3: full rotation with available inbox', () => {
  test('creates new account and archives exhausted alias', async () => {
    seedFile(healthPath, makeHealthFile({ alias1: 0 })); // exhausted
    seedFile(routerPath, makeRouterFile(['alias1']));
    seedFile(authPath, { alias1: { type: 'oauth', access: 'old', refresh: 'r', expires: 1, accountId: 'u1' } });
    seedFile(archivePath, { version: 1, aliases: [] });
    seedFile(poolPath, { version: 1, entries: [makePoolEntry('inbox@agentmail.to')], lastCheckedAt: 0, allEntriesExhausted: false });

    const mockPage = {
      goto: jest.fn().mockResolvedValue({}),
      evaluate: jest.fn()
        .mockResolvedValueOnce({ alreadyRegistered: false }) // signup check
        .mockResolvedValueOnce({}) // fill OTP
        .mockResolvedValueOnce({}) // accept invite
        .mockResolvedValueOnce({ accessToken: 'new_tok', user: { id: 'new_uid' }, expires: new Date(Date.now() + 3600_000).toISOString() }), // session
      waitForSelector: jest.fn().mockResolvedValue({ click: jest.fn() }),
      click: jest.fn(), type: jest.fn(), $: jest.fn().mockResolvedValue(null),
      $$: jest.fn().mockResolvedValue([]), url: jest.fn().mockReturnValue('https://chatgpt.com/'),
    };

    const mockFinalize = jest.fn().mockResolvedValue({ ok: true, validation: 'ok' });
    const mockTeamDriver = { inviteTeamMember: jest.fn().mockResolvedValue({}), removeTeamMember: jest.fn().mockResolvedValue({}) };
    const mockCreateBrowserSession = jest.fn().mockResolvedValue({
      page: mockPage,
      browser: { close: jest.fn() },
      proc: { kill: jest.fn() },
      cleanup: jest.fn(),
    });

    // Mock agentmail polling to return OTP then invite
    let fetchCount = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      fetchCount++;
      if (fetchCount === 1) return { ok: true, json: async () => ({ messages: [{ subject: 'Verify', body: '123456', receivedAt: Date.now() }] }) };
      if (fetchCount >= 2) return { ok: true, json: async () => ({ messages: [{ subject: 'Invited', body: 'invited you to join https://chatgpt.com/invitations/xyz', receivedAt: Date.now() }] }) };
      return { ok: true, json: async () => ({ messages: [] }) };
    });

    const result = await runCheckArchiveAndReplace({
      archivePath, poolPath, healthPath, routerPath, authPath,
      log: noopLog,
      createBrowserSession: mockCreateBrowserSession,
      finalize: mockFinalize,
      teamDriver: mockTeamDriver,
      agentMailPollIntervalMs: 10,
      agentMailTimeoutMs: 500,
    });

    expect(result.newAccountsCreated).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    global.fetch = undefined;
  });
});

// TC-5: Pool empty → bootstrap new root
describe('TC-5: pool exhausted triggers bootstrap', () => {
  test('calls bootstrapNewRoot when no available inbox', async () => {
    seedFile(healthPath, makeHealthFile({ alias1: 0 }));
    seedFile(routerPath, makeRouterFile(['alias1']));
    seedFile(authPath, { alias1: { type: 'oauth', access: 'a', refresh: 'r', expires: 1, accountId: 'u' } });
    seedFile(archivePath, { version: 1, aliases: [] });
    seedFile(poolPath, { version: 1, entries: [makePoolEntry('used@agentmail.to', 'in-use')], lastCheckedAt: 0, allEntriesExhausted: false });

    const newInbox = makePoolEntry('fresh@agentmail.to', 'available');
    const mockBootstrap = jest.fn().mockResolvedValue([newInbox]);

    const mockPage = {
      goto: jest.fn().mockResolvedValue({}),
      evaluate: jest.fn()
        .mockResolvedValueOnce({ alreadyRegistered: false })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ accessToken: 'tok', user: { id: 'uid' }, expires: new Date(Date.now() + 3600_000).toISOString() }),
      waitForSelector: jest.fn().mockResolvedValue({ click: jest.fn() }),
      click: jest.fn(), type: jest.fn(), $: jest.fn().mockResolvedValue(null),
      $$: jest.fn().mockResolvedValue([]), url: jest.fn().mockReturnValue('https://chatgpt.com/'),
    };

    let fetchCount = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      fetchCount++;
      if (fetchCount === 1) return { ok: true, json: async () => ({ messages: [{ subject: 'V', body: '654321', receivedAt: Date.now() }] }) };
      return { ok: true, json: async () => ({ messages: [{ subject: 'Invite', body: 'invited you to join https://chatgpt.com/invitations/abc', receivedAt: Date.now() }] }) };
    });

    const result = await runCheckArchiveAndReplace({
      archivePath, poolPath, healthPath, routerPath, authPath,
      log: noopLog,
      createBrowserSession: jest.fn().mockResolvedValue({ page: mockPage, browser: { close: jest.fn() }, proc: { kill: jest.fn() }, cleanup: jest.fn() }),
      finalize: jest.fn().mockResolvedValue({ ok: true, validation: 'ok' }),
      teamDriver: { inviteTeamMember: jest.fn(), removeTeamMember: jest.fn() },
      bootstrapNewRoot: mockBootstrap,
      agentMailPollIntervalMs: 10,
      agentMailTimeoutMs: 500,
    });

    expect(mockBootstrap).toHaveBeenCalled();
    global.fetch = undefined;
  });
});

// TC-7: finalize returns auth_invalid → mark inbox failed, continue
describe('TC-7: finalize auth_invalid marks inbox failed', () => {
  test('marks inbox failed and continues', async () => {
    seedFile(healthPath, makeHealthFile({ alias1: 0 }));
    seedFile(routerPath, makeRouterFile(['alias1']));
    seedFile(authPath, { alias1: { type: 'oauth', access: 'a', refresh: 'r', expires: 1, accountId: 'u' } });
    seedFile(archivePath, { version: 1, aliases: [] });
    seedFile(poolPath, { version: 1, entries: [makePoolEntry('inbox@agentmail.to')], lastCheckedAt: 0, allEntriesExhausted: false });

    const mockPage = {
      goto: jest.fn().mockResolvedValue({}),
      evaluate: jest.fn()
        .mockResolvedValueOnce({ alreadyRegistered: false })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ accessToken: 'tok', user: { id: 'uid' }, expires: new Date(Date.now() + 3600_000).toISOString() }),
      waitForSelector: jest.fn().mockResolvedValue({ click: jest.fn() }),
      click: jest.fn(), type: jest.fn(), $: jest.fn().mockResolvedValue(null),
      $$: jest.fn().mockResolvedValue([]), url: jest.fn().mockReturnValue('https://chatgpt.com/'),
    };

    let fetchCount = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      fetchCount++;
      if (fetchCount === 1) return { ok: true, json: async () => ({ messages: [{ subject: 'V', body: '123456', receivedAt: Date.now() }] }) };
      return { ok: true, json: async () => ({ messages: [{ subject: 'I', body: 'invited you to join https://chatgpt.com/invitations/a', receivedAt: Date.now() }] }) };
    });

    const result = await runCheckArchiveAndReplace({
      archivePath, poolPath, healthPath, routerPath, authPath,
      log: noopLog,
      createBrowserSession: jest.fn().mockResolvedValue({ page: mockPage, browser: { close: jest.fn() }, proc: { kill: jest.fn() }, cleanup: jest.fn() }),
      finalize: jest.fn().mockResolvedValue({ ok: false, error: 'auth:forbidden' }),
      teamDriver: { inviteTeamMember: jest.fn(), removeTeamMember: jest.fn() },
      agentMailPollIntervalMs: 10,
      agentMailTimeoutMs: 500,
    });

    expect(result.failed).toBeGreaterThanOrEqual(1);
    global.fetch = undefined;
  });
});

// Dry run
describe('dryRun mode', () => {
  test('makes no file writes in dry-run mode', async () => {
    seedFile(healthPath, makeHealthFile({ alias1: 0 }));
    seedFile(routerPath, makeRouterFile(['alias1']));
    seedFile(authPath, {});
    seedFile(archivePath, { version: 1, aliases: [] });
    seedFile(poolPath, { version: 1, entries: [makePoolEntry('inbox@agentmail.to')], lastCheckedAt: 0, allEntriesExhausted: false });

    const poolBefore = fs.readFileSync(poolPath, 'utf8');
    const archiveBefore = fs.readFileSync(archivePath, 'utf8');

    const result = await runCheckArchiveAndReplace({
      dryRun: true,
      archivePath, poolPath, healthPath, routerPath, authPath,
      log: noopLog,
      createBrowserSession: jest.fn(),
      finalize: jest.fn(),
      teamDriver: { inviteTeamMember: jest.fn(), removeTeamMember: jest.fn() },
    });

    expect(result.dryRun).toBe(true);
    expect(fs.readFileSync(poolPath, 'utf8')).toBe(poolBefore);
    expect(fs.readFileSync(archivePath, 'utf8')).toBe(archiveBefore);
  });
});
```

**Step 2: Run failing tests**

**Step 3: Implement checkArchiveAndReplaceExhausted.js**

IMPORTANT implementation details:
- Import `assessCodexQuotas` from `quotaDetector.js` — pass `healthPath`, `routerPath`
- Import `readArchive`, `archiveAlias`, `checkReinstatements`, `markReinstated` from `archiveManager.js`
- Import `readPool`, `nextAvailableInbox`, `markInboxInUse`, `markInboxFailed`, `markInboxChatGptUsed`, `addNewInboxes` from `inboxPoolManager.js`
- Import `createChatGptAccount` from `chatGptAccountCreator.js`
- Import `writeAuthCredential`, `removeAuthCredential`, `emailToAliasId` from `piAccountRegistrar.js`
- Write ledger to `state/rotation/ledger-<timestamp>.json` (relative to cwd)
- `finalize` is injected — in production it wraps `finalizeAddedAccount()` from pi extension
- `createBrowserSession` is injected — in production it launches Chrome + Xvfb

```js
// src/pipeline/rotation/checkArchiveAndReplaceExhausted.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { assessCodexQuotas } from './quotaDetector.js';
import { readArchive, archiveAlias, checkReinstatements, markReinstated } from './archiveManager.js';
import { nextAvailableInbox, markInboxInUse, markInboxFailed, markInboxChatGptUsed, addNewInboxes } from './inboxPoolManager.js';
import { createChatGptAccount } from './chatGptAccountCreator.js';
import { writeAuthCredential, removeAuthCredential, emailToAliasId } from './piAccountRegistrar.js';

const DEFAULT_ARCHIVE_PATH = path.join(os.homedir(), '.pi', 'agent', 'codex-alias-archive.json');
const DEFAULT_POOL_PATH = path.join(os.homedir(), '.pi', 'agent', 'codex-inbox-pool.json');
const DEFAULT_HEALTH_PATH = path.join(os.homedir(), '.pi', 'agent', 'account-router-health.json');
const DEFAULT_ROUTER_PATH = path.join(os.homedir(), '.pi', 'agent', 'account-router.json');
const DEFAULT_AUTH_PATH = path.join(os.homedir(), '.pi', 'agent', 'auth.json');

// ... full implementation
```

The full implementation must:
1. Accept all deps as optional params with defaults
2. In dryRun: log but skip all writes (archive, pool, auth, router)
3. For each exhausted alias: use try/catch around the whole block, push to failed on any error
4. After rotation: write `state/rotation/ledger-${Date.now()}.json` (mkdir -p first)
5. Return `{ exhaustedProcessed, reinstated, newAccountsCreated, failed, dryRun, details }`

**Step 4: Run tests — all 6 test groups pass**

**Step 5: Run full suite**

**Step 6: Commit**
```bash
git add src/pipeline/rotation/checkArchiveAndReplaceExhausted.js tests/pipeline/rotation/checkArchiveAndReplaceExhausted.test.js
git commit -m "feat: checkArchiveAndReplaceExhausted — main orchestrator with all TC-1 through TC-10 coverage"
```

---

## Task 5: pipeline-check-archive-replace.js CLI

**Files:**
- Create: `src/cli/pipeline-check-archive-replace.js`
- Create: `tests/cli/pipelineCheckArchiveReplace.test.js`

**Spec:**
```bash
node src/cli/pipeline-check-archive-replace.js [options]
  --dry-run               Simulate, no writes
  --force-replace-all-9   Create accounts for all 9 inboxes now
  --status                Show current archive + pool status, exit
```

**--status output format:**
```
=== Codex Rotation Status ===
Archive: 0 aliases archived, 0 reinstated
Pool: 9 available, 0 in-use, 0 failed, 0 chatgpt-used
Codex aliases: 8 total (6 healthy, 1 at-risk, 0 exhausted, 1 stale)
```

**Step 1: Write failing tests**

```js
// tests/cli/pipelineCheckArchiveReplace.test.js
import { describe, test, expect } from '@jest/globals';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.join(process.cwd(), 'src/cli/pipeline-check-archive-replace.js');

function seedFiles(tmpDir) {
  const archivePath = path.join(tmpDir, 'archive.json');
  const poolPath = path.join(tmpDir, 'pool.json');
  const healthPath = path.join(tmpDir, 'health.json');
  const routerPath = path.join(tmpDir, 'router.json');
  fs.writeFileSync(archivePath, JSON.stringify({ version: 1, aliases: [] }));
  fs.writeFileSync(poolPath, JSON.stringify({ version: 1, entries: [
    { inboxAddress: 'a@agentmail.to', status: 'available', rootEmail: 'r@e.com', rootOrgId: 'org1', rootApiKeyPrefix: 'am_', cfRuleId: 'r1', cfKvNamespaceId: 'kv1', statusUpdatedAt: Date.now() }
  ], lastCheckedAt: 0, allEntriesExhausted: false }));
  fs.writeFileSync(healthPath, JSON.stringify({ version: 1, providers: {}, models: {} }));
  fs.writeFileSync(routerPath, JSON.stringify({ version: 1, aliases: [], pools: [], policy: {} }));
  return { archivePath, poolPath, healthPath, routerPath };
}

describe('pipeline-check-archive-replace --status', () => {
  test('exits 0 and shows status output', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
    try {
      const { archivePath, poolPath, healthPath, routerPath } = seedFiles(tmpDir);
      const out = execSync(
        `node ${CLI} --status --archive-path ${archivePath} --pool-path ${poolPath} --health-path ${healthPath} --router-path ${routerPath}`,
        { encoding: 'utf8' }
      );
      expect(out).toContain('Archive:');
      expect(out).toContain('Pool:');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('pipeline-check-archive-replace --dry-run', () => {
  test('exits 0 and shows dry-run in output', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
    try {
      const { archivePath, poolPath, healthPath, routerPath } = seedFiles(tmpDir);
      const out = execSync(
        `node ${CLI} --dry-run --archive-path ${archivePath} --pool-path ${poolPath} --health-path ${healthPath} --router-path ${routerPath}`,
        { encoding: 'utf8' }
      );
      expect(out.toLowerCase()).toMatch(/dry.?run|simulate|no writes/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
```

**Step 2: Run failing tests**

**Step 3: Implement pipeline-check-archive-replace.js**

```js
#!/usr/bin/env node
// src/cli/pipeline-check-archive-replace.js
import { parseArgs } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { readArchive } from '../pipeline/rotation/archiveManager.js';
import { readPool } from '../pipeline/rotation/inboxPoolManager.js';
import { assessCodexQuotas } from '../pipeline/rotation/quotaDetector.js';
import { runCheckArchiveAndReplace } from '../pipeline/rotation/checkArchiveAndReplaceExhausted.js';

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    'force-replace-all-9': { type: 'boolean', default: false },
    'status': { type: 'boolean', default: false },
    // Override paths (for testing)
    'archive-path': { type: 'string' },
    'pool-path': { type: 'string' },
    'health-path': { type: 'string' },
    'router-path': { type: 'string' },
    'auth-path': { type: 'string' },
  },
  strict: true,
});

const agentDir = path.join(os.homedir(), '.pi', 'agent');
const archivePath = values['archive-path'] ?? path.join(agentDir, 'codex-alias-archive.json');
const poolPath = values['pool-path'] ?? path.join(agentDir, 'codex-inbox-pool.json');
const healthPath = values['health-path'] ?? path.join(agentDir, 'account-router-health.json');
const routerPath = values['router-path'] ?? path.join(agentDir, 'account-router.json');
const authPath = values['auth-path'] ?? path.join(agentDir, 'auth.json');

if (values.status) {
  const archive = readArchive({ archivePath });
  const pool = readPool({ poolPath });
  const quota = assessCodexQuotas({ healthPath, routerPath });

  const archived = archive.aliases.length;
  const reinstated = archive.aliases.filter((a) => a.reinstated).length;
  const available = pool.entries.filter((e) => e.status === 'available').length;
  const inUse = pool.entries.filter((e) => e.status === 'in-use').length;
  const failed = pool.entries.filter((e) => e.status === 'failed').length;
  const chatgptUsed = pool.entries.filter((e) => e.status === 'chatgpt-used').length;

  console.log('=== Codex Rotation Status ===');
  console.log(`Archive: ${archived} aliases archived, ${reinstated} reinstated`);
  console.log(`Pool: ${available} available, ${inUse} in-use, ${failed} failed, ${chatgptUsed} chatgpt-used`);
  console.log(`Codex aliases: ${quota.aliases.length} total (${quota.healthy.length} healthy, ${quota.atRisk.length} at-risk, ${quota.exhausted.length} exhausted)`);
  process.exit(0);
}

if (values['dry-run']) {
  console.log('[dry-run] Simulating check-archive-replace — no writes will occur');
}

const result = await runCheckArchiveAndReplace({
  dryRun: values['dry-run'],
  forceReplaceAll9: values['force-replace-all-9'],
  log: console.log,
  archivePath,
  poolPath,
  healthPath,
  routerPath,
  authPath,
});

console.log('\n=== Result ===');
console.log(`Exhausted processed: ${result.exhaustedProcessed}`);
console.log(`Reinstated: ${result.reinstated}`);
console.log(`New accounts created: ${result.newAccountsCreated}`);
console.log(`Failed: ${result.failed}`);
if (result.dryRun) console.log('(DRY RUN — no writes made)');
```

**Step 4: Run tests — expect PASS**

**Step 5: Run full suite — all tests pass**

**Step 6: Verify `--status` output on live system**
```bash
cd ~/Development/chatgpt-factory-bundle/.worktrees/deterministic-agentmail-pipeline-clone
node src/cli/pipeline-check-archive-replace.js --status
```
Expected: "9 available, 0 in-use..." etc.

**Step 7: Verify `--dry-run` on live system**
```bash
node src/cli/pipeline-check-archive-replace.js --dry-run --force-replace-all-9
```
Expected: exits 0, shows dry-run log

**Step 8: Commit**
```bash
git add src/cli/pipeline-check-archive-replace.js tests/cli/pipelineCheckArchiveReplace.test.js
git commit -m "feat: pipeline-check-archive-replace CLI — --status, --dry-run, --force-replace-all-9"
```

---

## Task 6: Final invariant tests and full verification

**Files:**
- Create: `tests/pipeline/rotation/invariants.test.js`

**Step 1: Write invariant tests (INV-1 through INV-9)**

```js
// tests/pipeline/rotation/invariants.test.js
// Tests for spec Section 9 invariants
import { describe, test, expect } from '@jest/globals';
// ... all INV-1 through INV-9 as unit assertions over mock data
```

**Step 2: Run full test suite — must show 125+ tests passing**
```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js tests/pipeline/ tests/cli/ --runInBand --testPathIgnorePatterns='/node_modules/'
```

**Step 3: Verify live `--status`**
```bash
node src/cli/pipeline-check-archive-replace.js --status
```

**Step 4: Final commit**
```bash
git add tests/pipeline/rotation/invariants.test.js
git commit -m "test: INV-1 through INV-9 invariant assertions"
```
