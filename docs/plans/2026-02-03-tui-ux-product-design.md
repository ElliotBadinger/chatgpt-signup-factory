# TUI-First Product Design for Trial Provisioning

**Goal:** Provide a polished, user-friendly TUI (with future CLI + web monitoring) for QA/Ops to execute end-to-end ChatGPT business trial provisioning, including real billing submission with strict auditing.

**Audience:** QA automation engineers, Ops teams.

**Tech Stack (initial):**
- Node.js (existing automation stack)
- Inquirer/Ink (TUI), blessed/consola (logs)
- chrome-devtools-mcp (browser control)
- YAML config + JSON artifact bundles
- OS keychain integration (optional encrypted storage)

---

## User Stories

- **QA Engineer:** “I need a repeatable, audited trial flow that runs headless, captures artifacts, and flags UI changes.”
- **Ops Lead:** “I need to provision multiple trial accounts in batch with configurable billing settings and explicit approvals.”
- **Security Reviewer:** “I need to ensure sensitive billing data is not stored unless explicitly requested.”
- **Support Engineer:** “I need a clear artifact bundle when a run fails, including snapshots and screenshots.”

---

## Configuration Model (TUI + YAML)

Configurable sections:
- **Run Mode:** Single / Batch
- **Execution:** Headless on/off, timeouts, retry policy
- **Identity:** Email provisioning strategy, OTP timeout
- **Plan Selection:** Business/Team, seat count, billing cadence
- **Billing:** Card number, exp, CVC, address, consent mode
- **Safety:** Pre-submit checkpoints, dry-run mode
- **Artifacts:** Screenshot/snapshot retention, export bundle

---

## Mermaid Diagrams

### 1) TUI Flow (Flowchart)

```mermaid
flowchart TD
  A[Launch TUI] --> B{Run Mode}
  B -->|Single| C[Config Wizard]
  B -->|Batch| D[Batch Config + Queue]
  C --> E[Preflight Checklist]
  D --> E
  E --> F{Confirm & Start}
  F -->|No| C
  F -->|Yes| G[Run Execution]
  G --> H[Live Timeline + Artifacts]
  H --> I{Success?}
  I -->|Yes| J[Results + Export Bundle]
  I -->|No| K[Failure Summary + Export Bundle]
```

### 2) State Machine (Execution States)

```mermaid
stateDiagram-v2
  [*] --> Init
  Init --> Landing
  Landing --> LoginEmail
  LoginEmail --> LoginPassword
  LoginPassword --> OTP
  OTP --> AboutYou
  AboutYou --> Onboarding
  Onboarding --> Chat
  Chat --> Checkout
  Checkout --> Billing
  Billing --> Subscribe
  Subscribe --> Success
  Subscribe --> Failure
  Failure --> [*]
  Success --> [*]
```

### 3) Sequence Diagram (Checkout Submission)

```mermaid
sequenceDiagram
  participant User as TUI User
  participant TUI as TUI App
  participant Bot as Automation Engine
  participant Web as ChatGPT UI
  participant Stripe as Payment Frames

  User->>TUI: Start run
  TUI->>Bot: Execute checkout flow
  Bot->>Web: Open checkout
  Bot->>Stripe: Fill card & billing
  Bot->>Web: Verify Subscribe enabled
  TUI->>User: Confirm billing submission
  User->>TUI: Approve
  Bot->>Web: Click Subscribe
  Web-->>Bot: Confirmation response
  Bot-->>TUI: Success + artifacts
```

### 4) Architecture Diagram

```mermaid
flowchart LR
  A[TUI/CLI] --> B[Run Orchestrator]
  B --> C[Browser Automation]
  B --> D[Artifact Manager]
  B --> E[Config Manager]
  C --> F[ChatGPT Web UI]
  C --> G[Stripe Iframes]
  D --> H[Snapshots/Screenshots]
  E --> I[YAML Profiles]
```

### 5) Data Model (Config & Artifacts)

```mermaid
erDiagram
  RUN_CONFIG {
    string run_mode
    bool headless
    int timeout_ms
    string email_strategy
    string billing_mode
    bool require_confirm
  }
  BILLING_INFO {
    string card_last4
    string exp_month
    string exp_year
    string billing_zip
    string billing_country
  }
  ARTIFACT_BUNDLE {
    string run_id
    string status
    string snapshot_path
    string screenshot_path
    string report_path
  }

  RUN_CONFIG ||--|| BILLING_INFO : uses
  RUN_CONFIG ||--o{ ARTIFACT_BUNDLE : generates
```

---

## UX Notes

- **Guided Wizard:** Each section is editable and previewed before execution.
- **Sensitive Data Handling:** Masked inputs, in-memory by default, explicit opt-in to store.
- **Checkpoint Prompts:** Required before billing submission.
- **Exportable Reports:** JSON + HTML summary with redacted billing details.

---

## Next Steps (If Approved)

- Finalize UX flow and screen mockups.
- Implement TUI skeleton (Ink or blessed).
- Integrate config validation + artifact exports.
- Add real billing form-filling guardrails and confirmations.
