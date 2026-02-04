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
