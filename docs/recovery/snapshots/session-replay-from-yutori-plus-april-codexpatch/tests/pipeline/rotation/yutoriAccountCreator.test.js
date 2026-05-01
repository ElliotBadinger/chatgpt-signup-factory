/**
 * tests/pipeline/rotation/yutoriAccountCreator.test.js
 *
 * TDD suite for yutoriAccountCreator.js (v3)
 * All HTTP calls are intercepted via globalThis.fetch mock — zero real API traffic.
 */

import {
  buildProxyUrl,
  buildBrowsingTask,
  pollTaskUntilDone,
  extractAuthFromResult,
  createAccountViaYutori,
} from '../../../src/pipeline/rotation/yutoriAccountCreator.js';

import { YutoriTimeoutError } from '../../../src/pipeline/rotation/errors.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_OPTS = {
  email:             'test@agentmail.to',
  agentMailApiKey:   'am_us_testkey123',
  agentMailInboxId:  'test@agentmail.to',
  yutoriApiKey:      'yt_testkey456',
  name:              'Codex Agent',
};

const MOCK_SESSION = {
  accessToken:  'eyJtest.access.token',
  refreshToken: 'eyJtest.refresh.token',
  expires:      '2026-04-01T00:00:00.000Z',
  user:         { id: 'user-abc123', email: 'test@agentmail.to' },
};

const MOCK_TASK_QUEUED   = { task_id: 'task-001', status: 'queued' };
const MOCK_TASK_RUNNING  = { task_id: 'task-001', status: 'running' };
const MOCK_TASK_SUCCEEDED = { task_id: 'task-001', status: 'succeeded', output: MOCK_SESSION };
const MOCK_TASK_FAILED   = { task_id: 'task-001', status: 'failed', error: 'Cloudflare blocked' };

// ─── fetch mock helper ─────────────────────────────────────────────────────────

function mockFetch(responses) {
  let idx = 0;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const resp = responses[idx] ?? responses[responses.length - 1];
    idx++;
    if (resp instanceof Error) throw resp;
    return {
      ok:     resp.ok ?? true,
      status: resp.status ?? 200,
      json:   async () => resp.body,
      text:   async () => JSON.stringify(resp.body),
    };
  };
  return calls;
}

// ─── buildProxyUrl ─────────────────────────────────────────────────────────────

