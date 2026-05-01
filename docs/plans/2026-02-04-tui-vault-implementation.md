# TUI Encrypted Vault Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a TUI-only encrypted vault that persists account + billing data on successful runs, using a user passcode and `safety.persistSecrets` gating.

**Architecture:** Introduce a `src/security/vault.js` module for AES‑256‑GCM encryption/decryption and a TUI passcode prompt screen that unlocks/prefills config before preflight. App orchestration will reuse vault account data instead of provisioning when available and save on success.

**Tech Stack:** Node `crypto`, Ink TUI, Jest + fast-check.

---

### Task 1: Vault module (round‑trip encryption/decryption)

**Files:**
- Create: `src/security/vault.js`
- Test: `tests/Vault.test.js`

**Step 1: Write the failing tests**

Create `tests/Vault.test.js`:
```js
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getVaultPath, saveVault, loadVault } from '../src/security/vault.js';

const payload = {
  account: { email: 'user@example.com', password: 'pass', agentMailInbox: 'inbox@agentmail.to' },
  billing: { cardNumber: '4111111111111111', expMonth: '01', expYear: '2028', cvc: '123', billingZip: '12345', billingCountry: 'US' },
};

test('vault encrypts and decrypts payload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-'));
  const vaultPath = join(dir, 'account.enc.json');
  saveVault({ passcode: 'secret', data: payload, vaultPath });

  const parsed = JSON.parse(readFileSync(vaultPath, 'utf8'));
  expect(parsed).toHaveProperty('version', 1);
  expect(parsed).toHaveProperty('kdf');
  expect(parsed).toHaveProperty('cipher');

  const result = loadVault({ passcode: 'secret', vaultPath });
  expect(result).toEqual(payload);
});

test('vault rejects wrong passcode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-'));
  const vaultPath = join(dir, 'account.enc.json');
  saveVault({ passcode: 'secret', data: payload, vaultPath });

  expect(() => loadVault({ passcode: 'wrong', vaultPath })).toThrow();
});

test('getVaultPath joins homedir with .account-factory', () => {
  const vaultPath = getVaultPath({ homedir: '/home/test' });
  expect(vaultPath).toContain('/home/test/.account-factory/account.enc.json');
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/Vault.test.js`

Expected: FAIL (`Cannot find module '../src/security/vault.js'`).

**Step 3: Implement minimal vault module**

Create `src/security/vault.js` with:
```js
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_ITERATIONS = 200000;
const DEFAULT_DIGEST = 'sha256';
const KEY_LEN = 32;

export function getVaultPath({ homedir = os.homedir(), pathImpl = path } = {}) {
  return pathImpl.join(homedir, '.account-factory', 'account.enc.json');
}

function deriveKey(passcode, salt, cryptoImpl = crypto) {
  return cryptoImpl.pbkdf2Sync(passcode, salt, DEFAULT_ITERATIONS, KEY_LEN, DEFAULT_DIGEST);
}

export function saveVault({ passcode, data, vaultPath = getVaultPath(), fsImpl = fs, cryptoImpl = crypto } = {}) {
  const dir = path.dirname(vaultPath);
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const salt = cryptoImpl.randomBytes(16);
  const iv = cryptoImpl.randomBytes(12);
  const key = deriveKey(passcode, salt, cryptoImpl);

  const cipher = cryptoImpl.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload = {
    version: 1,
    kdf: { salt: salt.toString('base64'), iterations: DEFAULT_ITERATIONS, digest: DEFAULT_DIGEST },
    cipher: { iv: iv.toString('base64'), tag: tag.toString('base64'), ciphertext: ciphertext.toString('base64') },
  };

  fsImpl.writeFileSync(vaultPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

export function loadVault({ passcode, vaultPath = getVaultPath(), fsImpl = fs, cryptoImpl = crypto } = {}) {
  const payload = JSON.parse(fsImpl.readFileSync(vaultPath, 'utf8'));
  const salt = Buffer.from(payload.kdf.salt, 'base64');
  const iv = Buffer.from(payload.cipher.iv, 'base64');
  const tag = Buffer.from(payload.cipher.tag, 'base64');
  const ciphertext = Buffer.from(payload.cipher.ciphertext, 'base64');

  const key = cryptoImpl.pbkdf2Sync(passcode, salt, payload.kdf.iterations, KEY_LEN, payload.kdf.digest);
  const decipher = cryptoImpl.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/Vault.test.js`

Expected: PASS

**Step 5: Commit**

```bash
git add src/security/vault.js tests/Vault.test.js
git commit -m "feat: add encrypted vault module"
```

---

### Task 2: Vault prompt screen (masked input + prompts)

**Files:**
- Create: `src/tui/screens/VaultScreen.js`
- Test: `tests/VaultScreen.test.js`

**Step 1: Write the failing tests**

Create `tests/VaultScreen.test.js`:
```js
import React from 'react';
import { render } from 'ink-testing-library';
import { VaultScreen } from '../src/tui/screens/VaultScreen.js';

test('renders unlock prompt', () => {
  const { lastFrame } = render(React.createElement(VaultScreen, { mode: 'unlock', error: null }));
  expect(lastFrame()).toContain('Vault Passcode');
  expect(lastFrame()).toContain('Enter passcode to unlock');
});

test('renders create prompt with confirmation', () => {
  const { lastFrame } = render(React.createElement(VaultScreen, { mode: 'create', error: null }));
  expect(lastFrame()).toContain('Create a new passcode');
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/VaultScreen.test.js`

