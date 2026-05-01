import { describe, expect, test } from '@jest/globals';

import { createNetworkRecorder } from '../../../src/pipeline/authTrace/cdpLive/browserCdp.js';

describe('browserCdp navigation', () => {
  test('tolerates HTTP response code failures from Page.navigate when page still loads', async () => {
    const handlers = new Map();
    const sent = [];
    class FakeWebSocket {
      constructor() {
        this.readyState = 1;
        queueMicrotask(() => this.onopen?.());
      }

      send(payload) {
        const message = JSON.parse(payload);
        sent.push(message);
        if (message.method === 'Target.getTargets') {
          queueMicrotask(() => this.onmessage?.({
            data: JSON.stringify({
              id: message.id,
              result: {
                targetInfos: [{
                  targetId: 'ABCDEF1234567890',
                  type: 'page',
                  title: 'Login',
                  url: 'https://auth.openai.com/log-in/password',
                }],
              },
            }),
          }));
          return;
        }
        if (message.method === 'Target.attachToTarget') {
          queueMicrotask(() => this.onmessage?.({
            data: JSON.stringify({
              id: message.id,
              result: { sessionId: 'SESSION-1' },
            }),
          }));
          return;
        }
        if (message.method === 'Page.navigate') {
          queueMicrotask(() => this.onmessage?.({
            data: JSON.stringify({
              id: message.id,
              sessionId: 'SESSION-1',
              result: {
                frameId: 'FRAME-1',
                loaderId: 'LOADER-1',
                errorText: 'net::ERR_HTTP_RESPONSE_CODE_FAILURE',
              },
            }),
          }));
          queueMicrotask(() => handlers.get('Page.loadEventFired')?.({}, { method: 'Page.loadEventFired', sessionId: 'SESSION-1' }));
          return;
        }
        if (message.method === 'Runtime.evaluate') {
          queueMicrotask(() => this.onmessage?.({
            data: JSON.stringify({
              id: message.id,
              sessionId: 'SESSION-1',
              result: { result: { value: 'complete' } },
            }),
          }));
          return;
        }
        if (message.method === 'Network.getCookies') {
          queueMicrotask(() => this.onmessage?.({
            data: JSON.stringify({
              id: message.id,
              sessionId: 'SESSION-1',
              result: { cookies: [] },
            }),
          }));
          return;
        }
        queueMicrotask(() => this.onmessage?.({
          data: JSON.stringify({
            id: message.id,
            sessionId: 'SESSION-1',
            result: {},
          }),
        }));
      }

      close() {
        queueMicrotask(() => this.onclose?.());
      }

      set onmessage(handler) {
        this._onmessage = handler;
      }

      get onmessage() {
        return this._onmessage;
      }

      set onopen(handler) {
        this._onopen = handler;
      }

      get onopen() {
        return this._onopen;
      }

      set onclose(handler) {
        this._onclose = handler;
      }

      get onclose() {
        return this._onclose;
      }

      set onerror(handler) {
        this._onerror = handler;
      }

      get onerror() {
        return this._onerror;
      }
    }

    globalThis.WebSocket = FakeWebSocket;
    const recorder = await createNetworkRecorder({
      targetId: 'ABCDEF1234567890',
      networkEventsPath: '.tmp-browser-cdp-network.jsonl',
      cdpWsUrl: 'ws://example.test/devtools/browser',
    });

    const onEventMethods = sent.filter((message) => message.method === 'Page.enable');
    expect(onEventMethods.length).toBeGreaterThan(0);

    await expect(recorder.navigate('https://auth.openai.com/log-in/password')).resolves.toContain('Navigated');
    await recorder.stop();
  });
});