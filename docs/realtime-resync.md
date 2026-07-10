# Realtime And Resync

Basecamp uses in-memory FastAPI WebSocket rooms for the MVP.

WebSocket messages are notifications, not authority. The source of truth is Postgres, and clients recover by calling REST resync after reconnect.

## Phase 1A.5 Rules

- A WebSocket connection only proves authentication, authorization, and transport availability.
- Every successful connection or reconnection must be followed by `GET /plans/{plan_id}/resync`.
- The frontend replaces local plan state with the resync response.
- Reconnect delay uses capped exponential backoff with jitter:
  `min(2000 * 2^attempt + random(0, 1000), 30000)`.
- The first connection attempt allows a 55 second handshake window for Render cold starts.
- After repeated reconnect failures, the UI stops automatic retries and shows manual retry.
