# Account-Router Lazy Startup Design

Date: 2026-03-26
Status: Approved

## Goal

Reduce pi startup latency with the `account-router` extension so load time is much closer to pi without extensions, without removing or breaking any existing router, dashboard, quota, polling, or failover behavior.

## Problem

`~/.pi/agent/extensions/account-router/index.ts` currently performs too much work during extension load and `session_start`:

- eager config and health loading
- eager alias registration
- eager runtime auth synchronization
- eager quota widget update
- eager startup auto-switch work
- eager background/global polling warmup

This makes pi feel slower even in sessions that never open `/accounts` and never trigger failover.

## Chosen approach

Use a **boot/runtime split**:

- keep a tiny boot path for extension registration
- defer heavy router work until needed
- keep `/accounts` fast with staged hydration
- keep reroute correctness by forcing runtime initialization before failover decisions

## Design

### Boot path
Only do:
- install hooks
- keep references to `ctx.modelRegistry` and `ctx`
- remember the current model
- schedule deferred startup maintenance

Do not do synchronous heavy work in the `session_start` hot path.

### Runtime initialization
Introduce a one-time `ensureRuntimeReady(ctx)` path that performs:
- `reload()`
- `health.load()`
- `registerAliases(ctx.modelRegistry)`
- `synchronizeRuntimeState(...)`

This must run before:
- `/accounts`
- `/quotas`
- reroute/failover logic
- any background maintenance that depends on config/health/auth state

### Deferred startup maintenance
Move these out of immediate `session_start` and into a scheduled delayed task:
- startup auto-switch check
- main quota widget update
- main quota widget follow-up refresh
- default-on poller warmup (only if policy/env says so)
- proactive auth refresh kickoff

This preserves behavior while moving cost off the visible startup path.

### Staged `/accounts` initialization
`/accounts` must call `ensureRuntimeReady(ctx)` before using config/health/router state.
That keeps correctness intact while allowing startup to stay cold.

### Invalidations
Any live config-changing path should mark runtime state dirty so the next feature path reinitializes cleanly.
At minimum:
- input-triggered config changes
- startup before first runtime use

## Safety rules

- do not remove polling, quota widget, failover, or auth refresh
- do not remove startup auto-switch; only defer it
- do not weaken strict quota/failover semantics
- do not require restart after config changes

## Expected outcome

- much faster visible startup/session entry
- no lost `/accounts` features
- no lost reroute behavior
- background work still happens, but after startup instead of in it
