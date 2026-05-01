import { describe, expect, jest, test } from '@jest/globals';

import { launchMitmproxy } from '../../../src/pipeline/authTrace/deepCapture/launchMitmproxy.js';

describe('launchMitmproxy', () => {
  test('spawns mitmdump with addon and output file paths', async () => {
    const child = { once: jest.fn((event, cb) => { if (event === 'spawn') cb(); }), kill: jest.fn() };
    const spawn = jest.fn(() => child);

    const result = await launchMitmproxy({
      port: 8899,
      addonPath: '/tmp/mitm-addon.py',
      flowsPath: '/tmp/flows.jsonl',
    }, { spawn });

    expect(spawn).toHaveBeenCalledWith(
      'mitmdump',
      expect.arrayContaining(['-p', '8899', '-s', '/tmp/mitm-addon.py', '--set', 'pi_flows_path=/tmp/flows.jsonl']),
      expect.any(Object),
    );
    await result.cleanup();
    expect(child.kill).toHaveBeenCalled();
  });
});
