import { describe, expect, test } from '@jest/globals';

import {
  renderCommandsShell,
  renderHandoffMarkdown,
} from '../../../src/pipeline/evidence/handoff.js';

const successfulHandoff = {
  target: 'target-alpha',
  inviter: 'inviter-beta',
  inviteLink: 'https://chat.example.com/invite/alpha',
  proofPaths: ['/artifacts/consume/target-alpha/invite.png', '/artifacts/consume/target-alpha/proven.json'],
  status: 'proven',
  resumeCommand: 'node src/cli/pipeline-consume.js --artifact-dir /tmp/runs/target-alpha',
  statusCommand: 'node src/cli/pipeline-status.js --run-id target-alpha',
};

const blockedHandoff = {
  target: 'target-seat-cap',
  inviter: 'inviter-seat-cap',
  inviteLink: '',
  proofPaths: [],
  status: 'blocked',
  resumeCommand: 'node src/cli/pipeline-consume.js --artifact-dir /tmp/runs/target-seat-cap',
  statusCommand: 'node src/cli/pipeline-status.js --run-id target-seat-cap',
  blocker: 'Workspace hard seat cap is active for workspace-hard-cap.',
  nextCommand: 'node src/cli/pipeline-bootstrap.js --state-dir /tmp/state --artifact-dir /tmp/runs --root owner@example.com',
};

describe('direct handoff command contract', () => {
  test('successful handoffs expose a stable direct-command bundle with entity ids and proof references', () => {
    const markdown = renderHandoffMarkdown(successfulHandoff);
    const commands = renderCommandsShell(successfulHandoff);

    expect(markdown).toContain('## Entity IDs');
    expect(markdown).toContain('- **Target ID**: target-alpha');
    expect(markdown).toContain('- **Inviter ID**: inviter-beta');
    expect(markdown).toContain('## Direct Command Bundle');
    expect(markdown).toContain('The commands below are copy-pasteable and contract-stable.');
    expect(markdown).toContain('### Resume Command');
    expect(markdown).toContain('### Status Command');
    expect(markdown).toContain('### Proof Path References');
    expect(markdown).toContain('- /artifacts/consume/target-alpha/invite.png');
    expect(markdown).toContain('- /artifacts/consume/target-alpha/proven.json');

    expect(commands).toBe([
      '#!/usr/bin/env sh',
      '# Auto-generated handoff commands — stable direct-command contract. Do not edit manually.',
      '# SECTION: resume',
      successfulHandoff.resumeCommand,
      '',
      '# SECTION: status',
      successfulHandoff.statusCommand,
      '',
    ].join('\n'));
  });

  test('blocked handoffs include exact blocker text and the suggested next command in both markdown and shell bundle', () => {
    const markdown = renderHandoffMarkdown(blockedHandoff);
    const commands = renderCommandsShell(blockedHandoff);

    expect(markdown).toContain('## Blocker');
    expect(markdown).toContain(blockedHandoff.blocker);
    expect(markdown).toContain('### Suggested Next Command');
    expect(markdown).toContain(blockedHandoff.nextCommand);

    expect(commands).toContain('# SECTION: next');
    expect(commands).toContain(blockedHandoff.nextCommand);
  });
});
