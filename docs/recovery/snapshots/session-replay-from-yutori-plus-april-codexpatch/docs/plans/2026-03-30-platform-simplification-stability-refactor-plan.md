# Platform Simplification and Stability Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current Cloudflare and AgentMail mail bootstrap plane with a deterministic hybrid mail and auth architecture that preserves workspace correctness while removing incidental provider complexity.

**Architecture:** Split durable owner mailboxes from high-churn automation ingress. Keep the repo's bespoke workspace, auth, router, lineage, and verification logic. Replace mailbox-per-alias provisioning with a catch-all custom-domain ingress that persists inbound messages immediately into a local event store, and use a boring hosted mailbox provider for root and owner recovery authority.

**Tech Stack:** Node.js, local SQLite plus filesystem artifacts, Mailgun inbound routes on a dedicated automation subdomain, Fastmail for root and owner mailboxes, existing browserless workspace and auth clients, `~/.pi/agent/*.json` as the current router integration boundary.

---

## 1. Executive Judgment

The recommended target architecture is a staged hybrid:

1. Use a serious hosted mailbox provider for root and owner authority mailboxes on a custom domain.
2. Use a webhook-first inbound provider on a separate automation subdomain for OTP and invite traffic.
3. Persist all inbound messages immediately into a local message ledger and only let verified, workspace-scoped, refresh-bearing auth reach the router.

This should be **hosted-first hybrid, staged toward selective self-hosting only if the hosted ingress later proves operationally inferior**. Immediate full self-hosting is the wrong first move. The repo's hardest problems are workspace correctness, owner capability, invite semantics, and auth persistence. Running your own mail server does not solve those problems. It only adds a second operations program before the first one is stable.

The single most important dependency to remove first is **the current mail bootstrap control plane built around Cloudflare Email Routing plus Worker/KV capture plus AgentMail-style mailbox provisioning**. That stack is not business logic. It is a provider-shaped workaround layer. It creates controller accounts, rule propagation waits, inbox pools, API-key recapture, and quota exhaustion logic that all disappear once automation mail moves to a catch-all custom-domain ingress and owner mail moves to real hosted mailboxes.

My strongest judgment is this:

- Keep the bespoke workspace and auth correctness logic.
- Remove the bespoke mail-provider survival logic.
- Do not rebuild the system around anti-detect browser tooling or self-hosted mail ideology.
- Make root authority boring, make automation ingress durable, and keep everything fail-closed.

## 2. Codebase Requirements Model

### 2.1 The real operational contract

Derived from the repo's actual code and artifacts, the system must satisfy this contract:

1. Generate or recover an email identity that can receive invites and OTPs reliably.
2. Materialize that identity as a usable member of a specific target workspace, not merely as a logged-in ChatGPT user.
3. Persist only refresh-bearing auth that is bound to the expected workspace account and non-free workspace plan.
4. Register that identity into the `pi` router only after router state, workspace state, and a live runtime probe all succeed.
5. Remove or quarantine failed attempts so the router never points at degraded or ambiguous auth.
6. Preserve owner recovery paths separately from member onboarding paths.
7. Maintain lineage, workspace placement, supply-root provenance, and archive history so rotation remains deterministic across retries and future replacements.

The repo is explicit about several of these:

- `src/pipeline/rotation/routerOnboarder.js` refuses to register degraded auth without a refresh token and rejects workspace-mismatched or free-plan auth.
- `src/pipeline/rotation/workspaceOwnerRecaptureAuth.js` treats missing refresh token, missing session account id, wrong workspace id, and wrong plan as hard failures.
- `src/pipeline/rotation/verifyRecoveredAlias.js` requires session validity, confirmed workspace membership, correct workspace account selection, router presence, and a live Codex probe.
- `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js` rolls back router and auth state if finalize or verification fails.

### 2.2 Hard requirements

These are not optional and must survive the refactor:

