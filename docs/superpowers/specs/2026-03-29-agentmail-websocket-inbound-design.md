# AgentMail WebSocket-First Inbound Transport Design

## Summary

Replace AgentMail polling as the steady-state inbound email read path with a shared, process-global WebSocket-first inbound transport. Preserve existing OTP/invite parsing, routing, deduplication, and persistence logic by inserting a thin adapter that emits a unified internal `new inbound message` event regardless of whether the source is WebSocket push or fallback polling.

## Goals

- Make AgentMail WebSockets the default inbound delivery mechanism.
- Keep polling only for startup reconciliation, post-reconnect catch-up, and explicit fallback when WebSocket establishment fails.
- Support current OTP and invite ingestion paths without changing their business rules.
- Provide a reusable shared inbound transport for future mail consumers.
- Normalize AgentMail event shape and naming differences seen in docs.
- Handle messages whose usable content is HTML-only.
- Ensure idempotent ingestion across mixed push/poll delivery.

## Non-Goals

- Introduce webhooks.
- Rewrite OTP extraction or invite matching heuristics.
- Restructure unrelated mailbox or onboarding flows.
- Depend on public webhook infrastructure.

## Relevant References

- `docs/reference/agentmail-docs/push-events-and-websockets.md`
- `docs/reference/agentmail-docs/api-reference-full.md`
- `docs/reference/agentmail-sdk/AgentClient.ts`
- `docs/reference/agentmail-schemas/domain.ts`

## Requirements Captured

1. Use AgentMail WebSockets first via `wss://ws.agentmail.to/v0?api_key=...` or SDK-equivalent connection flow.
2. After socket open, subscribe with a payload equivalent to:
   - `type: "subscribe"`
   - `inboxIds` / `inbox_ids`
   - `eventTypes` / `event_types: ["message.received"]`
3. Treat `message.received` as the primary new-mail signal.
4. Use payload `message` and `thread` directly when present.
5. Normalize both:
   - `message_received` and `message.received`
   - direct event style and wrapped `type: "event"` style
6. Prefer `message.html`; treat `message.text` as optional.
7. Reconnect with backoff, resubscribe after reconnect, and log socket lifecycle state.
8. Keep polling only for startup reconciliation, post-reconnect catch-up, and explicit fallback.
9. Expose a unified internal inbound-message event.
10. Add tests for subscribe, message handling, reconnect/resubscribe, fallback-to-polling, and duplicate suppression.

## Architecture

### 1. Shared process-global transport manager

Add a process-global AgentMail inbound manager responsible for maintaining one shared WebSocket connection per API key and multiplexing inbox subscriptions across consumers in the process.

Responsibilities:

- Open and own the AgentMail WebSocket connection.
- Track desired inbox subscriptions from active consumers.
- Send subscribe frames after socket open.
- Reconnect with bounded exponential backoff and jitter.
- Resubscribe after reconnect.
- Trigger startup reconciliation and post-reconnect catch-up polling.
- Fall back to polling when the socket cannot be established.
- Emit normalized inbound events to consumers.

Why process-global:

- Aligns with the requirement for a shared transport for current and future consumers.
- Avoids per-workflow socket churn.
- Centralizes reconnect/resubscribe/normalization behavior.

### 2. Thin normalized inbound adapter

Expose a narrow internal adapter so the rest of the system consumes a unified event shape instead of raw WebSocket or polling payloads.

Proposed normalized event shape:

```js
{
  kind: 'new-inbound-message',
  source: 'websocket' | 'poll',
  inboxId: string,
  messageId: string | null,
  threadId: string | null,
  receivedAt: string | null,
  message: object,
  thread: object | null,
  content: {
    html: string | null,
    text: string | null,
    preferredBody: string | null,
  },
  raw: object,
}
```

Consumers can then keep their existing matching/parsing rules while relying on a stable transport-agnostic shape.

### 3. Existing polling retained as bounded fallback/reconciliation

Keep the existing REST polling implementation but reposition it behind the transport manager for:

- startup reconciliation
- post-reconnect catch-up
- explicit fallback when WebSocket establishment fails

Polling is not used as the steady-state primary read path.

## Event Normalization

The transport must accept documented/raw variants and normalize them into a single internal event type.

### Accepted inbound forms

- `event.type === "message_received"`
- `event.type === "event" && event.eventType === "message.received"`
- `event.type === "event" && event.event_type === "message.received"`
- equivalent camel/snake/dot variants where docs differ

### Normalization rules

- Map both `message_received` and `message.received` to internal `new-inbound-message`.
- Read inbox identifier from `message.inboxId`, `message.inbox_id`, `thread.inboxId`, or `thread.inbox_id`.
- Prefer `message.messageId` / `message.message_id` as the stable message identifier.
- Use `message.threadId` / `message.thread_id` or thread metadata when present.
- Preserve the raw payload for diagnostics.

### Content rules

Compute normalized content as:

```js
{
  html: message.html ?? null,
  text: message.text ?? null,
  preferredBody: message.html ?? message.text ?? null,
}
```

Do not assume `preview` or `text` is present. `preview` may still be useful for diagnostics and older matching logic, but it is not treated as required body content.

## Lifecycle and Reliability

### WebSocket open and subscribe

On open:

1. Log open state.
2. Send subscribe message for all currently tracked inboxes.
3. Request only `message.received` events.
4. Log subscribed state when confirmed.

### Reconnect behavior

On close or recoverable error:

- log close/error
- schedule reconnect using bounded exponential backoff with jitter
- reconnect
- resubscribe all active inboxes
- run post-reconnect catch-up polling

Recommended backoff envelope:

- initial delay: 500ms to 1s
- multiplier: 2x
- max delay: 30s
- small random jitter
- reset after healthy reconnection

