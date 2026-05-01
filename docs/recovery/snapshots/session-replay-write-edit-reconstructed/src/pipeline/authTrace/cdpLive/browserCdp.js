import { createWriteStream, existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { createCriticalAuthTracker } from './criticalAuthTracker.js';

const TIMEOUT = 15000;
const NAVIGATION_TIMEOUT = 30000;

function portFileCandidates() {
  return [
    path.resolve(homedir(), 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
    path.resolve(homedir(), '.config/google-chrome/DevToolsActivePort'),
    path.resolve(homedir(), '.config/google-chrome/Default/DevToolsActivePort'),
    path.resolve(homedir(), '.config/chromium/DevToolsActivePort'),
    path.resolve(homedir(), '.config/chromium/Default/DevToolsActivePort'),
  ];
}

export async function getBrowserWsUrl({ cdpPort = null, cdpWsUrl = null } = {}) {
  if (cdpWsUrl) return cdpWsUrl;

  const candidates = portFileCandidates();
  if (cdpPort != null) {
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const lines = (await readFile(candidate, 'utf8')).trim().split('\n');
      if (lines[0] === String(cdpPort) && lines[1]) {
        return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
      }
    }
    return `ws://127.0.0.1:${cdpPort}/devtools/browser`;
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const lines = (await readFile(candidate, 'utf8')).trim().split('\n');
    if (lines[0] && lines[1]) {
      return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
    }
  }

  throw new Error(`Could not find DevToolsActivePort. Checked: ${candidates.join(', ')}`);
}

export class CDPClient {
  #ws;
  #id = 0;
  #pending = new Map();
  #handlers = new Map();
  #closeHandlers = [];

  async connect(wsUrl) {
    await new Promise((resolve, reject) => {
      this.#ws = new WebSocket(wsUrl);
      this.#ws.onopen = () => resolve();
      this.#ws.onerror = (event) => reject(new Error(`WebSocket error: ${event.message || event.type}`));
      this.#ws.onclose = () => this.#closeHandlers.forEach((handler) => handler());
      this.#ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && this.#pending.has(msg.id)) {
          const { resolve: done, reject: fail, timer } = this.#pending.get(msg.id);
          clearTimeout(timer);
          this.#pending.delete(msg.id);
          if (msg.error) fail(new Error(msg.error.message));
          else done(msg.result);
          return;
        }
        if (msg.method && this.#handlers.has(msg.method)) {
          for (const handler of this.#handlers.get(msg.method)) {
            handler(msg.params || {}, msg);
          }
        }
      };
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, TIMEOUT);
      this.#pending.set(id, { resolve, reject, timer });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.#ws.send(JSON.stringify(payload));
    });
  }

  onEvent(method, handler) {
    if (!this.#handlers.has(method)) this.#handlers.set(method, new Set());
    this.#handlers.get(method).add(handler);
    return () => this.#handlers.get(method)?.delete(handler);
  }

  onClose(handler) {
    this.#closeHandlers.push(handler);
  }

  close() {
    this.#ws?.close();
  }
}

export async function listOpenPages(cdpOptions = {}) {
  const client = new CDPClient();
  await client.connect(await getBrowserWsUrl(cdpOptions));
  try {
    const { targetInfos } = await client.send('Target.getTargets');
    return targetInfos
      .filter((target) => target.type === 'page' && !target.url.startsWith('chrome://'))
      .map((target) => ({
        targetId: target.targetId,
        targetIdPrefix: target.targetId.slice(0, 8).toUpperCase(),
        title: target.title,
        url: target.url,
      }));
  } finally {
    client.close();
  }
}

function nowIso(nowFactory) {
  return (nowFactory ? nowFactory() : new Date()).toISOString();
}

function sessionInvalid(error) {
  return /Session with given id not found|No session with given id|Target closed|Cannot find context/i.test(String(error?.message ?? error));
}

function shouldShowAxNode(node, compact = false) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  return role !== 'none' && role !== 'generic' && !(name === '' && (value === '' || value == null));
}

function formatAxNode(node, depth) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  const indent = '  '.repeat(Math.min(depth, 10));
  let line = `${indent}[${role}]`;
  if (name !== '') line += ` ${name}`;
  if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
  return line;
}

