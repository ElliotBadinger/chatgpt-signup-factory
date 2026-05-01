# AgentMail WebSocket-First Inbound Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace steady-state AgentMail polling with a shared process-global WebSocket-first inbound transport while preserving existing OTP/invite business logic through a unified inbound-message adapter and bounded polling fallback.

**Architecture:** Add a new shared AgentMail inbound transport manager that owns a process-global websocket connection per API key, normalizes inbound websocket and polling payloads into one event shape, and exposes mailbox wait helpers for current OTP/invite consumers. Keep existing REST polling only for startup reconciliation, post-reconnect catch-up, and explicit fallback when websocket establishment fails.

**Tech Stack:** Node.js ESM, Jest, existing global `fetch`, AgentMail websocket protocol, current `src/pipeline/authTrace/*` helpers.

---

## File Structure

### Create
- `src/pipeline/authTrace/agentMailInboundTransport.js` — shared process-global websocket manager, subscription registry, event normalization, reconnect/resubscribe logic, reconciliation hooks, duplicate suppression, and transport-agnostic wait helpers.
- `tests/pipeline/authTrace/agentMailInboundTransport.test.js` — websocket-first transport tests covering subscribe, event normalization, reconnect/resubscribe, fallback polling, and duplicate suppression.

### Modify
- `src/pipeline/authTrace/agentMailOtp.js` — keep REST list/get helpers and OTP extraction, but route mailbox waiting through the new shared transport and normalized message shape.
- `src/pipeline/authTrace/openaiAuthReplay.js` — keep OTP behavior but switch to websocket-first mailbox waiting via the transport-backed OTP helper.
- `src/pipeline/rotation/routerOnboarder.js` — use the updated OTP helper without assuming polling is primary.
- `src/pipeline/rotation/chatGptAccountCreator.js` — replace direct polling loops for OTP/invite waits with transport-backed wait helpers while preserving matching/extraction logic.
- `tests/pipeline/rotation/routerOnboarder.test.js` — add/adjust tests so OTP callers still pass under websocket-first helper semantics.
- `tests/pipeline/rotation/chatGptAccountCreator.test.js` — add/adjust tests so OTP/invite call sites still behave correctly with the transport-backed waits.

---

### Task 1: Add failing tests for the shared websocket transport

**Files:**
- Create: `tests/pipeline/authTrace/agentMailInboundTransport.test.js`
- Test: `tests/pipeline/authTrace/agentMailInboundTransport.test.js`

- [ ] **Step 1: Write the failing transport tests**

