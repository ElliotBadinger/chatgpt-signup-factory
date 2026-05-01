const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const screenshotPath = path.join(
  __dirname,
  '..',
  'app.asar.extracted',
  'dist',
  'main',
  'screenshot.js'
);

function withMockedElectron(fn) {
  const originalLoad = Module._load;
  Module._load = function patched(request, parent) {
    if (request === 'electron') {
      return {
        nativeImage: {
          createFromBuffer() {
            return {
              resize() {
                return { toDataURL() { return 'data:image/png;base64,test'; } };
              },
            };
          },
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[screenshotPath];
  try {
    return fn(require(screenshotPath));
  } finally {
    delete require.cache[screenshotPath];
    Module._load = originalLoad;
  }
}

test('shouldTreatAsLowSignal keeps sparse but text-heavy referral pages', () => {
  withMockedElectron(({ shouldTreatAsLowSignal }) => {
    const imageSignal = {
      distinctSamples: 5,
      channelSpread: 58,
      lowSignal: false,
    };
    const pageSignal = {
      bodyTextLength: 1175,
      bodyChildCount: 4,
      title: 'Join Claude!',
      readyState: 'complete',
      visibilityState: 'visible',
    };

    assert.equal(shouldTreatAsLowSignal(imageSignal, pageSignal), false);
  });
});

test('shouldTreatAsLowSignal still rejects nearly blank low-text frames', () => {
  withMockedElectron(({ shouldTreatAsLowSignal }) => {
    const imageSignal = {
      distinctSamples: 1,
      channelSpread: 2,
      lowSignal: true,
    };
    const pageSignal = {
      bodyTextLength: 10,
      bodyChildCount: 4,
      title: 'Join Claude!',
      readyState: 'complete',
      visibilityState: 'visible',
    };

    assert.equal(shouldTreatAsLowSignal(imageSignal, pageSignal), true);
  });
});
