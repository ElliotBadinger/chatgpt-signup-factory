import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const SENTINEL_LOADER_URL = 'https://sentinel.openai.com/backend-api/sentinel/sdk.js';
const FALLBACK_SENTINEL_SDK_URL = 'https://sentinel.openai.com/sentinel/20260219f9f6/sdk.js';
const AUTH_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

function parseJsonSafe(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function toDate(now) {
  return typeof now === 'function' ? now() : new Date();
}

function serializeTimestamp(now) {
  return toDate(now).toISOString();
}

function getSetCookieHeader(headers) {
  if (typeof headers.getSetCookie === 'function') {
    const values = headers.getSetCookie();
    if (values.length > 0) return values;
  }
  return headers.get('set-cookie');
}

function finalizeHeaders(headers) {
  const result = {};
  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }
  const setCookie = getSetCookieHeader(headers);
  return {
    location: result.location ?? null,
    'set-cookie': Array.isArray(setCookie) ? setCookie.join('\n') : setCookie,
    'content-type': result['content-type'] ?? null,
    'openai-processing-ms': result['openai-processing-ms'] ?? null,
    'openai-version': result['openai-version'] ?? null,
    'x-request-id': result['x-request-id'] ?? null,
    'x-oai-request-id': result['x-oai-request-id'] ?? null,
    'server-timing': result['server-timing'] ?? null,
    'cf-ray': result['cf-ray'] ?? null,
  };
}

function flowToStepName(flow) {
  if (flow === 'username_password_create') return 'sentinel_req_username_password_create';
  if (flow === 'oauth_create_account') return 'sentinel_req_oauth_create_account';
  return `sentinel_req_${String(flow ?? 'unknown')}`;
}

function getHeaderObject(headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function') return Object.fromEntries(headers.entries());
  return { ...headers };
}

function getOrigin(href) {
  try {
    return new URL(href).origin;
  } catch {
    return 'https://auth.openai.com';
  }
}

function createBtoa() {
  return (value) => Buffer.from(String(value), 'binary').toString('base64');
}

function createAtob() {
  return (value) => Buffer.from(String(value), 'base64').toString('binary');
}

function createFakeElement(tagName) {
  return createLenientProxy({
    tagName: String(tagName).toUpperCase(),
    style: {},
    src: '',
    type: '',
    async: false,
    defer: false,
    _listeners: {},
    addEventListener(type, callback) {
      (this._listeners[type] ||= []).push(callback);
    },
    _emit(type) {
      for (const callback of this._listeners[type] ?? []) {
        callback.call(this, { type, target: this });
      }
    },
    getAttribute(name) {
      return name === 'data-build' ? '20260219f9f6' : null;
    },
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 300, height: 150, top: 0, left: 0, right: 300, bottom: 150 };
    },
    appendChild(element) {
      setTimeout(() => element._emit?.('load'), 10);
      return element;
    },
    remove() {},
  });
}

function createLenientProxy(target) {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (property in object) return Reflect.get(object, property, receiver);
      if (typeof property === 'symbol') return undefined;
      return undefined;
    },
  });
}

function createFakeDocument(scriptSrc, { cookie = '' } = {}) {
  const script = {
    src: scriptSrc,
    getAttribute(name) {
      return name === 'data-build' ? '20260219f9f6' : null;
    },
  };
  const body = createLenientProxy({
    appendChild(element) {
      setTimeout(() => element._emit?.('load'), 10);
      return element;
    },
    removeChild(element) {
      return element;
    },
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 1920, height: 1080, top: 0, left: 0, right: 1920, bottom: 1080 };
    },
  });
  return createLenientProxy({
    cookie,
    currentScript: script,
    scripts: [script],
    documentElement: createLenientProxy({
      getAttribute(name) {
        return name === 'data-build' ? '20260219f9f6' : null;
      },
    }),
    head: createLenientProxy({
      appendChild(element) {
        setTimeout(() => element._emit?.('load'), 10);
        return element;
      },
    }),
    body,
    createElement: createFakeElement,
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  });
}

