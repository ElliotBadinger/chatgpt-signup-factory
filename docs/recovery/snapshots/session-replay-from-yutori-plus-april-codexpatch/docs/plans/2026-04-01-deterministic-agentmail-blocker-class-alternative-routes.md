# Deterministic AgentMail Blocker-Class Alternative Routes

Date: 2026-04-01

## Purpose

Institutionalize the rule that no blocker is final. When a failure class repeats, the system must switch routes instead of retrying the same broken mechanism.

## Primary Principle

Switch routes when:

- the same typed blocker repeats
- the same surface keeps failing with different aliases
- the current lane depends on brittle state that another lane can avoid
- success requires keeping two conflicting control planes alive

## Failure Class: Wrong Workspace Persists In Production

Observed or likely signals:

- active `openai-codex` pool contains multiple workspace ids
- owner/name fallback silently selects a non-target workspace
- codex-lb and Pi disagree about which workspace is active

Primary route:

- hard-lock production to explicit `placementContext.workspaceId`
- quarantine all non-target-workspace aliases before quota reasoning

Fallback route:

- if current storage cannot express quarantine cleanly, disable those aliases in Pi and mark them archived or deactivated in codex-lb in the same reconciliation pass

Switch evidence:

- any active alias on workspace `a5052b4c-79aa-4415-b325-7161b5883518`
- mixed active provider pool after reconciliation attempt

## Failure Class: Durable Auth Upgrade Repeats Weakly

Observed or likely signals:

- owned OAuth yields non-refresh-bearing auth
- owned OAuth returns wrong workspace account id
- session-bound reset or OTP flows keep failing on the same state boundary

Primary route:

- Hydra login-challenge continuation using an already authenticated session plus PKCE token exchange

Fallback route:

- passwordless continuation only if it still produces refresh-bearing target-workspace auth

Do not keep as primary:

- reset-password-only recovery
- access-token-only persistence

Switch evidence:

- repeated `password-reset-initiation-failed`
- repeated missing refresh token
- repeated account mismatch after owned OAuth

## Failure Class: Quota Evidence Is Ambiguous

Observed or likely signals:

- only one collapsed quota fraction is available
- health data is stale
- provider status and quota data disagree

Primary route:

- persist explicit 5-hour and weekly windows from the quota source

Fallback route:

- treat ambiguous aliases as non-promotable and non-restorable until live quota proof is refreshed

Switch evidence:

- any restore or keep decision would rely on a synthetic or collapsed single window

## Failure Class: codex-lb And Pi Disagree

Observed or likely signals:

- alias active in Pi but absent or deactivated in codex-lb
- alias active in codex-lb but missing route/auth in Pi

Primary route:

- lifecycle reconciler writes both stores as one transition

Fallback route:

- freeze the alias in quarantine until both stores agree

Never do:

- treat one store as healthy enough by itself for routing

Switch evidence:

- any disagreement after a supposed successful lifecycle transition

## Failure Class: Active Pool Drops Below The Healthy Floor

Observed or likely signals:

- removal scheduled before replacement verification
- only 2 or 3 healthy aliases remain in the target workspace

Primary route:

- restore-first, then replacement append, then old-alias remove

Fallback route:

- keep degraded but still workspace-correct alias routed temporarily only if it still satisfies durable-auth and workspace checks while the replacement is completed

Never do:

- remove first and hope refill succeeds

Switch evidence:

- projected active healthy count would fall below 4 at any transition step

## Failure Class: Inbox Capacity Or Ingress Friction Blocks Net-New Creation

Observed or likely signals:

- mailbox provider capacity exhaustion
- repeated inbox creation failures
- inbox provider becomes the pacing item rather than OAuth or workspace lifecycle

Primary route:

- prefer restore of archived target-workspace aliases
- prefer recovery of existing target-workspace aliases before net-new creation

Fallback route:

- move OTP/invite ingress to a more durable catch-all or webhook-based mail path

Switch evidence:

- repeated provider-capacity failures
- inability to reach 4 healthy aliases through current inbox supplier

## Failure Class: Legacy And Newer Control Planes Fight Each Other

Observed or likely signals:

- old path reactivates aliases the new path quarantined
- policy differs between docs, live-fix prep, and rotate engine
- operators cannot tell which command is authoritative

Primary route:

- consolidate on `pipeline-check-archive-replace.js` plus one lifecycle reconciler

Fallback route:

- if full consolidation cannot land immediately, make the canonical command authoritative and explicitly deprecate all others in docs and CLI output

Switch evidence:

- any live mutation occurs outside the canonical operator command during the same workflow

## Route Priority Summary

Primary routes:

- explicit target-workspace lock
- restore-first for target-workspace aliases
- Hydra owned OAuth durability lane
- single lifecycle reconciler for Pi plus codex-lb
- dual-window `0.25` quota policy

Fallback routes:

- passwordless continuation if owned OAuth primary lane weakens
- quarantine-then-disable when existing stores cannot cleanly archive immediately
- conservative non-promotion on ambiguous quota evidence
- alternate ingress model if inbox capacity becomes the pacing bottleneck

## Operator Rule

If the same blocker class appears twice without materially new evidence, stop retrying the same lane and switch to the better route named in this memo.