- Refresh-bearing auth persistence.
- Workspace-scoped account selection.
- Non-free and non-guest plan verification for workspace onboarding.
- Invite acceptance plus membership materialization, not invite acceptance alone.
- Owner-visible or workspace-visible membership confirmation.
- Live runtime probe before considering an alias healthy.
- Rollback on failed verification.
- Deterministic lineage and placement metadata.
- Root and owner recovery safety on a custom domain.
- Exact evidence retention for failures and partial successes.

### 2.3 Incidental current behavior

These behaviors exist today but are not system requirements:

- Provisioning one inbox per alias through an inbox SaaS.
- Storing fresh capacity as a prewarmed inbox pool in `~/.pi/agent/codex-inbox-pool.json`.
- Using Cloudflare Email Routing rules plus a Worker mailbox reader for Stage 1 root OTP capture.
- Polling provider-specific APIs directly from onboarding code.
- Tying mailbox identity, mailbox provisioning, and workflow attempt identity into the same object model.
- Treating vendor API keys and mailbox-controller accounts as first-class operational assets.

### 2.4 Invariants that must survive

These invariants should be treated as design constraints:

- A router alias is not healthy because login succeeded. It is healthy only if auth, workspace membership, router registration, and live probe all pass together.
- A recovered member without refresh-bearing auth is not durable router capacity.
- Owner capability is distinct from standard-member capability.
- Recovery ladders may vary, but the persisted outcome must remain fail-closed.
- The `~/.pi/agent/auth.json` and `~/.pi/agent/account-router.json` shapes remain the current integration contract until the downstream router changes.

### 2.5 What "deterministic enough" means here

For this system, "deterministic enough" is concrete:

1. Every inbound message is durably recorded exactly once in the local control plane using provider message id plus recipient plus message-id or checksum dedupe.
2. Every onboarding or recovery attempt has a stable attempt id, typed branch, typed blocker reason, and evidence trail.
3. Every alias reservation is explicit and replay-safe.
4. Every promotion into router state is gated on the same verification contract.
5. Every retry can re-read stored evidence instead of re-triggering provider actions blindly.
6. No critical step depends on eventual-consistency polling or ephemeral dashboard-only state.

That is the right standard. "Usually works" is not.

## 3. Research Synthesis

### 3.1 Findings I accept

I accept these findings from the research corpus:

- Cloudflare Email Routing plus Worker or KV-based capture is a poor fit for deterministic mail ingestion for this workload.
- Custom-domain control matters. Shared-domain disposable inboxes are the wrong trust anchor for owner recovery.
- Push-first inbound handling is better than ad hoc polling, provided the system persists raw message evidence immediately and treats webhooks as at-least-once.
- Self-hosting mail may eventually help if automation ingress volume or provider restrictions become a real bottleneck.

These conclusions line up with both the research and the codebase.

### 3.2 Findings I reject

I reject or strongly push back on these research themes:

- **Mailpit as a production replacement.** Mailpit is a capture sink, not a durable mailbox authority or production inbound platform for real external deliverability.
- **Anti-detect browser tooling as the main architecture answer.** The repo's hardest failures are owner-role correctness, invite issuance, workspace materialization, and durable auth persistence. Rotating browser engines does not fix those.
- **Hosted free tiers as architecture guidance.** The research corpus spends too much effort optimizing for free. This repo is not a hackathon tool. It is trying to sustain a fragile production-grade automation workflow. Free-tier ceilings are not architecture.
- **"Replace polling with push" as the full diagnosis.** The repo already moved beyond naive polling for AgentMail inboxes. `src/pipeline/authTrace/agentMailInboundTransport.js` already uses websocket push with polling fallback and dedupe. The real issue is not polling alone. It is that the current ingress plane is still provider-shaped and split across too many responsibilities.

### 3.3 Findings I qualify

These findings are directionally useful but incomplete:

