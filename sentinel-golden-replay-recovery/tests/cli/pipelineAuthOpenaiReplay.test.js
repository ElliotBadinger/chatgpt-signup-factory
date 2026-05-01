import { describe, expect, test } from '@jest/globals';

import { parseOpenAiReplayArgs } from '../../src/cli/pipeline-auth-openai-replay.js';

describe('parseOpenAiReplayArgs', () => {
  test('parses trace dir, email, mode, artifact dir, pool path, root api key, and create-new-inbox flag', () => {
    const args = parseOpenAiReplayArgs([
      '--trace-dir', '/tmp/trace',
      '--email', 'test.user@agentmail.to',
      '--mode', 'signup-new',
      '--artifact-dir', '/tmp/artifacts',
      '--pool-path', '/tmp/pool.json',
      '--root-api-key', 'am_us_testkey123',
      '--create-new-inbox',
      '--inbox-display-name', 'OpenAI Signup Replay',
    ]);

    expect(args.traceDir).toBe('/tmp/trace');
    expect(args.email).toBe('test.user@agentmail.to');
    expect(args.mode).toBe('signup-new');
    expect(args.artifactDir).toBe('/tmp/artifacts');
    expect(args.poolPath).toBe('/tmp/pool.json');
    expect(args.rootApiKey).toBe('am_us_testkey123');
    expect(args.createNewInbox).toBe(true);
    expect(args.inboxDisplayName).toBe('OpenAI Signup Replay');
  });
});