### Startup reconciliation

When an inbox is first registered with the shared transport, perform a bounded poll of recent inbound messages since a tracked watermark or recent lookback window. Emit matching normalized poll events through the same adapter and let dedupe suppress duplicates.

### Post-reconnect catch-up

After every reconnect, run a bounded reconciliation poll for active inboxes using the last known watermark. This ensures short disconnects do not silently drop inbound mail.

### Explicit fallback-to-polling mode

If the WebSocket cannot be established:

- log fallback activation
- run polling as a temporary transport
- keep emitting the same normalized events
- retry WebSocket establishment in the background
- once WebSocket is healthy again, return to push-first mode and stop fallback steady polling

## Watermarks and Idempotency

Track per inbox:

- last seen timestamp
- last seen message id
- optionally last seen AgentMail event id when present

These support:

- startup reconciliation windows
- post-reconnect catch-up windows
- duplicate suppression across mixed WebSocket/poll delivery

Duplicate suppression should prefer `(inboxId, messageId)` as the ingestion identity. If a WebSocket event and a poll result refer to the same message, only the first should be processed downstream; later duplicates are logged and dropped.

## Integration Plan

### Current code paths to migrate

Primary current consumers of AgentMail polling:

- `src/pipeline/authTrace/agentMailOtp.js`
- `src/pipeline/authTrace/openaiAuthReplay.js`
- `src/pipeline/rotation/routerOnboarder.js`
- `src/pipeline/rotation/chatGptAccountCreator.js`

### Integration approach

Refactor the current mailbox-waiting entry points so they consume the unified inbound transport instead of directly assuming polling.

Expected downstream behavior remains the same:

- OTP paths wait for the first normalized message whose subject/body matches the OTP matcher.
- Invite paths wait for the first normalized message whose content matches invite heuristics.
- Existing extraction, routing, dedupe, and persistence logic stays in place.

### Suggested responsibility split

- transport module: connection, subscribe, reconnect, resubscribe, normalization, fallback, catch-up
- polling helper: list/fetch messages and convert to normalized events
- consumer helpers: wait-for-match, OTP extraction, invite extraction

This split keeps transport concerns isolated from business logic.

## Logging

The transport should log at least:

- socket opening/opened
- subscribe payload intent
- subscribed confirmation
- socket close code/reason
- socket errors
- reconnect delay and attempt count
- reconciliation poll start/finish
- fallback-to-polling activation/deactivation
- duplicate suppression events at debug level

## Testing Strategy

Add focused tests for the shared transport and preserve/extend existing mailbox tests.

### Required tests

1. **initial subscribe**
   - opens socket
   - sends subscribe frame with target inboxes and `message.received`

2. **message.received handling**
   - accepts supported event naming variants
   - emits a normalized inbound event
   - prefers `html` over `text`

3. **reconnect + resubscribe**
   - reconnects after close/error
   - re-sends subscription after reconnect
   - runs catch-up reconciliation after reconnect

4. **fallback-to-polling behavior**
   - enters polling mode when websocket establishment fails
   - emits normalized poll-backed inbound events
   - retries websocket establishment in background

5. **duplicate-event suppression / idempotent ingestion**
   - suppresses duplicate websocket+poll deliveries for same inbox/message id
   - keeps downstream processing single-shot

### Additional valuable tests

- startup reconciliation emits recent unseen messages
- event wrapper normalization supports both `eventType` and `event_type`
- direct `message_received` and wrapped `message.received` variants both work
- HTML-only messages still match downstream extraction logic

## File-Level Design

Likely touch points:

- `src/pipeline/authTrace/agentMailOtp.js`
  - either host the new transport or delegate to a new nearby shared module
- `src/pipeline/authTrace/openaiAuthReplay.js`
  - switch mailbox waiting to the unified transport
- `src/pipeline/rotation/routerOnboarder.js`
  - switch OTP waiting to the unified transport
- `src/pipeline/rotation/chatGptAccountCreator.js`
  - switch OTP/invite waiting to the unified transport
- `tests/pipeline/rotation/routerOnboarder.test.js`
  - extend mailbox behavior coverage or split out transport-focused tests
- new shared transport test file if needed

If the code starts to become crowded, prefer a focused new module next to `agentMailOtp.js` for the transport manager rather than growing one file too large.

## Risks and Mitigations

### Risk: duplicate delivery from reconciliation
Mitigation: strict `(inboxId, messageId)` idempotency boundary.

### Risk: event shape mismatch from docs vs reality
Mitigation: normalization layer explicitly supports dotted/snake/camel variants and retains raw payloads for diagnostics.

### Risk: HTML-only messages break current matching assumptions
Mitigation: normalized `preferredBody` uses HTML first and keeps text optional.

### Risk: reconnect storms
Mitigation: bounded exponential backoff with jitter.

### Risk: transport complexity leaks into business logic
Mitigation: maintain thin adapter boundary and preserve existing OTP/invite logic.

## Recommended Implementation Direction

Implement a new shared, process-global AgentMail inbound transport with WebSocket-first delivery, bounded reconciliation polling, and a unified normalized inbound event contract. Migrate current OTP/invite call sites to that contract without changing their business logic.

## Acceptance Criteria

The work is complete when:

- steady-state inbound reading uses AgentMail WebSockets, not polling
- subscribe occurs after open with inbox filters and `message.received`
- both `message_received` and `message.received` forms are handled
- HTML is preferred over text during content extraction
- reconnect + resubscribe works with logs and bounded backoff
- startup reconciliation, reconnect catch-up, and explicit fallback polling work
- current OTP/invite flows still function without business-logic regressions
- duplicate events are ingested idempotently
- automated tests cover the required scenarios
