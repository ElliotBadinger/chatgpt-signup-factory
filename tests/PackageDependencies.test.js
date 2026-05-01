import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

test('runtime dependencies include required external modules', () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const packagePath = resolve(testDir, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));

  expect(pkg.dependencies).toHaveProperty('node-fetch');
  expect(pkg.dependencies).toHaveProperty('@puppeteer/browsers');
});