function createFakeWindow({ href, topRef = null, fetchImpl, consoleImpl = console }) {
  const listeners = new Map();
  const storage = new Map();
  const storageApi = createLenientProxy({
    get length() {
      return storage.size;
    },
    getItem(key) {
      return storage.get(String(key)) ?? null;
    },
    setItem(key, value) {
      storage.set(String(key), String(value));
    },
    removeItem(key) {
      storage.delete(String(key));
    },
    clear() {
      storage.clear();
    },
    key(index) {
      return Array.from(storage.keys())[index] ?? null;
    },
  });
  const fakeWindowTarget = {
    location: new URL(href),
    addEventListener(type, callback) {
      (listeners.get(type) ?? listeners.set(type, []).get(type)).push(callback);
    },
    dispatchMessage(event) {
      for (const callback of listeners.get('message') ?? []) {
        callback.call(fakeWindow, event);
      }
    },
    setTimeout,
    clearTimeout,
    performance,
    crypto: webcrypto,
    TextEncoder,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    fetch: fetchImpl,
    btoa: createBtoa(),
    atob: createAtob(),
    Math,
    Date,
    JSON,
    Promise,
    Array,
    Object,
    Reflect,
    String,
    Number,
    Boolean,
    Map,
    WeakMap,
    Uint8Array,
    Error,
    console: consoleImpl,
    navigator: createLenientProxy({
      userAgent: AUTH_USER_AGENT,
      language: 'en-US',
      languages: ['en-US', 'en'],
      hardwareConcurrency: 8,
      platform: 'Linux x86_64',
      webdriver: false,
    }),
    screen: createLenientProxy({ width: 1920, height: 1080, colorDepth: 24, pixelDepth: 24, availWidth: 1920, availHeight: 1040 }),
    localStorage: storageApi,
    sessionStorage: storageApi,
    history: createLenientProxy({
      length: 1,
      state: null,
      pushState() {},
      replaceState() {},
      back() {},
      forward() {},
      go() {},
    }),
    __sentinel_init_pending: [],
    __sentinel_token_pending: [],
    requestIdleCallback(callback) {
      return setTimeout(() => callback({ timeRemaining: () => 50, didTimeout: false }), 0);
    },
  };
  const fakeWindow = createLenientProxy(fakeWindowTarget);
  fakeWindow.window = fakeWindow;
  fakeWindow.self = fakeWindow;
  fakeWindow.globalThis = fakeWindow;
  fakeWindow.top = topRef || fakeWindow;
  fakeWindow.parent = topRef || fakeWindow;
  return fakeWindow;
}

async function readResponseText(response) {
  if (typeof response.text === 'function') return response.text();
  return '';
}