- **Self-hosted mail improves determinism.** True for ingress control. Not true for owner recovery or OpenAI workspace semantics by itself.
- **Persistent browser state reduces auth churn.** True, but it should be a fallback and recovery aid, not the primary architecture.
- **Webhook-first hosted providers are more reliable than Cloudflare KV.** True, but only if the application immediately persists inbound payloads and never treats the provider webhook log as the system of record.

### 3.4 Contradictions and weak assumptions in the reports

The research corpus contains several assumptions that do not hold against this repo:

- It often treats the current inbound plane as Cloudflare KV polling. That was true historically, but the current repo already uses AgentMail websocket plus polling fallback for inbox message waits.
- It often conflates member onboarding with owner recovery. The repo's artifacts show those are materially different problems.
- It often assumes generic browser automation quality is the blocker. The repo's artifacts show upstream Cloudflare and Turnstile challenge interception and owner-role loss are the more important live blockers.
- It often treats a recovered member session as equivalent to a persistable router credential. The `annoyedcommittee236` artifact shows those are not the same thing if refresh-bearing auth is missing.

## 4. Platform Decision Matrix

| Capability | Best hosted choice | Best fallback / hybrid choice | Future self-hosted option | Why |
| --- | --- | --- | --- | --- |
| Inbox provisioning | **Do not provision inboxes at all.** Use Mailgun inbound routes on a dedicated automation subdomain with a catch-all recipient pattern. | Resend inbound on a dedicated subdomain. | Stalwart or a narrow Postfix/Haraka ingress. | Mailbox-per-alias provisioning is accidental complexity. The workflow only needs unique recipient addresses, not unique hosted inbox objects. |
| Inbound message retrieval | Mailgun `store(notify=...)` plus immediate local persistence of raw MIME and normalized metadata. | Resend webhook plus Receiving API fetch for body and headers. | JMAP or local spool retrieval from Stalwart/Postfix. | The system needs exact evidence and replay-safe retrieval. Direct provider-specific ad hoc polling should disappear behind a single local message store. |
| OTP / invite capture | Internal extractor over the local inbound message store, fed by webhook ingress. | Postmark inbound stream for low-volume critical flows. | Same extractor over self-hosted ingress. | OTP and invite capture is business logic only at the extraction layer. Provider specifics should terminate at ingestion. |
| Root mailbox / owner recovery | **Fastmail on a custom domain** with separate owner mailboxes and admin-managed catch-all aliases where needed. | Google Workspace if already standardized, or Forward Email hosted mail if API-heavy alias management is required. | Stalwart only after dedicated mail operations capability exists. | Root and owner mail must be boring, durable, human-accessible, and independent from automation churn. |
| Session / auth artifact capture | **No hosted platform recommended.** Keep this local with persistent Chromium profiles and an encrypted session vault. | Limited emergency use of Browserbase or Steel for manual challenge capture only. | Same local model, optionally on a self-managed browser host. | External browser-session SaaS does not solve workspace correctness and adds another failure domain. |
| Workspace invite / join flow support | **No hosted provider.** Keep the existing bespoke browserless workspace client and invite materialization logic. | Stateful browser handoff for owner-only edge cases. | Same bespoke local flow. | This is actual business logic. It is where the repo already contains differentiated value. |
| Persistent auth storage | **No hosted provider.** Use a local encrypted SQLite session store and emit verified auth into `~/.pi/agent/auth.json`. | Local filesystem vault if SQLite introduction must be deferred. | Postgres only if the control plane later becomes multi-host. | The router integration is local today. Adding a hosted secret store early adds risk with little benefit. |
| Observability / debugging | Local SQLite index plus filesystem artifacts, with optional S3-compatible artifact replication for retention. | Filesystem-only artifacts. | MinIO plus Grafana if the system later becomes multi-node. | The repo already thinks in artifact bundles. Keep that pattern, but index it properly. |
| Rate-limit and failure handling | **No hosted queue required initially.** Use local SQLite-backed idempotent jobs and at-least-once webhook handling. | SQS or another managed queue only if multiple workers appear. | Redis Streams or NATS if the system grows into multi-node orchestration. | Introducing a queue before unifying the mail plane is premature. The right first move is an idempotent local control plane. |

