# OpenAI / ChatGPT Auth Endpoint Cataloger — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the captured `deep-golden-signup-v2` trace artifacts into a normalized backend auth map with explicit replayability verdicts, advancing the question "can this flow be driven without a browser?"

**Architecture:** Pure offline analysis layer (`src/pipeline/authTrace/`) + CLI (`src/cli/pipeline-auth-catalog.js`). Phase A: standalone analyzer. Phase B: wire into runAuthTrace. All functions pure (no browser, no I/O) except the loader and CLI.

**Tech Stack:** Node.js ESM, Jest, existing authTrace artifact format.

**Test command (focused):**
```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --testPathPattern="authTrace|pipelineAuthCatalog" --runInBand
```

**Test command (full suite):**
```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --runInBand
```

---

### Task 1: traceArtifactLoader — load and order trace pairs

**Files:**
- Create: `src/pipeline/authTrace/traceArtifactLoader.js`
- Create: `tests/pipeline/authTrace/traceArtifactLoader.test.js`

**Step 1: Write the failing test**

```js
// tests/pipeline/authTrace/traceArtifactLoader.test.js
import { describe, expect, test } from '@jest/globals';
import { loadTracePairs, loadCookieDiffs, loadCheckpoints } from '../../../src/pipeline/authTrace/traceArtifactLoader.js';
import path from 'node:path';

const FIXTURE_DIR = path.resolve('artifacts/auth-traces/2026-03-15T20-01-44-099Z-deep-golden-signup-v2');

describe('loadTracePairs', () => {
  test('loads all request/response pairs ordered by numeric id', async () => {
    const pairs = await loadTracePairs(FIXTURE_DIR);
    expect(pairs.length).toBeGreaterThan(50);
    // sorted by id
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i].id).toBeGreaterThan(pairs[i - 1].id);
    }
    // pair shape
    const first = pairs[0];
    expect(first.id).toBe(1);
    expect(first.request.method).toBe('GET');
    expect(first.request.url).toContain('chatgpt.com/api/auth/session');
    expect(first.response.status).toBe(200);
  });

  test('pair with no matching response gets responseStatus null', async () => {
    const pairs = await loadTracePairs(FIXTURE_DIR, {
      overrideRequests: [{ type: 'request', ts: 100, url: 'https://example.com/x', method: 'GET', headers: {}, postData: null }],
      overrideResponses: [],
    });
    expect(pairs[0].response).toBeNull();
  });
});

describe('loadCookieDiffs', () => {
  test('loads all cookie-diff files keyed by checkpoint name', async () => {
    const diffs = await loadCookieDiffs(FIXTURE_DIR);
    expect(typeof diffs).toBe('object');
    expect(diffs['auth-page-loaded']).toBeDefined();
    expect(Array.isArray(diffs['auth-page-loaded'].addedCookies)).toBe(true);
  });
});

describe('loadCheckpoints', () => {
  test('loads all checkpoints ordered by ts', async () => {
    const cps = await loadCheckpoints(FIXTURE_DIR);
    expect(cps.length).toBeGreaterThan(0);
    expect(cps[0].name).toBeDefined();
    expect(cps[0].url).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --testPathPattern="traceArtifactLoader" --runInBand
```

Expected: FAIL — module not found.

**Step 3: Write minimal implementation**

```js
// src/pipeline/authTrace/traceArtifactLoader.js
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export async function loadTracePairs(dir, overrides = {}) {
  if (overrides.overrideRequests) {
    return overrides.overrideRequests.map((req, i) => {
      const res = overrides.overrideResponses?.[i] ?? null;
      return { id: i + 1, request: req, response: res };
    });
  }

  const reqDir = path.join(dir, 'requests');
  const resDir = path.join(dir, 'responses');

  const reqFiles = (await readdir(reqDir)).filter((f) => f.startsWith('request-') && f.endsWith('.json'));
  const ids = reqFiles.map((f) => parseInt(f.replace('request-', '').replace('.json', ''), 10)).sort((a, b) => a - b);

  const pairs = [];
  for (const id of ids) {
    const req = JSON.parse(await readFile(path.join(reqDir, `request-${id}.json`), 'utf8'));
    let res = null;
    try {
      res = JSON.parse(await readFile(path.join(resDir, `response-${id}.json`), 'utf8'));
    } catch {
      // missing response is allowed
    }
    pairs.push({ id, request: req, response: res });
  }
  return pairs;
}

export async function loadCookieDiffs(dir) {
  const diffDir = path.join(dir, 'cookie-diffs');
  let files = [];
  try {
    files = await readdir(diffDir);
  } catch {
    return {};
  }
  const result = {};
  for (const f of files.filter((f) => f.endsWith('.json'))) {
    const name = f.replace('.json', '');
    result[name] = JSON.parse(await readFile(path.join(diffDir, f), 'utf8'));
  }
  return result;
}

export async function loadCheckpoints(dir) {
  const cpDir = path.join(dir, 'checkpoints');
  let files = [];
  try {
    files = await readdir(cpDir);
  } catch {
    return [];
  }
  const checkpoints = [];
  for (const f of files.filter((f) => f.endsWith('.json'))) {
    const cp = JSON.parse(await readFile(path.join(cpDir, f), 'utf8'));
    checkpoints.push(cp);
  }
  return checkpoints.sort((a, b) => (a.ts ?? 0) < (b.ts ?? 0) ? -1 : 1);
}
```

**Step 4: Run test to verify it passes**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --testPathPattern="traceArtifactLoader" --runInBand
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/pipeline/authTrace/traceArtifactLoader.js tests/pipeline/authTrace/traceArtifactLoader.test.js
git commit -m "feat: add traceArtifactLoader for offline catalog analysis"
```

---

### Task 2: endpointCatalog — normalize, deduplicate, enrich

**Files:**
- Create: `src/pipeline/authTrace/endpointCatalog.js`
- Create: `tests/pipeline/authTrace/endpointCatalog.test.js`

**Step 1: Write the failing test**

```js
// tests/pipeline/authTrace/endpointCatalog.test.js
import { describe, expect, test } from '@jest/globals';
import { normalizePath, buildEndpointCatalog } from '../../../src/pipeline/authTrace/endpointCatalog.js';

describe('normalizePath', () => {
  test('strips UUIDs to :uuid', () => {
    expect(normalizePath('/api/accounts/037bf0ab-6988-4f13-b7f4-802e2f3e0143/info'))
      .toBe('/api/accounts/:uuid/info');
  });

  test('strips hex-segment IDs like challenge-platform paths', () => {
    expect(normalizePath('/cdn-cgi/challenge-platform/h/g/scripts/jsd/ea2d291c0fdc/main.js'))
      .toBe('/cdn-cgi/challenge-platform/h/g/scripts/jsd/:hexid/main.js');
  });

  test('preserves known API paths intact', () => {
    expect(normalizePath('/api/auth/session')).toBe('/api/auth/session');
    expect(normalizePath('/backend-api/accounts/check/v4-2023-04-27')).toBe('/backend-api/accounts/check/v4-2023-04-27');
  });
});

