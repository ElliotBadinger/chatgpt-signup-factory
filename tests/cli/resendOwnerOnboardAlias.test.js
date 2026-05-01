import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { nextAliasEmail, selectWorkspace } from '../../src/cli/resend-owner-onboard-alias.js';

describe('resend owner CLI dependency boundary', () => {
  test('uses the browserless router onboarding module directly', () => {
    const source = fs.readFileSync(path.resolve('src/cli/resend-owner-onboard-alias.js'), 'utf8');

    expect(source).toMatch(/browserlessRouterOnboarder\.js/);
    expect(source).not.toMatch(/routerOnboarder\.js/);
  });
});

describe('resend owner alias allocation', () => {
  test('skips active, authenticated, and archived aliases', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resend-owner-alias-'));
    const routerJsonPath = path.join(tmpDir, 'account-router.json');
    const authJsonPath = path.join(tmpDir, 'auth.json');
    const archiveJsonPath = path.join(tmpDir, 'codex-alias-archive.json');

    fs.writeFileSync(routerJsonPath, JSON.stringify({
      version: 1,
      aliases: [
        { id: 'openai_1', email: 'openai_1@epistemophile.store' },
      ],
      pools: [],
    }));
    fs.writeFileSync(authJsonPath, JSON.stringify({
      openai_1: { type: 'oauth', access: 'owner' },
      openai_4: { type: 'oauth', access: 'stale-active-auth' },
    }));
    fs.writeFileSync(archiveJsonPath, JSON.stringify({
      version: 1,
      aliases: [
        { aliasId: 'openai_2', email: 'openai_2@epistemophile.store', reinstated: false },
        { aliasId: 'openai_3', email: 'openai_3@epistemophile.store', reinstated: false },
      ],
    }));

    expect(nextAliasEmail({
      routerJsonPath,
      authJsonPath,
      archiveJsonPath,
      prefix: 'openai',
      domain: 'epistemophile.store',
    })).toBe('openai_5@epistemophile.store');
  });

  test('skips workspace users supplied by the live owner check', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resend-owner-alias-'));
    const routerJsonPath = path.join(tmpDir, 'account-router.json');
    const authJsonPath = path.join(tmpDir, 'auth.json');
    const archiveJsonPath = path.join(tmpDir, 'codex-alias-archive.json');

    fs.writeFileSync(routerJsonPath, JSON.stringify({
      version: 1,
      aliases: [
        { id: 'openai_1', email: 'openai_1@epistemophile.store' },
        { id: 'openai_2', email: 'openai_2@epistemophile.store' },
      ],
      pools: [],
    }));
    fs.writeFileSync(authJsonPath, JSON.stringify({}));
    fs.writeFileSync(archiveJsonPath, JSON.stringify({ version: 1, aliases: [] }));

    expect(nextAliasEmail({
      routerJsonPath,
      authJsonPath,
      archiveJsonPath,
      prefix: 'openai',
      domain: 'epistemophile.store',
      extraReservedEmails: [
        'openai_3@epistemophile.store',
        'openai_4@epistemophile.store',
        'openai_5@epistemophile.store',
      ],
    })).toBe('openai_6@epistemophile.store');
  });
});

describe('resend owner workspace selection', () => {
  test('requires explicit workspace name when owner account has multiple workspaces', () => {
    expect(() => selectWorkspace({
      items: [
        { id: 'workspace-a', structure: 'workspace', name: 'A' },
        { id: 'workspace-b', structure: 'workspace', name: 'B' },
      ],
    })).toThrow(/multiple workspace/i);
  });

  test('selects the named workspace when multiple workspaces exist', () => {
    expect(selectWorkspace({
      items: [
        { id: 'workspace-a', structure: 'workspace', name: 'A' },
        { id: 'workspace-b', structure: 'workspace', name: 'B' },
      ],
    }, { workspaceName: 'B' })).toEqual(expect.objectContaining({
      id: 'workspace-b',
      name: 'B',
    }));
  });
});
