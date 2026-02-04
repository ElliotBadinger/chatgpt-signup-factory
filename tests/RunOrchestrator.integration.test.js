import fs from 'fs';
import path from 'path';
import os from 'os';
import { RunOrchestrator } from '../src/orchestrator/RunOrchestrator.js';
import { ArtifactManager } from '../src/artifacts/ArtifactManager.js';
import { Events } from '../src/orchestrator/events.js';

import { RunLogger } from '../src/tui/runLogger.js';

class FakeSignupFactory {
  constructor(apiKey, options) {
    this.apiKey = apiKey;
    this.options = options;
  }
  async init() {}
  async run() {
    this.options.onEvent({ type: Events.RUN_START });
    this.options.onEvent({ type: Events.STATE_CHANGE, state: 'INITIALIZING' });
    
    if (this.options.logger) {
      this.options.logger.log('Hello world');
    }

    this.options.onEvent({ 
      type: Events.ARTIFACT_WRITTEN, 
      kind: 'snapshot', 
      path: path.join(this.options.artifactManager.getRunDir(), 'snapshots', 'debug.txt') 
    });
    this.options.onEvent({ type: Events.RUN_SUCCESS });
    return true;
  }
}

describe('RunOrchestrator Integration with ArtifactManager', () => {
  let baseDir;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(baseDir)) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('should update ArtifactManager and log to file when events occur', async () => {
    const artifactManager = new ArtifactManager({ baseDir });
    const logger = new RunLogger({ artifactManager });
    const orchestrator = new RunOrchestrator({
      factoryClass: FakeSignupFactory,
      artifactManager,
      logger
    });

    await orchestrator.run({ config: { artifactManager, logger } });

    const manifestPath = path.join(artifactManager.getRunDir(), 'run.bundle.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    expect(manifest.status).toBe('success');
    expect(manifest.event_summary.last_state).toBe('INITIALIZING');
    expect(manifest.snapshot_paths).toContain('snapshots/debug.txt');
    expect(manifest.log_paths).toContain('logs/tui.log');

    const logFilePath = path.join(artifactManager.getRunDir(), 'logs', 'tui.log');
    expect(fs.existsSync(logFilePath)).toBe(true);
    const logContent = fs.readFileSync(logFilePath, 'utf8');
    expect(logContent).toContain('Hello world');
  });
});
