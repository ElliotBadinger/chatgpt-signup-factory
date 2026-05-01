import { describe, test, expect } from '@jest/globals';

import { createConfiguredCodexLbStore } from '../../../src/pipeline/rotation/codexLbLocalImportClient.js';

describe('createConfiguredCodexLbStore', () => {
  test('prefers the codex-lb-local import client when explicit importer env is configured', () => {
    const store = createConfiguredCodexLbStore({
      env: {
        CODEX_LB_LOCAL_BASE_URL: 'http://127.0.0.1:8765',
        CODEX_LB_LOCAL_DASHBOARD_SESSION: 'session-123',
      },
      fetchImpl: async () => {
        throw new Error('not reached');
      },
    });

    expect(store).toEqual(expect.objectContaining({
      storePath: null,
      importMode: 'codex-lb-local',
    }));
    expect(store.getStatus()).toEqual(expect.objectContaining({
      ready: true,
      reason: null,
      importMode: 'codex-lb-local',
    }));
  });
});