function orderedAxChildren(node, nodesById, childrenByParent) {
  const children = [];
  const seen = new Set();
  for (const childId of node.childIds || []) {
    const child = nodesById.get(childId);
    if (child && !seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  for (const child of childrenByParent.get(node.nodeId) || []) {
    if (!seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  return children;
}

async function waitForDocumentReady(send, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const { result } = await send('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
        awaitPromise: true,
      });
      lastState = result.value;
      if (lastState === 'complete') return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (lastState) throw new Error(`Timed out waiting for navigation to finish (last readyState: ${lastState})`);
  if (lastError) throw new Error(`Timed out waiting for navigation to finish (${lastError.message})`);
  throw new Error('Timed out waiting for navigation to finish');
}

export async function createNetworkRecorder({ targetId, networkEventsPath, cdpPort = null, cdpWsUrl = null, now = null }) {
  const client = new CDPClient();
  await client.connect(await getBrowserWsUrl({ cdpPort, cdpWsUrl }));

  let currentTargetId = targetId;
  let sessionId = null;
  let lastKnownUrl = null;
  let lastKnownTitle = null;
  let loadWaiters = [];

  const writer = createWriteStream(networkEventsPath, { flags: 'a' });
  const criticalRequestsPath = path.join(path.dirname(networkEventsPath), 'critical-requests.jsonl');
  const criticalWriter = createWriteStream(criticalRequestsPath, { flags: 'a' });
  const eventCounts = {};
  const pendingAsync = [];

  async function findBestTargetId() {
    const { targetInfos } = await client.send('Target.getTargets');
    const pages = targetInfos.filter((target) => target.type === 'page' && !target.url.startsWith('chrome://'));
    if (currentTargetId && pages.some((page) => page.targetId === currentTargetId)) return currentTargetId;
    const authCandidates = pages.filter((page) => /auth\.openai\.com|chatgpt\.com/.test(page.url));
    if (lastKnownUrl) {
      const sameOrigin = pages.filter((page) => {
        try {
          return new URL(page.url).origin === new URL(lastKnownUrl).origin;
        } catch {
          return false;
        }
      });
      if (sameOrigin.length === 1) return sameOrigin[0].targetId;
    }
    if (authCandidates.length === 1) return authCandidates[0].targetId;
    if (authCandidates.length > 0) return authCandidates[authCandidates.length - 1].targetId;
    if (pages.length > 0) return pages[pages.length - 1].targetId;
    throw new Error('No live page target available to attach recorder');
  }

  async function attachToTarget(nextTargetId) {
    currentTargetId = nextTargetId;
    const attached = await client.send('Target.attachToTarget', { targetId: nextTargetId, flatten: true });
    sessionId = attached.sessionId;
    await client.send('Page.enable', {}, sessionId);
    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Network.enable', {
      maxTotalBufferSize: 0,
      maxResourceBufferSize: 0,
      maxPostDataSize: 0,
    }, sessionId);
  }

  async function reattach() {
    await attachToTarget(await findBestTargetId());
  }

  async function send(method, params = {}) {
    try {
      if (!sessionId) await reattach();
      return await client.send(method, params, sessionId);
    } catch (error) {
      if (!sessionInvalid(error)) throw error;
      await reattach();
      return client.send(method, params, sessionId);
    }
  }

  const criticalTracker = createCriticalAuthTracker({
    writeCriticalRecord: async (record) => {
      criticalWriter.write(`${JSON.stringify(record)}\n`);
    },
    getResponseBody: async (requestId) => send('Network.getResponseBody', { requestId }),
    now,
  });

  const record = (method, params, msg = {}) => {
    eventCounts[method] = (eventCounts[method] ?? 0) + 1;
    if (params?.frame?.url) lastKnownUrl = params.frame.url;
    if (params?.frame?.name) lastKnownTitle = params.frame.name;
    if (params?.request?.url) lastKnownUrl = params.request.url;
    if (params?.response?.url) lastKnownUrl = params.response.url;
    if (method === 'Page.loadEventFired') {
      const waiters = loadWaiters;
      loadWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
    writer.write(`${JSON.stringify({ ts: nowIso(now), method, sessionId: msg.sessionId ?? null, params })}\n`);
    pendingAsync.push(Promise.resolve(criticalTracker.onEvent(method, params)).catch(() => {}));
  };

  const unsubscribers = [
    'Network.requestWillBeSent',
    'Network.requestWillBeSentExtraInfo',
    'Network.responseReceived',
    'Network.responseReceivedExtraInfo',
    'Network.loadingFinished',
    'Network.loadingFailed',
    'Network.requestServedFromCache',
    'Page.frameNavigated',
    'Page.navigatedWithinDocument',
    'Page.lifecycleEvent',
    'Page.loadEventFired',
    'Runtime.consoleAPICalled',
    'Runtime.exceptionThrown',
    'Target.targetInfoChanged',
    'Target.targetCreated',
    'Target.targetDestroyed',
    'Target.detachedFromTarget',
  ].map((method) => client.onEvent(method, (params, msg) => record(method, params, msg)));

  async function readRuntimeState() {
    const { result } = await send('Runtime.evaluate', {
      expression: `(() => ({
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        referrer: document.referrer,
        localStorage: Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => {
          const key = localStorage.key(i);
          return [key, localStorage.getItem(key)];
        })),
        sessionStorage: Object.fromEntries(Array.from({ length: sessionStorage.length }, (_, i) => {
          const key = sessionStorage.key(i);
          return [key, sessionStorage.getItem(key)];
        })),
      }))()`,
      returnByValue: true,
      awaitPromise: true,
    });
    lastKnownUrl = result.value?.url ?? lastKnownUrl;
    lastKnownTitle = result.value?.title ?? lastKnownTitle;
    return result.value;
  }

  async function readCookies(currentUrl) {
    const urls = [...new Set([
      currentUrl,
      'https://auth.openai.com/',
      'https://chatgpt.com/',
      'https://openai.com/',
    ].filter(Boolean))];
    const { cookies } = await send('Network.getCookies', { urls });
    return cookies;
  }

  async function captureBoundary(phase) {
    const state = await readRuntimeState();
    const cookies = await readCookies(state.url);
    return {
      phase,
      capturedAt: nowIso(now),
      targetId: currentTargetId,
      targetIdPrefix: currentTargetId?.slice(0, 8).toUpperCase() ?? null,
      url: state.url,
      title: state.title,
      readyState: state.readyState,
      referrer: state.referrer,
      cookies,
      storage: {
        localStorage: state.localStorage,
        sessionStorage: state.sessionStorage,
      },
      eventCounts: { ...eventCounts },
    };
  }

  async function navigate(url) {
    await send('Page.enable', {});
    const loadPromise = new Promise((resolve) => {
      loadWaiters.push(resolve);
    });
    const result = await send('Page.navigate', { url });
    if (result.errorText) throw new Error(result.errorText);
    if (result.loaderId) {
      await Promise.race([
        loadPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for load event')), NAVIGATION_TIMEOUT)),
      ]);
    }
    await waitForDocumentReady(send, 5000);
    return `Navigated to ${url}`;
  }

  async function snapshot() {
    const { nodes } = await send('Accessibility.getFullAXTree', {});
    const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
    const childrenByParent = new Map();
    for (const node of nodes) {
      if (!node.parentId) continue;
      if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
      childrenByParent.get(node.parentId).push(node);
    }

    const lines = [];
    const visited = new Set();
    function visit(node, depth) {
      if (!node || visited.has(node.nodeId)) return;
      visited.add(node.nodeId);
      if (shouldShowAxNode(node, true)) lines.push(formatAxNode(node, depth));
      for (const child of orderedAxChildren(node, nodesById, childrenByParent)) visit(child, depth + 1);
    }

    const roots = nodes.filter((node) => !node.parentId || !nodesById.has(node.parentId));
    for (const root of roots) visit(root, 0);
    for (const node of nodes) visit(node, 0);
    return lines.join('\n');
  }

  async function html() {
    const { result } = await send('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true,
      awaitPromise: true,
    });
    return String(result.value ?? '');
  }

  async function resourceEntries() {
    const { result } = await send('Runtime.evaluate', {
      expression: `JSON.stringify(performance.getEntriesByType('resource').map(e => ({ name: e.name.substring(0, 120), type: e.initiatorType, duration: Math.round(e.duration), size: e.transferSize })))`,
      returnByValue: true,
      awaitPromise: true,
    });
    return JSON.parse(result.value ?? '[]').map((e) => `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${String(e.type || '').padEnd(8)}  ${e.name}`).join('\n');
  }

  async function pageMeta() {
    const state = await readRuntimeState();
    return {
      result: {
        type: 'object',
        value: { url: state.url, title: state.title },
      },
    };
  }

  async function screenshot(filePath) {
    const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await writeFile(filePath, Buffer.from(data, 'base64'));
    return `Saved screenshot to ${filePath}`;
  }

  async function stop() {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    await Promise.allSettled(pendingAsync);
    await new Promise((resolve) => writer.end(resolve));
    await new Promise((resolve) => criticalWriter.end(resolve));
    client.close();
    return {
      stoppedAt: nowIso(now),
      targetId: currentTargetId,
      targetIdPrefix: currentTargetId?.slice(0, 8).toUpperCase() ?? null,
      lastKnownUrl,
      lastKnownTitle,
      eventCounts: { ...eventCounts },
      ...criticalTracker.summary(),
      criticalRequestsPath,
    };
  }

  await reattach();

  return {
    captureBoundary,
    navigate,
    snapshot,
    html,
    resourceEntries,
    pageMeta,
    screenshot,
    stop,
  };
}
