import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { redactConfig } from '../config/redaction.js';
import { RunBundle } from './RunBundle.js';
import { resolveArtifactPath } from './pathUtils.js';

export class ArtifactManager {
  constructor({ baseDir = 'artifacts', config = {} } = {}) {
    this.runId = randomUUID();
    this.baseDir = baseDir;
    this.runDir = path.join(this.baseDir, this.runId);
    
    this.bundle = new RunBundle(this.runId, redactConfig(config));

    this._ensureDir(this.runDir);
    this._saveManifest();
  }

  getRunId() {
    return this.runId;
  }

  getRunDir() {
    return this.runDir;
  }

  handleEvent(event) {
    this.bundle.event_summary.last_event_ts = new Date().toISOString();

    switch (event.type) {
      case 'run:start':
        this.updateManifest({ status: 'running' });
        break;
      case 'state:change':
        this.bundle.event_summary.last_state = event.state;
        this._saveManifest();
        break;
      case 'run:success':
        this.updateManifest({ status: 'success' });
        break;
      case 'run:failure':
        this.updateManifest({
          status: 'failure',
          failure_summary: event.reason || (event.error && event.error.message) || 'Unknown error'
        });
        break;
      case 'artifact:written':
        const key = this._getManifestKeyForKind(event.kind);
        if (key && this.bundle[key]) {
          let relativePath = event.path;
          if (path.isAbsolute(event.path)) {
            relativePath = path.relative(this.runDir, event.path);
          }
          if (!this.bundle[key].includes(relativePath)) {
            this.bundle[key].push(relativePath);
          }
          this._saveManifest();
        }
        break;
    }
  }

  pathFor(kind, filename) {
    const subDir = this._getSubDirForKind(kind);
    const fullSubDir = path.join(this.runDir, subDir);
    this._ensureDir(fullSubDir);
    return resolveArtifactPath(fullSubDir, filename);
  }

  recordArtifact(kind, filename) {
    const filePath = this.pathFor(kind, filename);
    const key = this._getManifestKeyForKind(kind);
    
    if (key && this.bundle[key]) {
      // Store relative path for portability
      const relativePath = path.relative(this.runDir, filePath);
      if (!this.bundle[key].includes(relativePath)) {
        this.bundle[key].push(relativePath);
      }
    }
    
    this._saveManifest();
    return filePath;
  }

  updateManifest(updates) {
    Object.assign(this.bundle, updates);
    if (updates.status === 'success' || updates.status === 'failure') {
      this.bundle.end_ts = new Date().toISOString();
    }
    this._saveManifest();
  }

  getManifest() {
    return this.bundle.toJSON();
  }

  _getSubDirForKind(kind) {
    switch (kind) {
      case 'screenshot': return 'screenshots';
      case 'snapshot': return 'snapshots';
      case 'log': return 'logs';
      default: return 'others';
    }
  }

  _getManifestKeyForKind(kind) {
    switch (kind) {
      case 'screenshot': return 'screenshot_paths';
      case 'snapshot': return 'snapshot_paths';
      case 'log': return 'log_paths';
      default: return null;
    }
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _saveManifest() {
    const manifestPath = path.join(this.runDir, 'run.bundle.json');
    fs.writeFileSync(manifestPath, JSON.stringify(this.bundle.toJSON(), null, 2));
  }
}
