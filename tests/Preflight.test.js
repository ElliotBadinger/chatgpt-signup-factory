import { runPreflight } from '../src/tui/preflight.js';

test('preflight returns structured checks and ok=false when env missing', () => {
  const result = runPreflight({ env: {}, artifactsDir: '/tmp' });
  expect(result.ok).toBe(false);
  expect(result.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'env.agentmail', ok: false })
    ])
  );
});

test('preflight returns ok=false when artifactsDir is missing', () => {
  const result = runPreflight({ env: { AGENTMAIL_API_KEY: 'abc' } });
  expect(result.ok).toBe(false);
  expect(result.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'fs.artifacts', ok: false })
    ])
  );
});

test('preflight returns ok=true when env and artifactsDir are valid', () => {
  const result = runPreflight({ 
    env: { AGENTMAIL_API_KEY: 'sk-test' }, 
    artifactsDir: '/tmp' 
  });
  expect(result.ok).toBe(true);
  expect(result.checks.every(c => c.ok)).toBe(true);
});

test('preflight respects fsImpl for artifacts check', () => {
  const fsMock = {
    existsSync: () => true,
    accessSync: () => { throw new Error('no access'); },
    constants: { W_OK: 2 }
  };
  const result = runPreflight({ 
    env: { AGENTMAIL_API_KEY: 'sk-test' }, 
    artifactsDir: '/protected',
    fsImpl: fsMock
  });
  expect(result.ok).toBe(false);
  expect(result.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'fs.artifacts', ok: false })
    ])
  );
});
