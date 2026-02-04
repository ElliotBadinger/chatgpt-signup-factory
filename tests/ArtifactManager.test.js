import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ArtifactManager } from '../src/artifacts/ArtifactManager.js';

describe('ArtifactManager', () => {
  let tempBaseDir;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-manager-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempBaseDir, { recursive: true, force: true });
  });

  test('should allocate a runId and create a run directory', async () => {
    const manager = new ArtifactManager({ baseDir: tempBaseDir });
    const runId = manager.getRunId();
    expect(runId).toBeDefined();
    expect(typeof runId).toBe('string');

    const runDir = manager.getRunDir();
    expect(runDir).toContain(runId);
    expect(fs.existsSync(runDir)).toBe(true);
  });

  test('should provide pathFor(kind, filename)', () => {
    const manager = new ArtifactManager({ baseDir: tempBaseDir });
    const screenshotPath = manager.pathFor('screenshot', 'step1.png');
    expect(screenshotPath).toContain('screenshots');
    expect(screenshotPath).toContain('step1.png');
    
    // Ensure parent dir of the path is created
    expect(fs.existsSync(path.dirname(screenshotPath))).toBe(true);
  });

  test('should maintain run.bundle.json manifest', () => {
    const manager = new ArtifactManager({ 
      baseDir: tempBaseDir,
      config: { headless: true, sensitive: 'secret' }
    });
    
    // Mock redaction or just test that it's stored
    manager.updateManifest({ status: 'running' });
    
    const manifestPath = path.join(manager.getRunDir(), 'run.bundle.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.run_id).toBe(manager.getRunId());
    expect(manifest.status).toBe('running');
  });

  test('should record artifact paths in manifest', () => {
    const manager = new ArtifactManager({ baseDir: tempBaseDir });
    const screenshotPath = manager.recordArtifact('screenshot', 'step1.png');
    
    const manifest = manager.getManifest();
    const relativePath = path.relative(manager.getRunDir(), screenshotPath);
    expect(manifest.screenshot_paths).toContain(relativePath);
  });

  test('should handle events to update status and artifacts', () => {
    const manager = new ArtifactManager({ baseDir: tempBaseDir });
    manager.handleEvent({ type: 'run:start' });
    manager.handleEvent({ type: 'artifact:written', kind: 'snapshot', path: 'snapshots/a.txt' });
    manager.handleEvent({ type: 'run:failure', reason: 'ERR' });
    
    expect(manager.getManifest().status).toBe('failure');
    expect(manager.getManifest().snapshot_paths).toContain('snapshots/a.txt');
    expect(manager.getManifest().failure_summary).toBe('ERR');
  });
});