async function loadCurrentSdkSource(fetchImpl) {
  const loaderResponse = await fetchImpl(SENTINEL_LOADER_URL, {
    headers: {
      'user-agent': AUTH_USER_AGENT,
      'accept-language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });
  const loaderText = await readResponseText(loaderResponse);
  const scriptSrc = loaderText.match(/script\.src\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? FALLBACK_SENTINEL_SDK_URL;
  const sdkResponse = await fetchImpl(scriptSrc, {
    headers: {
      'user-agent': AUTH_USER_AGENT,
      'accept-language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });
  return {
    scriptSrc,
    sdkSource: await readResponseText(sdkResponse),
  };
}

function createResponseClone(text, response) {
  return new Response(text, {
    status: response.status ?? 200,
    statusText: response.statusText ?? '',
    headers: response.headers,
  });
}

function createSentinelSdkRuntime({ fetchImpl, scriptSrc, sdkSource, locationHref, cookie = '', now = null }) {
  const steps = [];
  const parentWindow = createFakeWindow({
    href: locationHref,
    fetchImpl,
    consoleImpl: { log() {}, warn() {}, error() {} },
  });
  const childWindow = createFakeWindow({
    href: 'https://sentinel.openai.com/backend-api/sentinel/frame.html?sv=20260219f9f6',
    topRef: parentWindow,
    fetchImpl,
    consoleImpl: { log() {}, warn() {}, error() {} },
  });
  parentWindow.document = createFakeDocument(scriptSrc, { cookie });
  childWindow.document = createFakeDocument(scriptSrc, { cookie });

  let iframeWindow = null;
  parentWindow.postMessage = (message) => {
    parentWindow.dispatchMessage({
      data: message,
      origin: getOrigin(childWindow.location.href),
      source: iframeWindow,
    });
  };
  parentWindow.document.createElement = (tagName) => {
    const element = createFakeElement(tagName);
    if (String(tagName).toLowerCase() === 'iframe') {
      iframeWindow = {
        postMessage(message) {
          childWindow.dispatchMessage({
            data: message,
            origin: getOrigin(parentWindow.location.href),
            source: parentWindow,
          });
        },
      };
      element.contentWindow = iframeWindow;
    }
    return element;
  };

  const sentinelFetch = async (url, options = {}) => {
    const requestHeaders = {
      'user-agent': AUTH_USER_AGENT,
      'accept-language': 'en-US,en;q=0.9',
      ...getHeaderObject(options.headers),
    };
    const requestedAt = serializeTimestamp(now);
    const startedAtMs = Date.now();
    const response = await fetchImpl(url, {
      ...options,
      headers: requestHeaders,
    });
    const text = await readResponseText(response);
    const elapsedMs = Date.now() - startedAtMs;
    const responseJson = parseJsonSafe(text, null);
    steps.push({
      name: flowToStepName(parseJsonSafe(options.body, {})?.flow),
      url: String(url),
      method: options.method ?? 'GET',
      requestedAt,
      elapsedMs,
      status: response.status,
      requestHeaders,
      requestBody: options.body ?? null,
      responseHeaders: finalizeHeaders(response.headers),
      responseJson,
      responseTextPreview: text.slice(0, 400),
    });
    return createResponseClone(text, response);
  };

  parentWindow.fetch = sentinelFetch;
  childWindow.fetch = sentinelFetch;
  vm.createContext(childWindow);
  vm.createContext(parentWindow);
  vm.runInContext(sdkSource, childWindow, { timeout: 10_000 });
  vm.runInContext(sdkSource, parentWindow, { timeout: 10_000 });

  return {
    async token(flow) {
      return parentWindow.SentinelSDK.token(flow);
    },
    async sessionObserverToken(flow) {
      return parentWindow.SentinelSDK.sessionObserverToken(flow);
    },
    steps,
  };
}

function base64Json(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

function sentinelHash(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 2246822507) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 3266489909) >>> 0;
  hash ^= hash >>> 16;
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function buildSentinelData() {
  const now = new Date();
  return [
    3280,
    String(now),
    0,
    Math.random(),
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'https://sentinel.openai.com/sentinel/20260219f9f6/sdk.js',
    null,
    'en-US',
    'en-US,en',
    Math.random(),
    'userAgent−Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'documentElement',
    'SentinelSDK',
    0,
    crypto.randomUUID(),
    '',
    8,
    performance.timeOrigin,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
}

function generateSentinelAnswer(seed, difficulty = '0') {
  const startedAt = performance.now();
  const data = buildSentinelData();
  for (let attempt = 0; attempt < 500_000; attempt += 1) {
    data[3] = attempt;
    data[9] = Math.round(performance.now() - startedAt);
    const candidate = base64Json(data);
    if (sentinelHash(`${seed}${candidate}`).substring(0, String(difficulty).length) <= String(difficulty)) {
      return `${candidate}~S`;
    }
  }
  return `wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D${base64Json('generate-failed')}`;
}

function buildRequirementsToken() {
  return `gAAAAAC${generateSentinelAnswer(String(Math.random()), '0')}`;
}

function buildEnforcementToken(responseJson) {
  const proof = responseJson?.proofofwork;
  if (!proof?.required || typeof proof.seed !== 'string' || typeof proof.difficulty !== 'string') {
    return null;
  }
  return `gAAAAAB${generateSentinelAnswer(proof.seed, proof.difficulty)}`;
}

function mergeLiveToken(template, liveToken, proofToken = null) {
  return JSON.stringify({
    ...(template ?? {}),
    ...(proofToken ? { p: proofToken } : {}),
    ...(proofToken && Object.prototype.hasOwnProperty.call(template ?? {}, 't') ? { t: null } : {}),
    c: liveToken,
  });
}

function shouldUseSdkToken(sentinel, headerTemplates) {
  if (sentinel?.recoveredFromSummary) return true;
  return Object.values(headerTemplates ?? {}).some((template) =>
    Object.prototype.hasOwnProperty.call(template ?? {}, 't')
      && (!template?.p || !template?.t));
}

function buildCookieFromTemplate(requestTemplate) {
  const deviceId = String(requestTemplate?.body?.id ?? '').trim();
  if (!deviceId) return '';
  return `oai-did=${encodeURIComponent(deviceId)}`;
}

function normalizeRecoveredSentinel(sentinel) {
  if (!sentinel) return sentinel;
  if (
    Object.keys(sentinel.headerTemplates ?? {}).length > 0
    && Object.keys(sentinel.requestTemplates ?? {}).length > 0
  ) {
    return sentinel;
  }

  const headerTemplates = { ...(sentinel.headerTemplates ?? {}) };
  const requestTemplates = { ...(sentinel.requestTemplates ?? {}) };
  for (const entry of sentinel.headerFlows ?? []) {
    if (!entry?.path || !entry?.headerName || !entry?.flow) continue;
    headerTemplates[entry.path] ??= {};
    headerTemplates[entry.path][entry.headerName] = {
      flow: entry.flow,
    };
    requestTemplates[entry.flow] ??= {
      url: 'https://sentinel.openai.com/backend-api/sentinel/req',
      method: 'POST',
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        origin: 'https://auth.openai.com',
      },
      body: {
        flow: entry.flow,
      },
    };
  }

  return {
    ...sentinel,
    headerTemplates,
    requestTemplates,
  };
}

export function createOpenAiSentinelProvider({ sentinel, fetchImpl = fetch, now = null }) {
  const normalizedSentinel = normalizeRecoveredSentinel(sentinel);
  let sdkSourcePromise = null;

  async function buildSdkHeaders({ flow, headerTemplates, requestTemplate, requestPath }) {
    sdkSourcePromise ??= loadCurrentSdkSource(fetchImpl);
    const { scriptSrc, sdkSource } = await sdkSourcePromise;
    const runtime = createSentinelSdkRuntime({
      fetchImpl,
      scriptSrc,
      sdkSource,
      locationHref: requestPath === '/api/accounts/create_account'
        ? 'https://auth.openai.com/about-you'
        : 'https://auth.openai.com/create-account/password',
      cookie: buildCookieFromTemplate(requestTemplate),
      now,
    });
    const token = await runtime.token(flow);
    let sessionObserverToken = null;
    if (Object.prototype.hasOwnProperty.call(headerTemplates, 'openai-sentinel-so-token')) {
      sessionObserverToken = await runtime.sessionObserverToken(flow);
    }

    const headers = {};
    for (const headerName of Object.keys(headerTemplates)) {
      if (headerName === 'openai-sentinel-so-token') headers[headerName] = sessionObserverToken;
      else headers[headerName] = token;
    }

    const step = runtime.steps.find((entry) => entry.name === flowToStepName(flow)) ?? runtime.steps[0] ?? {
      name: flowToStepName(flow),
      url: requestTemplate.url,
      method: requestTemplate.method ?? 'POST',
      requestedAt: serializeTimestamp(now),
      elapsedMs: 0,
      status: null,
      requestHeaders: {},
      requestBody: null,
      responseHeaders: {},
      responseJson: null,
      responseTextPreview: '',
    };

    return {
      flow,
      headers,
      responseJson: step.responseJson,
      step,
    };
  }

  async function buildHeadersForPath(requestPath) {
    const headerTemplates = normalizedSentinel?.headerTemplates?.[requestPath];
    if (!headerTemplates || Object.keys(headerTemplates).length === 0) {
      throw new Error(`No sentinel header templates found for ${requestPath}`);
    }

    const flow = Object.values(headerTemplates).find((value) => value?.flow)?.flow ?? null;
    if (!flow) {
      throw new Error(`No sentinel flow found for ${requestPath}`);
    }

    const requestTemplate = normalizedSentinel?.requestTemplates?.[flow];
    if (!requestTemplate) {
      throw new Error(`No sentinel request template found for flow ${flow}`);
    }

    if (shouldUseSdkToken(normalizedSentinel, headerTemplates)) {
      return buildSdkHeaders({ flow, headerTemplates, requestTemplate, requestPath });
    }

    const requestHeaders = {
      'user-agent': AUTH_USER_AGENT,
      'accept-language': 'en-US,en;q=0.9',
      ...(requestTemplate.headers ?? {}),
    };
    const requestBody = JSON.stringify({
      ...(requestTemplate.body ?? {}),
      p: requestTemplate.body?.p || buildRequirementsToken(),
    });
    const startedAtMs = Date.now();
    const response = await fetchImpl(requestTemplate.url, {
      method: requestTemplate.method ?? 'POST',
      headers: requestHeaders,
      body: requestBody,
      redirect: 'manual',
    });
    const text = await response.text();
    const elapsedMs = Date.now() - startedAtMs;
    const responseJson = parseJsonSafe(text, null);
    if (!responseJson?.token) {
      throw new Error(`Sentinel response missing token for flow ${flow}`);
    }

    const proofToken = buildEnforcementToken(responseJson);
    const headers = {};
    for (const [headerName, template] of Object.entries(headerTemplates)) {
      headers[headerName] = mergeLiveToken(template, responseJson.token, proofToken);
    }

    return {
      flow,
      headers,
      responseJson,
      step: {
        name: flowToStepName(flow),
        url: requestTemplate.url,
        method: requestTemplate.method ?? 'POST',
        requestedAt: serializeTimestamp(now),
        elapsedMs,
        status: response.status,
        requestHeaders,
        requestBody,
        responseHeaders: finalizeHeaders(response.headers),
        responseJson,
        responseTextPreview: text.slice(0, 400),
      },
    };
  }

  return {
    buildHeadersForPath,
  };
}
