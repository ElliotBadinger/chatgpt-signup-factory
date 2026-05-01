import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';

import { updateFrictionLedger, writeCanonicalRunArtifact } from '../../../src/pipeline/rotation/lifecycleEvidence.js';

describe('lifecycleEvidence', () => {
  test('writes canonical-run-artifact.json with the required top-level sections', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-evidence-'));

    try {
      const result = writeCanonicalRunArtifact({
        runDir: tmpDir,
        summary: {
          details: [
            { aliasId: 'alias-1', status: 'awaiting-reinstatement', archivedReason: '5h-exhausted' },
            { aliasId: 'alias-2', status: 'failed', error: 'verification: live probe failed', blockerReason: 'verification-probe-not-configured' },
            { aliasId: 'alias-3', status: 'rotated', inbox: 'alias-3@agentmail.to', newAliasId: 'alias-3-new' },
          ],
        },
        artifactPaths: {
          summary: path.join(tmpDir, 'summary.json'),
          browserlessAudit: path.join(tmpDir, 'browserless-audit.json'),
        },
        writtenAt: '2026-04-02T00:00:00.000Z',
      });

      expect(result.canonicalRunArtifactPath).toBe(path.join(tmpDir, 'canonical-run-artifact.json'));
      const artifact = JSON.parse(fs.readFileSync(result.canonicalRunArtifactPath, 'utf8'));

      expect(artifact).toMatchObject({
        lifecycleTransitions: expect.any(Array),
        blockerOutcomes: expect.any(Array),
        rollbackOutcomes: expect.any(Array),
        supportingEvidence: expect.any(Object),
        frictionPoints: expect.any(Array),
      });
      expect(artifact.blockerOutcomes).toEqual([
        expect.objectContaining({
          blockerClass: 'verification-evidence',
          rawReason: 'verification-probe-not-configured',
        }),
      ]);
      expect(artifact.lifecycleTransitions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ aliasId: 'alias-1', toState: 'queued-replacement' }),
          expect.objectContaining({ aliasId: 'alias-3-new', fromState: 'candidate', toState: 'active' }),
        ]),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('increments timesSeen in the shared friction-ledger.json for repeated friction points', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friction-ledger-'));
    const ledgerPath = path.join(tmpDir, 'state', 'rotation', 'friction-ledger.json');

    try {
      updateFrictionLedger({
        ledgerPath,
        frictionPoints: [
          {
            blockerClass: 'verification-evidence',
            rawReason: 'verification-probe-not-configured',
            aliasId: 'alias-1',
            workspaceId: 'workspace-1',
            surface: 'failed',
            supportingEvidence: ['summary.json'],
          },
        ],
        runId: 'run-1',
        writtenAt: '2026-04-02T00:00:00.000Z',
      });

      const second = updateFrictionLedger({
        ledgerPath,
        frictionPoints: [
          {
            blockerClass: 'verification-evidence',
            rawReason: 'verification-probe-not-configured',
            aliasId: 'alias-1',
            workspaceId: 'workspace-1',
            surface: 'failed',
            supportingEvidence: ['summary-2.json'],
          },
        ],
        runId: 'run-2',
        writtenAt: '2026-04-02T01:00:00.000Z',
      });

      expect(second.entries).toEqual([
        expect.objectContaining({
          blockerClass: 'verification-evidence',
          rawReason: 'verification-probe-not-configured',
          timesSeen: 2,
          latestRunId: 'run-2',
          latestEvidencePath: 'summary-2.json',
        }),
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});