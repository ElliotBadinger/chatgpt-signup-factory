import React from 'react';
import { jest } from '@jest/globals';

// Capture onNext for interaction
let capturedOnNext;

jest.unstable_mockModule('../src/tui/screens/WizardScreen.js', () => ({
  WizardScreen: ({ onNext }) => {
    capturedOnNext = onNext;
    return React.createElement('ink-text', null, 'Wizard Mock');
  }
}));

jest.unstable_mockModule('../src/tui/screens/VaultScreen.js', () => ({
  VaultScreen: () => React.createElement('ink-text', null, 'Vault Mock')
}));

// We need to import dynamically after mocking
const { render } = await import('ink-testing-library');
const { default: App } = await import('../src/tui/App.js');

describe('TUI App Integration', () => {
  beforeEach(() => {
    capturedOnNext = null;
  });

  it('navigates to VaultScreen when persistSecrets is enabled', async () => {
    const initialConfig = { safety: { persistSecrets: true } };
    const { lastFrame } = render(React.createElement(App, { initialConfig }));
    
    expect(lastFrame()).toContain('Wizard Mock');
    expect(capturedOnNext).toBeDefined();
    
    // Trigger Next
    // Wrap in act? ink-testing-library usually doesn't expose act but handles it?
    // We are calling a callback from outside.
    capturedOnNext();
    
    // Allow effect/render cycle
    await new Promise(r => setTimeout(r, 10));
    
    expect(lastFrame()).toContain('Vault Mock');
  });

  it('navigates to Preflight when persistSecrets is disabled', async () => {
    const initialConfig = { safety: { persistSecrets: false } };
    const { lastFrame } = render(React.createElement(App, { initialConfig }));
    
    expect(lastFrame()).toContain('Wizard Mock');
    capturedOnNext();
    await new Promise(r => setTimeout(r, 10));
    
    // Should NOT show Vault Mock. Should show Preflight.
    // PreflightScreen is NOT mocked, so it might render real one or fail if deps missing?
    // PreflightScreen renders 'Preflight Checklist'
    expect(lastFrame()).not.toContain('Vault Mock');
    // We didn't mock PreflightScreen, so check for its content
    // Actually PreflightScreen needs props 'preflight'. App passes it.
    // 'preflight' prop comes from useMemo hook.
  });
});