```javascript
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

import {
  createAgentMailInboundTransport,
} from '../../../src/pipeline/authTrace/agentMailInboundTransport.js';

function makeSocket() {
  const handlers = new Map();
  return {
    sent: [],
    on: jest.fn((event, handler) => {
      handlers.set(event, handler);
    }),
    emit(event, payload) {
      const handler = handlers.get(event);
      if (handler) handler(payload);
    },
    send: jest.fn((payload) => {
      socket.sent.push(payload);
    }),
    close: jest.fn(),
  };
}

describe('AgentMail inbound transport', () => {
  let socket;
  let connect;
  let transport;
  let fetchImpl;

  beforeEach(() => {
    socket = makeSocket();
    connect = jest.fn().mockResolvedValue(socket);
    fetchImpl = jest.fn();
    transport = createAgentMailInboundTransport({
      apiKey: 'am_us_test',
      connectWebsocket: connect,
      fetchImpl,
      now: () => 1_700_000_000_000,
      timers: {
        setTimeout,
        clearTimeout,
      },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      },
    });
  });

  afterEach(async () => {
    await transport.shutdown();
    jest.restoreAllMocks();
  });

  test('subscribes on open for message.received events', async () => {
    await transport.watchInbox({ inboxId: 'otp@agentmail.to' });
    socket.emit('open');

    expect(connect).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'subscribe',
      inboxIds: ['otp@agentmail.to'],
      eventTypes: ['message.received'],
    }));
  });

  test('normalizes wrapped dot-style websocket events into inbound message events', async () => {
    const received = [];
    await transport.watchInbox({
      inboxId: 'otp@agentmail.to',
      onMessage: (event) => received.push(event),
    });
    socket.emit('open');
    socket.emit('message', {
      type: 'event',
      eventType: 'message.received',
      eventId: 'evt_1',
      message: {
        inbox_id: 'otp@agentmail.to',
        message_id: 'msg_1',
        thread_id: 'thr_1',
        subject: 'Your code',
        html: '<p>654321</p>',
      },
      thread: {
        inbox_id: 'otp@agentmail.to',
        thread_id: 'thr_1',
      },
    });

    expect(received).toEqual([
      expect.objectContaining({
        kind: 'new-inbound-message',
        source: 'websocket',
        inboxId: 'otp@agentmail.to',
        messageId: 'msg_1',
        threadId: 'thr_1',
        content: expect.objectContaining({
          html: '<p>654321</p>',
          text: null,
          preferredBody: '<p>654321</p>',
        }),
      }),
    ]);
  });

  test('reconnects and resubscribes after close', async () => {
    const secondSocket = makeSocket();
    connect
      .mockResolvedValueOnce(socket)
      .mockResolvedValueOnce(secondSocket);

    await transport.watchInbox({ inboxId: 'otp@agentmail.to' });
    socket.emit('open');
    socket.emit('close', { code: 1006, reason: 'network' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    secondSocket.emit('open');

    expect(connect).toHaveBeenCalledTimes(2);
    expect(secondSocket.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'subscribe',
      inboxIds: ['otp@agentmail.to'],
      eventTypes: ['message.received'],
    }));
  });

  test('falls back to polling when websocket establishment fails', async () => {
    connect.mockRejectedValue(new Error('connect failed'));
    fetchImpl.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        messages: [
          {
            message_id: 'msg_poll_1',
            timestamp: '2026-03-29T00:00:00.000Z',
            subject: 'OTP 222333',
            html: '<p>OTP 222333</p>',
          },
        ],
      }),
    });
    fetchImpl.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message_id: 'msg_poll_1',
        timestamp: '2026-03-29T00:00:00.000Z',
        subject: 'OTP 222333',
        html: '<p>OTP 222333</p>',
      }),
    });

    const match = await transport.waitForMatchingMessage({
      inboxId: 'otp@agentmail.to',
      timeoutMs: 50,
      matcher: (event) => event.message.subject.includes('222333'),
    });

    expect(match.source).toBe('poll');
    expect(fetchImpl).toHaveBeenCalled();
  });

  test('suppresses duplicate websocket and poll deliveries for the same inbox/message id', async () => {
    const received = [];
    await transport.watchInbox({
      inboxId: 'otp@agentmail.to',
      onMessage: (event) => received.push(event),
    });
    socket.emit('open');
    socket.emit('message', {
      type: 'message_received',
      message: {
        inbox_id: 'otp@agentmail.to',
        message_id: 'msg_1',
        subject: 'dup',
        html: '<p>dup</p>',
      },
      thread: { inbox_id: 'otp@agentmail.to', thread_id: 'thr_1' },
    });

    await transport.ingestPollMessages({
      inboxId: 'otp@agentmail.to',
      messages: [{
        message_id: 'msg_1',
        timestamp: '2026-03-29T00:00:00.000Z',
        subject: 'dup',
        html: '<p>dup</p>',
      }],
    });

    expect(received).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the new transport test file to verify RED**

Run: `npm test -- tests/pipeline/authTrace/agentMailInboundTransport.test.js --runInBand`

Expected: FAIL with module-not-found / missing export errors for `agentMailInboundTransport.js` and/or missing transport API methods.

- [ ] **Step 3: Commit the failing tests**

```bash
git add tests/pipeline/authTrace/agentMailInboundTransport.test.js
git commit -m "test: add failing AgentMail websocket transport tests"
```

---

### Task 2: Implement the shared process-global websocket transport

**Files:**
- Create: `src/pipeline/authTrace/agentMailInboundTransport.js`
- Test: `tests/pipeline/authTrace/agentMailInboundTransport.test.js`

- [ ] **Step 1: Write the minimal shared transport implementation**

```javascript
const DEFAULT_WS_URL = 'wss://ws.agentmail.to/v0';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeEventType(event = {}) {
  const directType = String(event.type ?? '');
  const wrappedType = String(event.eventType ?? event.event_type ?? '');
  if (directType === 'message_received') return 'message.received';
  if (wrappedType === 'message_received') return 'message.received';
  if (wrappedType === 'message.received') return 'message.received';
  return directType === 'event' ? wrappedType : directType;
}

