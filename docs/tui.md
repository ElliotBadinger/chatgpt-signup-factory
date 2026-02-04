# Rich TUI (Ink) — Operator Guide

## Prerequisites

- Node.js + npm
- A working `.env` (or environment) with:
  - `AGENTMAIL_API_KEY` (required)

## Run the TUI

```bash
cd /home/epistemophile/chatgpt-factory-bundle/.worktrees/phase01-e2e-trial
npm run tui
```

## UX Flow

1. **Config Wizard**
   - Sections: **Run/Execution**, **Identity**, **Plan**, **Billing**, **Safety**, **Artifacts**
   - Redacted preview always visible
   - YAML actions:
     - `[l]` Load config from `config.yaml`
     - `[s]` Save config to `config.yaml`
   - `[Tab]` cycles sections
2. **Preflight**
   - Structured checks (env vars, artifact dir accessibility)
   - Shows actionable failure hints
3. **Confirm & Start**
   - Explicit confirm
   - Redacted config preview
4. **Running**
   - Timeline of run events + state transitions
   - **Logs pane** with filter keys:
     - `[1]` Info, `[2]` Warn, `[3]` Error
   - Live artifact list (relative paths)
   - Checkpoint prompt (Subscribe click) shows:
     - run dir
     - latest snapshot + screenshot paths
5. **Results**
   - Status, run_id, run dir
   - `run.bundle.json` path

## Safety Defaults

- Config is redacted in UI by default.
- A **checkpoint prompt** is required before Subscribe click (billing submission).
- Logs are written to `logs/tui.log` and are redacted.

## Artifacts

- Each TUI run allocates `artifacts/<run_id>/` (see Running/Results screen).
- The automation engine writes screenshots/snapshots into that directory.
- `run.bundle.json` is always generated (redacted config + artifact paths + status).
- TUI logs are stored at `logs/tui.log` and recorded in the bundle.

## Notes

- To load a YAML config, create `config.yaml` in the repo root and press `[l]` in the Wizard.
- Secrets are never displayed in cleartext; the preview is always redacted.
