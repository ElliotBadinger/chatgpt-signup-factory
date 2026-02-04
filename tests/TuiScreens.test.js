import React from 'react';
import { render } from 'ink-testing-library';
import { jest } from '@jest/globals';
import { WizardScreen } from '../src/tui/screens/WizardScreen.js';
import { PreflightScreen } from '../src/tui/screens/PreflightScreen.js';
import { ConfirmScreen } from '../src/tui/screens/ConfirmScreen.js';
import { RunningScreen } from '../src/tui/screens/RunningScreen.js';
import { ResultsScreen } from '../src/tui/screens/ResultsScreen.js';
import { PreflightResult } from '../src/models/PreflightResult.js';

describe('TUI Screens UX', () => {
  describe('WizardScreen', () => {
    it('renders and handles YAML load/save labels', () => {
      const config = { run: { headless: true }, identity: {} };
      const { lastFrame } = render(React.createElement(WizardScreen, { config }));
      expect(lastFrame()).toContain('Config Wizard');
      expect(lastFrame()).toContain('[l] Load YAML');
      expect(lastFrame()).toContain('[s] Save YAML');
    });
  });

  describe('PreflightScreen', () => {
    it('renders check results', () => {
      const preflight = new PreflightResult();
      preflight.addCheck('API Key', false, 'Missing');
      const { lastFrame } = render(React.createElement(PreflightScreen, { preflight }));
      expect(lastFrame()).toContain('Preflight Checklist');
      expect(lastFrame()).toContain('API Key: Missing');
    });
  });

  describe('ConfirmScreen', () => {
    it('shows redacted preview', () => {
      const configRedacted = { password: '[REDACTED]' };
      const { lastFrame } = render(React.createElement(ConfirmScreen, { configRedacted }));
      expect(lastFrame()).toContain('Confirm & Start');
      expect(lastFrame()).toContain('[REDACTED]');
    });
  });

  describe('RunningScreen', () => {
    it('shows timeline entries and artifact list', () => {
      const timeline = [{ ts: Date.now(), type: 'STEP', state: 'login' }];
      const runMeta = { runId: 'run-123', runDir: '/tmp/run-123' };
      const { lastFrame } = render(React.createElement(RunningScreen, { 
        timeline, 
        runMeta,
        artifacts: ['shot1.png', 'trace.json'] 
      }));
      expect(lastFrame()).toContain('Running');
      expect(lastFrame()).toContain('STEP [login]');
      expect(lastFrame()).toContain('shot1.png');
    });
  });

  describe('ResultsScreen', () => {
    it('shows bundle path and status', () => {
      const runMeta = { status: 'success', runId: '123', runDir: '/path/to/run' };
      const { lastFrame } = render(React.createElement(ResultsScreen, { runMeta }));
      expect(lastFrame()).toContain('Results');
      expect(lastFrame()).toContain('SUCCESS');
      expect(lastFrame()).toContain('/path/to/run');
    });
  });
});
