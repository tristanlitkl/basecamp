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

## Phase 1B Balances

`GET /plans/{plan_id}/balances`

- Requires `Authorization: Bearer <app_jwt>` and server-side plan membership.
- Returns every plan member as `{user_id, balance_cents}`.
- Values are authoritative read-time sums from immutable ledger entries; no mutable balance is stored.

## Phase 1B.75 Coordination

- Activities may include nullable `travel_mode`: `car`, `plane`, `train`, or `bus`. It is persisted on the activity and returned by activity create/edit reads and authoritative `/resync` snapshots.

- `PATCH /auth/me` updates only the authenticated user's Basecamp `display_name`; Google identity claims remain immutable.
- `/plans/{plan_id}/members` exposes display names and roles, never member emails in the authoritative snapshot.
- Primary owners manage roles; co-owners may remove regular members only. Removing a membership is permitted even after finalization and immediately revokes plan access while preserving historical user/ledger records.
- `PATCH /plans/{plan_id}/vote-visibility` selects `public` or `anonymous`. Anonymous resync responses include totals and the current user's own vote only; other voter records and vote events are omitted.
- Activity comments remain available on finalized plans. Suggestions may be submitted, but acceptance is rejected while finalized.
- Date availability and range suggestions coordinate with, but do not overwrite, authoritative plan dates until an owner/co-owner accepts a current-version suggestion.
- Comment creation, activity-suggestion creation, and date-suggestion creation require `client_operation_id` in the JSON body. Repeating an identical actor/plan/operation/payload replays the stored status/body; reusing the ID with another payload returns `409 idempotency_key_reused`.
- Activity/date suggestion decisions and role changes accept `client_operation_id` in their JSON body. Member removal accepts it as a query parameter. They use the same atomic claim/replay path, so an accepted decision cannot apply more than once.

## Phase 1B.75 Coordination Extension

- `PATCH /plans/{plan_id}` allows owners/co-owners to update title and nullable plan-level `travel_mode`, `travel_duration_minutes`, and `travel_notes` with `expected_version`. These planning inputs increment both plan counters.
- Activity creator display names are included in authoritative `/resync`; legacy activity travel mode remains stored but is no longer edited by the normal application UI.
- `PUT /plans/{plan_id}/date-suggestions/{suggestion_id}/vote` upserts the current member's `yes`, `maybe`, or `no` vote without changing plan versions.
- Date suggestions in `/resync` include computed vote totals and only the current member's selected date vote. Accept/dismiss decisions remain owner/co-owner-only, idempotent, terminal, and version-checked.
- `POST /plans/{plan_id}/plan-suggestions` creates an idempotent whole-plan suggestion. Owner/co-owner accept/dismiss endpoints require current plan version and an operation ID.
- Adopting a whole-plan suggestion copies only supported, non-null plan metadata. Activities, itinerary, expenses, ledger entries, comments, votes, membership, ownership, and audit history are preserved.
