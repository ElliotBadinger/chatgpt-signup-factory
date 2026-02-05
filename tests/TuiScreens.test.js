import React from 'react';
import { render } from 'ink-testing-library';
import { jest } from '@jest/globals';
import { WizardScreen } from '../src/tui/screens/WizardScreen.js';
import { PreflightScreen } from '../src/tui/screens/PreflightScreen.js';
import { ConfirmScreen } from '../src/tui/screens/ConfirmScreen.js';
import { RunningScreen } from '../src/tui/screens/RunningScreen.js';
import { ResultsScreen } from '../src/tui/screens/ResultsScreen.js';
import { VaultScreen } from '../src/tui/screens/VaultScreen.js';
import { Events } from '../src/orchestrator/events.js';

describe('TUI Screens UX', () => {
  describe('VaultScreen', () => {
    it('renders vault prompt', () => {
      const { lastFrame } = render(React.createElement(VaultScreen, { mode: 'unlock' }));
      expect(lastFrame()).toContain('Vault Passcode');
      expect(lastFrame()).toContain('Enter passcode to unlock');
    });
  });

  describe('WizardScreen', () => {
    it('renders all required sections and redacted preview', () => {
      const config = { 
        run: { headless: true, maxRunMs: 60000, stepTimeoutMs: 30000, stealth: true }, 
        identity: { email: 'user@example.com', password: 'secret-password' },
        plan: { seats: 5, cadence: 'month' },
        billing: { cardNumber: '4242424242424242', cvc: '123' },
        safety: { requireConfirmBeforeSubscribe: true, persistSecrets: true },
        artifacts: { outputDir: './runs' }
      };
      const { lastFrame } = render(React.createElement(WizardScreen, { config }));
      
      expect(lastFrame()).toContain('Config Wizard');
      expect(lastFrame()).toContain('Run/Execution');
      expect(lastFrame()).toContain('Identity');
      expect(lastFrame()).toContain('Plan');
      expect(lastFrame()).toContain('Billing');
      expect(lastFrame()).toContain('Safety');
      expect(lastFrame()).toContain('Artifacts');
      expect(lastFrame()).toContain('Persist secrets');
      
      // Redacted preview
      expect(lastFrame()).toContain('Preview (redacted)');
      expect(lastFrame()).toContain('[REDACTED]');
      expect(lastFrame()).not.toContain('secret-password');

      expect(lastFrame()).toContain('[l] Load YAML');
      expect(lastFrame()).toContain('[s] Save YAML');
    });
  });

  describe('PreflightScreen', () => {
    it('renders check results using structured PreflightResult', () => {
      const preflight = {
        ok: false,
        checks: [
          { id: 'env.test', ok: false, message: 'Check Failed', fixHint: 'Try fixing it' }
        ]
      };
      const { lastFrame } = render(React.createElement(PreflightScreen, { preflight }));
      expect(lastFrame()).toContain('Preflight Checklist');
      expect(lastFrame()).toContain('FAIL  env.test: Check Failed');
      expect(lastFrame()).toContain('Hint: Try fixing it');
    });
  });

  describe('ConfirmScreen', () => {
    it('shows redacted preview', () => {
      const configRedacted = { identity: { password: '[REDACTED]' }, run: {}, plan: {}, safety: {}, artifacts: {}, billing: {} };
      const { lastFrame } = render(React.createElement(ConfirmScreen, { configRedacted }));
      expect(lastFrame()).toContain('Confirm & Start');
      expect(lastFrame()).toContain('[REDACTED]');
    });
  });

  describe('RunningScreen', () => {
    it('shows failure summary and checkpoint details with artifacts and snapshots', () => {
      const timeline = [
        { ts: Date.now(), type: Events.STATE_CHANGE, state: 'login' },
        { ts: Date.now(), type: Events.LOG_LINE, level: 'info', message: 'Starting login' },
        { ts: Date.now(), type: Events.LOG_LINE, level: 'error', message: 'Failed to find button' }
      ];
      const runMeta = { 
        status: 'failure', 
        runId: 'run-123', 
        runDir: '/tmp/run-123',
        error: 'Login failed' 
      };
      const artifacts = ['shot1.png', 'snap1.txt'];
      const checkpointPending = { 
        message: 'what will happen', 
        runDir: '/tmp/run-123' 
      };
      const failureSnapshotExcerpt = 'Sample snapshot content with redacted secret';
      
      const { lastFrame } = render(React.createElement(RunningScreen, { 
        timeline, 
        runMeta,
        artifacts,
        checkpointPending,
        failureSnapshotExcerpt
      }));
      
      expect(lastFrame()).toContain('FAILURE SUMMARY');
      expect(lastFrame()).toContain('State: login');
      expect(lastFrame()).toContain('Login failed');
      expect(lastFrame()).toContain('Sample snapshot content with redacted secret');
      expect(lastFrame()).toContain('snap1.txt');
      
      expect(lastFrame()).toContain('CHECKPOINT REQUIRED');
      expect(lastFrame()).toContain('what will happen');
      expect(lastFrame()).toContain('/tmp/run-123');
      expect(lastFrame()).toContain('Latest Snapshot: snap1.txt');
      expect(lastFrame()).toContain('Latest Screenshot: shot1.png');

      // Log pane (separate from timeline)
      expect(lastFrame()).toContain('Logs (info)');
      expect(lastFrame()).toContain('Failed to find button');
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

    it('shows vault warning when present', () => {
      const runMeta = { status: 'success', vaultWarning: 'Vault save failed' };
      const { lastFrame } = render(React.createElement(ResultsScreen, { runMeta }));
      expect(lastFrame()).toContain('Vault Warning');
      expect(lastFrame()).toContain('Vault save failed');
    });
  });
});
