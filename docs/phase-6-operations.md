# Phase 6 operational audit

Current expiration-backed resources are deliberately limited:

- `idempotency_records.expires_at`: completed and permanently failed replay
  records are temporary. In-progress claims are preserved even after their
  expiry so cleanup cannot interfere with an active mutation.
- `langgraph_runs.expires_at`: completed or failed non-authoritative draft
  history may expire. `pending` and `running` records are preserved, and a
  null expiry means no automatic deletion.

`plan_invites` has no `expires_at` in the current schema, so it is not a
cleanup target. Notifications are durable collaboration history. Ledger
entries, expenses, plan events, memberships, votes, activities, itinerary,
and recommendation rows are retained because they support correctness or
history.

The cleanup service selects each resource in `expires_at ASC, id ASC` order,
locks at most `CLEANUP_BATCH_SIZE` rows with `SKIP LOCKED`, and deletes only
that selected batch in the same transaction. PostgreSQL has no `DELETE LIMIT`
dependency. The same service backs the APScheduler job, the protected manual
endpoint, and the throttled post-resync trigger.

The resync trigger is a process-local optimization: it schedules at most one
background cleanup attempt per `CLEANUP_INTERVAL_MINUTES` per process and
never delays or determines resync correctness. Process-local metrics use the
same deliberately non-durable scope.