describe('buildProxyUrl', () => {
  test('returns a Cloudflare Worker HTTPS URL', () => {
    const url = buildProxyUrl('inbox@agentmail.to', 'am_us_key');
    expect(url).toMatch(/^https:\/\/otp-proxy\.windsurf-epistemophile\.workers\.dev\/otp\//);
  });

  test('includes inbox ID in the URL path', () => {
    const url = buildProxyUrl('inbox123@agentmail.to', 'am_us_key');
    expect(url).toContain('inbox123%40agentmail.to');
  });

  test('includes base64-encoded API key as k param', () => {
    const url = buildProxyUrl('inbox@agentmail.to', 'am_us_secretkey999');
    const keyParam = new URL(url).searchParams.get('k');
    expect(keyParam).toBeTruthy();
    // Decode and verify it round-trips
    const decoded = Buffer.from(keyParam, 'base64').toString('utf-8');
    expect(decoded).toBe('am_us_secretkey999');
  });
});

// ─── buildBrowsingTask ─────────────────────────────────────────────────────────

describe('buildBrowsingTask', () => {
  test('embeds the email in the task string', () => {
    const { task } = buildBrowsingTask(BASE_OPTS);
    expect(task).toContain(BASE_OPTS.email);
  });

  test('embeds the proxy URL (containing inboxId) in the task string', () => {
    const { task } = buildBrowsingTask(BASE_OPTS);
    expect(task).toContain('otp-proxy.windsurf-epistemophile.workers.dev');
  });

  test('includes the fixed account password in the task string', () => {
    const { task } = buildBrowsingTask(BASE_OPTS);
    expect(task).toContain('C0dexAg3nt!2025');
  });

  test('explains that password fields show dots', () => {
    const { task } = buildBrowsingTask(BASE_OPTS);
    expect(task).toMatch(/dots|●/i);
  });

  test('output_schema requires accessToken', () => {
    const { output_schema } = buildBrowsingTask(BASE_OPTS);
    expect(output_schema.required).toContain('accessToken');
    expect(output_schema.properties.accessToken.type).toBe('string');
  });

  test('sets max_steps to 75 and uses navigator-n1-latest agent', () => {
    const result = buildBrowsingTask(BASE_OPTS);
    expect(result.max_steps).toBe(75);
    expect(result.agent).toBe('navigator-n1-latest');
  });

  test('start_url is auth.openai.com/log-in-or-create-account (forces OTP flow)', () => {
    const { start_url } = buildBrowsingTask(BASE_OPTS);
    expect(start_url).toBe('https://auth.openai.com/log-in-or-create-account');
  });

  test('proxy URL appears at least twice in the task (OTP + invite)', () => {
    const { task } = buildBrowsingTask(BASE_OPTS);
    const count = (task.match(/otp-proxy\.windsurf-epistemophile/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

// ─── pollTaskUntilDone ─────────────────────────────────────────────────────────

describe('pollTaskUntilDone', () => {
  afterEach(() => { delete globalThis.fetch; });

  test('resolves immediately when first poll returns succeeded', async () => {
    mockFetch([{ body: MOCK_TASK_SUCCEEDED }]);
    const result = await pollTaskUntilDone('task-001', 'yt_key', { pollIntervalMs: 10, timeoutMs: 5000 });
    expect(result.status).toBe('succeeded');
  });

  test('resolves with failed result (does not throw) when task fails', async () => {
    mockFetch([{ body: MOCK_TASK_FAILED }]);
    const result = await pollTaskUntilDone('task-001', 'yt_key', { pollIntervalMs: 10, timeoutMs: 5000 });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Cloudflare');
  });

  test('polls multiple times before task succeeds', async () => {
    const calls = mockFetch([
      { body: MOCK_TASK_QUEUED },
      { body: MOCK_TASK_RUNNING },
      { body: MOCK_TASK_SUCCEEDED },
    ]);
    const result = await pollTaskUntilDone('task-001', 'yt_key', { pollIntervalMs: 10, timeoutMs: 5000 });
    expect(result.status).toBe('succeeded');
    expect(calls.length).toBe(3);
  });

  test('throws YutoriTimeoutError when deadline exceeded', async () => {
    mockFetch([{ body: MOCK_TASK_RUNNING }]);
    await expect(
      pollTaskUntilDone('task-001', 'yt_key', { pollIntervalMs: 10, timeoutMs: 50 })
    ).rejects.toBeInstanceOf(YutoriTimeoutError);
  });

  test('sends correct Authorization header on each poll', async () => {
    const calls = mockFetch([{ body: MOCK_TASK_SUCCEEDED }]);
    await pollTaskUntilDone('task-001', 'yt_apikey', { pollIntervalMs: 10, timeoutMs: 5000 });
    const hdr = calls[0].init?.headers;
    expect(hdr?.['X-API-Key'] ?? hdr?.['Authorization']).toBeDefined();
  });
});

// ─── extractAuthFromResult ─────────────────────────────────────────────────────

describe('extractAuthFromResult', () => {
  test('parses accessToken, refreshToken, expires, and user.id from output', () => {
    const auth = extractAuthFromResult(MOCK_TASK_SUCCEEDED);
    expect(auth).not.toBeNull();
    expect(auth.access).toBe(MOCK_SESSION.accessToken);
    expect(auth.refresh).toBe(MOCK_SESSION.refreshToken);
    expect(auth.expires).toBeGreaterThan(Date.now());
    expect(auth.accountId).toBe(MOCK_SESSION.user.id);
    expect(auth.type).toBe('oauth');
  });

  test('returns null when output is missing accessToken', () => {
    const badResult = { task_id: 'x', status: 'succeeded', output: { user: {} } };
    expect(extractAuthFromResult(badResult)).toBeNull();
  });

  test('returns null when result has no output', () => {
    expect(extractAuthFromResult(MOCK_TASK_FAILED)).toBeNull();
  });

  test('handles missing refreshToken gracefully (sets null)', () => {
    const result = { status: 'succeeded', output: { accessToken: 'abc', expires: '2026-01-01', user: { id: 'u1' } } };
    const auth = extractAuthFromResult(result);
    expect(auth.refresh).toBeNull();
  });
});

// ─── createAccountViaYutori ────────────────────────────────────────────────────

describe('createAccountViaYutori', () => {
  afterEach(() => { delete globalThis.fetch; });

  test('success path: creates task, polls to completion, returns auth', async () => {
    mockFetch([
      { status: 201, body: MOCK_TASK_QUEUED },
      { body: MOCK_TASK_SUCCEEDED },
    ]);
    const result = await createAccountViaYutori({ ...BASE_OPTS, pollIntervalMs: 10, taskTimeoutMs: 5000 });
    expect(result.success).toBe(true);
    expect(result.auth.access).toBe(MOCK_SESSION.accessToken);
    expect(result.auth.type).toBe('oauth');
  });

  test('calls teamInviteCallback with email before launching task', async () => {
    mockFetch([
      { status: 201, body: MOCK_TASK_QUEUED },
      { body: MOCK_TASK_SUCCEEDED },
    ]);
    const inviteCalls = [];
    await createAccountViaYutori({
      ...BASE_OPTS,
      teamInviteCallback: async (e) => { inviteCalls.push(e); },
      pollIntervalMs: 10, taskTimeoutMs: 5000,
    });
    expect(inviteCalls).toEqual([BASE_OPTS.email]);
  });

  test('returns success:false when browsing task fails', async () => {
    mockFetch([
      { status: 201, body: MOCK_TASK_QUEUED },
      { body: MOCK_TASK_FAILED },
    ]);
    const result = await createAccountViaYutori({ ...BASE_OPTS, pollIntervalMs: 10, taskTimeoutMs: 5000 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cloudflare');
  });

  test('returns success:false on HTTP error from POST', async () => {
    mockFetch([{ ok: false, status: 401, body: { error: 'Unauthorized' } }]);
    const result = await createAccountViaYutori({ ...BASE_OPTS, pollIntervalMs: 10, taskTimeoutMs: 5000 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/401|Unauthorized/i);
  });

  test('retries POST on network failure (fetch failed) up to 3 times', async () => {
    // First 2 calls throw, 3rd returns success
    const calls = mockFetch([
      new Error('ECONNREFUSED'),
      new Error('ECONNREFUSED'),
      { status: 201, body: MOCK_TASK_QUEUED },
      { body: MOCK_TASK_SUCCEEDED },
    ]);
    const result = await createAccountViaYutori({ ...BASE_OPTS, pollIntervalMs: 10, taskTimeoutMs: 5000 });
    expect(result.success).toBe(true);
    // POST was attempted 3 times (2 failures + 1 success) + 1 poll
    expect(calls.filter(c => String(c.url).includes('/browsing/tasks') && !String(c.url).includes('task-001')).length).toBe(3);
  });

  test('returns success:false when all POST retries exhausted', async () => {
    mockFetch([
      new Error('ECONNREFUSED'),
      new Error('ECONNREFUSED'),
      new Error('ECONNREFUSED'),
    ]);
    const result = await createAccountViaYutori({ ...BASE_OPTS, pollIntervalMs: 10, taskTimeoutMs: 5000 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED|network/i);
  });

  test('returns success:false when no accessToken in succeeded output', async () => {
    mockFetch([
      { status: 201, body: MOCK_TASK_QUEUED },
      { body: { task_id: 'task-001', status: 'succeeded', output: { user: { id: 'x' } } } },
    ]);
    const result = await createAccountViaYutori({ ...BASE_OPTS, pollIntervalMs: 10, taskTimeoutMs: 5000 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/accessToken/i);
  });

  test('validates required opts — throws TypeError on missing email', async () => {
    const { email: _drop, ...noEmail } = BASE_OPTS;
    await expect(createAccountViaYutori({ ...noEmail, pollIntervalMs: 10, taskTimeoutMs: 5000 }))
      .rejects.toBeInstanceOf(TypeError);
  });

  test('validates required opts — throws TypeError on missing yutoriApiKey', async () => {
    const { yutoriApiKey: _drop, ...noKey } = BASE_OPTS;
    await expect(createAccountViaYutori({ ...noKey, pollIntervalMs: 10, taskTimeoutMs: 5000 }))
      .rejects.toBeInstanceOf(TypeError);
  });
});
