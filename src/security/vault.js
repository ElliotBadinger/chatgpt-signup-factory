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
