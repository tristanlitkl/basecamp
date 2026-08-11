# Basecamp — Canonical Implementation Roadmap

Basecamp is a real-time collaborative group outing planner. Its purpose is to
help a group plan an outing together with dependable collaboration, manually
entered activities, itinerary management, and exact expense settlement.

## Product scope

The product centers on:

- Manual activity creation and editing, with optional address, coordinates,
  cost, duration, tags, and notes.
- Group voting, comments, activity suggestions, date suggestions, trip notes,
  trip-member roles, and owner/co-owner workflows.
- Versioned itinerary management with conflict-safe reordering.
- Integer-cent expenses, deterministic splits, immutable zero-sum ledger
  entries, and balances computed at read time.
- Realtime invalidation notices followed by authoritative `/resync` recovery.

Basecamp intentionally has no place-discovery or provider-backed planning
surface. Creating and editing activities must remain fully usable without a
network dependency beyond Basecamp's own API.

## Canonical architecture

- `apps/web`: Next.js App Router frontend, deployed to Vercel.
- `apps/api`: FastAPI backend, deployed to Render.
- Postgres is the source of truth (Neon in production; Docker Compose
  locally).
- Google OAuth establishes identity; the web app issues an app JWT signed
  with the shared `JWT_SECRET`; FastAPI verifies that JWT offline.
- A single-instance in-memory WebSocket room manager provides notification
  broadcasts. WebSocket messages are never authoritative.

## Non-negotiable guardrails

1. Basecamp is the project name everywhere. The canonical service roots are
   `apps/web` and `apps/api`.
2. Authentication is two-stage: Google OAuth for identity, then a shared-secret
   app JWT for API authorization. FastAPI never calls Google per request.
3. `plans.version` and `plans.planning_version` are independent counters.
4. All money uses integer cents. Equal splits use `//` and `%`, with remainder
   distributed deterministically by sorted user ID.
5. Ledger entries are immutable and append-only. Balances are calculated from
   ledger sums; there is no stored mutable balance.
6. Mutations use server-side role checks, optimistic concurrency where
   applicable, and atomic idempotency claims for create-style operations.
7. Mutation order is validate → commit to Postgres → write `plan_events` →
   broadcast. Clients recover by replacing state from `/resync`.
8. In-memory room broadcasts iterate a copied socket-set snapshot, never the
   live set.
9. Do not introduce generic CRUD resources, Redis Pub/Sub, AI features, or
   future-phase work without an explicit phase prompt.

## Implemented phase sequence

| Phase | State |
|---|---|
| 0 | Local database and migration foundation. |
| 1A | Authenticated product shell, plans, invites, manual activities, and voting. |
| 1A.5 | WebSocket authentication, reconnect/backoff, and authoritative resync. |
| 1B | Optimistic concurrency, itinerary ordering, expenses, ledger, lifecycle, and idempotency. |
| 1C | In-memory realtime collaboration with post-commit invalidations. |
| 3 | Deterministic activity recommendations from saved planning state. |
| De-scope | Place discovery, route estimates, forecasts, and their supporting application code are removed. Historical database migrations remain immutable. |

Future feature phases beyond Phase 3 are not authorized by this roadmap. Do
not begin a new feature phase as part of cleanup work.

## Phase 3 — Deterministic Activity Recommendations

Recommendations are derived data from the authoritative plan, activity, vote,
itinerary, availability, and membership rows. They neither introduce a new
planning input nor infer information that Basecamp does not store.

### Score scale and formula

Every component score is an integer in `0..1000`. The total is integer-only:

```py
total_score = (
    vote_score * 500
    + budget_score * 250
    + schedule_fit_score * 250
) // 1000
```

- Vote support: 50% (`500`)
- Budget fit: 25% (`250`)
- Schedule/date fit: 25% (`250`)
- Preference fit: 0% (`0`)

Because the three weighted components are each bounded in `0..1000` and their
weights sum to `1000`, `total_score` is also an integer in `0..1000`.

### Preference neutrality

Basecamp has no authoritative stored member-preference signal. Accordingly,
`preference_score` is persisted as the neutral value `500`, its weight is `0`,
and no synthetic preference rows or values may be created. Preference cannot
affect ranking until a future roadmap phase explicitly adds an authoritative
preference input.

### Component rules

Vote support uses votes from current plan members only. `yes` contributes `+2`,
`maybe` contributes `+1`, and `no` contributes `-2`. With `N` current members,
the normalized score is clamped to `0..1000` after integer division:

```py
raw = 2 * yes + maybe - 2 * no
vote_score = ((raw + 2 * N) * 1000) // (4 * N)
```

No votes, or no current members, produces the neutral vote score `500`.

Budget comparison uses integer cents only: an activity cost at or below the
plan budget scores `1000`; an over-budget activity scores `0`; missing activity
cost or plan budget scores the neutral `500`.

For a scheduled activity, a date outside a present plan start or end boundary
scores `0`. Otherwise, responses on that scheduled date from current members
are averaged with integer division: `available = 1000`, `maybe` or missing
response = `500`, and `unavailable = 0`. An unscheduled activity, or a
scheduled activity with no availability responses, scores the neutral `500`.

### Determinism and derived-data guardrails

Ranking is deterministic: total score descending, then activity `created_at`
ascending, then activity UUID ascending. Identical authoritative plan state
therefore produces identical rankings.

Recomputing recommendation rows is derived-data maintenance only. It must not
change `activity.version`, `plans.version`, or `plans.planning_version`; mutate
activity content or votes; append a recommendation-specific planning event; or
emit an independent recommendation WebSocket message. The authoritative
mutation that changed an input retains its own normal event and broadcast.

## Repository structure

```txt
basecamp/
  docs/
  apps/
    web/
      src/
        app/
        components/
        hooks/
        lib/
        types/
    api/
      app/
        api/routes/
        models/
        realtime/
        schemas/
        services/
      alembic/versions/
      tests/
```

## Definition of done for the current de-scope

- There is no Explore Places UI, hidden feature flag, discovery state, route
  lookup, forecast display, or provider-status rendering.
- Manual activity entry and editing remain functional.
- The plan-scoped discovery, routing, and forecast endpoints are absent.
- The supporting adapters, cache application models, service layer, and tests
  are absent when no remaining Basecamp feature uses them.
- Existing Alembic migrations are unchanged; no cosmetic schema-cleanup
  migration is introduced.
- Auth, roles, plan versions, idempotency, itinerary, expenses, ledger,
  WebSockets, `/resync`, dashboard tiles, notes, members, and voting continue
  to work.

## Verification

```bash
cd apps/api
uv run pytest -q
uv run ruff check app tests
uv run ruff format --check app tests
uv run python -m compileall -q app

cd ../web
npm test
npm run typecheck
npm run build

cd ../..
git diff --check
git status --short
git diff --name-status
git diff --stat
```