function normalizeInboundMessage({ source, rawEvent, message, thread = null }) {
  const inboxId = message?.inboxId ?? message?.inbox_id ?? thread?.inboxId ?? thread?.inbox_id ?? null;
  const messageId = message?.messageId ?? message?.message_id ?? null;
  const threadId = message?.threadId ?? message?.thread_id ?? thread?.threadId ?? thread?.thread_id ?? null;
  const receivedAt = message?.timestamp ?? message?.receivedAt ?? message?.created_at ?? null;
  const html = message?.html ?? null;
  const text = message?.text ?? null;

  return {
    kind: 'new-inbound-message',
    source,
    inboxId,
    messageId,
    threadId,
    receivedAt,
    message,
    thread,
    content: {
      html,
      text,
      preferredBody: html ?? text ?? null,
    },
    raw: rawEvent,
  };
}

export function createAgentMailInboundTransport({
  apiKey,
  connectWebsocket,
  fetchImpl = fetch,
  logger = console,
  now = () => Date.now(),
  timers = { setTimeout, clearTimeout },
}) {
  const subscribers = new Map();
  const seenMessageKeys = new Set();
  let socket = null;
  let connecting = null;
  let reconnectAttempt = 0;
  let closed = false;

  function messageKey(event) {
    return `${event.inboxId ?? 'unknown'}:${event.messageId ?? 'unknown'}`;
  }

  function emit(event) {
    if (!event.inboxId) return;
    const key = messageKey(event);
    if (seenMessageKeys.has(key)) {
      logger.debug?.('[agentmail] duplicate inbound suppressed', { key, source: event.source });
      return;
    }
    seenMessageKeys.add(key);
    const bucket = subscribers.get(event.inboxId);
    if (!bucket) return;
    bucket.watermark = Math.max(bucket.watermark ?? 0, event.receivedAt ? new Date(event.receivedAt).getTime() : now());
    for (const listener of bucket.listeners) {
      listener(event);
    }
  }

  async function sendSubscribe() {
    const inboxIds = [...subscribers.keys()];
    if (!socket || inboxIds.length === 0) return;
    socket.send({
      type: 'subscribe',
      inboxIds,
      eventTypes: ['message.received'],
    });
    logger.info?.('[agentmail] subscribed', { inboxIds, eventTypes: ['message.received'] });
  }

  async function connect() {
    if (closed || connecting) return connecting;
    connecting = (async () => {
      try {
        socket = await connectWebsocket({
          apiKey,
          url: `${DEFAULT_WS_URL}?api_key=${encodeURIComponent(apiKey)}`,
        });
        socket.on('open', async () => {
          reconnectAttempt = 0;
          logger.info?.('[agentmail] websocket open');
          await sendSubscribe();
          await reconcileAll();
        });
        socket.on('message', async (rawEvent) => {
          const eventType = normalizeEventType(rawEvent);
          if (eventType !== 'message.received') return;
          const payload = rawEvent?.type === 'event' ? rawEvent : rawEvent;
          emit(normalizeInboundMessage({
            source: 'websocket',
            rawEvent,
            message: payload.message ?? {},
            thread: payload.thread ?? null,
          }));
        });
        socket.on('close', () => scheduleReconnect());
        socket.on('error', () => scheduleReconnect());
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  }

  function scheduleReconnect() {
    if (closed) return;
    reconnectAttempt += 1;
    const delay = Math.min(30_000, 500 * (2 ** (reconnectAttempt - 1)) + Math.floor(Math.random() * 100));
    logger.warn?.('[agentmail] websocket reconnect scheduled', { reconnectAttempt, delay });
    timers.setTimeout(() => {
      connect().catch(async () => {
        await reconcileAll();
        scheduleReconnect();
      });
    }, delay);
  }

  async function listMessages({ inboxId }) {
    const response = await fetchImpl(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages?limit=20`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`AgentMail list failed for ${inboxId}: ${response.status}`);
    return await response.json();
  }

  async function getMessage({ inboxId, messageId }) {
    const response = await fetchImpl(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`AgentMail message fetch failed for ${inboxId}/${messageId}: ${response.status}`);
    return await response.json();
  }

  async function reconcileInbox(inboxId) {
    const bucket = subscribers.get(inboxId);
    if (!bucket) return;
    const data = await listMessages({ inboxId });
    for (const listedMessage of data.messages ?? []) {
      const listedAt = listedMessage.timestamp ? new Date(listedMessage.timestamp).getTime() : 0;
      if (listedAt < (bucket.watermark ?? 0) - 5_000) continue;
      const fullMessage = listedMessage.message_id ? await getMessage({ inboxId, messageId: listedMessage.message_id }) : listedMessage;
      emit(normalizeInboundMessage({
        source: 'poll',
        rawEvent: fullMessage,
        message: fullMessage,
        thread: fullMessage.thread ?? null,
      }));
    }
  }

  async function reconcileAll() {
    await Promise.all([...subscribers.keys()].map((inboxId) => reconcileInbox(inboxId).catch((error) => {
      logger.warn?.('[agentmail] reconcile failed', { inboxId, error: error.message });
    })));
  }

  return {
    async watchInbox({ inboxId, onMessage = () => {} }) {
      const bucket = subscribers.get(inboxId) ?? { listeners: new Set(), watermark: 0 };
      bucket.listeners.add(onMessage);
      subscribers.set(inboxId, bucket);
      await connect().catch(async (error) => {
        logger.warn?.('[agentmail] websocket connect failed, using poll fallback', { error: error.message, inboxId });
        await reconcileInbox(inboxId);
      });
      return () => {
        const existing = subscribers.get(inboxId);
        if (!existing) return;
        existing.listeners.delete(onMessage);
        if (existing.listeners.size === 0) subscribers.delete(inboxId);
      };
    },

    async waitForMatchingMessage({ inboxId, matcher, timeoutMs = 120_000 }) {
      return await new Promise(async (resolve, reject) => {
        const timeout = timers.setTimeout(() => reject(new Error(`Timed out waiting for inbound message for ${inboxId}`)), timeoutMs);
        const stop = await this.watchInbox({
          inboxId,
          onMessage: (event) => {
            if (!matcher(event)) return;
            timers.clearTimeout(timeout);
            stop();
            resolve(event);
          },
        });
      });
    },

    async ingestPollMessages({ inboxId, messages }) {
      for (const message of messages) {
        emit(normalizeInboundMessage({ source: 'poll', rawEvent: message, message, thread: message.thread ?? null }));
      }
    },

    async shutdown() {
      closed = true;
      subscribers.clear();
      if (socket?.close) socket.close();
    },
  };
}
```

- [ ] **Step 2: Run the transport tests to verify GREEN**

Run: `npm test -- tests/pipeline/authTrace/agentMailInboundTransport.test.js --runInBand`

Expected: PASS for all transport-focused tests.

- [ ] **Step 3: Refactor transport internals for clarity while keeping tests green**

```javascript
// Inside src/pipeline/authTrace/agentMailInboundTransport.js
export function extractInboundIdentifiers(message = {}, thread = null) {
  return {
    inboxId: message?.inboxId ?? message?.inbox_id ?? thread?.inboxId ?? thread?.inbox_id ?? null,
    messageId: message?.messageId ?? message?.message_id ?? null,
    threadId: message?.threadId ?? message?.thread_id ?? thread?.threadId ?? thread?.thread_id ?? null,
  };
}

export function buildSubscribeFrame(inboxIds) {
  return {
    type: 'subscribe',
    inboxIds,
    eventTypes: ['message.received'],
  };
}
```

- [ ] **Step 4: Commit the transport implementation**

```bash
git add src/pipeline/authTrace/agentMailInboundTransport.js tests/pipeline/authTrace/agentMailInboundTransport.test.js
git commit -m "feat: add AgentMail websocket inbound transport"
```

---

### Task 3: Convert `agentMailOtp.js` to use the shared inbound transport

**Files:**
- Modify: `src/pipeline/authTrace/agentMailOtp.js`
- Test: `tests/pipeline/rotation/routerOnboarder.test.js`

- [ ] **Step 1: Add failing tests for transport-backed OTP waiting and HTML-first extraction**

```javascript
test('finds OTP in HTML-only AgentMail content when text and preview are absent', async () => {
  global.fetch = jest.fn().mockImplementation(async (url) => {
    if (String(url).includes('/messages?limit=10')) {
      return {
        ok: true,
        json: async () => ({
          messages: [
            { message_id: 'm-html', timestamp: '2026-03-29T00:00:00.000Z', subject: 'OpenAI' },
          ],
        }),
      };
    }
    if (String(url).includes('/messages/m-html')) {
      return {
        ok: true,
        json: async () => ({
          message_id: 'm-html',
          timestamp: '2026-03-29T00:00:00.000Z',
          subject: 'OpenAI',
          html: '<div>Your ChatGPT code is <strong>640151</strong></div>',
        }),
      };
    }
    throw new Error(`Unexpected URL ${url}`);
  });

  const result = await fetchLatestInboxOtp({
    inboxId: 'lovelypopulation489@agentmail.to',
    apiKey: 'am_us_test',
    fetchImpl: global.fetch,
  });

  expect(result.otp).toBe('640151');
});
```

- [ ] **Step 2: Run the OTP-related test file to verify RED**

Run: `npm test -- tests/pipeline/rotation/routerOnboarder.test.js --runInBand`

Expected: FAIL because `agentMailOtp.js` does not yet expose transport-backed mailbox waiting and/or HTML-first normalized matching semantics.

- [ ] **Step 3: Update `agentMailOtp.js` to delegate waiting to the transport and preserve OTP extraction**

```javascript
import { createAgentMailInboundTransport } from './agentMailInboundTransport.js';

const transportRegistry = new Map();

function getTransport({ apiKey, fetchImpl = fetch, logger = console }) {
  const key = `${apiKey}`;
  if (!transportRegistry.has(key)) {
    transportRegistry.set(key, createAgentMailInboundTransport({
      apiKey,
      fetchImpl,
      logger,
      connectWebsocket: async ({ url }) => {
        const WebSocketImpl = globalThis.WebSocket;
        if (!WebSocketImpl) {
          throw new Error('Global WebSocket implementation is not available');
        }
        const socket = new WebSocketImpl(url);
        return {
          on(event, handler) {
            if (event === 'message') {
              socket.addEventListener('message', (incoming) => handler(JSON.parse(incoming.data)));
              return;
            }
            socket.addEventListener(event, handler);
          },
          send(payload) {
            socket.send(JSON.stringify(payload));
          },
          close() {
            socket.close();
          },
        };
      },
    }));
  }
  return transportRegistry.get(key);
}

export async function waitForInboundOtp({
  inboxId,
  apiKey,
  sinceMs,
  timeoutMs = 120_000,
  fetchImpl = fetch,
}) {
  const transport = getTransport({ apiKey, fetchImpl });
  const event = await transport.waitForMatchingMessage({
    inboxId,
    timeoutMs,
    matcher: (candidate) => extractOtpFromMessageFields({
      subject: candidate.message?.subject,
      preview: candidate.message?.preview,
      text: candidate.content?.text,
      html: candidate.content?.html,
      body: candidate.content?.preferredBody,
    }) != null,
  });

  return {
    messageId: event.messageId,
    timestamp: event.receivedAt,
    subject: event.message?.subject ?? '',
    preview: event.message?.preview ?? '',
    otp: extractOtpFromMessageFields({
      subject: event.message?.subject,
      preview: event.message?.preview,
      text: event.content?.text,
      html: event.content?.html,
      body: event.content?.preferredBody,
    }),
    fullMessage: event.message,
  };
}

export async function pollFreshInboxOtp(options) {
  return await waitForInboundOtp(options);
}
```

- [ ] **Step 4: Run the OTP-related tests to verify GREEN**

Run: `npm test -- tests/pipeline/rotation/routerOnboarder.test.js --runInBand`

Expected: PASS, including the new HTML-only OTP coverage.

- [ ] **Step 5: Commit the OTP helper migration**

```bash
git add src/pipeline/authTrace/agentMailOtp.js tests/pipeline/rotation/routerOnboarder.test.js
git commit -m "feat: route AgentMail OTP waits through websocket transport"
```

---

### Task 4: Replace direct OTP/invite polling in `chatGptAccountCreator.js`

**Files:**
- Modify: `src/pipeline/rotation/chatGptAccountCreator.js`
- Test: `tests/pipeline/rotation/chatGptAccountCreator.test.js`

- [ ] **Step 1: Add failing tests for transport-backed OTP and invite waits**

```javascript
test('uses the shared inbound transport for OTP and invite waits', async () => {
  const page = mockPage([
    E_FIND_SIGNUP_URL,
    E_SIGNUP_OK,
    E_OTP_NEEDED,
    E_FILL_OTP_OK,
    E_ACCEPT_OK,
    E_SESSION(),
  ]);

  const waitForInboundMessage = jest
    .fn()
    .mockResolvedValueOnce({
      message: { subject: 'Your ChatGPT code is 123456', html: '<p>123456</p>' },
      content: { html: '<p>123456</p>', text: null, preferredBody: '<p>123456</p>' },
      messageId: 'otp_msg',
      receivedAt: '2026-03-29T00:00:00.000Z',
      source: 'websocket',
    })
    .mockResolvedValueOnce({
      message: { subject: 'Invite', html: '<a href="https://chatgpt.com/invitations/abc123">accept</a>' },
      content: { html: '<a href="https://chatgpt.com/invitations/abc123">accept</a>', text: null, preferredBody: '<a href="https://chatgpt.com/invitations/abc123">accept</a>' },
      messageId: 'invite_msg',
      receivedAt: '2026-03-29T00:00:01.000Z',
      source: 'websocket',
    });

  const result = await createChatGptAccount(page, {
    ...BASE_OPTS,
    teamInviteCallback: jest.fn().mockResolvedValue({}),
    waitForInboundMessage,
  });

  expect(result.success).toBe(true);
  expect(waitForInboundMessage).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the chatGPT account creator tests to verify RED**

Run: `npm test -- tests/pipeline/rotation/chatGptAccountCreator.test.js --runInBand`

Expected: FAIL because `createChatGptAccount()` does not yet accept or use the transport-backed message wait helper.

- [ ] **Step 3: Replace direct polling calls with transport-backed waiting while preserving matching rules**

```javascript
import { waitForInboundOtp, waitForInboundMessage } from '../authTrace/agentMailOtp.js';

function extractInviteLinkFromInboundEvent(event) {
  const text = [
    event.message?.subject ?? '',
    event.content?.preferredBody ?? '',
    event.message?.preview ?? '',
  ].join(' ');
  const match = INVITE_LINK_REGEX.exec(text);
  return match ? match[0] : null;
}

// Inside createChatGptAccount()
const otpMessage = !skipOtpPoll
  ? await waitForInboundOtp({
      inboxId: agentMailInboxId,
      apiKey: agentMailApiKey,
      sinceMs: otpSinceMs,
      timeoutMs: agentMailTimeoutMs,
      fetchImpl: fetch,
    })
  : null;

const inviteEvent = await waitForInboundMessage({
  inboxId: agentMailInboxId,
  apiKey: agentMailApiKey,
  sinceMs: inviteSinceMs,
  timeoutMs: agentMailTimeoutMs,
  fetchImpl: fetch,
  matcher: (event) => {
    const text = `${event.message?.subject ?? ''} ${event.content?.preferredBody ?? ''} ${event.message?.preview ?? ''}`;
    return (
      text.includes('invited you to join') ||
      text.includes('invited you to ChatGPT') ||
      text.includes('invited you to collaborate') ||
      text.includes('ChatGPT Business') ||
      INVITE_LINK_REGEX.test(text)
    );
  },
});

const inviteLink = extractInviteLinkFromInboundEvent(inviteEvent);
```

- [ ] **Step 4: Run the chatGPT account creator tests to verify GREEN**

Run: `npm test -- tests/pipeline/rotation/chatGptAccountCreator.test.js --runInBand`

Expected: PASS, including the new transport-backed OTP/invite wait coverage.

- [ ] **Step 5: Commit the account creator migration**

```bash
git add src/pipeline/rotation/chatGptAccountCreator.js tests/pipeline/rotation/chatGptAccountCreator.test.js
git commit -m "feat: use websocket-first AgentMail waits in account creator"
```

---

### Task 5: Update remaining consumers and validate end-to-end behavior

**Files:**
- Modify: `src/pipeline/authTrace/openaiAuthReplay.js`
- Modify: `src/pipeline/rotation/routerOnboarder.js`
- Test: `tests/pipeline/rotation/routerOnboarder.test.js`
- Test: `tests/pipeline/authTrace/agentMailInboundTransport.test.js`
- Test: `tests/pipeline/rotation/chatGptAccountCreator.test.js`

- [ ] **Step 1: Add failing regression coverage for caller integration**

```javascript
test('router onboarding still requests a fresh OTP through the shared helper', async () => {
  const prepareLogin = jest.fn().mockResolvedValue({
    otpRequestedAt: new Date('2026-03-15T18:55:00.000Z').getTime(),
    page: {},
    cleanup: jest.fn().mockResolvedValue({}),
    fillRes: { emailFilled: true },
    state: { state: 'otp-needed', url: 'https://auth.openai.com/email-verification' },
  });

  const completeLogin = jest.fn().mockResolvedValue({
    finalUrl: 'https://chatgpt.com/',
    title: 'ChatGPT',
    session: {
      user: { email: 'eagerstatus254@agentmail.to' },
      expires: '2026-06-13T18:59:15.674Z',
      account: { id: 'd3d588b2-8a74-4acc-aa2e-94662ff0e025', planType: 'team' },
      accessToken: makeJwt('eagerstatus254@agentmail.to'),
      authProvider: 'openai',
    },
  });

  const waitForInboundOtp = jest.fn().mockResolvedValue({ otp: '619121' });

  const result = await onboardInboxToPiRouter({
    email: 'eagerstatus254@agentmail.to',
    apiKey: 'am_us_test',
    authJsonPath: authPath,
    routerJsonPath: routerPath,
    prepareLogin,
    completeLogin,
    waitForInboundOtp,
  });

  expect(result.aliasId).toBe('eagerstatus254');
  expect(waitForInboundOtp).toHaveBeenCalledWith(expect.objectContaining({
    inboxId: 'eagerstatus254@agentmail.to',
    apiKey: 'am_us_test',
  }));
});
```

- [ ] **Step 2: Run the integration-oriented test files to verify RED**

Run: `npm test -- tests/pipeline/rotation/routerOnboarder.test.js tests/pipeline/rotation/chatGptAccountCreator.test.js --runInBand`

Expected: FAIL because the remaining callers still hard-wire the old helper surfaces or do not inject the new transport-backed wait helpers.

- [ ] **Step 3: Update the remaining consumers to use the new helper signatures**

```javascript
// In src/pipeline/rotation/routerOnboarder.js
import {
  fetchLatestInboxOtp,
  pollFreshInboxOtp,
  waitForInboundOtp,
} from '../authTrace/agentMailOtp.js';

export async function onboardInboxToPiRouter({
  email,
  apiKey,
  waitForInboundOtp: waitForInboundOtpImpl = waitForInboundOtp,
  ...rest
}) {
  // ...
  const otp = await waitForInboundOtpImpl({
    inboxId: email,
    apiKey,
    fetchImpl,
    sinceMs: Math.max(0, Number(prepared.otpRequestedAt ?? 0) - 5_000),
  });
  // ...
}

// In src/pipeline/authTrace/openaiAuthReplay.js
import { waitForInboundOtp } from './agentMailOtp.js';

async function provideOtp({ email, sinceMs, otpProvider, poolPath, fetchImpl, agentMailApiKey }) {
  if (otpProvider) {
    return otpProvider({ email, sinceMs });
  }

  const effectiveApiKey = agentMailApiKey
    ?? loadPoolEntry(email, poolPath || path.join(os.homedir(), '.pi', 'agent', 'codex-inbox-pool.json'))?.rootApiKey
    ?? null;
  if (!effectiveApiKey) {
    throw new Error(`No AgentMail API key available for ${email}`);
  }

  return await waitForInboundOtp({
    inboxId: email,
    apiKey: effectiveApiKey,
    sinceMs,
    fetchImpl,
  });
}
```

- [ ] **Step 4: Run the targeted integration tests to verify GREEN**

Run: `npm test -- tests/pipeline/authTrace/agentMailInboundTransport.test.js tests/pipeline/rotation/routerOnboarder.test.js tests/pipeline/rotation/chatGptAccountCreator.test.js --runInBand`

Expected: PASS across transport, router onboarding, and account creator coverage.

- [ ] **Step 5: Run the full Jest suite for final verification**

Run: `npm test -- --runInBand`

Expected: PASS with no newly failing tests.

- [ ] **Step 6: Commit the remaining consumer updates**

```bash
git add src/pipeline/authTrace/openaiAuthReplay.js src/pipeline/rotation/routerOnboarder.js tests/pipeline/rotation/routerOnboarder.test.js tests/pipeline/authTrace/agentMailInboundTransport.test.js tests/pipeline/rotation/chatGptAccountCreator.test.js
git commit -m "feat: adopt shared AgentMail inbound transport across callers"
```

---

## Self-Review Checklist

- Spec coverage:
  - WebSocket-first transport: Tasks 1-2
  - unified inbound adapter: Tasks 2-3
  - current OTP/invite consumers: Tasks 3-5
  - reconnect/resubscribe/fallback polling: Tasks 1-2
  - duplicate suppression: Tasks 1-2
  - HTML-first extraction: Task 3
- Placeholder scan: no TBD/TODO placeholders remain in the tasks.
- Type consistency:
  - transport helpers use `waitForMatchingMessage`, `watchInbox`, `ingestPollMessages`, `shutdown`
  - OTP helper uses `waitForInboundOtp`
  - account creator uses `waitForInboundMessage` / transport-backed waits

## Notes for the Implementer

- Keep the process-global transport keyed by API key so multiple inboxes can share one websocket.
- Support both `inboxIds` and inbound `inbox_id`/`inboxId` forms, but standardize internal output to `inboxId`.
- Use websocket payload `message` + `thread` directly whenever present.
- Polling remains bounded and secondary: startup reconciliation, reconnect catch-up, explicit connection-failure fallback.
- Do not reintroduce steady-state polling loops in call sites after the transport exists.