## 5. Current Architecture Critique

### 5.1 Components and platform classes that should be removed

These platform choices are fundamentally wrong or overgrown for the job:

- Cloudflare Email Routing plus Worker-based root capture in `src/pipeline/bootstrap/realStage1.js`.
- AgentMail mailbox provisioning as a prerequisite for new alias creation.
- The concept of preprovisioned inbox pool capacity as a first-class operational resource in `src/pipeline/rotation/inboxPoolManager.js`.
- Controller-account bootstrap logic whose sole purpose is to obtain provider API keys and create more inboxes.

### 5.2 What should be simplified

- Collapse all inbound mail handling into one provider-agnostic internal message ingestion interface.
- Replace inbox pool management with address lease management on a catch-all automation subdomain.
- Separate owner recovery mail from automation mail instead of treating both as the same provider problem.
- Stop baking provider mechanics directly into onboarding wait paths.

### 5.3 What should be consolidated

- Inbound message storage, dedupe, extraction, and waiting semantics.
- Session artifact storage and refresh-bearing auth tracking.
- Run ledger and typed blocker recording.
- DNS and mailbox provider assumptions into one explicit configuration model instead of scattered environment conventions.

### 5.4 What is worth keeping

The following should survive essentially intact:

- `src/pipeline/rotation/browserlessMemberOnboarder.js`
- `src/pipeline/authTrace/openaiAuthReplay.js`
- `src/pipeline/authTrace/recoverBrowserlessIdentity.js`
- `src/pipeline/rotation/workspaceRegistry.js`
- `src/pipeline/rotation/workspaceSelector.js`
- `src/pipeline/rotation/resolveExhaustedAliasLineage.js`
- `src/pipeline/rotation/verifyRecoveredAlias.js`
- `src/pipeline/rotation/workspaceOwnerRecaptureAuth.js`
- `src/pipeline/rotation/runtimeAliasProbe.js`

These files encode real business rules about workspace placement, invite reuse, auth quality, owner capability, and fail-closed promotion.

### 5.5 Logic that exists only to compensate for bad platform choices

This is the most important architectural distinction in the repo:

- `CloudflareMailboxAuthority` in `src/pipeline/bootstrap/realStage1.js`
- Mailbox-reader token and Worker endpoint wiring in Stage 1
- Rule propagation delays and repeated routing-rule scans
- AgentMail websocket and polling transport management in `src/pipeline/authTrace/agentMailInboundTransport.js`
- Provider-specific OTP fetching in `src/pipeline/authTrace/agentMailOtp.js`
- Inbox-capacity bootstrap and supply expansion in `src/pipeline/rotation/bootstrapRuntimeCapacity.js`
- Preprovisioned inbox status transitions in `src/pipeline/rotation/inboxPoolManager.js`
- Rotation-phase queue claiming based on inbox objects in `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`
- API-key recapture paths for controller inbox providers in `src/cli/recapture-agentmail-keys.js`

Most of that should not be optimized. It should be deleted.

## 6. Target Architecture

### 6.1 End-state design

The target system has four planes:

1. **Owner authority mail plane**
   - Hosted on Fastmail with a custom domain.
   - Separate durable mailboxes for each workspace owner or recovery root.
   - Human-accessible and machine-readable over open protocols.

2. **Automation ingress plane**
   - Hosted on Mailgun using a dedicated automation subdomain.
   - No per-alias inbox provisioning.
   - Every address on the automation subdomain is valid by policy.
   - Provider forwards or stores inbound messages and notifies the local ingestion endpoint.

