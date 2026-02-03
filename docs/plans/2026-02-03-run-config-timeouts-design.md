---
type: analysis
title: Run Config and Fail-Fast Timeouts Design
created: 2026-02-03
tags:
  - run-config
  - timeouts
  - signup-factory
related:
  - "[[2026-02-03-run-config-timeouts-plan]]"
---

# Run Config and Fail-Fast Timeouts Design

## Architecture

The run configuration should live in a small, explicit module that centralizes all time-based limits and retry counts, with sensible defaults and predictable environment overrides. This module should expose a single getter that reads environment variables, validates them, and returns a plain object used by runtime code. The runtime paths that currently hardcode sleeps and timeouts should be updated to reference the config object so that the system has a single “source of truth” for wall-clock enforcement. A hard maximum run duration needs to be enforced in the main automation loop so the run fails fast instead of drifting. The design should keep the config object in memory, passed into `SignupFactory` from the CLI entry point, so it is easy to log or override without hidden globals. In addition, the snapshot retrieval logic should incorporate a short retry delay from config to reduce transient missing snapshots without slowing the loop. These changes keep the behavior deterministic, reduce the time spent in stuck states, and allow test coverage over configuration parsing and clamping, while avoiding invasive changes to the browser/mcp wiring.

## Data Flow and Error Handling

The CLI entry point loads configuration and passes it into `SignupFactory`, which stores it as `this.config`. The `run()` method should capture a start timestamp and enforce a maximum run duration with a clear error message that includes elapsed time. The per-iteration delay should use the configured step timeout to avoid 5-second fixed sleeps. OTP retrieval should use a configurable timeout so fast-fail can be tuned depending on mailbox latency. Snapshot retrieval should return the first non-empty snapshot, retrying once after a configured delay, and otherwise return an empty string to allow state detection to fail gracefully. Stuck-state logic should use a configurable limit before hard failing and persisting debug artifacts. Jest’s global timeout should align with the maximum run duration so tests do not outlive the intended runtime constraints. For testing, the configuration module can be exercised with environment overrides and clamping behavior, while the runtime can be validated by unit tests where feasible without requiring live browser state.
