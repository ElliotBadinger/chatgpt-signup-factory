const DEFAULT_WS_URL = 'wss://ws.agentmail.to/v0';
const DEFAULT_API_URL = 'https://api.agentmail.to/v0';
const DEFAULT_EVENT_TYPES = ['message.received'];
const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const processGlobalTransports = new Map();

function identityKey(inboxId, messageId) {
  if (!inboxId || !messageId) {
    return null;
  }
  return `${inboxId}:${messageId}`;
}

function normalizeError(error, fallbackMessage) {
  if (error instanceof Error) {
    return error;
  }
  return new Error(error?.message ?? fallbackMessage);
}

async function requestJson(url, { apiKey, fetchImpl }) {
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP_${response.status}`);
  }

  return response.json();
}

function attachSocketHandler(socket, eventName, handler) {
  if (typeof socket?.on === 'function') {
    socket.on(eventName, handler);
    return;
  }

  if (typeof socket?.addEventListener === 'function') {
    socket.addEventListener(eventName, (event) => {
      handler(event?.data ?? event);
    });
  }
}

function createDefaultWebsocketConnector({ url, logger }) {
  return async function connectWebsocket() {
    if (typeof WebSocket !== 'function') {
      throw new Error('WebSocket is not available in this runtime');
    }

    logger?.debug?.('Opening AgentMail websocket', { url });
    return new WebSocket(url);
  };
}

export function extractInboundIdentifiers(message = {}, thread = {}) {
  return {
    inboxId: message.inboxId
      ?? message.inbox_id
      ?? thread.inboxId
      ?? thread.inbox_id
      ?? null,
    messageId: message.messageId
      ?? message.message_id
      ?? null,
    threadId: message.threadId
      ?? message.thread_id
      ?? thread.threadId
      ?? thread.thread_id
      ?? null,
  };
}

export function buildSubscribeFrame(inboxIds = []) {
  return {
    type: 'subscribe',
    inboxIds: Array.from(new Set(inboxIds.filter(Boolean))),
    eventTypes: DEFAULT_EVENT_TYPES.slice(),
  };
}

function normalizeInboundEvent({ raw, source }) {
  const rawType = raw?.type;
  const eventType = raw?.eventType ?? raw?.event_type ?? rawType;
  const normalizedType = eventType === 'message_received' ? 'message.received' : eventType;

  if (normalizedType !== 'message.received') {
    return null;
  }

  const message = raw?.message ?? {};
  const thread = raw?.thread ?? null;
  const identifiers = extractInboundIdentifiers(message, thread ?? {});
  const content = {
    html: message.html ?? null,
    text: message.text ?? null,
    preferredBody: message.html ?? message.text ?? null,
  };

  return {
    kind: 'new-inbound-message',
    source,
    inboxId: identifiers.inboxId,
    messageId: identifiers.messageId,
    threadId: identifiers.threadId,
    receivedAt: message.timestamp ?? message.receivedAt ?? message.received_at ?? null,
    message,
    thread,
    content,
    raw,
  };
}

function normalizePollMessage({ inboxId, message, thread = null }) {
  return normalizeInboundEvent({
    source: 'poll',
    raw: {
      type: 'message.received',
      message: {
        ...message,
        inbox_id: message?.inbox_id ?? inboxId,
      },
      thread: thread ?? {
        inbox_id: thread?.inbox_id ?? inboxId,
        thread_id: message?.thread_id ?? thread?.thread_id ?? null,
      },
    },
  });
}

function createTransportController({
  apiKey,
  connectWebsocket,
  fetchImpl,
  now,
  timers,
  logger,
}) {
  const watchersByInbox = new Map();
  const seenMessageKeys = new Set();
  const pendingMatchers = new Set();
  let socket = null;
  let connectPromise = null;
  let reconnectTimer = null;
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  let pollingTimer = null;
  let pollingActive = false;
  let shutdownRequested = false;

  function getInboxIds() {
    return Array.from(watchersByInbox.keys()).sort();
  }

  function addWatcher(inboxId, watcher) {
    if (!watchersByInbox.has(inboxId)) {
      watchersByInbox.set(inboxId, new Set());
    }
    watchersByInbox.get(inboxId).add(watcher);
  }

  function removeWatcher(inboxId, watcher) {
    const watchers = watchersByInbox.get(inboxId);
    if (!watchers) {
      return;
    }
    watchers.delete(watcher);
    if (watchers.size === 0) {
      watchersByInbox.delete(inboxId);
    }
  }

  function emitInboundEvent(event) {
    if (!event?.inboxId) {
      return false;
    }

    const key = identityKey(event.inboxId, event.messageId);
    if (key && seenMessageKeys.has(key)) {
      logger?.debug?.('Suppressing duplicate AgentMail inbound message', {
        inboxId: event.inboxId,
        messageId: event.messageId,
        source: event.source,
      });
      return false;
    }

    if (key) {
      seenMessageKeys.add(key);
    }

    const watchers = watchersByInbox.get(event.inboxId);
    if (watchers) {
      for (const watcher of watchers) {
        watcher.onMessage?.(event);
      }
    }

    for (const matcher of Array.from(pendingMatchers)) {
      if (matcher.inboxId !== event.inboxId) {
        continue;
      }

      let matches = false;
      try {
        matches = Boolean(matcher.matcher(event));
      } catch (error) {
        matcher.reject(error);
        pendingMatchers.delete(matcher);
        continue;
      }

      if (matches) {
        matcher.resolve(event);
        pendingMatchers.delete(matcher);
      }
    }

    return true;
  }

  function sendSubscribeFrame() {
    if (!socket || typeof socket.send !== 'function') {
      return;
    }

    const frame = buildSubscribeFrame(getInboxIds());
    if (frame.inboxIds.length === 0) {
      return;
    }

    logger?.debug?.('Subscribing AgentMail websocket', frame);
    socket.send(frame);
  }

  function stopPollingLoop() {
    if (pollingTimer) {
      timers.clearTimeout(pollingTimer);
      pollingTimer = null;
    }
    pollingActive = false;
  }

  async function listInboxMessages(inboxId, { limit = 10 } = {}) {
    const url = `${DEFAULT_API_URL}/inboxes/${encodeURIComponent(inboxId)}/messages?limit=${limit}`;
    try {
      return await requestJson(url, { apiKey, fetchImpl });
    } catch (error) {
      if (String(error?.message ?? '').startsWith('HTTP_')) {
        const status = String(error.message).replace('HTTP_', '');
        throw new Error(`AgentMail list failed for ${inboxId}: ${status}`);
      }
      throw error;
    }
  }

  async function getInboxMessage(inboxId, messageId) {
    const url = `${DEFAULT_API_URL}/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`;
    try {
      return await requestJson(url, { apiKey, fetchImpl });
    } catch (error) {
      if (String(error?.message ?? '').startsWith('HTTP_')) {
        const status = String(error.message).replace('HTTP_', '');
        throw new Error(`AgentMail message fetch failed for ${inboxId}/${messageId}: ${status}`);
      }
      throw error;
    }
  }

  async function ingestPollMessages({ inboxId, messages = [] }) {
    for (const message of messages) {
      let fullMessage = message;
      const messageId = message?.message_id ?? message?.messageId ?? null;

      if (messageId) {
        try {
          fullMessage = await getInboxMessage(inboxId, messageId);
        } catch (error) {
          logger?.debug?.('AgentMail poll message detail fetch failed', {
            inboxId,
            messageId,
            error: error?.message,
          });
        }
      }

      const normalized = normalizePollMessage({ inboxId, message: fullMessage });
      emitInboundEvent(normalized);
    }
  }

  async function reconcileInbox(inboxId) {
    const listed = await listInboxMessages(inboxId);
    await ingestPollMessages({
      inboxId,
      messages: listed?.messages ?? [],
    });
  }

  async function pollActiveInboxes() {
    const inboxIds = getInboxIds();
    for (const inboxId of inboxIds) {
      await reconcileInbox(inboxId);
    }
  }

  async function runPollingLoop() {
    if (shutdownRequested || pollingActive) {
      return;
    }

    pollingActive = true;
    try {
      await pollActiveInboxes();
    } finally {
      pollingActive = false;
      if (!shutdownRequested && getInboxIds().length > 0) {
        pollingTimer = timers.setTimeout(() => {
          void runPollingLoop();
        }, DEFAULT_POLL_INTERVAL_MS);
      }
    }
  }

  function startPollingLoop() {
    if (shutdownRequested) {
      return;
    }
    if (!pollingTimer && !pollingActive) {
      pollingTimer = timers.setTimeout(() => {
        pollingTimer = null;
        void runPollingLoop();
      }, 0);
    }
  }

  function scheduleReconnect() {
    if (shutdownRequested || reconnectTimer || getInboxIds().length === 0) {
      return;
    }

    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      void ensureSocket();
    }, delay);
  }

  function handleSocketOpen() {
    logger?.info?.('AgentMail websocket opened');
    reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    stopPollingLoop();
    sendSubscribeFrame();
  }

  function handleSocketClose(payload) {
    logger?.warn?.('AgentMail websocket closed', payload);
    socket = null;
    connectPromise = null;
    scheduleReconnect();
    startPollingLoop();
  }

  function handleSocketMessage(payload) {
    const rawPayload = typeof payload === 'string'
      ? JSON.parse(payload)
      : payload;
    const normalized = normalizeInboundEvent({
      raw: rawPayload,
      source: 'websocket',
    });
    if (normalized) {
      emitInboundEvent(normalized);
    }
  }

  function registerSocketHandlers(nextSocket) {
    attachSocketHandler(nextSocket, 'open', handleSocketOpen);
    attachSocketHandler(nextSocket, 'close', handleSocketClose);
    attachSocketHandler(nextSocket, 'message', handleSocketMessage);
    attachSocketHandler(nextSocket, 'error', (error) => {
      logger?.warn?.('AgentMail websocket error', error);
    });
  }

  async function ensureSocket() {
    if (shutdownRequested || getInboxIds().length === 0) {
      return socket;
    }
    if (socket) {
      return socket;
    }
    if (connectPromise) {
      return connectPromise;
    }

    connectPromise = Promise.resolve()
      .then(() => connectWebsocket())
      .then((nextSocket) => {
        socket = nextSocket;
        registerSocketHandlers(nextSocket);
        return nextSocket;
      })
      .catch((error) => {
        socket = null;
        connectPromise = null;
        logger?.warn?.('Falling back to AgentMail polling after websocket connect failure', error);
        startPollingLoop();
        scheduleReconnect();
        throw error;
      });

    return connectPromise;
  }

  async function watchInbox({ inboxId, onMessage } = {}) {
    if (!inboxId) {
      throw new Error('inboxId is required');
    }

    const watcher = { onMessage };
    addWatcher(inboxId, watcher);

    try {
      await ensureSocket();
    } catch {
      // Polling fallback is activated by ensureSocket.
    }

    return () => removeWatcher(inboxId, watcher);
  }

  async function waitForMatchingMessage({
    inboxId,
    matcher,
    timeoutMs = 120_000,
  }) {
    if (typeof matcher !== 'function') {
      throw new Error('matcher is required');
    }

    await watchInbox({ inboxId });

    return new Promise((resolve, reject) => {
      const pending = {
        inboxId,
        matcher,
        resolve: (event) => {
          if (timeoutTimer) {
            timers.clearTimeout(timeoutTimer);
          }
          pendingMatchers.delete(pending);
          resolve(event);
        },
        reject: (error) => {
          if (timeoutTimer) {
            timers.clearTimeout(timeoutTimer);
          }
          pendingMatchers.delete(pending);
          reject(error);
        },
      };

      const timeoutTimer = timers.setTimeout(() => {
        pendingMatchers.delete(pending);
        reject(new Error(`Timed out waiting for AgentMail message in ${inboxId}`));
      }, timeoutMs);

      pendingMatchers.add(pending);
      startPollingLoop();
    });
  }

  async function shutdown() {
    shutdownRequested = true;
    stopPollingLoop();
    if (reconnectTimer) {
      timers.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    for (const pending of Array.from(pendingMatchers)) {
      pending.reject(new Error('Transport shutdown'));
    }

    pendingMatchers.clear();
    watchersByInbox.clear();

    if (socket && typeof socket.close === 'function') {
      socket.close();
    }

    socket = null;
    connectPromise = null;
  }

  return {
    watchInbox,
    waitForMatchingMessage,
    ingestPollMessages,
    listInboxMessages,
    getInboxMessage,
    reconcileInbox,
    shutdown,
  };
}

export function createAgentMailInboundTransport(options = {}) {
  const {
    apiKey,
    connectWebsocket,
    fetchImpl = fetch,
    now = () => Date.now(),
    timers = {
      setTimeout,
      clearTimeout,
    },
    logger = console,
  } = options;

  if (!apiKey) {
    throw new Error('apiKey is required');
  }

  const url = `${DEFAULT_WS_URL}?api_key=${encodeURIComponent(apiKey)}`;
  const effectiveConnectWebsocket = connectWebsocket
    ?? createDefaultWebsocketConnector({ url, logger });
  const existing = processGlobalTransports.get(apiKey);

  if (existing) {
    return existing;
  }

  const transport = createTransportController({
    apiKey,
    connectWebsocket: effectiveConnectWebsocket,
    fetchImpl,
    now,
    timers,
    logger,
  });

  const wrappedTransport = {
    ...transport,
    async shutdown() {
      processGlobalTransports.delete(apiKey);
      await transport.shutdown();
    },
  };

  processGlobalTransports.set(apiKey, wrappedTransport);
  return wrappedTransport;
}