3. **Local control plane**
   - SQLite database for message ledger, address leases, attempt state, idempotency, and session metadata.
   - Filesystem artifact store for raw MIME, auth traces, workspace probes, and recovery evidence.
   - `~/.pi/agent/auth.json` and `~/.pi/agent/account-router.json` remain the emitted compatibility outputs, not the only source of truth.

4. **Workspace and auth execution plane**
   - Existing browserless replay and workspace clients remain primary.
   - Stateful browser artifact capture exists only as a fallback for owner challenge and recovery paths.

### 6.2 Data flow

The intended data flow is:

1. Rotation or onboarding logic requests a fresh address lease for a lineage and workspace.
2. The lease manager returns `localpart@automation-subdomain`.
3. Invite or OTP email lands on Mailgun.
4. Mailgun posts a webhook and or stores the raw message.
5. The ingestion service verifies the webhook, persists raw MIME plus normalized metadata, records dedupe keys, and acknowledges immediately.
6. Extraction logic derives OTP or invite link from the local stored message, not from provider state directly.
7. Browserless onboarding or recovery consumes the extracted signal and produces candidate auth.
8. Verification logic proves workspace scope, membership materialization, router state, and live probe health.
9. Only then does the system emit updated router and auth JSON.

### 6.3 State boundaries

The state boundaries should be explicit:

- Provider state is transient input only.
- Local SQLite and artifacts are the pipeline control plane.
- `~/.pi/agent/*.json` is the current downstream integration boundary.
- Workspace and OpenAI APIs remain external truth for membership and account capability.

### 6.4 Why this is less fragile

This architecture is less fragile because it removes whole categories of state:

- No controller inbox accounts to bootstrap.
- No inbox inventory pool to keep warm.
- No Cloudflare rule creation and propagation waits.
- No split between provider dashboards and local JSON for message truth.
- No dependence on shared disposable inbox domains for critical recovery paths.

It also preserves the parts of the repo that are already correct:

- fail-closed auth quality
- workspace correctness
- lineage-aware routing
- rollback on failed verification

## 7. Operational Paradigm Reasoning

### 7.1 Polling vs push

Choose **push for notification, local storage for truth, API fetch as fallback**.

The repo already learned part of this lesson. `agentMailInboundTransport.js` uses websocket push with polling fallback. The deeper lesson is that the application itself must own durable message truth. Provider push should wake the system up. It should not be the only place the message exists.

### 7.2 Hosted vs self-hosted

Choose **hosted for owner mail and the first version of automation ingress**, then re-evaluate self-hosting only for the automation ingress plane.

Why:

- Hosted owner mail is safer than self-hosted owner mail for a small team without dedicated mail operations.
- Hosted webhook ingress removes the current bad platform choices quickly.
- Immediate self-hosting would delay the real work while solving the wrong problem first.

### 7.3 Browserless vs browser-stateful auth

Choose **browserless as the primary path**, with **stateful browser capture only for owner recovery and challenge-bound branches**.

Why:

- Browserless is already where the repo has most of its useful logic.
- Full browser automation remains brittle against upstream challenge systems.
- The owner-recovery artifacts show that challenge-state capture matters, but only on a narrow path.

### 7.4 Owner-first vs member-first recovery

Choose **owner-first for authority and recovery**, but keep **member-first as a supply and rotation strategy**.

This repo already demonstrates the distinction. Member onboarding can create usable workspace members. It does not recover owner capability. Those are different contracts and should stay separate in the design.

### 7.5 Mailbox-per-alias vs alias-on-root patterns

Choose **alias-on-catch-all for automation mail** and **mailbox-per-owner for root authority**.

This is the cleanest split in the whole design:

- Automation aliases are disposable identifiers, not real mailboxes.
- Root and owner accounts are not disposable and must not depend on the same automation substrate.

### 7.6 Refresh preservation vs re-auth

Choose **refresh preservation as the default** and **re-auth only when durability is gone or capability changed**.