Expected: FAIL (`Cannot find module '../src/tui/screens/VaultScreen.js'`).

**Step 3: Implement minimal VaultScreen**

Create `src/tui/screens/VaultScreen.js` that:
- Uses `useInput` to collect characters.
- Masks input with `*`.
- Shows different prompts for `mode: 'unlock' | 'create' | 'confirm'`.
- Calls `onSubmit(passcode)` on Enter and `onCancel()` on Escape.

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/VaultScreen.test.js`

Expected: PASS

**Step 5: Commit**

```bash
git add src/tui/screens/VaultScreen.js tests/VaultScreen.test.js
git commit -m "feat: add vault passcode screen"
```

---

### Task 3: State machine support for vault prompt

**Files:**
- Modify: `src/tui/stateMachine.js`
- Test: `tests/TuiStateMachine.test.js`
- Test: `tests/TuiStateMachine.property.test.js`

**Step 1: Write failing tests**

Update `tests/TuiStateMachine.test.js`:
```js
expect(s.screen).toBe(Screens.WIZARD);
// new action
s = reducer(s, { type: 'VAULT_OPEN' });
expect(s.screen).toBe(Screens.VAULT);

s = reducer(s, { type: 'NAV_NEXT' });
expect(s.screen).toBe(Screens.PREFLIGHT);

s = reducer(s, { type: 'VAULT_CANCEL' });
expect(s.screen).toBe(Screens.WIZARD);
```

Update `tests/TuiStateMachine.property.test.js` to include new actions in the action list and ensure invariants still hold.

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/TuiStateMachine.test.js tests/TuiStateMachine.property.test.js`

Expected: FAIL (unknown screen/actions).

**Step 3: Implement minimal reducer changes**

- Add `Screens.VAULT`.
- Handle `VAULT_OPEN`, `VAULT_CANCEL`.
- Allow `NAV_NEXT` from `VAULT` to `PREFLIGHT`.

**Step 4: Run tests to verify they pass**

Run: `npm test -- tests/TuiStateMachine.test.js tests/TuiStateMachine.property.test.js`

Expected: PASS

**Step 5: Commit**

```bash
git add src/tui/stateMachine.js tests/TuiStateMachine.test.js tests/TuiStateMachine.property.test.js
git commit -m "feat: add vault screen to state machine"
```

---

### Task 4: App integration (unlock, prefill, reuse account, save on success)

**Files:**
- Modify: `src/tui/App.js`
- Modify: `src/tui/screens/WizardScreen.js`
- Modify: `tests/TuiScreens.test.js`
- Modify: `tests/TuiEntrypoint.test.js`

**Step 1: Write failing tests**

Update `tests/TuiScreens.test.js` to render the new `VaultScreen` prompt and include it in the screen suite.

Add a new test in `tests/TuiEntrypoint.test.js` that ensures the app renders `VaultScreen` when `safety.persistSecrets: true` and vault is locked (inject by passing a config with `persistSecrets: true` once App supports `initialConfig`).

**Step 2: Run tests to verify they fail**

Run: `npm test -- tests/TuiScreens.test.js tests/TuiEntrypoint.test.js`

Expected: FAIL (VaultScreen not rendered / App lacks vault flow).

**Step 3: Implement App changes**

- Add vault state in `App`:
  ```js
  const [vault, setVault] = useState({ enabled: false, unlocked: false, passcode: null, account: null, error: null, mode: 'unlock' });
  ```
- If `config.safety.persistSecrets` is true, route Wizard → Vault prompt via `VAULT_OPEN` before preflight.
- Use `loadVault` on unlock to prefill:
  - `config.identity.email`, `config.identity.password`
  - `config.billing.*`
  - Store `vault.account` with `email` + `agentMailInbox`.
- On successful run:
  - Determine the account used (vault account or newly provisioned).
  - Call `saveVault({ passcode: vault.passcode, data: { account, billing } })`.
- Skip `EmailProvisioner.provision()` if `vault.account` exists.
- Use `VAULT_CANCEL` to return to Wizard when user cancels.
- Ensure no logging of passcode or decrypted values.

**Step 4: Run tests to verify they pass**

Run: `npm test -- tests/TuiScreens.test.js tests/TuiEntrypoint.test.js`

Expected: PASS

**Step 5: Commit**

```bash
git add src/tui/App.js src/tui/screens/WizardScreen.js tests/TuiScreens.test.js tests/TuiEntrypoint.test.js
git commit -m "feat: integrate vault unlock and persistence"
```

---

### Task 5: Documentation updates

**Files:**
- Modify: `docs/tui.md`

**Step 1: Update docs**
Add a section describing:
- `safety.persistSecrets: true`
- Vault file location `~/.account-factory/account.enc.json`
- Passcode prompt behavior and retry/cancel

**Step 2: Commit**

```bash
git add docs/tui.md
git commit -m "docs: document TUI vault persistence"
```

---

### Task 6: Full verification

Run: `npm test`

Expected: PASS (all tests, with AgentMailProvider skipped if no API key).

---

**Plan complete and saved to `docs/plans/2026-02-04-tui-vault-implementation.md`.**

Two execution options:

1. **Subagent‑Driven (this session)** — I dispatch a fresh subagent per task, review between tasks.
2. **Parallel Session (separate)** — Open a new session with executing‑plans.

Which approach?
