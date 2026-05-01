import React from 'react';
import { render } from 'ink-testing-library';
import { VaultScreen } from '../src/tui/screens/VaultScreen.js';

test('renders unlock prompt', () => {
  const { lastFrame } = render(React.createElement(VaultScreen, { mode: 'unlock', error: null }));
  expect(lastFrame()).toContain('Vault Passcode');
  expect(lastFrame()).toContain('Enter passcode to unlock');
});

test('renders create prompt', () => {
  const { lastFrame } = render(React.createElement(VaultScreen, { mode: 'create', error: null }));
  expect(lastFrame()).toContain('Create a new passcode');
});

test('renders confirm prompt', () => {
  const { lastFrame } = render(React.createElement(VaultScreen, { mode: 'confirm', error: null }));
  expect(lastFrame()).toContain('Confirm passcode');
});