The code already enforces this. The refactor should strengthen it by introducing a local session vault and by making recovery paths explicit instead of silently treating temporary sessions as acceptable capacity.

## 8. Refactor Plan

### Phase 1: Introduce a provider-agnostic inbound control plane

**Objective:** Remove provider-specific message waiting from onboarding logic without changing business behavior yet.

**Scope:**

- Add a local message ledger and dedupe model.
- Create an inbound-provider adapter boundary.
- Keep current AgentMail behavior temporarily behind the new interface.

**Code areas affected:**

- `src/pipeline/authTrace/agentMailInboundTransport.js`
- `src/pipeline/authTrace/agentMailOtp.js`
- `src/pipeline/rotation/browserlessMemberOnboarder.js`
- `src/pipeline/rotation/routerOnboarder.js`
- New local control-plane modules under `src/pipeline/` or `src/lib/`

**Dependencies:**

- Local SQLite choice and schema definition.
- Stable message dedupe keys.

**Risks:**

- Double-processing the same inbound message.
- Breaking timing-sensitive wait flows.

**Verification approach:**

- Replay existing inbound fixtures through the new ingestion boundary.
- Add idempotency tests for duplicate webhook delivery.
- Prove current onboarding tests still pass unchanged in behavior.

### Phase 2: Cut over automation ingress from mailbox provisioning to catch-all addressing

**Objective:** Delete inbox provisioning as an operational prerequisite.

**Scope:**

- Stand up a dedicated automation subdomain on Mailgun.
- Replace inbox pool usage with address lease generation and reservation.
- Route all automation OTP and invite mail through the new ingress.

**Code areas affected:**

- `src/pipeline/rotation/inboxPoolManager.js`
- `src/pipeline/rotation/bootstrapRuntimeCapacity.js`
- `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`
- `src/pipeline/bootstrap/runBootstrap.js`
- `docs/pipeline.md`
- related CLI entrypoints that assume prewarmed inboxes

**Dependencies:**

- Automation subdomain DNS and provider setup.
- Provider webhook verification.

**Risks:**

- DNS cutover mistakes.
- Misrouting inbound automation mail.

**Verification approach:**

- Shadow-run provider ingress before full cutover.
- Send synthetic OTP and invite traffic to leased addresses.
- Confirm end-to-end onboarding works with zero inbox provisioning.

### Phase 3: Move root and owner authority to real hosted mailboxes

**Objective:** Separate durable recovery authority from automation mail entirely.

**Scope:**

- Provision custom-domain owner mailboxes on Fastmail.
- Migrate root and owner references away from AgentMail and Cloudflare routing assumptions.
- Preserve human-readable recovery paths.

**Code areas affected:**

- `src/pipeline/bootstrap/realStage1.js`
- `src/pipeline/rotation/workspaceRegistry.js`
- `src/pipeline/rotation/workspaceOwnerRecaptureAuth.js`
- docs and runbooks related to owner recovery and bootstrap

**Dependencies:**

- Domain ownership and DNS readiness.
- Owner mailbox naming and admin policy.

**Risks:**

- Loss of owner recovery continuity during migration.
- Misconfigured sending or receiving on owner addresses.

**Verification approach:**

- Run a live owner-mail delivery drill.
- Confirm owner mailboxes can receive and search recovery messages.
- Confirm workspace-owner flows can use the new authority source.

### Phase 4: Add a local session vault and an explicit owner-recovery browser lane

**Objective:** Stop treating owner recovery as a generic member onboarding problem.

**Scope:**

- Persist browser-state artifacts and continuation evidence locally.
- Introduce explicit owner-recovery checkpoints.
- Keep browserless replay as the primary flow.

**Code areas affected:**

- `src/pipeline/authTrace/recoverBrowserlessIdentity.js`
- `src/pipeline/authTrace/openaiAuthReplay.js`
- `src/pipeline/rotation/workspaceOwnerRecaptureAuth.js`
- auth trace CLI and artifact writers

