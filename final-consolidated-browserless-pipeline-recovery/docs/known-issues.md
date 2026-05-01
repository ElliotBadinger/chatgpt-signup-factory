# Known Issues

## Open
1. **Production relay upgrade stall is currently reproducible beyond the local machine**
   - The production relay hostname resolves and completes TLS, but websocket upgrade requests are hanging during verification.
   - The same timeout now reproduces through an Ink-hosted relay tunnel, which means the issue is presently upstream of the local Linux transport path as tested so far.
   - This blocks final live proof for Scouts `Yutori Local is running` and real production browser sessions.
   - Evidence: `artifacts/logs/app-connected.log`, `artifacts/logs/probe-desktop.log`, `artifacts/logs/ws-debug.log`, `artifacts/logs/relay-tunnel-probe.log`, `artifacts/logs/relay-tunnel-ink.log`

2. **No production-equivalent alternate relay endpoint has been discovered yet**
   - The latest public DMG (`0.4.8`) still embeds the same prod relay hostname.
   - The authenticated Scouts API surface discovered so far (`/client/desktop/status`, `/client/desktop/login`) has not yet exposed an alternate relay host.

3. **Desktop control on Linux still needs clearer runtime surfacing**
   - The executor code is cross-platform-capable, but the current permission/status path still reports non-macOS as unsupported.
   - Browser-mode parity is working locally; desktop control still needs either Linux enablement or a clearer renderer affordance.

4. **Renderer status visibility is limited**
   - The current recovered renderer shows the original settings UX, but live relay status proof is pending because of the upstream relay stall.

## Confirmed platform limitations
- **iMessage is unsupported on Linux.** The port does not register iMessage tools on Linux and does not claim otherwise.

## Implemented Linux substitutes
- **Terminal access:** implemented with allowlisted execution, timeout/output limits, Bubblewrap preference, and restricted fallback.

## Notes for follow-up
- Relay URL override support and a mock relay harness are now in place; use them while continuing live production relay investigation.
- Add an explicit Linux desktop-control support indicator in the renderer UI.
