import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

import { createAgentMailInboundTransport } from '../../../src/pipeline/authTrace/agentMailInboundTransport.js';

function makeSocket() {
  const handlers = new Map();
  const socket = {
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

  return socket;
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
    if (transport?.shutdown) {
      await transport.shutdown();
    }
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