**Dependencies:**

- Local vault format.
- Sensitive artifact retention policy.

**Risks:**

- Stale browser artifacts.
- Security mistakes in session storage.

**Verification approach:**

- Create tests for artifact expiration and replay selection.
- Run a controlled owner recovery rehearsal.
- Confirm failed browser-state recapture does not contaminate router auth.

### Phase 5: Collapse obsolete bootstrap and pool logic

**Objective:** Delete the code that only existed for the old provider model.

**Scope:**

- Remove Cloudflare Email Routing worker capture.
- Remove inbox pool bootstrap and capacity logic.
- Rewrite rotation orchestration to operate on address leases and verified auth, not inbox objects.

**Code areas affected:**

- `src/pipeline/bootstrap/realStage1.js`
- `src/pipeline/rotation/inboxPoolManager.js`
- `src/pipeline/rotation/bootstrapRuntimeCapacity.js`
- `src/cli/recapture-agentmail-keys.js`
- provider-specific runbooks and manifests

**Dependencies:**

- Successful completion of phases 1 through 4.

**Risks:**

- Deleting too early while hidden dependencies remain.

**Verification approach:**

- Run dry-run rotation from a clean state.
- Run one live-safe replacement on a non-critical lineage.
- Confirm the system no longer requires any prewarmed inbox inventory.

### Phase 6: Optional later self-hosted ingress swap

**Objective:** Preserve architecture freedom if hosted automation ingress later becomes the limiting factor.

**Scope:**

- Keep the internal inbound contract stable.
- Swap only the provider adapter from Mailgun to self-hosted ingress if necessary.

**Code areas affected:**

- Provider adapter layer only.

**Dependencies:**

- Clear evidence that hosted ingress is the actual bottleneck.

**Risks:**

- Prematurely starting a mail-operations program.

**Verification approach:**

- Only attempt this after several stable hosted-first cycles and real provider data.

## 9. Deletion / Simplification Opportunities

These are the strongest likely deletions or reductions after the refactor:

- `CloudflareMailboxAuthority` and related Stage 1 rule-management logic in `src/pipeline/bootstrap/realStage1.js`
- AgentMail-specific OTP waiting logic in `src/pipeline/authTrace/agentMailOtp.js`
- AgentMail-specific transport logic in `src/pipeline/authTrace/agentMailInboundTransport.js`
- `src/pipeline/rotation/inboxPoolManager.js`
- `src/pipeline/rotation/bootstrapRuntimeCapacity.js`
- large inbox-queue sections of `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`
- `src/cli/recapture-agentmail-keys.js`
- any runbooks and manifests that exist only to manage controller roots, provider API keys, or prewarmed inbox pools

These should not survive as "legacy compatibility" unless a concrete remaining dependency proves it is still needed.

## 10. Risks and Unknowns

The biggest unknowns that still require validation are:

- Whether the upstream Root-Mail_a invite-creation failure is mailbox-provider related or an OpenAI workspace-side restriction unrelated to ingress.
- Whether owner role loss in the `workspace-owner-b` lineage is recoverable at all from currently known accounts.
- How OpenAI behaves for the chosen custom-domain automation subdomain in terms of invite and OTP deliverability.
- Whether a single automation subdomain is sufficient or whether lineages should be split across multiple subdomains or domains.
- How long refresh-bearing auth remains durable across normal operations.
- Whether the downstream router consumer will eventually need a stronger transactional boundary than JSON files.

The most dangerous assumptions would be:

- assuming self-hosted mail will fix owner recovery
- assuming a new hosted provider will fix workspace invite refusals
- assuming stateful browser capture will restore owner role when the underlying account no longer has it

Residual lock-in and provider risks:

- Mailgun creates ingress-provider dependency, but the design keeps it behind a narrow adapter.
- Fastmail creates owner-mail hosting dependency, but this is acceptable because it is the boring authority layer and supports open protocols.
- The real external lock-in remains OpenAI workspace behavior, not the email providers.

## 11. Draft Plan Output

### Recommended end-state

Build the next version of this system around:

1. **Fastmail-hosted owner mailboxes on a custom domain**
2. **Mailgun-hosted catch-all automation ingress on a separate subdomain**
3. **Local SQLite plus artifact-backed control plane**
4. **Existing bespoke browserless workspace and verification logic**
5. **Explicit owner-recovery browser-state fallback, not browser automation everywhere**

### Preserve

- Workspace selection and lineage logic
- Invite reuse and materialization rules
- Refresh-bearing auth enforcement
- Router verification and live probe gating
- Rollback on failed verification

### Remove

- Cloudflare Email Routing plus Worker capture
- mailbox-per-alias provisioning
- inbox pool bootstrap and prewarm logic
- provider-specific inbox-wait code spread through business flows

### Sequence

1. Introduce a local inbound event store and provider adapter layer.
2. Cut automation ingress over to catch-all custom-domain receiving.
3. Move owner mail to real hosted mailboxes.
4. Add explicit session vault and owner browser-state recovery lane.
5. Delete obsolete bootstrap and inbox-pool logic.
6. Reconsider self-hosted ingress only after the hosted-first architecture proves inadequate in practice.

### Final judgment

The right refactor is not a rewrite and not a platform swap frenzy. It is a **mail-plane simplification**:

- make owner authority boring
- make automation ingress durable
- keep workspace and auth correctness bespoke
- stop treating provider workarounds as core architecture

If this sequence is followed, a later implementer can converge on a much smaller system with fewer failure domains while preserving the only things that actually matter here: refresh-bearing auth correctness, workspace correctness, owner recovery safety, and deterministic rotation.

## Evidence anchors

### Repo evidence

- `docs/pipeline.md`
- `docs/plans/2026-03-29-deterministic-agentmail-codex-current-state-handoff.md`
- `docs/plans/2026-03-30-root-mail-a-determinism-writeup.md`
- `src/pipeline/rotation/routerOnboarder.js`
- `src/pipeline/rotation/workspaceOwnerRecaptureAuth.js`
- `src/pipeline/rotation/verifyRecoveredAlias.js`
- `src/pipeline/rotation/checkArchiveAndReplaceExhausted.js`
- `src/pipeline/rotation/workspaceRegistry.js`
- `src/pipeline/authTrace/agentMailInboundTransport.js`
- `artifacts/manual-browserless-onboard-live-rerun-20260329-owner-check.log`
- `artifacts/root-mail-a-determinism-20260330/invite-preload-prototype-failure-summary.json`
- `artifacts/auth-traces/2026-03-29T04-40-09-012Z-owner-password-reset-agent-browser-challenge/summary.json`

### External provider evidence

- Cloudflare Workers KV limits: https://developers.cloudflare.com/kv/platform/limits/
- Cloudflare Email Routing overview and limits: https://developers.cloudflare.com/email-routing/ and https://developers.cloudflare.com/email-routing/limits/
- Mailgun routes and stored-message retrieval: https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/route-actions and https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/
- Resend inbound receiving and retries: https://resend.com/inbound and https://resend.com/docs/webhooks/retries-and-replays
- Postmark inbound webhook retries and retention: https://postmarkapp.com/developer/webhooks/inbound-webhook and https://postmarkapp.com/support/article/how-long-are-inbound-and-outbound-messages-stored-in-activity
- Fastmail custom domains, catch-all aliases, and API protocols: https://www.fastmail.help/hc/en-us/articles/360058753394-Custom-domains-with-Fastmail , https://www.fastmail.help/hc/en-us/articles/360060591133 , https://www.fastmail.help/hc/en-us/articles/360058752394-Account-administrators , and https://www.fastmail.com/dev/