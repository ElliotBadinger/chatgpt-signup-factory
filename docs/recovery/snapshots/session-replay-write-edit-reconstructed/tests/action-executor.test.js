const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const actionExecutorPath = path.join(
  __dirname,
  '..',
  'app.asar.extracted',
  'dist',
  'main',
  'action-executor.js'
);

function withActionExecutor(fn) {
  const calls = [];
  const screenshotCalls = [];
  const fakeCdpActions = {
    attachDebugger: async () => calls.push(['attachDebugger']),
    waitForLoad: async () => calls.push(['waitForLoad']),
    evaluateJs: async (_win, expression, arg) => ({ expression, arg }),
    getCurrentUrl: async () => 'https://example.com',
    clickAbsolute: async (_win, x, y, button, width, height, clickCount) => calls.push(['clickAbsolute', x, y, button, width, height, clickCount]),
    mouseDownAbsolute: async (_win, x, y, button, width, height) => calls.push(['mouseDownAbsolute', x, y, button, width, height]),
    mouseUpAbsolute: async (_win, x, y, button, width, height) => calls.push(['mouseUpAbsolute', x, y, button, width, height]),
    typeAbsolute: async (_win, text, x, y, clearFirst, pressEnter, width, height) => calls.push(['typeAbsolute', text, x, y, clearFirst, pressEnter, width, height]),
    scrollAbsolute: async (_win, direction, amount, x, y, width, height) => calls.push(['scrollAbsolute', direction, amount, x, y, width, height]),
    keyPress: async (_win, key) => calls.push(['keyPress', key]),
    hoverAbsolute: async (_win, x, y, width, height) => calls.push(['hoverAbsolute', x, y, width, height]),
    gotoUrl: async (_win, url) => calls.push(['gotoUrl', url]),
    goBack: async () => calls.push(['goBack']),
    goForward: async () => calls.push(['goForward']),
    refresh: async () => calls.push(['refresh']),
    wait: async (duration) => calls.push(['wait', duration]),
    dragAbsolute: async (_win, startX, startY, endX, endY, width, height) => calls.push(['dragAbsolute', startX, startY, endX, endY, width, height]),
  };
  const fakeScreenshot = {
    captureScreenshot: async (_win, width, height) => {
      screenshotCalls.push([width, height]);
      return 'data:image/webp;base64,ZmFrZQ==';
    },
  };

  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === './cdp-actions' && parent && parent.filename === actionExecutorPath) {
      return fakeCdpActions;
    }
    if (request === './screenshot' && parent && parent.filename === actionExecutorPath) {
      return fakeScreenshot;
    }
    return originalLoad.apply(this, arguments);
  };

  delete require.cache[actionExecutorPath];
  try {
    const { ActionExecutor } = require(actionExecutorPath);
    const win = {
      isDestroyed: () => false,
      webContents: { executeJavaScript: () => Promise.resolve() },
    };
    const windowManager = {
      createTaskWindow: () => win,
      getActiveWindow: () => win,
      closeTaskWindows: () => {},
    };
    return fn({ ActionExecutor, calls, screenshotCalls, win, windowManager });
  } finally {
    delete require.cache[actionExecutorPath];
    Module._load = originalLoad;
  }
}

test('ActionExecutor initBrowser attaches debugger, waits for load, and captures initial state', async () => {
  await withActionExecutor(async ({ ActionExecutor, calls, screenshotCalls, windowManager }) => {
    const executor = new ActionExecutor('session-1', windowManager);
    const result = await executor.initBrowser('https://example.com', 1280, 800, false);

    assert.deepEqual(calls.slice(0, 2), [['attachDebugger'], ['waitForLoad']]);
    assert.deepEqual(screenshotCalls, [[1280, 800]]);
    assert.equal(result.url, 'https://example.com');
  });
});

const actionCases = [
  ['left_click', { action_type: 'left_click', x: 10, y: 20 }, 'clickAbsolute'],
  ['right_click', { action_type: 'right_click', x: 10, y: 20 }, 'clickAbsolute'],
  ['double_click', { action_type: 'double_click', x: 10, y: 20 }, 'clickAbsolute'],
  ['middle_click', { action_type: 'middle_click', x: 10, y: 20 }, 'clickAbsolute'],
  ['mouse_down', { action_type: 'mouse_down', x: 10, y: 20, button: 'left' }, 'mouseDownAbsolute'],
  ['mouse_up', { action_type: 'mouse_up', x: 10, y: 20, button: 'left' }, 'mouseUpAbsolute'],
  ['type', { action_type: 'type', text: 'hello', x: 1, y: 2, clear_first: true, press_enter: true }, 'typeAbsolute'],
  ['scroll', { action_type: 'scroll', direction: 'down', amount: 400, x: 1, y: 2 }, 'scrollAbsolute'],
  ['key_press', { action_type: 'key_press', key: 'Enter' }, 'keyPress'],
  ['hover', { action_type: 'hover', x: 10, y: 20 }, 'hoverAbsolute'],
  ['goto_url', { action_type: 'goto_url', url: 'https://example.com' }, 'gotoUrl'],
  ['go_back', { action_type: 'go_back' }, 'goBack'],
  ['go_forward', { action_type: 'go_forward' }, 'goForward'],
  ['refresh', { action_type: 'refresh' }, 'refresh'],
  ['wait', { action_type: 'wait', duration: 1 }, 'wait'],
  ['drag', { action_type: 'drag', start_x: 1, start_y: 2, end_x: 3, end_y: 4 }, 'dragAbsolute'],
];

for (const [name, action, expectedCall] of actionCases) {
  test(`ActionExecutor dispatches ${name} through ${expectedCall}`, async () => {
    await withActionExecutor(async ({ ActionExecutor, calls, screenshotCalls, windowManager }) => {
      const executor = new ActionExecutor('session-1', windowManager);
      await executor.initBrowser('https://example.com', 1280, 800, false);
      calls.length = 0;
      screenshotCalls.length = 0;

      const result = await executor.executeAction(action);

      assert.equal(calls.some((entry) => entry[0] === expectedCall), true);
      assert.deepEqual(screenshotCalls, [[1280, 800]]);
      assert.equal(result.success, true);
      assert.equal(result.url, 'https://example.com');
    });
  });
}
