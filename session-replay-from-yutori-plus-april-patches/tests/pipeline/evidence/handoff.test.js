import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';

import {
  renderCommandsShell,
  renderHandoffMarkdown,
  writeHandoffBundle,
} from '../../../src/pipeline/evidence/handoff.js';

/** Minimal valid handoff fixture */
const baseHandoff = {
  target: 'target-007',
  inviter: 'inviter-42',
  inviteLink: 'https://chat.example.com/invite/abc123',
  proofPaths: ['/artifacts/run-x/screenshot.png', '/artifacts/run-x/dom.html'],
  status: 'invited',
  resumeCommand: 'node src/cli/resume.js --run-id run-x',
  statusCommand: 'node src/cli/status.js --run-id run-x',
};

describe('renderHandoffMarkdown', () => {
  test('includes all required direct-DM-friendly fields', () => {
    const md = renderHandoffMarkdown(baseHandoff);

    expect(md).toContain('target-007');
    expect(md).toContain('inviter-42');
    expect(md).toContain('https://chat.example.com/invite/abc123');
    expect(md).toContain('invited');
    expect(md).toContain('node src/cli/resume.js --run-id run-x');
    expect(md).toContain('node src/cli/status.js --run-id run-x');
  });

  test('includes all proof paths', () => {
    const md = renderHandoffMarkdown(baseHandoff);

    for (const p of baseHandoff.proofPaths) {
      expect(md).toContain(p);
    }
  });

  test('is deterministic — same input produces same output', () => {
    expect(renderHandoffMarkdown(baseHandoff)).toBe(renderHandoffMarkdown(baseHandoff));
  });

  test('returns a non-empty string', () => {
    const md = renderHandoffMarkdown(baseHandoff);
    expect(typeof md).toBe('string');
    expect(md.length).toBeGreaterThan(0);
  });

  test('handles empty proofPaths gracefully', () => {
    const md = renderHandoffMarkdown({ ...baseHandoff, proofPaths: [] });
    expect(typeof md).toBe('string');
    expect(md).toContain('target-007');
  });
});

describe('renderCommandsShell', () => {
  test('includes resume command', () => {
    const sh = renderCommandsShell(baseHandoff);
    expect(sh).toContain('node src/cli/resume.js --run-id run-x');
  });

  test('includes status command', () => {
    const sh = renderCommandsShell(baseHandoff);
    expect(sh).toContain('node src/cli/status.js --run-id run-x');
  });

  test('is deterministic', () => {
    expect(renderCommandsShell(baseHandoff)).toBe(renderCommandsShell(baseHandoff));
  });

  test('returns a non-empty string', () => {
    const sh = renderCommandsShell(baseHandoff);
    expect(typeof sh).toBe('string');
    expect(sh.length).toBeGreaterThan(0);
  });
});

describe('writeHandoffBundle', () => {
  test('writes handoff.md to artifactDir', async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'handoff-test-'));

    await writeHandoffBundle(artifactDir, baseHandoff);

    const md = await readFile(path.join(artifactDir, 'handoff.md'), 'utf8');
    expect(md).toContain('target-007');
    expect(md).toContain('https://chat.example.com/invite/abc123');
  });

  test('writes commands.sh to artifactDir', async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'handoff-test-'));

    await writeHandoffBundle(artifactDir, baseHandoff);

    const sh = await readFile(path.join(artifactDir, 'commands.sh'), 'utf8');
    expect(sh).toContain('node src/cli/resume.js --run-id run-x');
    expect(sh).toContain('node src/cli/status.js --run-id run-x');
  });

  test('writes summary.json to artifactDir', async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'handoff-test-'));

    await writeHandoffBundle(artifactDir, baseHandoff);

    const raw = await readFile(path.join(artifactDir, 'summary.json'), 'utf8');
    const parsed = JSON.parse(raw);

    expect(parsed.target).toBe('target-007');
    expect(parsed.inviter).toBe('inviter-42');
    expect(parsed.inviteLink).toBe('https://chat.example.com/invite/abc123');
    expect(parsed.status).toBe('invited');
    expect(Array.isArray(parsed.proofPaths)).toBe(true);
  });

  test('creates artifactDir if it does not exist', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'handoff-test-'));
    const artifactDir = path.join(base, 'run-autocreate');

    await writeHandoffBundle(artifactDir, baseHandoff);

    const md = await readFile(path.join(artifactDir, 'handoff.md'), 'utf8');
    expect(md.length).toBeGreaterThan(0);
  });

  test('file content is consistent with render functions', async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'handoff-test-'));

    await writeHandoffBundle(artifactDir, baseHandoff);

    const [actualMd, actualSh] = await Promise.all([
      readFile(path.join(artifactDir, 'handoff.md'), 'utf8'),
      readFile(path.join(artifactDir, 'commands.sh'), 'utf8'),
    ]);

    expect(actualMd).toBe(renderHandoffMarkdown(baseHandoff));
    expect(actualSh).toBe(renderCommandsShell(baseHandoff));
  });
});
