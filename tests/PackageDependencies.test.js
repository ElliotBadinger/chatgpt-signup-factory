import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

test('node-fetch is declared as a runtime dependency', () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const packagePath = resolve(testDir, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));

  expect(pkg.dependencies).toHaveProperty('node-fetch');
});
