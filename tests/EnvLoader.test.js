import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnv } from '../src/config/envLoader.js';

describe('loadEnv', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const key of Object.keys(originalEnv)) {
      process.env[key] = originalEnv[key];
    }
  });

  test('prefers config directory .env when present', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'env-root-'));
    const configDir = mkdtempSync(join(tmpdir(), 'env-config-'));
    const rootKey = `ROOT_ONLY_${Date.now()}`;
    const configKey = `CONFIG_ONLY_${Date.now()}`;

    writeFileSync(join(rootDir, '.env'), `${rootKey}=root-value\n`, 'utf8');
    writeFileSync(join(configDir, '.env'), `${configKey}=config-value\n`, 'utf8');

    loadEnv({ configPath: join(configDir, 'config.yaml'), cwd: rootDir });

    expect(process.env[configKey]).toBe('config-value');
    expect(process.env[rootKey]).toBeUndefined();

    rmSync(rootDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  test('falls back to cwd .env when config directory has none', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'env-root-'));
    const configDir = mkdtempSync(join(tmpdir(), 'env-config-'));
    const rootKey = `ROOT_ONLY_${Date.now()}`;

    writeFileSync(join(rootDir, '.env'), `${rootKey}=root-value\n`, 'utf8');

    loadEnv({ configPath: join(configDir, 'config.yaml'), cwd: rootDir });

    expect(process.env[rootKey]).toBe('root-value');

    rmSync(rootDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });
});
