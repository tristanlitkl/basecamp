# Architecture

Basecamp is a Next.js App Router frontend in `apps/web` and a FastAPI API in
`apps/api`. Vercel hosts the web app, Render hosts the API, and PostgreSQL
(Neon in production; Docker Compose locally) is authoritative.

Auth.js/NextAuth uses Google OAuth to establish identity and the web app issues
a shared-secret application JWT. FastAPI validates that JWT offline; it never
calls Google per API request. Plan membership roles control product actions;
the separate `ADMIN_EMAILS` allowlist controls the two application-operation
endpoints.

Product mutations use server-side role checks, optimistic concurrency, and
atomic idempotency claims. `plans.version` and `plans.planning_version` are
independent. Expense amounts are integer cents; equal-split remainders are
deterministic; the append-only ledger is the source for balances. Plan events,
notifications, and WebSocket invalidations follow committed mutations.

WebSockets are single-instance in-memory invalidations only. On connection or
sequence uncertainty, clients replace their state using the authoritative
`/resync` snapshot. Notifications are durable collaboration history and are
not expired by operations cleanup.

Recommendations are deterministic derived scores from saved plan state.
Deterministic LangGraph itinerary drafts persist non-authoritative snapshots;
their apply path rejects stale planning versions transactionally.
`/planning-status` remains read-only guidance over current planning state; it
does not replace drafts or create authoritative changes.

Phase 6 operations add compact `/health` database liveness, process-local
aggregate metrics, and bounded cleanup. Only completed/failed expired
idempotency records and completed/failed expired LangGraph runs are eligible.
Cleanup is shared by the admin endpoint, optional single-process APScheduler,
and a throttled post-resync background trigger. Metrics reset on restart and
are per instance; they are diagnostic counters, not durable distributed
telemetry.
