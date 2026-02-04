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
   - Toggle headless / stealth (currently only these two)
2. **Preflight**
   - Verifies required environment variables are present
3. **Confirm & Start**
   - Shows a **redacted** config preview
4. **Running**
   - Shows a live event timeline
   - When the automation reaches the billing submission checkpoint, the TUI will prompt:
     - `[y]` approve Subscribe click
     - `[n]` reject (run aborts safely)
5. **Results**
   - Prints run status and the run artifact directory

## Safety Defaults

- Config is redacted in UI by default.
- A **checkpoint prompt** is required before Subscribe click (billing submission).

## Artifacts

- Each TUI run allocates `artifacts/<run_id>/` (see the path in the Running/Results screen).
- The automation engine is configured to write screenshots/snapshots into that directory when launched from the TUI.
