import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheckArchiveAndReplace } from '../../../src/pipeline/rotation/checkArchiveAndReplaceExhausted.js';

let tmpDir, archivePath, poolPath, healthPath, routerPath, authPath;
let savedFetch;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-archive-test-'));
  archivePath = path.join(tmpDir, 'archive.json');
  poolPath    = path.join(tmpDir, 'pool.json');
  healthPath  = path.join(tmpDir, 'health.json');
  routerPath  = path.join(tmpDir, 'router.json');
  authPath    = path.join(tmpDir, 'auth.json');
  savedFetch  = global.fetch;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  global.fetch = savedFetch;
  jest.restoreAllMocks();
});

// ────────────────────────────── seed helpers ─────────────────────────────────────
function seed(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function makePoolEntry(address, status = 'available') {
  return {
    inboxAddress: address,
    agentMailInboxId: address,     // InboxID = address in AgentMail
    rootEmail: 'root@example.com',
    rootOrgId: 'org1',
    rootApiKey: 'am_us_testkey123456',  // full key (required by chatGptAccountCreator validation)
    rootApiKeyPrefix: 'am_us',
    cfRuleId: 'r1',
    cfKvNamespaceId: 'kv1',
    status,
    statusUpdatedAt: Date.now(),
  };
}

function makeHealthFile(aliasQuotas) {
  // aliasQuotas: { aliasId: fraction }
  const models = {};
  for (const [id, fraction] of Object.entries(aliasQuotas)) {
    models[`${id}/gpt-5.4`] = {
      quotaRemainingFraction: fraction,
      quotaProofAmbiguous: false,
      quotaCheckedAt: Date.now(),
    };
  }
  return { version: 1, providers: {}, models };
}

function makeRouterFile(aliasIds) {
  return {
    version: 1,
    aliases: aliasIds.map((id) => ({
      id, cloneFrom: 'openai-codex', apiKey: 'unused',
      email: `${id}@agentmail.to`, label: id, disabled: false,
    })),
    pools: [{
      name: 'openai-codex',
      providers: aliasIds,
      routes: aliasIds.map((id) => ({ provider: id, model: 'gpt-5.4' })),
    }],
    policy: {},
  };
}

function makeAuth(aliasIds) {
  const auth = {};
  for (const id of aliasIds) {
    auth[id] = { type: 'oauth', access: `tok_${id}`, refresh: `ref_${id}`, expires: 9999999999, accountId: `uid_${id}` };
  }
  return auth;
}

function emptyArchive() {
  return { version: 1, aliases: [] };
}

const noopLog = () => {};

// ─────────────────────────────── minimal deps ────────────────────────────────────
// Mock browser session that always returns a "happy" page.
// Matches the NEW 5-evaluate-call sequence in chatGptAccountCreator.js:
//   1. navigateToSignup → { alreadyRegistered, emailFilled, url }
//   2. checkPostSubmitState → { state: 'otp-needed', url }
//   3. fillOtpAndOnboard → { otpFilled, nameFilled }
//   4. clickAcceptInvite → { clicked, btnText }
//   5. getSessionToken → { accessToken, user, expires }
function happyPage({ otpCode = '123456', inviteLink = 'https://chatgpt.com/invitations/abc' } = {}) {
  let evaluateCall = 0;
  return {
    goto: jest.fn().mockResolvedValue({}),
    evaluate: jest.fn().mockImplementation(async () => {
      evaluateCall++;
      if (evaluateCall === 1) return null;  // eval-0: findSignupUrlScript → null (no redirect)
      if (evaluateCall === 2) return { alreadyRegistered: false, emailFilled: true, url: 'https://chatgpt.com/' };
      if (evaluateCall === 3) return { state: 'otp-needed', url: 'https://chatgpt.com/auth/verify' };
      if (evaluateCall === 4) return { otpFilled: true, nameFilled: false };
      if (evaluateCall === 5) return { clicked: true, btnText: 'Accept' };
      if (evaluateCall === 6) return {
        accessToken: 'new_access_tok',
        user: { id: 'new_uid_123' },
        expires: new Date(Date.now() + 3_600_000).toISOString(),
      };
      return {};
    }),
    waitForSelector: jest.fn().mockResolvedValue({ click: jest.fn() }),
    click: jest.fn(), type: jest.fn(),
    $: jest.fn().mockResolvedValue(null),
    $$: jest.fn().mockResolvedValue([]),
    url: jest.fn().mockReturnValue('https://chatgpt.com/'),
    waitForNavigation: jest.fn().mockResolvedValue({}),
    waitForFunction: jest.fn().mockResolvedValue({}),
    keyboard: { press: jest.fn().mockResolvedValue({}), type: jest.fn().mockResolvedValue({}) },
  };
}

function mockCreateBrowserSession(pageObj) {
  return jest.fn().mockResolvedValue({
    page: pageObj,
    browser: { close: jest.fn() },
    proc: { kill: jest.fn() },
    cleanup: jest.fn().mockResolvedValue({}),
  });
}

function mockFetch(otpCode = '123456', inviteLink = 'https://chatgpt.com/invitations/abc') {
  let call = 0;
  global.fetch = jest.fn().mockImplementation(async () => {
    call++;
    if (call === 1) {
      return { ok: true, json: async () => ({ messages: [{ subject: 'Verify', body: `${otpCode}`, receivedAt: Date.now() }] }) };
    }
    return { ok: true, json: async () => ({ messages: [{ subject: 'Invite', body: `invited you to join ${inviteLink}`, receivedAt: Date.now() }] }) };
  });
}

// ─────────────────────────────── TC-1 ────────────────────────────────────────────
describe('TC-1: no exhausted aliases → IDLE, zero changes', () => {
  test('returns exhaustedProcessed=0 and newAccountsCreated=0 when all healthy', async () => {
    seed(healthPath, makeHealthFile({ alias1: 0.9, alias2: 0.85 }));
    seed(routerPath, makeRouterFile(['alias1', 'alias2']));
    seed(authPath, makeAuth(['alias1', 'alias2']));
    seed(archivePath, emptyArchive());
    seed(poolPath, { version: 1, entries: [makePoolEntry('a@agentmail.to')], lastCheckedAt: 0, allEntriesExhausted: false });

    const createBrowserSession = jest.fn();
    const finalize = jest.fn();

    const result = await runCheckArchiveAndReplace({
      archivePath, poolPath, healthPath, routerPath, authPath,
      log: noopLog,
      createBrowserSession,
      finalize,
      teamDriver: { inviteTeamMember: jest.fn(), removeTeamMember: jest.fn() },
    });

    expect(result.exhaustedProcessed).toBe(0);
    expect(result.newAccountsCreated).toBe(0);
    expect(createBrowserSession).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────── TC-2 ────────────────────────────────────────────
describe('TC-2: archived alias has renewed quota → reinstated, no new account', () => {
  test('reinstates archive entry, does not create new account for exhausted alias', async () => {
    // One alias is exhausted in health
    seed(healthPath, makeHealthFile({ alias_exhausted: 0 }));
    seed(routerPath, makeRouterFile(['alias_exhausted']));
    seed(authPath, makeAuth(['alias_exhausted']));
    seed(poolPath, { version: 1, entries: [makePoolEntry('inbox@agentmail.to')], lastCheckedAt: 0, allEntriesExhausted: false });

    // Archive has an alias with renewed quota (will be reinstated)
    seed(archivePath, {
      version: 1,
      aliases: [{
        aliasId: 'renewed_alias',
        email: 'renewed@agentmail.to',
        cloneFrom: 'openai-codex',
        auth: { type: 'oauth', access: 'fresh_tok', refresh: 'r', expires: Date.now() + 3_600_000, accountId: 'uid_renewed' },
        archivedAt: Date.now() - 86_400_000,
        archivedReason: 'both-exhausted',
        quotaRemainingFraction: 0,
        reinstated: false,
        teamMemberStatus: 'active',
      }],
    });

    // probeQuota returns > 0.1 for the archived alias
    const finalize = jest.fn().mockResolvedValue({ ok: true, validation: 'ok' });
    const createBrowserSession = jest.fn();

    const result = await runCheckArchiveAndReplace({
      archivePath, poolPath, healthPath, routerPath, authPath,
      log: noopLog,
      _probeQuotaOverride: async () => 0.5,  // override so archive alias gets reinstated
      finalize,
      teamDriver: { inviteTeamMember: jest.fn(), removeTeamMember: jest.fn() },
      createBrowserSession,
    });

    expect(result.reinstated).toBeGreaterThanOrEqual(1);
    // Archive entry should now be marked reinstated
    const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    expect(archive.aliases[0].reinstated).toBe(true);
  });
});

// ─────────────────────────────── TC-3 ────────────────────────────────────────────
describe('TC-3: exhausted alias + available inbox → full rotation', () => {
  test('creates new account, archives old alias, marks inbox in-use', async () => {
    seed(healthPath, makeHealthFile({ alias1: 0 }));
    seed(routerPath, makeRouterFile(['alias1']));
    seed(authPath, makeAuth(['alias1']));
    seed(archivePath, emptyArchive());
    seed(poolPath, { version: 1, entries: [makePoolEntry('inbox@agentmail.to')], lastCheckedAt: 0, allEntriesExhausted: false });

    mockFetch();

    const page = happyPage();
    const finalize = jest.fn().mockResolvedValue({ ok: true, validation: 'ok' });
    const teamDriver = { inviteTeamMember: jest.fn().mockResolvedValue({}), removeTeamMember: jest.fn().mockResolvedValue({}) };

    const result = await runCheckArchiveAndReplace({
      archivePath, poolPath, healthPath, routerPath, authPath,
      log: noopLog,
      createBrowserSession: mockCreateBrowserSession(page),
      finalize,
      teamDriver,
      agentMailPollIntervalMs: 5,
      navigationDelayMs: 0,
      pageStateCheckRetries: 1,
      pageStateCheckIntervalMs: 5,
      agentMailTimeoutMs: 500,
    });

    expect(result.newAccountsCreated).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    // INV-2: old alias no longer in router
    const router = JSON.parse(fs.readFileSync(routerPath, 'utf8'));
    const codexProviders = router.pools.find((p) => p.name === 'openai-codex')?.providers ?? [];
    expect(codexProviders).not.toContain('alias1');

    // Archive should contain alias1
    const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    expect(archive.aliases.some((a) => a.aliasId === 'alias1')).toBe(true);

    // Pool inbox should now be in-use
    const pool = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
    const inbox = pool.entries.find((e) => e.inboxAddress === 'inbox@agentmail.to');
    expect(inbox.status).toBe('in-use');
  });
});

// ─────────────────────────────── TC-4 (handled by chatGptAccountCreator) ─────────
describe('TC-4: inbox already registered → mark chatgpt-used, try next', () => {
  test('marks first inbox chatgpt-used and tries second inbox', async () => {
    seed(healthPath, makeHealthFile({ alias1: 0 }));
    seed(routerPath, makeRouterFile(['alias1']));
    seed(authPath, makeAuth(['alias1']));
    seed(archivePath, emptyArchive());
    seed(poolPath, {
      version: 1,
      entries: [
        makePoolEntry('taken@agentmail.to'),    // already registered
        makePoolEntry('fresh@agentmail.to'),    // clean
      ],
      lastCheckedAt: 0,
      allEntriesExhausted: false,
    });

    // evaluate() call sequence (same page object accumulates calls across retries):
    // ── Inbox 1 ("taken"): 3 calls
    //    eval-0: findSignupUrl → null
    //    eval-1: fillEmail → { alreadyRegistered: true }  (pre-submit password detect)
    //    eval-2: handlePostSubmitState → { state: 'already-registered-no-code-option' }
    //            → throws NoEmailCodeOptionError → error includes 'NO_EMAIL_CODE_OPTION'
    //            → orchestrator marks inbox1 chatgpt-used, retries with inbox2
    //
    // ── Inbox 2 ("fresh"): 6 calls (happy path)
    //    eval-3: findSignupUrl → null
    //    eval-4: fillEmail → { alreadyRegistered: false, emailFilled: true }
    //    eval-5: handlePostSubmitState → { state: 'otp-needed' }
    //    eval-6: fillOtp → { otpFilled: true }
    //    eval-7: acceptInvite → { clicked: true }
    //    eval-8: session → { accessToken: 'tok_fresh', ... }
    //
    // NOTE: With password fallback, inbox-1 now has an extra call (eval-2b):
    //   call-4: buildFillPasswordScript → { passwordFilled: false } → throws NO_EMAIL_CODE_OPTION
    // So inbox-2 calls shift by 1 (start at call 5 instead of 4).
    let pageCall = 0;
    const page = {
      goto: jest.fn().mockResolvedValue({}),
      evaluate: jest.fn().mockImplementation(async () => {
        pageCall++;
        // Inbox 1 attempts (calls 1–4 → NO_EMAIL_CODE_OPTION after password fill fails)
        if (pageCall === 1) return null; // eval-0 findSignupUrl
        if (pageCall === 2) return { alreadyRegistered: true, emailFilled: false, url: 'https://chatgpt.com/' };
        if (pageCall === 3) return { state: 'already-registered-no-code-option', url: 'https://auth.openai.com/login' };
        if (pageCall === 4) return { passwordFilled: false }; // eval-2b: password fill fails → NO_EMAIL_CODE_OPTION
        // Inbox 2 happy path (calls 5–10)
        if (pageCall === 5) return null; // eval-0 findSignupUrl
        if (pageCall === 6) return { alreadyRegistered: false, emailFilled: true, url: 'https://auth.openai.com/' };
        if (pageCall === 7) return { state: 'otp-needed', url: 'https://auth.openai.com/verify' };
        if (pageCall === 8) return { otpFilled: true, nameFilled: false };
        if (pageCall === 9) return { clicked: true, btnText: 'Accept' };
        if (pageCall === 10) return {
          accessToken: 'tok_fresh',
          user: { id: 'uid_fresh' },
          expires: new Date(Date.now() + 3_600_000).toISOString(),
        };
        return {};
      }),
      waitForSelector: jest.fn().mockResolvedValue({ click: jest.fn() }),
      click: jest.fn(), type: jest.fn(),
      $: jest.fn().mockResolvedValue(null),
      $$: jest.fn().mockResolvedValue([]),
      url: jest.fn().mockReturnValue('https://chatgpt.com/'),
      waitForNavigation: jest.fn().mockResolvedValue({}),
    waitForFunction: jest.fn().mockResolvedValue({}),
    keyboard: { press: jest.fn().mockResolvedValue({}), type: jest.fn().mockResolvedValue({}) },
    };

    mockFetch();

    const result = await runCheckArchiveAndReplace({
      archivePath, poolPath, healthPath, routerPath, authPath,
      log: noopLog,
      createBrowserSession: mockCreateBrowserSession(page),
      finalize: jest.fn().mockResolvedValue({ ok: true, validation: 'ok' }),
      teamDriver: { inviteTeamMember: jest.fn().mockResolvedValue({}), removeTeamMember: jest.fn().mockResolvedValue({}) },
      agentMailPollIntervalMs: 5,
      navigationDelayMs: 0,
      pageStateCheckRetries: 1,
      pageStateCheckIntervalMs: 5,
      agentMailTimeoutMs: 500,
    });

    // first inbox should be chatgpt-used
    const pool = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
    const takenEntry = pool.entries.find((e) => e.inboxAddress === 'taken@agentmail.to');
    expect(takenEntry.status).toBe('chatgpt-used');
    // Should still succeed via the second inbox
    expect(result.newAccountsCreated).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────── TC-5 ────────────────────────────────────────────
describe('TC-5: pool exhausted → bootstrapNewRoot called', () => {
  test('calls bootstrapNewRoot and adds new inboxes when pool is empty', async () => {
    seed(healthPath, makeHealthFile({ alias1: 0 }));
    seed(routerPath, makeRouterFile(['alias1']));
    seed(authPath, makeAuth(['alias1']));
    seed(archivePath, emptyArchive());
    // All existing inboxes in-use
    seed(poolPath, { version: 1, entries: [makePoolEntry('used@agentmail.to', 'in-use')], lastCheckedAt: 0, allEntriesExhausted: false });

    const newInbox = makePoolEntry('fresh@agentmail.to', 'available');
    const bootstrapNewRoot = jest.fn().mockResolvedValue([newInbox]);

    mockFetch();

    const page = happyPage();

    const result = await runCheckArchiveAndReplace({
      archivePath, poolPath, healthPath, routerPath, authPath,
      log: noopLog,
      createBrowserSession: mockCreateBrowserSession(page),
      finalize: jest.fn().mockResolvedValue({ ok: true, validation: 'ok' }),
      teamDriver: { inviteTeamMember: jest.fn().mockResolvedValue({}), removeTeamMember: jest.fn().mockResolvedValue({}) },
      bootstrapNewRoot,
      agentMailPollIntervalMs: 5,
      navigationDelayMs: 0,
      pageStateCheckRetries: 1,
      pageStateCheckIntervalMs: 5,
      agentMailTimeoutMs: 500,
    });

    expect(bootstrapNewRoot).toHaveBeenCalledTimes(1);
    expect(result.newAccountsCreated).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────── TC-7 ────────────────────────────────────────────
describe('TC-7: finalize returns auth_invalid → mark inbox failed, count as failed', () => {
  test('marks inbox failed and increments failed counter', async () => {
    seed(healthPath, makeHealthFile({ alias1: 0 }));
    seed(routerPath, makeRouterFile(['alias1']));
    seed(authPath, makeAuth(['alias1']));
    seed(archivePath, emptyArchive());
    seed(poolPath, { version: 1, entries: [makePoolEntry('inbox@agentmail.to')], lastCheckedAt: 0, allEntriesExhausted: false });

    mockFetch();

    const result = await runCheckArchiveAndReplace({
      archivePath, poolPath, healthPath, routerPath, authPath,
      log: noopLog,
      createBrowserSession: mockCreateBrowserSession(happyPage()),
      finalize: jest.fn().mockResolvedValue({ ok: false, error: 'auth:forbidden' }),
      teamDriver: { inviteTeamMember: jest.fn().mockResolvedValue({}), removeTeamMember: jest.fn().mockResolvedValue({}) },
      agentMailPollIntervalMs: 5,
      navigationDelayMs: 0,
      pageStateCheckRetries: 1,
      pageStateCheckIntervalMs: 5,
      agentMailTimeoutMs: 500,
    });

    expect(result.failed).toBeGreaterThanOrEqual(1);
    // inbox should be marked failed
    const pool = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
    const inbox = pool.entries.find((e) => e.inboxAddress === 'inbox@agentmail.to');
    expect(inbox.status).toBe('failed');
    // archive should NOT have alias1 (rotation didn't complete)
    const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    expect(archive.aliases.some((a) => a.aliasId === 'alias1')).toBe(false);
  });
});

// ─────────────────────────────── dry-run ─────────────────────────────────────────
describe('dry-run mode', () => {
  test('makes no file writes and returns dryRun=true', async () => {
    seed(healthPath, makeHealthFile({ alias1: 0 }));
    seed(routerPath, makeRouterFile(['alias1']));
    seed(authPath, makeAuth(['alias1']));
    seed(archivePath, emptyArchive());
    seed(poolPath, { version: 1, entries: [makePoolEntry('inbox@agentmail.to')], lastCheckedAt: 0, allEntriesExhausted: false });

    const poolBefore    = fs.readFileSync(poolPath, 'utf8');
    const archiveBefore = fs.readFileSync(archivePath, 'utf8');
    const authBefore    = fs.readFileSync(authPath, 'utf8');

    const result = await runCheckArchiveAndReplace({
      dryRun: true,
      archivePath, poolPath, healthPath, routerPath, authPath,
      log: noopLog,
      createBrowserSession: jest.fn(),
      finalize: jest.fn(),
      teamDriver: { inviteTeamMember: jest.fn(), removeTeamMember: jest.fn() },
    });

    expect(result.dryRun).toBe(true);
    expect(fs.readFileSync(poolPath, 'utf8')).toBe(poolBefore);
    expect(fs.readFileSync(archivePath, 'utf8')).toBe(archiveBefore);
    expect(fs.readFileSync(authPath, 'utf8')).toBe(authBefore);
  });
});

// ─────────────────────── INV-9: no temp IDs remain ───────────────────────────────
describe('INV-9: no temp IDs remain after cycle', () => {
  test('auth.json has no temp- entries after successful rotation', async () => {
    seed(healthPath, makeHealthFile({ alias1: 0 }));
    seed(routerPath, makeRouterFile(['alias1']));
    seed(authPath, makeAuth(['alias1']));
    seed(archivePath, emptyArchive());
    seed(poolPath, { version: 1, entries: [makePoolEntry('inbox@agentmail.to')], lastCheckedAt: 0, allEntriesExhausted: false });

    mockFetch();

    await runCheckArchiveAndReplace({
      archivePath, poolPath, healthPath, routerPath, authPath,
      log: noopLog,
      createBrowserSession: mockCreateBrowserSession(happyPage()),
      finalize: jest.fn().mockResolvedValue({ ok: true, validation: 'ok' }),
      teamDriver: { inviteTeamMember: jest.fn().mockResolvedValue({}), removeTeamMember: jest.fn().mockResolvedValue({}) },
      agentMailPollIntervalMs: 5,
      navigationDelayMs: 0,
      pageStateCheckRetries: 1,
      pageStateCheckIntervalMs: 5,
      agentMailTimeoutMs: 500,
    });

    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    const tempIds = Object.keys(auth).filter((id) => id.startsWith('temp-'));
    expect(tempIds).toHaveLength(0);
  });
});

// ─────────────────────── INV-2: no alias in both router and archive ───────────────
describe('INV-2: retired alias not in router after archive', () => {
  test('alias1 removed from openai-codex pool after successful rotation', async () => {
    seed(healthPath, makeHealthFile({ alias1: 0 }));
    seed(routerPath, makeRouterFile(['alias1']));
    seed(authPath, makeAuth(['alias1']));
    seed(archivePath, emptyArchive());
    seed(poolPath, { version: 1, entries: [makePoolEntry('inbox@agentmail.to')], lastCheckedAt: 0, allEntriesExhausted: false });

    mockFetch();

    await runCheckArchiveAndReplace({
      archivePath, poolPath, healthPath, routerPath, authPath,
      log: noopLog,
      createBrowserSession: mockCreateBrowserSession(happyPage()),
      finalize: jest.fn().mockResolvedValue({ ok: true, validation: 'ok' }),
      teamDriver: { inviteTeamMember: jest.fn().mockResolvedValue({}), removeTeamMember: jest.fn().mockResolvedValue({}) },
      agentMailPollIntervalMs: 5,
      navigationDelayMs: 0,
      pageStateCheckRetries: 1,
      pageStateCheckIntervalMs: 5,
      agentMailTimeoutMs: 500,
    });

    const router = JSON.parse(fs.readFileSync(routerPath, 'utf8'));
    const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    const activeIds = new Set(router.aliases.map((a) => a.id));
    const archivedNonReinstated = archive.aliases.filter((a) => !a.reinstated).map((a) => a.aliasId);

    // No alias in both active router AND non-reinstated archive
    for (const id of archivedNonReinstated) {
      expect(activeIds.has(id)).toBe(false);
    }
  });
});

// ─────────────────────── Parallel execution ─────────────────────────────────────
describe('parallel execution (concurrency=2)', () => {
  test('creates N accounts in parallel; all succeed independently', async () => {
    // 3 exhausted aliases, 3 available inboxes, concurrency=2
    seed(healthPath, makeHealthFile({ a1: 0, a2: 0, a3: 0 }));
    seed(routerPath, makeRouterFile(['a1', 'a2', 'a3']));
    seed(authPath, makeAuth(['a1', 'a2', 'a3']));
    seed(archivePath, emptyArchive());
    seed(poolPath, {
      version: 1,
      entries: [
        makePoolEntry('i1@agentmail.to'),
        makePoolEntry('i2@agentmail.to'),
        makePoolEntry('i3@agentmail.to'),
      ],
      lastCheckedAt: 0, allEntriesExhausted: false,
    });

    // Each browser session gets its own independent page mock
    let sessionCount = 0;
    function makePage() {
      let ec = 0;
      return {
        goto: jest.fn().mockResolvedValue({}),
        evaluate: jest.fn().mockImplementation(async () => {
          ec++;
          if (ec === 1) return null;
          if (ec === 2) return { alreadyRegistered: false, emailFilled: true, url: 'x' };
          if (ec === 3) return { state: 'otp-needed', url: 'x' };
          if (ec === 4) return { otpFilled: true, nameFilled: false };
          if (ec === 5) return { clicked: true, btnText: 'Accept' };
          if (ec === 6) return { accessToken: `tok_session_${sessionCount}`, user: { id: `uid_${ec}` }, expires: new Date(Date.now() + 3_600_000).toISOString() };
          return {};
        }),
        waitForSelector: jest.fn().mockResolvedValue({ click: jest.fn() }),
        click: jest.fn(), waitForNavigation: jest.fn().mockResolvedValue({}),
    waitForFunction: jest.fn().mockResolvedValue({}),
    keyboard: { press: jest.fn().mockResolvedValue({}), type: jest.fn().mockResolvedValue({}) },
        url: jest.fn().mockReturnValue('https://chatgpt.com/'),
        $: jest.fn().mockResolvedValue(null), $$: jest.fn().mockResolvedValue([]),
      };
    }

    // For parallel tests: always return OTP first, then invite.
    // Multiple concurrent sessions all need their own OTP + invite messages.
    global.fetch = jest.fn().mockImplementation(async (url) => {
      // Any /messages call returns OTP first, then invite — independent per call
      // (inboxId is in the URL, so each session gets its own sequence)
      const inboxCallKey = url;
      if (!global._fetchCallMap) global._fetchCallMap = new Map();
      const n = (global._fetchCallMap.get(inboxCallKey) ?? 0) + 1;
      global._fetchCallMap.set(inboxCallKey, n);
      if (n === 1) return { ok: true, json: async () => ({ messages: [{ subject: 'Verify', body: '123456', receivedAt: Date.now() }] }) };
      return { ok: true, json: async () => ({ messages: [{ subject: 'Invite', body: 'invited you to join https://chatgpt.com/invitations/a', receivedAt: Date.now() }] }) };
    });

    const createBrowserSession = jest.fn().mockImplementation(async () => {
      sessionCount++;
      return { page: makePage(), cleanup: jest.fn().mockResolvedValue({}) };
    });

    const result = await runCheckArchiveAndReplace({
      archivePath, poolPath, healthPath, routerPath, authPath,
      log: noopLog,
      createBrowserSession,
      finalize: jest.fn().mockResolvedValue({ ok: true, validation: 'ok' }),
      teamDriver: { inviteTeamMember: jest.fn().mockResolvedValue({}), removeTeamMember: jest.fn().mockResolvedValue({}) },
      agentMailPollIntervalMs: 5,
      navigationDelayMs: 0,
      pageStateCheckRetries: 1,
      pageStateCheckIntervalMs: 5,
      agentMailTimeoutMs: 500,
      concurrency: 2,
    });

    expect(result.newAccountsCreated).toBe(3);
    expect(result.failed).toBe(0);

    // Each of a1, a2, a3 should be archived
    const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    expect(archive.aliases.map((a) => a.aliasId).sort()).toEqual(['a1', 'a2', 'a3']);

    // All 3 inboxes should be in-use
    const pool = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
    expect(pool.entries.every((e) => e.status === 'in-use')).toBe(true);
  });
});

// ─────────────── already-onboarded inbox detected in router ──────────────────────
describe('already-onboarded inbox skipped when email in router', () => {
  test('inbox email already in router → skipped, other aliases still processed', async () => {
    seed(healthPath, makeHealthFile({ alias1: 0, alias2: 0 }));
    // alias2@agentmail.to email is also the inboxAddress we'd assign
    seed(routerPath, {
      version: 1,
      aliases: [
        { id: 'alias1', cloneFrom: 'openai-codex', email: 'alias1@agentmail.to', apiKey: 'x', disabled: false },
        { id: 'alias2', cloneFrom: 'openai-codex', email: 'alias2@agentmail.to', apiKey: 'x', disabled: false },
        // already onboarded with same address as inbox
        { id: 'existing', cloneFrom: 'openai-codex', email: 'i1@agentmail.to', apiKey: 'x', disabled: false },
      ],
      pools: [{ name: 'openai-codex', providers: ['alias1','alias2','existing'], routes: [] }],
      policy: {},
    });
    seed(authPath, makeAuth(['alias1', 'alias2']));
    seed(archivePath, emptyArchive());
    seed(poolPath, {
      version: 1,
      entries: [
        makePoolEntry('i1@agentmail.to'),  // i1 email IS already in router above → will be skipped
        makePoolEntry('i2@agentmail.to'),  // i2 is fresh
        makePoolEntry('i3@agentmail.to'),  // spare
      ],
      lastCheckedAt: 0, allEntriesExhausted: false,
    });

    // Use per-call fetch: each inbox URL gets its own OTP→invite sequence
    global.fetch = jest.fn().mockImplementation(async (url) => {
      if (!global._aaFetchMap) global._aaFetchMap = new Map();
      const n = (global._aaFetchMap.get(url) ?? 0) + 1;
      global._aaFetchMap.set(url, n);
      if (n === 1) return { ok: true, json: async () => ({ messages: [{ subject: 'V', body: '654321', receivedAt: Date.now() }] }) };
      return { ok: true, json: async () => ({ messages: [{ subject: 'I', body: 'invited you to join https://chatgpt.com/invitations/b', receivedAt: Date.now() }] }) };
    });

    // Each browser session gets a fresh page mock so call counts don't interfere
    const createBrowserSession = jest.fn().mockImplementation(async () => ({
      page: happyPage(), cleanup: jest.fn().mockResolvedValue({}),
    }));

    const result = await runCheckArchiveAndReplace({
      archivePath, poolPath, healthPath, routerPath, authPath,
      log: noopLog,
      createBrowserSession,
      finalize: jest.fn().mockResolvedValue({ ok: true, validation: 'ok' }),
      teamDriver: { inviteTeamMember: jest.fn().mockResolvedValue({}), removeTeamMember: jest.fn().mockResolvedValue({}) },
      agentMailPollIntervalMs: 5,
      navigationDelayMs: 0,
      pageStateCheckRetries: 1,
      pageStateCheckIntervalMs: 5,
      agentMailTimeoutMs: 500,
    });

    // Pool: i1 should end up chatgpt-used; at least one account created
    const pool = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
    const i1 = pool.entries.find((e) => e.inboxAddress === 'i1@agentmail.to');
    expect(i1.status).toBe('chatgpt-used');
    expect(result.newAccountsCreated).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────── Fail-fast ───────────────────────────────────────
describe('failFast: abort entire pipeline on first account creation failure', () => {
  test('failFast=true: throws RotationError on first alias failure, second alias NOT attempted', async () => {
    seed(healthPath, makeHealthFile({ alias1: 0.0, alias2: 0.0 }));
    seed(routerPath, makeRouterFile(['alias1', 'alias2']));
    seed(authPath, makeAuth(['alias1', 'alias2']));
    seed(archivePath, emptyArchive());
    seed(poolPath, {
      version: 1,
      entries: [makePoolEntry('i1@agentmail.to'), makePoolEntry('i2@agentmail.to')],
      lastCheckedAt: 0, allEntriesExhausted: false,
    });

    // Always fail — browser session itself throws
    const createBrowserSession = jest.fn().mockRejectedValue(new Error('Chrome launch failed'));

    await expect(
      runCheckArchiveAndReplace({
        archivePath, poolPath, healthPath, routerPath, authPath,
        log: noopLog,
        failFast: true,
        createBrowserSession,
        finalize: jest.fn(),
        agentMailPollIntervalMs: 5,
        navigationDelayMs: 0,
        pageStateCheckRetries: 1,
        pageStateCheckIntervalMs: 5,
        agentMailTimeoutMs: 100,
        concurrency: 1,
      })
    ).rejects.toThrow();

    // Only ONE browser session was attempted (alias1), not two (alias2 was aborted)
    expect(createBrowserSession.mock.calls.length).toBe(1);
  });

  test('failFast=false (default): continues after first failure, both aliases attempted', async () => {
    seed(healthPath, makeHealthFile({ alias1: 0.0, alias2: 0.0 }));
    seed(routerPath, makeRouterFile(['alias1', 'alias2']));
    seed(authPath, makeAuth(['alias1', 'alias2']));
    seed(archivePath, emptyArchive());
    seed(poolPath, {
      version: 1,
      entries: [makePoolEntry('i1@agentmail.to'), makePoolEntry('i2@agentmail.to')],
      lastCheckedAt: 0, allEntriesExhausted: false,
    });

    const createBrowserSession = jest.fn().mockRejectedValue(new Error('Chrome launch failed'));

    // Should NOT throw — just return summary with failed=2
    const result = await runCheckArchiveAndReplace({
      archivePath, poolPath, healthPath, routerPath, authPath,
      log: noopLog,
      failFast: false,
      createBrowserSession,
      finalize: jest.fn(),
      agentMailPollIntervalMs: 5,
      navigationDelayMs: 0,
      pageStateCheckRetries: 1,
      pageStateCheckIntervalMs: 5,
      agentMailTimeoutMs: 100,
      concurrency: 1,
    });

    expect(result.failed).toBe(2);
    // Both aliases were attempted
    expect(createBrowserSession.mock.calls.length).toBe(2);
  });
});
