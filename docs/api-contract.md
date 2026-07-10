# API Contract

Bootstrap rule: do not add generic CRUD resources or placeholder endpoints outside the active phase.

## Phase 1A.5 Resync

`GET /plans/{plan_id}/resync`

- Requires `Authorization: Bearer <app_jwt>`.
- Requires server-side plan membership.
- Returns a complete authoritative snapshot, not a delta:
  - `plan`
  - `members`
  - `activities`
  - `activity_scores`
  - `itinerary_items`
  - `votes`
  - `expenses`
  - `expense_splits`
  - `ledger_entries`
  - `latest_plan_events`
  - `server_version`

## Phase 1A.5 WebSocket

`/ws/plans/{plan_id}?token=<app_jwt>`

- Validates the same app JWT used by HTTP auth.
- Requires server-side plan membership.
- Sends one message on success: `{"type":"connected"}`.
- The connected message is not authoritative state. Clients must call `/resync`.