describe('buildEndpointCatalog', () => {
  const pairs = [
    {
      id: 1,
      request: { ts: 1000, method: 'GET', url: 'https://chatgpt.com/api/auth/session', headers: { 'user-agent': 'UA' }, postData: null },
      response: { status: 200, headers: { 'content-type': 'application/json' }, body: { kind: 'json', keys: ['WARNING_BANNER'], schema: { type: 'object', keys: { WARNING_BANNER: 'string' } } } },
    },
    {
      id: 54,
      request: { ts: 5000, method: 'GET', url: 'https://chatgpt.com/api/auth/session', headers: { 'user-agent': 'UA' }, postData: null },
      response: { status: 200, headers: { 'content-type': 'application/json' }, body: { kind: 'json', keys: ['WARNING_BANNER', 'user', 'accessToken'], schema: { type: 'object', keys: { WARNING_BANNER: 'string', user: 'object', accessToken: 'string' } } } },
    },
  ];

  test('deduplicates same method+path into one entry', () => {
    const catalog = buildEndpointCatalog(pairs);
    const entry = catalog.find((e) => e.endpointId === 'GET:/api/auth/session');
    expect(entry).toBeDefined();
    expect(entry.occurrences).toBe(2);
  });

  test('records first and last ts', () => {
    const catalog = buildEndpointCatalog(pairs);
    const entry = catalog.find((e) => e.endpointId === 'GET:/api/auth/session');
    expect(entry.firstTs).toBe(1000);
    expect(entry.lastTs).toBe(5000);
  });

  test('records host and normalizedPath correctly', () => {
    const catalog = buildEndpointCatalog(pairs);
    const entry = catalog.find((e) => e.endpointId === 'GET:/api/auth/session');
    expect(entry.host).toBe('chatgpt.com');
    expect(entry.normalizedPath).toBe('/api/auth/session');
  });

  test('captures query param keys from url', () => {
    const pairsWithQuery = [
      {
        id: 1,
        request: { ts: 1, method: 'GET', url: 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=420', headers: {}, postData: null },
        response: { status: 200, headers: {}, body: null },
      },
    ];
    const catalog = buildEndpointCatalog(pairsWithQuery);
    const entry = catalog[0];
    expect(entry.queryParamKeys).toContain('timezone_offset_min');
  });

  test('entry with no response gets responseStatus null', () => {
    const pairsNoRes = [
      { id: 1, request: { ts: 1, method: 'GET', url: 'https://chatgpt.com/api/auth/session', headers: {}, postData: null }, response: null },
    ];
    const catalog = buildEndpointCatalog(pairsNoRes);
    expect(catalog[0].responseStatus).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --testPathPattern="endpointCatalog" --runInBand
```

Expected: FAIL — module not found.

**Step 3: Write minimal implementation**

```js
// src/pipeline/authTrace/endpointCatalog.js

export function normalizePath(rawPath) {
  return rawPath
    // UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':uuid')
    // Hex segment IDs (exactly 12 lowercase hex chars like ea2d291c0fdc)
    .replace(/\/[0-9a-f]{12}(?=\/|$)/g, '/:hexid');
}

function extractQueryParamKeys(url) {
  try {
    const u = new URL(url);
    return [...u.searchParams.keys()];
  } catch {
    return [];
  }
}

function extractPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function extractHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function buildEndpointCatalog(pairs) {
  const map = new Map();

  for (const { id, request, response } of pairs) {
    const rawPath = extractPath(request.url);
    const normalizedPath = normalizePath(rawPath);
    const endpointId = `${request.method}:${normalizedPath}`;

    if (!map.has(endpointId)) {
      map.set(endpointId, {
        endpointId,
        method: request.method,
        url: request.url,
        normalizedPath,
        host: extractHost(request.url),
        queryParamKeys: extractQueryParamKeys(request.url),
        requestHeaders: request.headers ?? {},
        requestCookieNames: cookieNamesFromHeader(request.headers),
        requestBodySchema: request.postData ? inferBodySchema(request.postData) : null,
        responseStatus: response?.status ?? null,
        responseHeaders: response?.headers ?? {},
        redirectLocation: response?.headers?.location ?? null,
        setCookieNames: extractSetCookieNames(response?.headers),
        responseBodySchema: response?.body?.schema ?? null,
        responseBodyKeys: response?.body?.keys ?? null,
        authCritical: false, // set later
        replayClassification: 'unknown',
        occurrences: 0,
        firstTs: request.ts,
        lastTs: request.ts,
        firstId: id,
        lastId: id,
      });
    }

    const entry = map.get(endpointId);
    entry.occurrences += 1;
    if (request.ts < entry.firstTs) { entry.firstTs = request.ts; entry.firstId = id; }
    if (request.ts > entry.lastTs) { entry.lastTs = request.ts; entry.lastId = id; }
    // merge query param keys from later occurrences
    for (const k of extractQueryParamKeys(request.url)) {
      if (!entry.queryParamKeys.includes(k)) entry.queryParamKeys.push(k);
    }
    // merge response schema keys if later response richer
    if (response?.body?.keys && (!entry.responseBodyKeys || response.body.keys.length > entry.responseBodyKeys.length)) {
      entry.responseBodyKeys = response.body.keys;
      entry.responseBodySchema = response.body.schema ?? entry.responseBodySchema;
    }
  }

  return [...map.values()].sort((a, b) => a.firstTs - b.firstTs);
}

function cookieNamesFromHeader(headers = {}) {
  const cookieHeader = headers['cookie'] ?? headers['Cookie'] ?? '';
  if (!cookieHeader) return [];
  return cookieHeader.split(';').map((c) => c.trim().split('=')[0]).filter(Boolean);
}

function extractSetCookieNames(headers = {}) {
  const raw = headers['set-cookie'];
  if (!raw) return [];
  const entries = Array.isArray(raw) ? raw : [raw];
  return entries.map((s) => s.split('=')[0].trim()).filter(Boolean);
}

function inferBodySchema(postData) {
  if (!postData) return null;
  try {
    const parsed = JSON.parse(postData);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { type: 'object', keys: Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v === null ? 'null' : typeof v])) };
    }
    return { type: typeof parsed };
  } catch {
    return { type: 'string', raw: '[non-json body]' };
  }
}
```

**Step 4: Run test to verify it passes**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --testPathPattern="endpointCatalog" --runInBand
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/pipeline/authTrace/endpointCatalog.js tests/pipeline/authTrace/endpointCatalog.test.js
git commit -m "feat: add endpointCatalog normalization and deduplication"
```

---

### Task 3: flowSequence — ordered timeline with auth-critical flagging

**Files:**
- Create: `src/pipeline/authTrace/flowSequence.js`
- Create: `tests/pipeline/authTrace/flowSequence.test.js`

**Step 1: Write the failing test**

```js
// tests/pipeline/authTrace/flowSequence.test.js
import { describe, expect, test } from '@jest/globals';
import { buildFlowSequence, flagAuthCritical } from '../../../src/pipeline/authTrace/flowSequence.js';

const AUTH_SIDE_PAIR = {
  id: 2,
  request: { ts: 2000, method: 'GET', url: 'https://auth.openai.com/api/accounts/authorize?client_id=abc', headers: {}, postData: null },
  response: { status: 302, headers: { location: 'https://auth.openai.com/create-account/password' }, body: null },
};

const PRE_TOKEN_SESSION_PAIR = {
  id: 1,
  request: { ts: 1000, method: 'GET', url: 'https://chatgpt.com/api/auth/session', headers: {}, postData: null },
  response: { status: 200, headers: {}, body: { kind: 'json', keys: ['WARNING_BANNER'], schema: null } },
};

const POST_TOKEN_SESSION_PAIR = {
  id: 54,
  request: { ts: 9000, method: 'GET', url: 'https://chatgpt.com/api/auth/session', headers: {}, postData: null },
  response: { status: 200, headers: {}, body: { kind: 'json', keys: ['WARNING_BANNER', 'user', 'accessToken'], schema: null } },
};

const PRODUCT_PAIR = {
  id: 30,
  request: { ts: 7000, method: 'GET', url: 'https://chatgpt.com/backend-api/gizmos/bootstrap?limit=2', headers: {}, postData: null },
  response: { status: 200, headers: {}, body: null },
};

describe('flagAuthCritical', () => {
  test('auth.openai.com endpoints are auth-critical', () => {
    expect(flagAuthCritical(AUTH_SIDE_PAIR)).toBe(true);
  });

  test('chatgpt.com/api/auth/session is auth-critical', () => {
    expect(flagAuthCritical(PRE_TOKEN_SESSION_PAIR)).toBe(true);
  });

  test('product bootstrap endpoints are not auth-critical', () => {
    expect(flagAuthCritical(PRODUCT_PAIR)).toBe(false);
  });
});

describe('buildFlowSequence', () => {
  const pairs = [PRE_TOKEN_SESSION_PAIR, AUTH_SIDE_PAIR, PRODUCT_PAIR, POST_TOKEN_SESSION_PAIR];

  test('entries are ordered by timestamp', () => {
    const seq = buildFlowSequence(pairs);
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i].ts).toBeGreaterThanOrEqual(seq[i - 1].ts);
    }
  });

  test('marks firstAccessTokenOccurrence on the session response that first includes accessToken key', () => {
    const seq = buildFlowSequence(pairs);
    const tokenEntry = seq.find((e) => e.firstAccessTokenOccurrence);
    expect(tokenEntry).toBeDefined();
    expect(tokenEntry.id).toBe(54);
  });

  test('each entry has correct shape', () => {
    const seq = buildFlowSequence(pairs);
    const entry = seq[0];
    expect(entry).toMatchObject({
      id: expect.any(Number),
      ts: expect.any(Number),
      method: expect.any(String),
      url: expect.any(String),
      normalizedPath: expect.any(String),
      host: expect.any(String),
      responseStatus: expect.anything(),
      authCritical: expect.any(Boolean),
    });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --testPathPattern="flowSequence" --runInBand
```

Expected: FAIL — module not found.

**Step 3: Write minimal implementation**

```js
// src/pipeline/authTrace/flowSequence.js
import { normalizePath } from './endpointCatalog.js';

const AUTH_CRITICAL_HOSTS = ['auth.openai.com', 'sentinel.openai.com'];
const AUTH_CRITICAL_PATHS = ['/api/auth/session', '/backend-api/accounts/check'];

export function flagAuthCritical(pair) {
  try {
    const u = new URL(pair.request.url);
    if (AUTH_CRITICAL_HOSTS.includes(u.hostname)) return true;
    if (u.hostname === 'chatgpt.com' && AUTH_CRITICAL_PATHS.some((p) => u.pathname.startsWith(p))) return true;
  } catch {
    // ignore
  }
  return false;
}

function hasAccessToken(response) {
  return Array.isArray(response?.body?.keys) && response.body.keys.includes('accessToken');
}

function extractHost(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

export function buildFlowSequence(pairs) {
  const sorted = [...pairs].sort((a, b) => a.request.ts - b.request.ts);

  let accessTokenSeen = false;
  return sorted.map(({ id, request, response }) => {
    const isFirstAccessToken = !accessTokenSeen && hasAccessToken(response);
    if (isFirstAccessToken) accessTokenSeen = true;

    return {
      id,
      ts: request.ts,
      method: request.method,
      url: request.url,
      normalizedPath: normalizePath(new URL(request.url).pathname),
      host: extractHost(request.url),
      responseStatus: response?.status ?? null,
      redirectLocation: response?.headers?.location ?? null,
      authCritical: flagAuthCritical({ request, response }),
      firstAccessTokenOccurrence: isFirstAccessToken,
      requestHeaders: Object.keys(request.headers ?? {}),
      responseBodyKeys: response?.body?.keys ?? null,
    };
  });
}
```

**Step 4: Run test to verify it passes**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --testPathPattern="flowSequence" --runInBand
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/pipeline/authTrace/flowSequence.js tests/pipeline/authTrace/flowSequence.test.js
git commit -m "feat: add flowSequence builder with auth-critical flagging"
```

---

### Task 4: cookieEvolution — phase lifecycle analysis

**Files:**
- Create: `src/pipeline/authTrace/cookieEvolution.js`
- Create: `tests/pipeline/authTrace/cookieEvolution.test.js`

**Step 1: Write the failing test**

```js
// tests/pipeline/authTrace/cookieEvolution.test.js
import { describe, expect, test } from '@jest/globals';
import { buildCookieEvolution } from '../../../src/pipeline/authTrace/cookieEvolution.js';

const ORDERED_PHASES = ['landing', 'auth-page-loaded', 'post-callback', 'final'];

const DIFFS = {
  'landing': {
    addedCookies: ['__Host-next-auth.csrf-token@chatgpt.com', '__Secure-next-auth.callback-url@chatgpt.com'],
    removedCookies: [],
    persistedCookies: [],
  },
  'auth-page-loaded': {
    addedCookies: ['login_session@.auth.openai.com', 'oai-login-csrf_dev@auth.openai.com'],
    removedCookies: ['__Host-next-auth.csrf-token@chatgpt.com'],
    persistedCookies: ['__Secure-next-auth.callback-url@chatgpt.com'],
  },
  'post-callback': {
    addedCookies: ['__Secure-next-auth.session-token@.chatgpt.com', 'oai-client-auth-info@chatgpt.com'],
    removedCookies: [],
    persistedCookies: ['__Secure-next-auth.callback-url@chatgpt.com', 'login_session@.auth.openai.com'],
  },
  'final': {
    addedCookies: [],
    removedCookies: [],
    persistedCookies: ['__Secure-next-auth.session-token@.chatgpt.com', 'oai-client-auth-info@chatgpt.com'],
  },
};

describe('buildCookieEvolution', () => {
  test('produces one phase entry per checkpoint diff', () => {
    const evo = buildCookieEvolution(DIFFS, ORDERED_PHASES);
    expect(evo.phases).toHaveLength(4);
    expect(evo.phases[0].phase).toBe('landing');
  });

  test('firstAppearance maps cookie to the phase where it was first added', () => {
    const evo = buildCookieEvolution(DIFFS, ORDERED_PHASES);
    expect(evo.firstAppearance['__Secure-next-auth.session-token@.chatgpt.com']).toBe('post-callback');
    expect(evo.firstAppearance['login_session@.auth.openai.com']).toBe('auth-page-loaded');
  });

  test('authSideCookies contains auth.openai.com cookies', () => {
    const evo = buildCookieEvolution(DIFFS, ORDERED_PHASES);
    expect(evo.authSideCookies.some((c) => c.includes('auth.openai.com'))).toBe(true);
  });

  test('sessionCookies contains the next-auth session token', () => {
    const evo = buildCookieEvolution(DIFFS, ORDERED_PHASES);
    expect(evo.sessionCookies).toContain('__Secure-next-auth.session-token@.chatgpt.com');
  });

  test('phase with missing diffs is marked data-missing', () => {
    const evo = buildCookieEvolution({}, ORDERED_PHASES);
    expect(evo.phases[0].status).toBe('data-missing');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --testPathPattern="cookieEvolution" --runInBand
```

Expected: FAIL — module not found.

**Step 3: Write minimal implementation**

```js
// src/pipeline/authTrace/cookieEvolution.js

const SESSION_COOKIE_PATTERNS = ['session-token', 'session_token', 'access_token'];
const AUTH_SIDE_DOMAINS = ['auth.openai.com', '.auth.openai.com', 'openai.com', '.openai.com'];

function isAuthSide(cookieKey) {
  return AUTH_SIDE_DOMAINS.some((d) => cookieKey.endsWith(`@${d}`));
}

function isChatGptSide(cookieKey) {
  return cookieKey.includes('@chatgpt.com') || cookieKey.includes('@.chatgpt.com');
}

function isSessionCookie(cookieKey) {
  return SESSION_COOKIE_PATTERNS.some((p) => cookieKey.toLowerCase().includes(p));
}

export function buildCookieEvolution(diffs, orderedPhases) {
  const firstAppearance = {};
  const allSeen = new Set();
  const phases = [];

  for (const phase of orderedPhases) {
    const diff = diffs[phase];
    if (!diff) {
      phases.push({ phase, status: 'data-missing', added: [], removed: [], present: [] });
      continue;
    }

    for (const c of diff.addedCookies ?? []) {
      if (!firstAppearance[c]) firstAppearance[c] = phase;
      allSeen.add(c);
    }
    for (const c of diff.persistedCookies ?? []) {
      allSeen.add(c);
    }

    phases.push({
      phase,
      status: 'ok',
      added: diff.addedCookies ?? [],
      removed: diff.removedCookies ?? [],
      present: [...new Set([...(diff.addedCookies ?? []), ...(diff.persistedCookies ?? [])])],
    });
  }

  const allCookies = [...allSeen];
  return {
    phases,
    firstAppearance,
    authSideCookies: allCookies.filter(isAuthSide),
    chatgptSideCookies: allCookies.filter(isChatGptSide),
    sessionCookies: allCookies.filter(isSessionCookie),
  };
}
```

**Step 4: Run test to verify it passes**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --testPathPattern="cookieEvolution" --runInBand
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/pipeline/authTrace/cookieEvolution.js tests/pipeline/authTrace/cookieEvolution.test.js
git commit -m "feat: add cookieEvolution phase lifecycle analysis"
```

---

### Task 5: replayCandidates — classify every auth-critical endpoint

**Files:**
- Create: `src/pipeline/authTrace/replayCandidates.js`
- Create: `tests/pipeline/authTrace/replayCandidates.test.js`

**Step 1: Write the failing test**

```js
// tests/pipeline/authTrace/replayCandidates.test.js
import { describe, expect, test } from '@jest/globals';
import { classifyEndpoint, buildReplayCandidates } from '../../../src/pipeline/authTrace/replayCandidates.js';

describe('classifyEndpoint', () => {
  test('Cloudflare CDN challenge platform is browser-bound', () => {
    expect(classifyEndpoint({ method: 'GET', url: 'https://auth.openai.com/cdn-cgi/challenge-platform/h/g/scripts/jsd/main.js', requestHeaders: {}, normalizedPath: '/cdn-cgi/challenge-platform/h/g/scripts/jsd/main.js' }))
      .toBe('browser-bound');
  });

  test('sentinel.openai.com SDK and req endpoints are browser-bound', () => {
    expect(classifyEndpoint({ method: 'POST', url: 'https://sentinel.openai.com/backend-api/sentinel/req', requestHeaders: {}, normalizedPath: '/backend-api/sentinel/req' }))
      .toBe('browser-bound');
    expect(classifyEndpoint({ method: 'GET', url: 'https://sentinel.openai.com/backend-api/sentinel/sdk.js', requestHeaders: {}, normalizedPath: '/backend-api/sentinel/sdk.js' }))
      .toBe('browser-bound');
  });

  test('email OTP validate is challenge-bound', () => {
    expect(classifyEndpoint({ method: 'POST', url: 'https://auth.openai.com/api/accounts/email-otp/validate', requestHeaders: {}, normalizedPath: '/api/accounts/email-otp/validate' }))
      .toBe('challenge-bound');
  });

  test('user/register with openai-sentinel-token header is replayable-with-dynamic-cookie-csrf-extraction', () => {
    expect(classifyEndpoint({ method: 'POST', url: 'https://auth.openai.com/api/accounts/user/register', requestHeaders: { 'openai-sentinel-token': '[REDACTED]' }, normalizedPath: '/api/accounts/user/register' }))
      .toBe('replayable-with-dynamic-cookie-csrf-extraction');
  });

  test('chatgpt.com/api/auth/session GET is replayable-direct', () => {
    expect(classifyEndpoint({ method: 'GET', url: 'https://chatgpt.com/api/auth/session', requestHeaders: {}, normalizedPath: '/api/auth/session' }))
      .toBe('replayable-direct');
  });

  test('chatgpt.com product endpoints are replayable-direct', () => {
    expect(classifyEndpoint({ method: 'GET', url: 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27', requestHeaders: {}, normalizedPath: '/backend-api/accounts/check/v4-2023-04-27' }))
      .toBe('replayable-direct');
  });

  test('auth.openai.com/api/accounts/authorize GET is browser-bound (OAuth kickoff)', () => {
    expect(classifyEndpoint({ method: 'GET', url: 'https://auth.openai.com/api/accounts/authorize', requestHeaders: {}, normalizedPath: '/api/accounts/authorize' }))
      .toBe('browser-bound');
  });
});

describe('buildReplayCandidates', () => {
  test('produces one entry per endpointId with classification and evidence', () => {
    const catalog = [
      { endpointId: 'GET:/api/auth/session', method: 'GET', url: 'https://chatgpt.com/api/auth/session', normalizedPath: '/api/auth/session', host: 'chatgpt.com', requestHeaders: {}, authCritical: true },
      { endpointId: 'POST:/backend-api/sentinel/req', method: 'POST', url: 'https://sentinel.openai.com/backend-api/sentinel/req', normalizedPath: '/backend-api/sentinel/req', host: 'sentinel.openai.com', requestHeaders: {}, authCritical: true },
    ];
    const candidates = buildReplayCandidates(catalog);
    expect(candidates).toHaveLength(2);
    const session = candidates.find((c) => c.endpointId === 'GET:/api/auth/session');
    expect(session.replayClassification).toBe('replayable-direct');
    const sentinel = candidates.find((c) => c.endpointId === 'POST:/backend-api/sentinel/req');
    expect(sentinel.replayClassification).toBe('browser-bound');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --testPathPattern="replayCandidates" --runInBand
```

Expected: FAIL — module not found.

**Step 3: Write minimal implementation**

```js
// src/pipeline/authTrace/replayCandidates.js

// Rules are ordered: first match wins.
const CLASSIFICATION_RULES = [
  // Cloudflare challenge pages
  { match: (e) => e.normalizedPath.startsWith('/cdn-cgi/'), result: 'browser-bound' },
  // Sentinel JS/SDK/proof-of-work
  { match: (e) => e.host === 'sentinel.openai.com', result: 'browser-bound' },
  // OAuth authorize kickoff — requires browser for redirect handling and Cloudflare clearance
  { match: (e) => e.host === 'auth.openai.com' && e.normalizedPath.startsWith('/api/accounts/authorize'), result: 'browser-bound' },
  // Email OTP challenge
  { match: (e) => e.normalizedPath.includes('email-otp'), result: 'challenge-bound' },
  // auth.openai.com endpoints that carry sentinel tokens — those tokens come from browser-executed sentinel.js
  // but the endpoint call itself can be replayed once tokens are obtained
  {
    match: (e) => e.host === 'auth.openai.com' && (
      Object.keys(e.requestHeaders ?? {}).some((h) => h.toLowerCase().includes('sentinel')) ||
      ['/api/accounts/user/register', '/api/accounts/create_account'].includes(e.normalizedPath)
    ),
    result: 'replayable-with-dynamic-cookie-csrf-extraction',
  },
  // auth.openai.com remaining (password page, email-verification page, other redirects)
  { match: (e) => e.host === 'auth.openai.com', result: 'replayable-with-dynamic-cookie-csrf-extraction' },
  // chatgpt.com session and account check
  {
    match: (e) => e.host === 'chatgpt.com' || e.host.endsWith('.chatgpt.com'),
    result: 'replayable-direct',
  },
];

export function classifyEndpoint(entry) {
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.match(entry)) return rule.result;
  }
  return 'unknown';
}

export function buildReplayCandidates(catalog) {
  return catalog.map((entry) => ({
    endpointId: entry.endpointId,
    method: entry.method,
    normalizedPath: entry.normalizedPath,
    host: entry.host,
    authCritical: entry.authCritical ?? false,
    replayClassification: classifyEndpoint(entry),
    requestHeaderKeys: Object.keys(entry.requestHeaders ?? {}),
    responseStatus: entry.responseStatus,
    occurrences: entry.occurrences,
  }));
}
```

**Step 4: Run test to verify it passes**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --testPathPattern="replayCandidates" --runInBand
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/pipeline/authTrace/replayCandidates.js tests/pipeline/authTrace/replayCandidates.test.js
git commit -m "feat: add replayCandidates endpoint classifier"
```

---

### Task 6: upgrade analysis.js — answer the six key questions

**Files:**
- Modify: `src/pipeline/authTrace/analysis.js`
- Modify: `tests/pipeline/authTrace/analysis.test.js`

**Step 1: Write the new failing tests**

Add to the existing `tests/pipeline/authTrace/analysis.test.js`:

```js
import { buildCatalogAnalysis } from '../../../src/pipeline/authTrace/analysis.js';

describe('buildCatalogAnalysis', () => {
  const flowSeq = [
    { id: 1, ts: 1000, method: 'GET', url: 'https://chatgpt.com/api/auth/session', normalizedPath: '/api/auth/session', host: 'chatgpt.com', authCritical: true, firstAccessTokenOccurrence: false, responseStatus: 200, responseBodyKeys: ['WARNING_BANNER'] },
    { id: 2, ts: 2000, method: 'GET', url: 'https://auth.openai.com/api/accounts/authorize', normalizedPath: '/api/accounts/authorize', host: 'auth.openai.com', authCritical: true, firstAccessTokenOccurrence: false, responseStatus: 302, responseBodyKeys: null },
    { id: 54, ts: 9000, method: 'GET', url: 'https://chatgpt.com/api/auth/session', normalizedPath: '/api/auth/session', host: 'chatgpt.com', authCritical: true, firstAccessTokenOccurrence: true, responseStatus: 200, responseBodyKeys: ['WARNING_BANNER', 'user', 'accessToken'] },
  ];

  const candidates = [
    { endpointId: 'GET:/api/auth/session', replayClassification: 'replayable-direct', authCritical: true },
    { endpointId: 'GET:/api/accounts/authorize', replayClassification: 'browser-bound', authCritical: true },
  ];

  const cookieEvo = {
    firstAppearance: {
      'login_session@.auth.openai.com': 'auth-page-loaded',
      '__Secure-next-auth.session-token@.chatgpt.com': 'post-callback',
    },
    authSideCookies: ['login_session@.auth.openai.com'],
    chatgptSideCookies: ['__Secure-next-auth.session-token@.chatgpt.com'],
    sessionCookies: ['__Secure-next-auth.session-token@.chatgpt.com'],
  };

  test('firstAuthSideSessionRequest identifies first auth.openai.com request', () => {
    const analysis = buildCatalogAnalysis({ flowSeq, candidates, cookieEvo });
    expect(analysis.firstAuthSideSessionRequest.id).toBe(2);
  });

  test('firstAccessTokenRequest identifies first session response with accessToken', () => {
    const analysis = buildCatalogAnalysis({ flowSeq, candidates, cookieEvo });
    expect(analysis.firstAccessTokenRequest.id).toBe(54);
  });

  test('preCallbackCookies are cookies first appearing before post-callback', () => {
    const analysis = buildCatalogAnalysis({ flowSeq, candidates, cookieEvo });
    expect(analysis.preCallbackCookies).toContain('login_session@.auth.openai.com');
    expect(analysis.preCallbackCookies).not.toContain('__Secure-next-auth.session-token@.chatgpt.com');
  });

  test('postCallbackCookies are cookies first appearing at or after post-callback', () => {
    const analysis = buildCatalogAnalysis({ flowSeq, candidates, cookieEvo });
    expect(analysis.postCallbackCookies).toContain('__Secure-next-auth.session-token@.chatgpt.com');
  });

  test('browserBoundEndpoints lists browser-bound endpoint ids', () => {
    const analysis = buildCatalogAnalysis({ flowSeq, candidates, cookieEvo });
    expect(analysis.browserBoundEndpoints).toContain('GET:/api/accounts/authorize');
  });

  test('likelyReplayCandidates lists replayable-direct endpoint ids', () => {
    const analysis = buildCatalogAnalysis({ flowSeq, candidates, cookieEvo });
    expect(analysis.likelyReplayCandidates).toContain('GET:/api/auth/session');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --testPathPattern="tests/pipeline/authTrace/analysis" --runInBand
```

Expected: FAIL — `buildCatalogAnalysis` not exported.

**Step 3: Add `buildCatalogAnalysis` to `analysis.js`**

Append to existing `src/pipeline/authTrace/analysis.js` (preserve existing exports):

```js
const POST_CALLBACK_PHASES = new Set(['post-callback', 'final']);

export function buildCatalogAnalysis({ flowSeq = [], candidates = [], cookieEvo = {} }) {
  const firstAuthSideRequest = flowSeq.find((e) => e.host === 'auth.openai.com');
  const firstAccessToken = flowSeq.find((e) => e.firstAccessTokenOccurrence);

  const firstAppearance = cookieEvo.firstAppearance ?? {};
  const preCallbackCookies = Object.entries(firstAppearance)
    .filter(([, phase]) => !POST_CALLBACK_PHASES.has(phase))
    .map(([cookie]) => cookie);
  const postCallbackCookies = Object.entries(firstAppearance)
    .filter(([, phase]) => POST_CALLBACK_PHASES.has(phase))
    .map(([cookie]) => cookie);

  const browserBoundEndpoints = candidates
    .filter((c) => c.replayClassification === 'browser-bound' || c.replayClassification === 'challenge-bound')
    .map((c) => c.endpointId);

  const likelyReplayCandidates = candidates
    .filter((c) => c.replayClassification === 'replayable-direct')
    .map((c) => c.endpointId);

  return {
    firstAuthSideSessionRequest: firstAuthSideRequest ?? null,
    firstAccessTokenRequest: firstAccessToken ?? null,
    preCallbackCookies,
    postCallbackCookies,
    browserBoundEndpoints,
    likelyReplayCandidates,
  };
}
```

**Step 4: Run test to verify it passes**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --testPathPattern="tests/pipeline/authTrace/analysis" --runInBand
```

Expected: PASS (all existing tests + new tests).

**Step 5: Commit**

```bash
git add src/pipeline/authTrace/analysis.js tests/pipeline/authTrace/analysis.test.js
git commit -m "feat: add buildCatalogAnalysis to answer six key auth questions"
```

---

### Task 7: runCatalogAnalysis — orchestrator that produces all five outputs

**Files:**
- Create: `src/pipeline/authTrace/runCatalogAnalysis.js`
- Create: `tests/pipeline/authTrace/runCatalogAnalysis.test.js`

**Step 1: Write the failing test**

```js
// tests/pipeline/authTrace/runCatalogAnalysis.test.js
import { describe, expect, test } from '@jest/globals';
import path from 'node:path';
import { runCatalogAnalysis } from '../../../src/pipeline/authTrace/runCatalogAnalysis.js';

const FIXTURE_DIR = path.resolve('artifacts/auth-traces/2026-03-15T20-01-44-099Z-deep-golden-signup-v2');

describe('runCatalogAnalysis', () => {
  test('produces all five output artifact shapes from a real trace dir', async () => {
    const result = await runCatalogAnalysis(FIXTURE_DIR, { dryRun: true });
    expect(result.endpointCatalog).toBeInstanceOf(Array);
    expect(result.endpointCatalog.length).toBeGreaterThan(10);

    expect(result.flowSequence).toBeInstanceOf(Array);
    expect(result.flowSequence.length).toBe(result.endpointCatalog.length === 0 ? 0 : result.flowSequence.length);

    expect(result.cookieEvolution).toHaveProperty('phases');
    expect(result.cookieEvolution).toHaveProperty('firstAppearance');

    expect(result.replayCandidates).toBeInstanceOf(Array);
    expect(result.replayCandidates.length).toBeGreaterThan(0);

    expect(result.analysis).toHaveProperty('firstAuthSideSessionRequest');
    expect(result.analysis).toHaveProperty('firstAccessTokenRequest');
    expect(result.analysis).toHaveProperty('browserBoundEndpoints');
    expect(result.analysis).toHaveProperty('likelyReplayCandidates');
  });

  test('firstAuthSideSessionRequest is auth.openai.com authorize endpoint', async () => {
    const result = await runCatalogAnalysis(FIXTURE_DIR, { dryRun: true });
    expect(result.analysis.firstAuthSideSessionRequest?.host).toBe('auth.openai.com');
  });

  test('firstAccessTokenRequest is chatgpt.com/api/auth/session', async () => {
    const result = await runCatalogAnalysis(FIXTURE_DIR, { dryRun: true });
    expect(result.analysis.firstAccessTokenRequest?.url).toContain('/api/auth/session');
  });

  test('sentinel endpoints classified as browser-bound', async () => {
    const result = await runCatalogAnalysis(FIXTURE_DIR, { dryRun: true });
    const sentinelEntry = result.replayCandidates.find((c) => c.host === 'sentinel.openai.com');
    expect(sentinelEntry).toBeDefined();
    expect(sentinelEntry.replayClassification).toBe('browser-bound');
  });

  test('chatgpt.com product API endpoints classified as replayable-direct', async () => {
    const result = await runCatalogAnalysis(FIXTURE_DIR, { dryRun: true });
    const check = result.replayCandidates.find((c) => c.normalizedPath.startsWith('/backend-api/accounts/check'));
    expect(check).toBeDefined();
    expect(check.replayClassification).toBe('replayable-direct');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --testPathPattern="runCatalogAnalysis" --runInBand
```

Expected: FAIL — module not found.

**Step 3: Write minimal implementation**

```js
// src/pipeline/authTrace/runCatalogAnalysis.js
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadTracePairs, loadCookieDiffs, loadCheckpoints } from './traceArtifactLoader.js';
import { buildEndpointCatalog } from './endpointCatalog.js';
import { buildFlowSequence, flagAuthCritical } from './flowSequence.js';
import { buildCookieEvolution } from './cookieEvolution.js';
import { buildReplayCandidates } from './replayCandidates.js';
import { buildCatalogAnalysis, inferActualScenario, classifyReplayability } from './analysis.js';

const PHASE_ORDER = ['landing', 'auth-page-loaded', 'email-submitted', 'otp-page', 'otp-submitted', 'password-page', 'password-submitted', 'post-callback', 'final'];

export async function runCatalogAnalysis(traceDir, opts = {}) {
  const { dryRun = false } = opts;

  const [pairs, cookieDiffs, checkpoints] = await Promise.all([
    loadTracePairs(traceDir),
    loadCookieDiffs(traceDir),
    loadCheckpoints(traceDir),
  ]);

  // Build catalog
  const rawCatalog = buildEndpointCatalog(pairs);

  // Build flow sequence
  const flowSequence = buildFlowSequence(pairs);

  // Flag auth-critical on catalog entries by joining with flowSequence
  const authCriticalIds = new Set(
    pairs.filter((p) => flagAuthCritical(p)).map((p) => p.id)
  );
  const endpointCatalog = rawCatalog.map((entry) => ({
    ...entry,
    authCritical:
      entry.authCritical ||
      flowSequence.some((s) => s.normalizedPath === entry.normalizedPath && s.host === entry.host && s.authCritical),
  }));

  // Cookie evolution — use PHASE_ORDER to filter to phases present in diffs
  const presentPhases = PHASE_ORDER.filter((p) => cookieDiffs[p] !== undefined);
  const cookieEvolution = buildCookieEvolution(cookieDiffs, presentPhases.length > 0 ? presentPhases : PHASE_ORDER);

  // Replay candidates
  const replayCandidates = buildReplayCandidates(endpointCatalog);

  // Upgraded analysis
  const catalogAnalysis = buildCatalogAnalysis({ flowSeq: flowSequence, candidates: replayCandidates, cookieEvo: cookieEvolution });

  // Backward-compatible base analysis
  const actualScenario = inferActualScenario(checkpoints);
  const replayability = classifyReplayability({
    actualScenario,
    hasAuthenticatedSession: checkpoints.some((c) => c.session?.hasAccessToken),
    sawAuthOpenAi: checkpoints.some((c) => String(c.url ?? '').includes('auth.openai.com')),
    sawChatGptSession: checkpoints.some((c) => Boolean(c.session?.hasAccessToken)),
    sawPasswordPage: checkpoints.some((c) => String(c.url ?? '').includes('password')),
    sawSignupPage: checkpoints.some((c) => String(c.url ?? '').includes('create-account')),
  });

  const analysis = {
    actualScenario,
    replayability,
    ...catalogAnalysis,
  };

  if (!dryRun) {
    await Promise.all([
      writeFile(path.join(traceDir, 'endpoint-catalog.json'), JSON.stringify(endpointCatalog, null, 2) + '\n', 'utf8'),
      writeFile(path.join(traceDir, 'flow-sequence.json'), JSON.stringify(flowSequence, null, 2) + '\n', 'utf8'),
      writeFile(path.join(traceDir, 'cookie-evolution.json'), JSON.stringify(cookieEvolution, null, 2) + '\n', 'utf8'),
      writeFile(path.join(traceDir, 'replay-candidates.json'), JSON.stringify(replayCandidates, null, 2) + '\n', 'utf8'),
      writeFile(path.join(traceDir, 'analysis.json'), JSON.stringify(analysis, null, 2) + '\n', 'utf8'),
    ]);
  }

  return { endpointCatalog, flowSequence, cookieEvolution, replayCandidates, analysis };
}
```

**Step 4: Run test to verify it passes**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --testPathPattern="runCatalogAnalysis" --runInBand
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/pipeline/authTrace/runCatalogAnalysis.js tests/pipeline/authTrace/runCatalogAnalysis.test.js
git commit -m "feat: add runCatalogAnalysis orchestrator — produces all five auth artifacts"
```

---

### Task 8: pipeline-auth-catalog CLI

**Files:**
- Create: `src/cli/pipeline-auth-catalog.js`
- Create: `tests/cli/pipelineAuthCatalog.test.js`

**Step 1: Write the failing test**

```js
// tests/cli/pipelineAuthCatalog.test.js
import { describe, expect, test } from '@jest/globals';
import { parseArgs, buildCliConfig } from '../../src/cli/pipeline-auth-catalog.js';

describe('parseArgs', () => {
  test('parses --trace-dir', () => {
    const cfg = parseArgs(['--trace-dir', '/tmp/my-trace']);
    expect(cfg.traceDir).toBe('/tmp/my-trace');
  });

  test('parses --dry-run flag', () => {
    const cfg = parseArgs(['--trace-dir', '/tmp/my-trace', '--dry-run']);
    expect(cfg.dryRun).toBe(true);
  });

  test('defaults dryRun to false', () => {
    const cfg = parseArgs(['--trace-dir', '/tmp/my-trace']);
    expect(cfg.dryRun).toBe(false);
  });
});

describe('buildCliConfig', () => {
  test('returns valid config from parsed args', () => {
    const cfg = buildCliConfig({ traceDir: '/tmp/t', dryRun: false });
    expect(cfg.traceDir).toBe('/tmp/t');
    expect(cfg.dryRun).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --testPathPattern="pipelineAuthCatalog" --runInBand
```

Expected: FAIL — module not found.

**Step 3: Write minimal implementation**

```js
// src/cli/pipeline-auth-catalog.js
import { runCatalogAnalysis } from '../pipeline/authTrace/runCatalogAnalysis.js';

export function parseArgs(argv = process.argv.slice(2)) {
  let traceDir = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--trace-dir' && argv[i + 1]) { traceDir = argv[i + 1]; i++; }
    if (argv[i] === '--dry-run') dryRun = true;
  }
  return { traceDir, dryRun };
}

export function buildCliConfig(parsed) {
  return { traceDir: parsed.traceDir, dryRun: parsed.dryRun ?? false };
}

async function main() {
  const args = parseArgs();
  const cfg = buildCliConfig(args);

  if (!cfg.traceDir) {
    console.error('Usage: pipeline-auth-catalog --trace-dir <path> [--dry-run]');
    process.exit(1);
  }

  console.log(`Analyzing trace dir: ${cfg.traceDir}`);
  const result = await runCatalogAnalysis(cfg.traceDir, { dryRun: cfg.dryRun });

  const totalEndpoints = result.endpointCatalog.length;
  const byClass = {};
  for (const c of result.replayCandidates) {
    byClass[c.replayClassification] = (byClass[c.replayClassification] ?? 0) + 1;
  }

  console.log(`\n=== Auth Catalog Summary ===`);
  console.log(`Total endpoints cataloged: ${totalEndpoints}`);
  for (const [cls, count] of Object.entries(byClass)) {
    console.log(`  ${cls}: ${count}`);
  }
  console.log(`\nFirst auth-side request: ${result.analysis.firstAuthSideSessionRequest?.url ?? 'none'}`);
  console.log(`First access-token response: ${result.analysis.firstAccessTokenRequest?.url ?? 'none'}`);
  console.log(`Browser-bound endpoints: ${result.analysis.browserBoundEndpoints.length}`);
  console.log(`Direct replay candidates: ${result.analysis.likelyReplayCandidates.length}`);

  if (!cfg.dryRun) {
    console.log(`\nArtifacts written to: ${cfg.traceDir}`);
    console.log(`  endpoint-catalog.json`);
    console.log(`  flow-sequence.json`);
    console.log(`  cookie-evolution.json`);
    console.log(`  replay-candidates.json`);
    console.log(`  analysis.json`);
  }
}

if (process.argv[1]?.endsWith('pipeline-auth-catalog.js')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
```

**Step 4: Run test to verify it passes**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --testPathPattern="pipelineAuthCatalog" --runInBand
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/cli/pipeline-auth-catalog.js tests/cli/pipelineAuthCatalog.test.js
git commit -m "feat: add pipeline-auth-catalog CLI"
```

---

### Task 9: run CLI against real artifact + verify outputs

**Files:** No new files.

**Step 1: Run CLI against deep-golden-signup-v2 (dry run first)**

```bash
cd /home/epistemophile/Development/chatgpt-factory-bundle/.worktrees/deterministic-agentmail-pipeline-clone
node src/cli/pipeline-auth-catalog.js \
  --trace-dir artifacts/auth-traces/2026-03-15T20-01-44-099Z-deep-golden-signup-v2 \
  --dry-run
```

Expected: summary printed, no files written.

**Step 2: Run CLI for real, write outputs**

```bash
node src/cli/pipeline-auth-catalog.js \
  --trace-dir artifacts/auth-traces/2026-03-15T20-01-44-099Z-deep-golden-signup-v2
```

Expected: five artifacts written. Verify:

```bash
ls -lh artifacts/auth-traces/2026-03-15T20-01-44-099Z-deep-golden-signup-v2/{endpoint-catalog,flow-sequence,cookie-evolution,replay-candidates,analysis}.json
```

**Step 3: Spot-check key findings**

```bash
# Classification breakdown
node -e "
const r = JSON.parse(require('fs').readFileSync('artifacts/auth-traces/2026-03-15T20-01-44-099Z-deep-golden-signup-v2/replay-candidates.json'));
const by = {};
r.forEach(c => by[c.replayClassification] = (by[c.replayClassification]||0)+1);
console.log(by);
"

# First access-token session request
node -e "
const a = JSON.parse(require('fs').readFileSync('artifacts/auth-traces/2026-03-15T20-01-44-099Z-deep-golden-signup-v2/analysis.json'));
console.log('firstAccessTokenRequest:', a.firstAccessTokenRequest?.url);
console.log('browserBound:', a.browserBoundEndpoints.length);
console.log('replayDirect:', a.likelyReplayCandidates.length);
"
```

Expected output shape (values may differ, these are minimums):
- `browser-bound` count ≥ 3 (cdn-cgi, sentinel SDK, sentinel/req, authorize)
- `challenge-bound` count ≥ 1 (email-otp/validate)
- `replayable-direct` count ≥ 15 (chatgpt.com product APIs)
- `firstAccessTokenRequest` URL contains `/api/auth/session`

**Step 4: Commit artifacts**

```bash
git add artifacts/auth-traces/2026-03-15T20-01-44-099Z-deep-golden-signup-v2/{endpoint-catalog,flow-sequence,cookie-evolution,replay-candidates,analysis}.json
git commit -m "chore: add catalog artifacts from deep-golden-signup-v2 trace"
```

---

### Task 10: Phase B — wire catalog analysis into runAuthTrace

**Files:**
- Modify: `src/pipeline/authTrace/runAuthTrace.js`
- Modify: `tests/pipeline/authTrace/runAuthTrace.test.js`

**Step 1: Add failing test for integration**

Add to `tests/pipeline/authTrace/runAuthTrace.test.js`:

```js
test('runAuthTrace calls runCatalogAnalysis after capture when catalogAnalysis dep provided', async () => {
  const catalogResults = [];
  const fakeCatalogAnalysis = async (dir, opts) => {
    catalogResults.push({ dir, opts });
    return {};
  };

  await runAuthTrace(
    { mode: 'manual', scenario: 'unknown-auto', label: 'test-catalog' },
    {
      ...commonDeps,
      runCatalogAnalysis: fakeCatalogAnalysis,
    }
  );

  expect(catalogResults).toHaveLength(1);
  expect(catalogResults[0].opts?.dryRun).toBe(false);
});
```

**Step 2: Run test to verify it fails**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --testPathPattern="tests/pipeline/authTrace/runAuthTrace" --runInBand
```

Expected: FAIL — runCatalogAnalysis not called.

**Step 3: Wire catalog analysis into runAuthTrace**

In `src/pipeline/authTrace/runAuthTrace.js`, at the top add:

```js
import { runCatalogAnalysis as defaultRunCatalogAnalysis } from './runCatalogAnalysis.js';
```

And at the end of `runAuthTrace`, before the final return, add:

```js
  const catalogAnalysisFn = deps.runCatalogAnalysis ?? defaultRunCatalogAnalysis;
  try {
    await catalogAnalysisFn(runDir, { dryRun: false });
  } catch (err) {
    // catalog analysis failure must not break the capture run
    await writer.write({ type: 'catalog-analysis-error', message: String(err) });
  }
```

**Step 4: Run test to verify it passes**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --testPathPattern="tests/pipeline/authTrace/runAuthTrace" --runInBand
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/pipeline/authTrace/runAuthTrace.js tests/pipeline/authTrace/runAuthTrace.test.js
git commit -m "feat: wire runCatalogAnalysis into runAuthTrace (Phase B)"
```

---

### Task 11: full suite verification

**Step 1: Run focused auth-trace suite**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --testPathPattern="authTrace|pipelineAuthCatalog" --runInBand
```

Expected: all pass.

**Step 2: Run complete suite**

```bash
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --rootDir=. --config='{"transform":{},"testEnvironment":"node","testTimeout":300000,"testMatch":["**/tests/**/*.test.js"]}' --runInBand
```

Expected: all pass, no regressions.

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat: complete auth endpoint cataloger — offline analysis + tracer integration"
```
