/**
 * Represents the structure of a run artifact bundle.
 */
export class RunBundle {
  constructor(runId, config = {}, startTime = new Date().toISOString()) {
    this.run_id = runId;
    this.start_ts = startTime;
    this.end_ts = null;
    this.status = 'pending';
    this.config_redacted = config;
    this.log_paths = [];
    this.snapshot_paths = [];
    this.screenshot_paths = [];
    this.failure_summary = null;
    this.event_summary = {
      last_state: null,
      last_event_ts: null
    };
  }

  toJSON() {
    return {
      run_id: this.run_id,
      start_ts: this.start_ts,
      end_ts: this.end_ts,
      status: this.status,
      config_redacted: this.config_redacted,
      log_paths: this.log_paths,
      snapshot_paths: this.snapshot_paths,
      screenshot_paths: this.screenshot_paths,
      failure_summary: this.failure_summary,
      event_summary: this.event_summary
    };
  }
}
