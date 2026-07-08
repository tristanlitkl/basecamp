# Basecamp — Canonical Vibe-Coding Implementation Roadmap for Codex

This is the merged, cleaned, single-source build spec for **Basecamp**. It combines the strongest parts of both uploaded documents:

- The **Basecamp Implementation Roadmap** provides the current product name, North Star, monorepo layout, deployment targets, and architecture-specific phase order.
- The **Basecamp Vibe-Coding Roadmap** provides the stronger Codex anti-drift guardrails, Definition of Done checklists, and phase-by-phase prompt discipline.

This file is intentionally written for **vibe coding with Codex**. Treat it as a canonical engineering spec, not a brainstorming document. Paste one phase prompt at a time into Codex. Do not ask Codex to implement multiple phases at once.

---

## Codex Usage Rules

1. **Project name is Basecamp everywhere.** Codex must not create or reference any alternate project name in code, docs, package names, env vars, comments, UI copy, migration names, or tests.
2. **Use one canonical repo layout.** The repo is a monorepo named `basecamp/` with `apps/web` for Next.js and `apps/api` for FastAPI. Do not create legacy root-level service folders; use exactly `apps/web` and `apps/api` under the `basecamp/` monorepo.
3. **Work phase by phase.** Paste the Master Guardrail Reference, then paste only the current phase prompt. Do not let Codex jump ahead.
4. **Reject stubs and generic CRUD.** If Codex writes TODOs, placeholder `/items` routes, unauthenticated CRUD, fake tests, or shortcuts around guardrails, reject the output and ask for a rewrite.
5. **Tests are gates.** Do not move to the next phase until the phase Definition of Done passes locally.
6. **Architecture beats speed.** This project is impressive because of correctness: JWT auth bridge, offline FastAPI verification, in-memory realtime with resync, integer-cent ledger, idempotency, optimistic concurrency, stale-draft protection, and graceful degradation.

---

## North Star

Basecamp is **not** an AI trip generator. Build it as a real-time collaborative group outing planner with strong backend correctness.

The core architecture is:

- Next.js frontend deployed on Vercel
- FastAPI backend deployed on Render
- Neon Postgres as the source of truth
- NextAuth/Auth.js Google OAuth for identity
- App-issued JWT signed by NextAuth using shared `JWT_SECRET`
- FastAPI validates the app JWT offline using PyJWT
- In-memory FastAPI WebSocket room manager for the MVP
- REST `/resync` after reconnect
- Integer-cent expense system
- Immutable zero-sum ledger
- Optimistic concurrency
- Idempotent create operations
- Dual version tracking: `plans.version` and `plans.planning_version`
- Deterministic recommendations before any LLM involvement
- LangGraph deterministic planning with stale-draft protection
- Optional AI polish only, with deterministic fallback

The build order protects the hard engineering parts early so Codex does not drift into a generic CRUD trip-planner.

---

## Canonical Repository Structure

Codex must use this structure unless a later phase explicitly adds files under it.

```txt
basecamp/
  README.md
  docker-compose.yml
  .env.example
  .gitignore
  docs/
    architecture.md
    api-contract.md
    auth.md
    realtime-resync.md
    ledger-invariants.md
    deployment.md
    upgrade-triggers.md
    codex-guardrails.md
  apps/
    web/
      package.json
      next.config.ts
      tsconfig.json
      .env.example
      src/
        app/
          page.tsx
          layout.tsx
          dashboard/
            page.tsx
          plans/
            [planId]/
              page.tsx
          invites/
            [token]/
              page.tsx
          privacy/
            page.tsx
          terms/
            page.tsx
          api/
            auth/
              [...nextauth]/
                route.ts
        components/
          auth/
          dashboard/
          plans/
          activities/
          itinerary/
          expenses/
          realtime/
          ui/
        lib/
          api-client.ts
          auth.ts
          app-jwt.ts
          websocket-client.ts
          query-client.ts
          env.ts
        hooks/
          usePlanSocket.ts
          useResyncPlan.ts
          useConnectionStatus.ts
        types/
          api.ts
    api/
      pyproject.toml
      alembic.ini
      Dockerfile
      app/
        main.py
        core/
          config.py
          database.py
          security.py
          errors.py
          cors.py
        models/
          user.py
          plan.py
          activity.py
          itinerary.py
          vote.py
          expense.py
          ledger.py
          event.py
          idempotency.py
          cache.py
          langgraph_run.py
          ai.py
          metrics.py
          launch.py
        schemas/
          auth.py
          plan.py
          activity.py
          itinerary.py
          vote.py
          expense.py
          resync.py
          recommendation.py
          planning.py
          ai.py
          launch.py
        api/
          deps.py
          routes/
            auth.py
            plans.py
            invites.py
            activities.py
            votes.py
            itinerary.py
            expenses.py
            recommendations.py
            planning.py
            ai.py
            health.py
            admin.py
        services/
          auth_service.py
          plan_service.py
          member_service.py
          activity_service.py
          vote_service.py
          itinerary_service.py
          expense_service.py
          ledger_service.py
          idempotency_service.py
          event_service.py
          recommendation_service.py
          external_api_service.py
          planning_graph.py
          ai_provider.py
          cleanup_service.py
          launch_control_service.py
        realtime/
          connection_manager.py
          websocket_routes.py
          events.py
        external/
          nominatim.py
          overpass.py
          osrm.py
          open_meteo.py
      tests/
        unit/
        integration/
        realtime/
        concurrency/
      alembic/
        versions/
```

---

## Canonical Stack Decisions

- **Frontend:** Next.js App Router, TypeScript, Auth.js/NextAuth, React Query or equivalent query caching, minimal UI library if desired.
- **Backend:** FastAPI, Python 3.12, SQLAlchemy 2.x, Alembic, Pydantic v2, PyJWT.
- **Database:** Neon Postgres. Local Postgres through Docker Compose.
- **Auth:** Google OAuth in NextAuth; app JWT signed inside NextAuth server-side callbacks; FastAPI verifies offline.
- **Realtime:** Single-instance in-memory FastAPI WebSockets for MVP. No Redis Pub/Sub until scaling requires it.
- **External APIs:** Nominatim, Overpass, OSRM, Open-Meteo, all cache-first and fallback-safe.
- **AI:** Optional polish layer only. Deterministic recommendations and deterministic LangGraph planning come first.
- **Money:** Integer cents only. No floats. No mutable balances.

---

## Phase Execution Rule

For every phase, paste this instruction before the phase-specific prompt:

```md
You are implementing Basecamp in the existing `basecamp/` monorepo. Before coding, read `docs/codex-guardrails.md`, `docs/architecture.md`, and the current phase prompt. Implement only the current phase. Do not skip tests. Do not create TODO stubs. Do not rename Basecamp. Do not create `/backend` or `/frontend`; use `apps/api` and `apps/web`.
```

---

## Master Guardrail Reference

These are cross-cutting constraints from the PRD that AI agents statistically tend to "simplify away" because they look like unnecessary complexity in isolation. Each phase below tells you which of these are *live* in that phase.

| # | Guardrail | The trap the agent will fall into if unguarded |
|---|---|---|
| **G1** | Auth is two-phase: Google OAuth (identity) → app-issued JWT (authorization), signed via a **shared `JWT_SECRET`** between NextAuth and FastAPI. FastAPI validates offline via PyJWT — **never** calls Google per-request. | Agent wires FastAPI to hit Google's tokeninfo/userinfo endpoint on every request, or has NextAuth call a live FastAPI endpoint during the login callback to mint the JWT. Both add a brittle network hop and break under Render cold starts. |
| **G2** | Plans carry **two independent version counters**: `version` (broad concurrency) and `planning_version` (only bumps on things that can stale a LangGraph draft). | Agent collapses these into one `version` field "for simplicity," which either creates false-positive stale-draft warnings on every vote, or fails to detect real staleness. |
| **G3** | All money is **integer cents**. No floats, no `Decimal` division that isn't explicitly integer-safe. Splits use `//` and `%`, remainder distributed deterministically (sorted `user_id`). | Agent uses `amount / member_count` in Python (float) or a `NUMERIC` column with implicit float casting in the ORM layer, silently breaking the zero-sum invariant. |
| **G4** | In-memory WebSocket room broadcaster (`dict[plan_id, set[WebSocket]]`) must broadcast over a **copied snapshot** of the socket set, never the live set. | Agent iterates the live `set()` directly, causing `RuntimeError: Set changed size during iteration` under concurrent join/leave — a bug that won't show up in a single-user demo but will show up with real users. |
| **G5** | WebSocket messages are **never authoritative**. Order is always: validate → commit to Postgres → write `plan_events` → broadcast. Clients recover via `/resync`, not by trusting the socket. | Agent updates in-memory/broadcast state before or without a DB commit "for responsiveness," so a reconnecting client can never actually recover truth. |
| **G6** | Idempotent creates use an atomic claim insert: `INSERT ... ON CONFLICT (plan_id, actor_id, client_operation_id) DO NOTHING RETURNING id`, keyed with a canonical request hash. | Agent does a `SELECT` check-then-`INSERT` (race condition) instead of an atomic conflict-clause insert, or skips idempotency entirely on "simple" endpoints. |
| **G7** | LangGraph runs snapshot `base_planning_version` at start. On completion, compare to current `plan.planning_version`. Mismatch = stale draft, **Apply is disabled**, no auto-overwrite. | Agent implements a naive "lock the room while generating" pattern instead of staleness detection, or skips the version-diff check and always allows Apply. |
| **G8** | Every external API (Nominatim, Overpass, OSRM, Open-Meteo) must degrade gracefully: cache first, explicit fallback (manual entry, straight-line distance, neutral weather score of 0.5), explicit UI-facing "unavailable" state. | Agent lets an external API failure raise an unhandled exception that 500s the whole itinerary-generation or activity-creation flow. |
| **G9** | Ledger entries are **immutable and append-only**; edits/deletes are reversal entries. Zero-sum per expense and per plan. Balances are computed via `SUM(...)` on read — no mutable stored balance column. | Agent adds an `UPDATE balances SET amount = ...` convenience column "for performance," which will eventually desync from the ledger truth. |
| **G10** | Role/permission checks (owner vs. member) are enforced **server-side**, per the PRD's permission matrix, on every mutating endpoint — not just hidden in the frontend UI. | Agent hides a "Finalize" button in the frontend for members but leaves the backend endpoint open to any authenticated plan member. |
| **G11** | Cache-like tables (`weather_snapshots`, `route_cache`, `place_cache`, `langgraph_runs`, `ai_polished_summaries`) carry `expires_at` and are **actually deleted** on a schedule + opportunistically — not just marked stale and left to grow forever. | Agent adds the `expires_at` column but never writes the cleanup job, so Neon Free storage silently fills up. |
| **G12** | AI is a `LLMProvider` abstraction with `NoopProvider` as the **default**. Real providers (Groq/Gemini) are opt-in via env var, and the LLM only polishes already-validated JSON — it never selects activities or writes state. | Agent wires the "real" LLM provider as the only path, with no deterministic fallback, so a quota failure becomes a user-facing crash instead of a graceful summary. |
| **G13** | `LAUNCH_MODE` (`private_beta | soft_launch | public_launch | waitlist`) gates signup/access behavior at the application layer, not just as documentation. | Agent treats launch mode as a comment/README note instead of an enforced runtime check on the signup and plan-creation paths. |

---

## Phase Map (Execution Order)

| Phase | Name | Deployable State After This Phase |
|---|---|---|
| 0 | Local Foundation | `docker compose up` gives a working local Postgres + FastAPI skeleton with correct schema foundations |
| 1A | Product Shell + Private OAuth | A single allowlisted user can log in via Google, get an app JWT, create a plan, invite a friend, add a manual activity, and vote — deployed to Vercel + Render + Neon |
| 1A.5 | Resync + WebSocket Backoff Core | The app survives WebSocket drops, Render sleep, and cold starts without losing state — **mandatory before any further realtime feature work** |
| 1B | Planning Correctness | Itinerary versioning, expense splitting, immutable ledger, finalize/un-finalize lifecycle, and idempotency are all backend-enforced |
| 1C | MVP Realtime Collaboration | Two real users can co-edit a plan live on a single backend instance safely, with no Redis Pub/Sub |
| 2 | External APIs + Caching | Place search, routing, and weather work — and fail gracefully — with caching and rate limiting |
| 3 | Deterministic Recommendations | Spotify-style ranked, explainable recommendations without any LLM involved |
| 4 | LangGraph Planning + Stale-Draft Protection | A full deterministic planning workflow produces a validated draft that can never silently clobber a human's concurrent edits |
| 5 | Optional AI Polish | A quota-aware, cached, fallback-safe LLM polish layer on top of an already-correct system |
| 6 | Cleanup, Metrics, Docs, Demo Reliability | The system is observable, self-cleaning, and demo-safe |
| 7 | Real-User Beta (Operational, not a code phase) | Real friends are using the app; you are watching failure classes, not writing new features |
| 8 | Public Launch Readiness | OAuth production readiness, legal pages, and launch-mode throttles are all live and enforced |
| 9 | Public / Reddit Soft Launch (Operational, not a code phase) | Controlled, staged public rollout with waitlist mode as an escape valve |

---

## Phase 0 — Local Foundation

### Objective
Stand up the local dev environment and the database schema foundation before any UI or business logic exists.

### Scope
- Docker Compose: Postgres 16 service, backend service (FastAPI), `.env.example`.
- FastAPI project skeleton with SQLAlchemy + Alembic wired (no `create_all()` — migrations only).
- Core tables from the data model, focused on structural correctness: `users`, `plans` (with **both** `version` and `planning_version`), `plan_members`, `activities`, `itinerary_items`, `expenses`, `expense_splits`, `ledger_entries`.
- All lat/lng columns as `NUMERIC(9,6)` — **no PostGIS extension**.
- All money columns as `INTEGER` (cents) — **no FLOAT, no implicit-float NUMERIC for currency**.
- Basic README with one-command startup instructions.

### Guardrails Active This Phase
- **G2** — `plans.version` and `plans.planning_version` must both exist as separate `INTEGER NOT NULL DEFAULT 1` columns from the very first migration. Retrofitting this later is painful.
- **G3** — Every money-bearing column must be `INTEGER`, named with an explicit `_cents` suffix. Reject any column named `amount`, `cost`, or `price` without the suffix.
- **G9** — `ledger_entries` has no `updated_at` and no mutable balance column — it is insert-only by design from day one.

### Explicit Non-Goals This Phase
- No auth, no API endpoints beyond a health check, no frontend, no WebSockets, no Redis.

### Vibe-Coding Prompt

```markdown
You are setting up the local development foundation for a backend project called
"Basecamp" — a real-time collaborative group outing planner. This phase is
foundation-only: schema and local tooling. Use the canonical monorepo layout:
`basecamp/apps/api` for FastAPI and `basecamp/apps/web` for Next.js. Do not create legacy root-level service folders; use exactly the canonical monorepo paths above. Do not build any API routes beyond
a health check, and do not build any frontend code.

## Stack
- FastAPI (Python 3.12)
- SQLAlchemy 2.x (async engine, `asyncpg` driver)
- Alembic for migrations — DO NOT use `Base.metadata.create_all()` anywhere.
  All schema changes must go through a generated Alembic revision.
- PostgreSQL 16 via Docker Compose
- Pydantic v2 for settings and (later) schemas

## Deliverables

1. `docker-compose.yml` with services:
   - `postgres`: image `postgres:16`, persisted volume, exposed on 5432,
     credentials sourced from `.env`.
   - `backend`: builds from a `Dockerfile` in `apps/api`, depends on `postgres`,
     mounts source for hot reload, runs `uvicorn app.main:app --reload`.
   Do NOT include a Redis service in this phase.

2. `.env.example` at repo root containing (values as placeholders, not real secrets):
   `DATABASE_URL`, `JWT_SECRET`, `ENVIRONMENT`.

3. `apps/api` FastAPI project structure:
   ```
   apps/api/
     app/
       main.py            # FastAPI app, includes /health only
       config.py          # Pydantic Settings class reading from env
       db/
         base.py          # SQLAlchemy declarative base + async session factory
         models/
           user.py
           plan.py
           plan_member.py
           activity.py
           itinerary_item.py
           expense.py
           expense_split.py
           ledger_entry.py
     alembic/
       env.py             # configured to read DATABASE_URL from Settings
       versions/
     alembic.ini
     Dockerfile
     pyproject.toml (or requirements.txt)
   ```

4. SQLAlchemy models with these HARD requirements:
   - `plans` table MUST have both `version: Mapped[int]` (default 1) AND
     `planning_version: Mapped[int]` (default 1) as two distinct columns.
     These are NOT the same field and must never be merged.
   - Every money-bearing column across all models MUST be `Integer` type and
     MUST be named with a `_cents` suffix (e.g. `budget_cents`,
     `estimated_cost_cents`, `amount_cents`). Do not use `Float` or `Numeric`
     for any currency value anywhere in the schema.
   - `lat` / `lng` columns MUST be `Numeric(9, 6)`. Do NOT enable or reference
     the PostGIS extension anywhere in migrations or models.
   - `ledger_entries` MUST NOT have an `updated_at` column and MUST NOT have
     any mutable balance/total column. It is an insert-only audit table.
     Include a `reversed_by_entry_id` nullable self-referential FK instead of
     an update path.
   - `itinerary_items.position_key` MUST be `Numeric`, not `Integer`, to
     support fractional reordering later.

5. One initial Alembic revision (`alembic revision --autogenerate`) that creates
   all of the above tables with correct types and constraints. Review the
   generated SQL and confirm no column silently became `FLOAT` or `DOUBLE
   PRECISION`.

6. A `README.md` with exactly these setup steps verified to work:
   `cp .env.example .env` → `docker compose up --build` → confirm
   `GET http://localhost:8000/health` returns `{"status": "ok"}`.

## Explicit constraints — do NOT do any of the following
- Do NOT scaffold generic placeholder CRUD endpoints ("/items", "/todos",
  example resources unrelated to this schema).
- Do NOT use `Base.metadata.create_all()` — Alembic migrations only.
- Do NOT add PostGIS.
- Do NOT use floats or implicit-float numerics for any money field.
- Do NOT add Redis, Celery, or any realtime/WebSocket code in this phase.
- Do NOT stub business logic with `pass` or `# TODO` — if a piece of scope is
  ambiguous, ask me rather than guessing with a placeholder.

## Definition of done (I will check these before moving to Phase 1A)
- [ ] `docker compose up --build` succeeds from a clean clone.
- [ ] `alembic upgrade head` applies cleanly to an empty database.
- [ ] `plans` table has both `version` and `planning_version` as separate
      integer columns.
- [ ] Every currency column is `INTEGER` and ends in `_cents`.
- [ ] No PostGIS extension is referenced anywhere.
- [ ] `/health` returns 200.
```

---

## Phase 1A — Product Shell + Private OAuth

### Objective
A real (allowlisted) user can authenticate end-to-end and perform the minimum planning loop, deployed — not just running locally.

### Scope
- Next.js frontend with NextAuth Google OAuth (testing/private mode, low-risk scopes only: `openid email profile`).
- Shared `JWT_SECRET` between Vercel (NextAuth signs) and Render (FastAPI validates).
- `POST /auth/sync-user`, `GET /auth/me`.
- `POST /plans`, invite + join flow, manual activity creation, basic voting.
- CORS locked to exact frontend origins.
- Deployed: Vercel (frontend), Render Free (backend), Neon Free (Postgres).

### Guardrails Active This Phase
- **G1** — This is the phase where the auth trap is most likely to appear. NextAuth signs the JWT **server-side in the login callback using the shared secret** — it does **not** call FastAPI over the network to mint the token, and FastAPI does **not** call Google per-request.
- **G10** — Even at this early stage, enforce owner-vs-member checks server-side for anything owner-only (e.g., deleting an activity), not just in the frontend.

### Explicit Non-Goals This Phase
- No WebSockets/realtime yet (that's 1A.5/1C). No recommendations, no LangGraph, no AI. No public OAuth verification (that's Phase 8).

### Vibe-Coding Prompt

```markdown
You are building Phase 1A of "Basecamp": the authenticated product shell.
Assume Phase 0's schema and repo structure already exist — extend it, do not
recreate it from scratch. Use the canonical monorepo paths: `apps/api` and `apps/web`.

## Non-negotiable auth architecture (read carefully — this is the most
## common place AI agents get this wrong)

Auth is two distinct identities:
1. Google OAuth via NextAuth — this establishes WHO the user is.
2. An app-issued JWT — this establishes what FastAPI trusts.

The flow MUST be:
1. User logs in with Google through NextAuth on the Next.js frontend.
2. Inside NextAuth's `jwt`/`session` callback (server-side, on Vercel), sign
   an app JWT using the `jose` library and the `JWT_SECRET` environment
   variable. Claims: `sub` (stable google subject or internal user id),
   `email`, `name`, `iat`, `exp`, `iss: "basecamp-web"`, `aud: "basecamp-api"`.
3. Expose this signed app JWT to the frontend session object.
4. Frontend sends it as `Authorization: Bearer <app_jwt>` to every FastAPI call.
5. FastAPI validates it OFFLINE using PyJWT and the SAME `JWT_SECRET` env var
   — checking signature, expiration, issuer, and audience.

DO NOT, under any circumstance:
- Have FastAPI call Google's tokeninfo or userinfo endpoint on any normal
  request.
- Have NextAuth make a network call to a FastAPI endpoint during the login
  callback in order to obtain or mint the JWT. The JWT is signed entirely
  client-side-of-Vercel using the shared secret — no backend round-trip
  during login.

## Deliverables

### Frontend (`apps/web`, Next.js + NextAuth)
- Google provider configured with scopes limited to `openid email profile`
  only. No Gmail/Calendar/Drive/Contacts scopes.
- `jwt`/`session` callback signs the app JWT server-side using `jose` and
  `process.env.JWT_SECRET`.
- An API client wrapper that attaches `Authorization: Bearer <token>` to every
  request to the FastAPI backend.
- Pages: landing (`/`), dashboard (list of plans + create button), plan detail
  page (basic — activity list, add-activity form, vote buttons).

### Backend (`apps/api`, extends Phase 0)
- `HTTPBearer` FastAPI dependency that validates the app JWT with PyJWT using
  `settings.JWT_SECRET`, checking `iss="basecamp-web"` and `aud="basecamp-api"`.
  Reject with 401 on any validation failure (bad signature, expired, wrong
  issuer/audience) with a clear error body — no silent pass-through.
- `POST /auth/sync-user`: validates JWT, upserts a `users` row keyed by the
  stable `sub` claim (create if missing, update `email`/`name` if changed).
- `GET /auth/me`: returns the current user's row.
- `POST /plans`: creates a plan, creates a `plan_members` row for the creator
  with `role="owner"`.
- `POST /plans/{plan_id}/invites`, `POST /invites/{token}/join`: invite link
  generation (store a hashed token, not the raw token) and join flow that
  creates a `plan_members` row with `role="member"`.
- `POST /plans/{plan_id}/activities`: manual activity creation (name, optional
  address/lat/lng, `estimated_cost_cents` as INTEGER, `estimated_duration_minutes`,
  tags, notes).
- `DELETE /plans/{plan_id}/activities/{activity_id}`: server-side check that
  the requester's `plan_members.role == "owner"` — return 403 for members,
  even if the frontend never renders a delete button for them. Never trust
  frontend-only permission gating.
- `PUT /plans/{plan_id}/activities/{activity_id}/vote`: upsert-style vote
  (unique on `(activity_id, user_id)`).

### CORS
- Configure FastAPI CORS with an explicit allow-list: the Vercel production
  domain, any custom domain, and `http://localhost:3000`. Do NOT use `"*"`
  for any route that reads `Authorization` headers.

## Explicit constraints — do NOT do any of the following
- Do NOT implement any WebSocket code in this phase — that is Phase 1A.5/1C.
- Do NOT implement Google OAuth "publishing"/verification flows — this phase
  is intentionally testing-mode-only with a manual allowlist.
- Do NOT let any endpoint skip the JWT dependency "for now" — every mutating
  endpoint requires a valid app JWT.
- Do NOT hardcode `JWT_SECRET` anywhere — it must come from environment
  variables and be identical on Vercel and Render.
- Do NOT use floats for `estimated_cost_cents` or any other money field.

## Definition of done
- [ ] A real Google account (added as an OAuth test user) can log in on the
      deployed Vercel URL and receive a session containing a signed app JWT.
- [ ] FastAPI rejects requests with a missing, expired, or wrong-issuer JWT
      with 401 — verified by a manual curl test with a tampered token.
- [ ] A member (non-owner) gets a 403 when attempting to DELETE an activity,
      confirmed via direct API call bypassing the frontend.
- [ ] CORS rejects a request from an origin not in the allow-list.
```

---

## Phase 1A.5 — Resync + WebSocket Backoff Core

### Objective
Make reconnect/resync correctness a first-class citizen **before** any further realtime feature work is layered on top. This phase is mandatory, not optional polish — free-tier Render sleep makes this core correctness, not a nice-to-have.

### Scope
- `plan_events` table.
- `GET /plans/{plan_id}/resync` returning full authoritative state.
- Frontend WebSocket client with exponential backoff + jitter, generous cold-start handshake timeout, and explicit UI connection states.
- Basic WebSocket endpoint that authenticates via app JWT and does nothing more than confirm connection + membership for now (full broadcasting logic comes in Phase 1C).

### Guardrails Active This Phase
- **G1** — WebSocket auth uses the *same* app JWT, validated the same way (offline, same secret).
- **G5** — Even at this early stage, treat the WebSocket connection as a notification channel only. `/resync` is the source of truth the client falls back to — build this muscle memory now.

### Explicit Non-Goals This Phase
- No in-memory room broadcaster/multi-user broadcast logic yet (Phase 1C). No LangGraph. This phase is about the client/server surviving disconnects, not about collaboration features.

### Vibe-Coding Prompt

```markdown
You are building Phase 1A.5 of "Basecamp": WebSocket resync and reconnect
correctness. This is treated as CORE correctness, not polish, because the
backend runs on Render's free tier and WILL sleep after inactivity. Do not
under-scope this phase because "it's just reconnect logic."

## Backend deliverables

1. Add a `plan_events` table (via Alembic migration): `id`, `plan_id`,
   `actor_id`, `event_type`, `payload_json` (JSONB), `resource_type`,
   `resource_id`, `resource_version_after`, `client_operation_id` (nullable),
   `created_at`.

2. `GET /plans/{plan_id}/resync` — requires valid app JWT + plan membership.
   Returns a single JSON payload containing: `plan`, `members`, `activities`,
   `activity_scores`, `itinerary_items`, `votes`, `expenses`,
   `expense_splits`, `ledger_entries`, `latest_plan_events` (most recent N),
   and `server_version` (the plan's current `version`). This endpoint must
   be a complete state snapshot the client can use to fully replace its local
   state — not a partial/delta response.

3. A WebSocket endpoint `wss://.../ws/plans/{plan_id}?token=<app_jwt>` that:
   - Validates the app JWT the same way as the HTTP `HTTPBearer` dependency
     (same secret, same issuer/audience checks).
   - Confirms the user is a member of `plan_id`; if not, closes the socket
     with a clear auth-failure close code — does NOT silently accept the
     connection.
   - On successful connect, sends a single `{"type": "connected"}` message.
     Do not build the multi-user broadcast room manager yet — that's Phase 1C.
     This phase only needs single-connection auth + lifecycle to work
     correctly.

## Frontend deliverables

1. A WebSocket client hook/module implementing exponential backoff with
   jitter on disconnect:
   `wait_time = min(base * 2^attempt, 30_000) + random(0, 1000)` in ms,
   starting at 2000ms base.

2. A generous handshake timeout for the INITIAL connection attempt (45–60
   seconds) to tolerate Render cold starts — do not use an aggressive
   timeout here. Subsequent heartbeat/liveness checks on an already-connected
   socket can use a shorter timeout.

3. Explicit UI connection states, each visually distinct: `Connecting…`,
   `Waking server…` (shown specifically during the first cold-start attempt),
   `Reconnecting…`, `Syncing latest plan state…`, `Connection restored`,
   `Connection unavailable — retry` (with a manual retry button after
   repeated failures — never spin forever with no user control).

4. On every successful (re)connection, the client MUST call
   `GET /plans/{plan_id}/resync` and fully replace local state with the
   response before exiting the "Syncing" UI state. Do not attempt to merge
   or diff local optimistic state against the server response — full
   replacement only.

## Explicit constraints — do NOT do any of the following
- Do NOT implement tight/fixed-interval reconnect loops — backoff with
  jitter is required, or you will hammer a waking Render container.
- Do NOT treat the WebSocket "connected" event as proof that state is in
  sync — the resync call is mandatory on every reconnect regardless of how
  fast the socket reconnected.
- Do NOT build the in-memory multi-socket room manager in this phase — keep
  this phase scoped to single-connection auth/lifecycle + resync.
- Do NOT skip the manual-retry UI — infinite silent retries are a support
  nightmare and a bad user experience.

## Required manual/automated tests before moving on
- [ ] Kill the WebSocket mid-session (e.g., via devtools) → verify backoff
      timing matches the spec (2s, 4s, 8s, 15s, 30s cap) with jitter.
- [ ] Simulate a slow Render cold start (delay the WS handshake response
      manually) → verify the client does not abandon the connection attempt
      before ~45–60 seconds and shows "Waking server…".
- [ ] Restart the backend process entirely → verify the frontend reconnects
      and `/resync` restores identical state to what existed before restart.
- [ ] Expire the app JWT and attempt a WebSocket reconnect → verify the
      socket is rejected and the client surfaces a re-login flow rather than
      looping silently.
```

---

## Phase 1B — Planning Correctness

### Objective
Make the backend enforce the product's non-negotiable data-integrity rules: versioned optimistic concurrency, integer-cent expense splitting, an immutable zero-sum ledger, finalize/un-finalize lifecycle, and idempotent mutations.

### Scope
- `itinerary_items` with fractional `position_key` reordering.
- Vote upserts (already started in 1A, harden here).
- Expense creation with deterministic integer-cent splitting.
- `ledger_entries` write path (append-only, transactional with expense creation).
- Finalize/un-finalize endpoints with hard rejection of mutations post-finalization.
- `idempotency_records` table + atomic claim-insert pattern.
- Optimistic concurrency (`version` column check) on all relevant mutating endpoints.

### Guardrails Active This Phase
- **G2** — `planning_version` must increment on: activity add/edit/delete, itinerary item add/edit/delete/reorder, budget/date/max-drive-time change, finalize/un-finalize. It must NOT increment on votes (votes may optionally bump a separate scoring version, never `planning_version`).
- **G3** — Split math is integer-only: `base_share = amount_cents // member_count`, remainder distributed by sorted `user_id`. Any float anywhere in this path is a bug.
- **G6** — Idempotency uses an atomic `INSERT ... ON CONFLICT DO NOTHING RETURNING id`, never a check-then-insert.
- **G9** — Ledger entries are inserted in the *same transaction* as the expense + splits; edits/deletes are reversal entries, never row mutation; zero-sum is validated before commit, not assumed.
- **G10** — Finalize/un-finalize and member-removal are owner-only, enforced server-side.

### Explicit Non-Goals This Phase
- No realtime broadcasting yet (Phase 1C wires broadcasting on top of these write paths). No recommendations/LangGraph/AI.

### Vibe-Coding Prompt

```markdown
You are building Phase 1B of "Basecamp": backend correctness for itinerary
concurrency, expense splitting, the ledger, plan lifecycle, and idempotency.
This phase is pure backend logic and data integrity — assume Phases 0/1A/1A.5
already exist. Use `apps/api` for all backend work.

## 1. Optimistic concurrency (apply to itinerary_items, activities, plans,
##    expenses — every mutable resource)

Every UPDATE to a versioned resource MUST use this exact pattern (adapt table/
columns per resource), executed as a single atomic statement:

```sql
UPDATE itinerary_items
SET position_key = :new_position_key,
    version = version + 1,
    updated_at = NOW()
WHERE id = :id
  AND version = :expected_version
RETURNING *;
```

If the UPDATE affects zero rows, return HTTP 409 with a body indicating a
version conflict — do NOT silently overwrite, do NOT retry automatically
server-side, do NOT ignore the version check "to keep things simple."

## 2. Fractional itinerary ordering

`itinerary_items.position_key` is `NUMERIC`. New items get sequential
positions (1000, 2000, 3000...). Moving an item between two others computes
`new_position_key = (previous.position_key + next.position_key) / 2`. Do NOT
implement reordering as a full-list renumber/update-every-row operation.

## 3. Plan versioning — the two-counter rule

Implement a small internal helper (e.g. `bump_planning_version(plan)`) that
is called ONLY from these mutation paths, and bumps `plans.planning_version`
(NOT `plans.version`) by 1:
- activity created / edited / deleted
- itinerary item created / edited / deleted / reordered
- plan budget, dates, or max_drive_minutes changed
- plan finalized / un-finalized

`plans.version` bumps on ANY direct edit to the `plans` row itself (title,
etc.) — it is a separate, broader concurrency counter.

Votes MUST NOT bump `planning_version`. If you add a scoring-version concept,
it must be a distinct field, never conflated with `planning_version`.

## 4. Expense splitting — integer-cent, deterministic remainder

Implement equal-split logic exactly as follows (no floating point anywhere):

```python
base_share = amount_cents // member_count
remainder = amount_cents % member_count
# Distribute the remainder by ascending sorted user_id — the first
# `remainder` users (sorted) get base_share + 1, the rest get base_share.
```

After computing splits, assert `sum(split.amount_cents for split in splits)
== expense.amount_cents` before committing. If this assertion fails, raise
and roll back the transaction — never commit a mismatched split set.

## 5. Ledger entries — immutable, transactional, zero-sum

When an expense is created:
- Insert the `expenses` row, the `expense_splits` rows, and the derived
  `ledger_entries` rows ALL within a single database transaction.
- `ledger_entries` for that expense MUST sum to exactly 0 (payer entries
  positive, split-owed entries negative, or your chosen sign convention —
  consistency matters, not the specific sign choice).
- To "edit" or "delete" an expense, insert REVERSAL ledger entries that net
  the original entries to zero, then insert new entries for the corrected
  state if applicable. Do NOT UPDATE or DELETE existing `ledger_entries` rows.
- Implement balance retrieval as a read-time aggregation:
  `SELECT user_id, SUM(amount_cents) FROM ledger_entries WHERE plan_id = :id
  GROUP BY user_id`. Do NOT add a stored/mutable balance column anywhere.
- Finalized plans (`plans.status == "finalized"`) MUST reject new expense
  mutations with 409/403 — check this server-side on every expense-mutating
  endpoint.

## 6. Idempotency

Add `idempotency_records` table (per the schema: `plan_id`, `actor_id`,
`client_operation_id`, `request_hash`, `resource_type`, `resource_id`,
`response_json`, `status` [`in_progress`/`completed`/`failed`],
`failure_type` [`permanent`/`transient`], `expires_at`, timestamps).

For every create-type mutation endpoint that accepts a client-generated
`client_operation_id`:
1. Compute `request_hash = sha256(canonical_json(payload))` where canonical
   JSON means: sorted keys, no whitespace, integers for money (never floats),
   normalized decimal strings for `position_key`.
2. Attempt the atomic claim:
   `INSERT INTO idempotency_records (...) VALUES (...)
   ON CONFLICT (plan_id, actor_id, client_operation_id) DO NOTHING
   RETURNING id;`
   Do NOT implement this as a `SELECT` existence check followed by a
   separate `INSERT` — that has a race condition under concurrent retries.
3. If the claim succeeds (a row was returned), proceed with the actual
   mutation, then update the record to `completed` with the response stored.
4. If the claim fails (no row returned) — fetch the existing record:
   - Same hash + `completed` → return the stored response as-is.
   - Different hash → return 409 conflict.
   - `in_progress` and expired → mark transient failure, allow retry.
   - `failed`/`permanent` → return the stored error.

## 7. Plan lifecycle enforcement

- `POST /plans/{plan_id}/finalize` and `.../unfinalize`: owner-only
  (403 for members, checked server-side against `plan_members.role`).
- Once `status == "finalized"`, reject (403/409) all of: itinerary edits,
  activity edits/deletes, votes, expense mutations, budget/date/member
  changes. Un-finalizing (owner-only) re-enables these.

## Explicit constraints — do NOT do any of the following
- Do NOT use Python float division anywhere in the expense-splitting path.
- Do NOT implement optimistic concurrency as "fetch, compare in Python, then
  update" — it must be a single atomic conditional UPDATE statement.
- Do NOT add a mutable `balance_cents` column to any table.
- Do NOT let votes bump `plans.planning_version`.
- Do NOT implement idempotency via check-then-insert.
- Do NOT skip the finalized-plan mutation rejection on ANY mutating endpoint
  — audit every POST/PATCH/DELETE under a plan for this check.

## Required tests before moving on
- [ ] Unit test: $10.00 split 3 ways yields exactly [334, 333, 333] cents
      (or equivalent per your sort rule), summing to exactly 1000.
- [ ] Unit test: concurrent idempotent POSTs with the same
      `client_operation_id` and payload result in exactly one mutation and
      both callers receive the same response.
- [ ] Unit test: two concurrent itinerary reorders on the same item — the
      second one (stale `version`) receives a 409, not a silent overwrite.
- [ ] Unit test: creating a vote does NOT change `plans.planning_version`;
      creating/editing/deleting an activity DOES.
- [ ] Integration test: attempting any mutation on a finalized plan returns
      403/409 for both owner-restricted and member-allowed actions as
      applicable.
- [ ] Integration test: SUM of ledger_entries for a plan is exactly 0 after
      a sequence of expense creates, edits, and deletes.
```

---

## Phase 1C — MVP Realtime Collaboration

### Objective
Wire real-time broadcasting of the Phase 1B write paths using a single-instance, in-memory room manager — deliberately avoiding Redis Pub/Sub until horizontal scaling is actually needed.

### Scope
- `ConnectionManager` class with `active_rooms: dict[plan_id, set[WebSocket]]`.
- Safe copied-set broadcast pattern with dead-socket eviction.
- Optional `asyncio.Lock` around join/leave if churn proves racey.
- Broadcast triggered only *after* a successful Postgres commit from the Phase 1B write paths.
- Debounced broadcasts for high-frequency events (e.g., itinerary reorder drag).

### Guardrails Active This Phase
- **G4** — Broadcast over a **copied list**, never the live set: `active_sockets = list(active_rooms.get(plan_id, []))`, then iterate that copy.
- **G5** — Broadcast happens strictly after DB commit + `plan_events` write. Never broadcast speculative/unconfirmed state.
- This phase deliberately does **not** introduce Redis Pub/Sub — flag any agent suggestion to add it as scope creep.

### Explicit Non-Goals This Phase
- No Redis Pub/Sub, no presence/typing indicators, no live cursors, no horizontal scaling.

### Vibe-Coding Prompt

```markdown
You are building Phase 1C of "Basecamp": MVP realtime collaboration using an
IN-MEMORY, single-instance room broadcaster. Do NOT introduce Redis Pub/Sub,
Celery, or any cross-process broadcasting mechanism in this phase — the
backend runs as a single Render Free instance and Redis Pub/Sub is explicitly
out of scope until a future horizontal-scaling phase.

## Backend: ConnectionManager

Implement a `ConnectionManager` class (module-level singleton) with:

```python
active_rooms: dict[UUID, set[WebSocketConnection]]
```

Where each `WebSocketConnection` wraps the raw WebSocket plus `user_id`,
`plan_id`, `connected_at`, `last_seen_at`.

### Join flow
1. WebSocket connects with app JWT (reuse the Phase 1A.5 auth logic exactly
   — do not reimplement JWT validation differently here).
2. Validate plan membership.
3. Add the connection to `active_rooms[plan_id]`.
4. Send `{"type": "connected"}`.
5. Client is expected to call `/resync` itself (per Phase 1A.5) — do not push
   full state over the socket on connect.

### Leave/disconnect flow
1. Remove the connection from `active_rooms[plan_id]`.
2. If the set for that `plan_id` is now empty, delete the dict key entirely
   (don't leak empty entries).

### Broadcast flow — THE CRITICAL PART
Every mutation from Phase 1B (activity create/edit/delete, vote, itinerary
item create/edit/delete/reorder, expense create/edit/delete, finalize/
unfinalize) follows this exact order:
1. Validate the request.
2. Commit the mutation to Postgres (using the optimistic-concurrency pattern
   from Phase 1B).
3. Insert the corresponding `plan_events` row in the same transaction.
4. ONLY THEN broadcast to the room:

```python
async def broadcast(self, plan_id: UUID, payload: dict):
    active_sockets = list(self.active_rooms.get(plan_id, []))  # COPY, not live set
    for conn in active_sockets:
        try:
            await conn.websocket.send_json(payload)
        except Exception:
            await self.disconnect(plan_id, conn)  # evict dead socket
```

Do NOT iterate `self.active_rooms[plan_id]` directly during broadcast — you
MUST iterate a copied list/snapshot, or concurrent join/leave during a
broadcast will raise a "set changed size during iteration" runtime error
under real (not single-user-demo) load.

If you determine join/leave is racey enough to need a lock, wrap ONLY the
join/leave mutation (not the broadcast iteration) in `asyncio.Lock()`.

### Debouncing
For high-frequency events like itinerary drag-reorder, debounce broadcasts
server-side (e.g., coalesce rapid `position_key` updates for the same item
within a short window, e.g. 150–300ms) so you're not flooding sockets with
every intermediate drag frame — broadcast the committed final state, not
every keystroke-equivalent.

## Explicit constraints — do NOT do any of the following
- Do NOT add Redis Pub/Sub, a message queue, or any cross-process broadcast
  mechanism in this phase.
- Do NOT broadcast before the Postgres commit succeeds.
- Do NOT iterate the live `active_rooms[plan_id]` set directly during
  broadcast — always copy first.
- Do NOT implement presence indicators, typing indicators, or live cursors —
  explicitly out of scope.
- Do NOT skip dead-socket eviction on send failure — a stale socket left in
  the room will keep failing every subsequent broadcast.

## Required tests before moving on
- [ ] Two authenticated browser sessions join the same plan; an edit from
      one appears in the other within the debounce window.
- [ ] Forcefully kill one client mid-broadcast (e.g., close devtools network)
      — verify the server does not raise an unhandled exception and evicts
      the dead socket.
- [ ] Concurrency test: rapidly connect/disconnect multiple sockets to the
      same `plan_id` WHILE a broadcast is in-flight — verify no
      "set changed size during iteration" error occurs (this is the
      specific bug the copied-list pattern prevents).
- [ ] Restart the backend process; verify both clients' sockets drop, both
      reconnect per Phase 1A.5 backoff, and both `/resync` to identical state.
```

---

## Phase 2 — External APIs and Caching

### Objective
Integrate Nominatim, Overpass, OSRM, and Open-Meteo with caching and rate limiting implemented **before** any of them is user-facing — not retrofitted after a demo breaks.

### Scope
- `place_cache`, `route_cache`, `weather_snapshots` tables with `expires_at`.
- Nominatim: real `User-Agent`, global 1 req/sec limiter, debounced/explicit search, caching.
- Overpass: cache by bbox + place type, fallback to cached/manual on failure.
- OSRM: cache, timeout/retry, straight-line-distance fallback on failure (never crash itinerary generation).
- Open-Meteo: cache by rounded lat/lng + hour, stale-cache-or-neutral-score (0.5) fallback.
- Explicit "unavailable" UI states surfaced from the API layer, not swallowed.

### Guardrails Active This Phase
- **G8** — Every external call has: cache-first lookup → live call with timeout → explicit fallback → explicit UI state. No external API failure may propagate as an unhandled 500.
- **G11** — Cache tables need real `expires_at` values sized per data type (weather 24h, route 7d, place search 7d) and are actually cleaned up (ties into Phase 6's cleanup jobs, but the columns and query patterns start here).

### Explicit Non-Goals This Phase
- No PostGIS, no Mapbox, no paid routing/geocoding providers.

### Vibe-Coding Prompt

```markdown
You are building Phase 2 of "Basecamp": cache-first, fallback-safe
integrations with Nominatim (geocoding), Overpass (places), OSRM (routing),
and Open-Meteo (weather). The core rule for this entire phase: NO external
API call is allowed to crash or fail a user-facing flow. Every call has a
cache check, a timeout, and an explicit fallback.

## Shared pattern (implement once, reuse per provider)

For each external integration, implement a service function shaped like:

```python
async def get_route_estimate(origin, destination) -> RouteEstimate:
    cached = await lookup_route_cache(origin, destination)
    if cached and not cached.is_expired:
        return cached.to_estimate()
    try:
        result = await call_osrm_with_timeout(origin, destination, timeout=5.0)
        await store_route_cache(origin, destination, result, ttl=timedelta(days=7))
        return result
    except (TimeoutError, HTTPError):
        return RouteEstimate(
            status="unavailable",
            distance_estimate=haversine_fallback(origin, destination),
        )
```

Every provider integration follows this shape: cache check → live call with
explicit timeout → typed fallback result with a `status` field the frontend
can render an "unavailable" message from. NEVER let a raw `httpx`/`requests`
exception bubble up past the service layer uncaught.

## Nominatim (geocoding)
- Set a real, identifying `User-Agent` header, e.g.
  `"Basecamp/1.0 (student portfolio project; contact: <email>)"` — never use
  the default `python-requests` UA.
- Enforce a GLOBAL rate limit of 1 request/second across all users (a simple
  in-process token-bucket or timestamp-gate is sufficient for MVP — this does
  not require Redis).
- Frontend: do NOT search on every keystroke. Debounce input (e.g. 400ms) and
  prefer an explicit "Search" action for the actual API call.
- Cache geocode results in `place_cache` keyed by a hash of the normalized
  query string.
- If Nominatim fails or is rate-limited, the user must still be able to save
  an activity with a manually-entered address/lat-lng — geocoding is a
  convenience, never a hard dependency for activity creation.

## Overpass (places)
- Cache results in `place_cache` keyed by a hash of `(bounding_box,
  place_type, query_params)`.
- On failure: return cached results if available (even if slightly stale),
  otherwise return an empty result set with `status: "unavailable"` so the
  frontend can render "place search unavailable right now — add manually."

## OSRM (routing)
- Cache in `route_cache` keyed by `(origin_hash, destination_hash)`, TTL 7
  days, with an `estimate_status` field (`"ok" | "unavailable"`).
- On timeout/failure, compute a straight-line fallback:
  `distance_miles * average_minutes_per_mile` (pick a reasonable constant,
  e.g. 2.5 min/mile as a placeholder default) and mark
  `estimate_status = "unavailable"`. Itinerary generation MUST continue using
  this fallback rather than raising.

## Open-Meteo (weather)
- Cache in `weather_snapshots` keyed by `(rounded_lat, rounded_lng,
  forecast_hour)`, TTL 24 hours.
- On failure: use the most recent cached snapshot for that location/hour if
  one exists (even if expired), and if none exists, fall back to a NEUTRAL
  `weather_score = 0.5` — never let a weather failure zero-out or crash the
  recommendation scoring path (recommendation scoring itself is Phase 3, but
  the weather SERVICE and its fallback contract must be built now).

## Frontend
- Add explicit unavailable-state UI copy wired to each provider's `status`
  field: "Place search unavailable — you can still add a place manually.",
  "Route estimate unavailable — itinerary can still be saved.", "Weather
  unavailable — recommendations are using a neutral weather score.", "Using
  cached route estimate.", "Using cached weather."

## Explicit constraints — do NOT do any of the following
- Do NOT let any provider integration raise an uncaught exception into a
  route handler — every provider call is wrapped with try/except and a typed
  fallback result.
- Do NOT implement per-keystroke live search against Nominatim.
- Do NOT skip the `User-Agent` header on Nominatim requests.
- Do NOT make geocoding, routing, or weather a hard requirement for saving
  an activity or itinerary item — manual entry must always work.
- Do NOT add Mapbox, Google Maps Platform, or PostGIS in this phase.

## Required tests before moving on
- [ ] Simulate an OSRM timeout (mock the client to raise) — verify itinerary
      generation still completes using the straight-line fallback and the
      frontend shows the "unavailable" message.
- [ ] Simulate an Open-Meteo failure with no prior cache — verify
      `weather_score` defaults to 0.5 and no exception propagates.
- [ ] Verify a repeated identical Nominatim query within the cache TTL does
      NOT trigger a second live API call (assert via a call-count mock).
- [ ] Verify the global Nominatim rate limiter actually delays/queues a
      second immediate request rather than firing both concurrently.
```

---

## Phase 3 — Deterministic Recommendations

### Objective
Spotify-style, fully explainable group recommendations with zero LLM involvement.

### Scope
- `activity_scores` table populated by a scoring job, kept separate from `activities`.
- Weighted scoring formula: `vote(0.35) + distance(0.20) + weather(0.15) + budget(0.15) + preference(0.10) + schedule_fit(0.05)`.
- Human-readable "why this ranked highly" explanation strings.
- Score recomputation job (can be a simple background task for MVP).

### Guardrails Active This Phase
- Reiterating from Phase 1B: derived scores live in `activity_scores`, and writing to that table must **never** bump `activities.version` — background recomputation is fully decoupled from user-edit concurrency.
- **G8** — Component scores (distance, weather) must gracefully consume the fallback values from Phase 2 (neutral weather = 0.5, straight-line distance) without special-casing "the API was down" logic scattered elsewhere.

### Explicit Non-Goals This Phase
- No LLM, no LangGraph — this entire phase is deterministic math.

### Vibe-Coding Prompt

```markdown
You are building Phase 3 of "Basecamp": fully deterministic, explainable
activity recommendations. NO LLM or external AI call is involved anywhere in
this phase — this is pure scoring logic.

## Scoring formula (implement exactly)

```python
final_score = (
    vote_score * 0.35
    + distance_score * 0.20
    + weather_score * 0.15
    + budget_score * 0.15
    + preference_score * 0.10
    + schedule_fit_score * 0.05
)
```

Each component score is normalized to a 0.0–1.0 range. Implement each as a
pure, independently unit-testable function:
- `vote_score(activity, votes)`: e.g. upvote ratio among plan members.
- `distance_score(activity, route_estimate)`: closer = higher score; must
  consume the Phase 2 straight-line fallback transparently when
  `estimate_status == "unavailable"` — no special-case branching needed if
  the fallback estimate is already a valid distance figure.
- `weather_score(weather_snapshot)`: directly uses the Phase 2 weather
  service's score/fallback (including the neutral 0.5 default) — do not
  re-implement weather fallback logic here, just consume it.
- `budget_score(activity, plan.budget_cents)`: cheaper relative to remaining
  budget = higher score. Use integer-cents math, never floats for the
  underlying cost comparison (the resulting *score* is a float 0–1, but the
  cost values feeding it are integer cents).
- `preference_score(activity.tags, group_preferences)`: tag-overlap based.
- `schedule_fit_score(activity, plan constraints)`: e.g. fits within
  available time windows.

## Storage — MUST be decoupled from `activities`

Write results to the existing `activity_scores` table (one row per
activity, recomputed in place — upsert by `activity_id`). Writing to
`activity_scores` MUST NOT touch `activities.version` or
`plans.planning_version` in any way — recomputation is a background concern
fully decoupled from the optimistic-concurrency and stale-draft-detection
paths built in Phases 1B/4.

## Explanation strings

For each scored activity, generate a short human-readable explanation built
from the actual component scores/inputs, e.g.:
`"5/6 members upvoted · low estimated cost · 18-minute drive · good weather
window"` — derive the numbers in the string from the real vote counts,
real route estimate, and real weather data, not placeholder text.

## Recomputation job

Implement a recomputation function callable both:
1. On-demand via `GET /plans/{plan_id}/activities/recommended` (compute if
   stale/missing, else return cached `activity_scores` rows).
2. On a scheduled interval (hook into the Phase 6 job scheduler — for this
   phase, a simple callable is enough; wiring the actual scheduler cron can
   wait for Phase 6).

## Explicit constraints — do NOT do any of the following
- Do NOT call any LLM/AI provider anywhere in this phase.
- Do NOT let `activity_scores` writes touch `activities.version` or
  `plans.planning_version`.
- Do NOT hardcode or fake the explanation strings — they must be generated
  from the actual scoring inputs.
- Do NOT use floating-point cost comparisons that could introduce rounding
  drift into money-adjacent logic — keep cost values as integer cents right
  up until the final 0–1 score normalization.

## Required tests before moving on
- [ ] Unit test each component score function independently with known
      inputs/expected outputs.
- [ ] Unit test the weighted formula sums component weights to 1.0 and
      produces a final score in [0, 1] for boundary inputs (all zeros, all
      ones).
- [ ] Integration test: recomputing scores for a plan does NOT change
      `activities.version` or `plans.planning_version` for any activity in
      that plan.
- [ ] Integration test: an activity with no weather data (Phase 2 fallback
      triggered) still receives a valid `weather_score` of 0.5, not null/error.
```

---

## Phase 4 — LangGraph Deterministic Planning + Stale-Draft Protection

### Objective
A LangGraph pipeline that produces a validated, structured itinerary draft — and can **never** silently overwrite a plan that changed while the draft was being generated.

### Scope
- `langgraph_runs` table.
- Graph nodes: parse goal → normalize constraints → fetch candidates → fetch weather → estimate routes → score → select → order → produce structured JSON → Pydantic validation.
- `base_planning_version` snapshot at run start, compared against current `plan.planning_version` at completion.
- Preview/approve/regenerate API flow — no auto-apply.

### Guardrails Active This Phase
- **G7** — This is the phase where G7 is the entire point. The stale-draft check is not optional polish; it's the core deliverable.
- **G2** — Reuses `planning_version` from Phase 1B exactly as designed — this is why that field could not be conflated with `version` back in Phase 0/1B.
- Reiterating: human edits are **never blocked** during generation. No "status = generating, disable all edits" pattern.

### Explicit Non-Goals This Phase
- No LLM call anywhere in this phase — LangGraph runs entirely deterministically. AI polish is Phase 5, layered strictly on top of this phase's *validated output*.

### Vibe-Coding Prompt

```markdown
You are building Phase 4 of "Basecamp": a LangGraph-based DETERMINISTIC
itinerary planning workflow (no LLM calls anywhere in this graph) with
stale-draft protection. This is the single most important correctness
feature in the whole product — read this prompt fully before writing code.

## The core problem this phase solves

LangGraph planning can take several seconds. During that time, a real human
in the same plan might add/delete an activity, vote, reorder the itinerary,
change the budget, or finalize the plan. If the graph blindly applies its
(now-outdated) result when it finishes, it silently destroys the human's
concurrent edits. This MUST NOT be possible.

## Required solution: planning-version snapshot + compare

1. Add `langgraph_runs` table (per schema): `id`, `plan_id`,
   `triggered_by_user_id`, `run_type`, `status`, `base_plan_version`,
   `base_planning_version`, `input_json`, `output_json`,
   `validation_errors_json`, `draft_status`, `created_at`, `completed_at`,
   `expires_at`.

2. When a planning run STARTS: read the plan's CURRENT
   `planning_version` and store it as `langgraph_runs.base_planning_version`.
   This is a snapshot — do not recompute or reference it dynamically later.

3. Build the LangGraph pipeline as a sequence of nodes operating on a
   `PlanPlanningState` object with fields: `plan_id`, `user_id`,
   `base_planning_version`, `plan_goal`, `constraints`, `candidate_places`,
   `weather_by_place`, `route_estimates`, `scored_activities`,
   `selected_activities`, `itinerary_json`, `validation_errors`,
   `draft_status`.

   Nodes, in order:
   - `parse_plan_goal`: extract structured goal/constraints from plan
     metadata (budget, dates, max_drive_minutes) — no free-text LLM parsing,
     this reads structured fields already on the `plans` row.
   - `normalize_constraints`
   - `fetch_candidate_places`: reuse the Phase 2 place-search service (with
     its caching/fallback already built — do not reimplement).
   - `fetch_weather`: reuse the Phase 2 weather service.
   - `estimate_routes`: reuse the Phase 2 routing service.
   - `score_activities`: reuse the EXACT scoring formula and component
     functions from Phase 3 — do not reimplement or approximate scoring
     logic inside the graph.
   - `select_candidates`
   - `order_itinerary`
   - `produce_structured_json`: emit the itinerary draft as a Pydantic
     model, not a raw dict.
   - `validate_with_pydantic`: run full schema validation; on failure,
     populate `validation_errors` and set `draft_status = "invalid"` rather
     than raising an unhandled exception.

4. When the run COMPLETES, compare:
   `current plan.planning_version == langgraph_runs.base_planning_version`
   - If EQUAL → draft is fresh. Set `draft_status = "fresh"`. The owner may
     apply it.
   - If NOT EQUAL → draft is STALE. Set `draft_status = "stale"`. The
     one-click "Apply" action MUST be disabled/rejected server-side (not
     just hidden in the UI) — the user must explicitly choose to
     "Regenerate" or "Review anyway" (manual, non-auto-applying review).

5. Applying an approved draft still goes through the Phase 1B optimistic
   concurrency write path (versioned UPDATEs) — a LangGraph draft apply is
   NOT a special bypass of normal concurrency control.

## API endpoints

- `POST /plans/{plan_id}/planning/run`: kicks off a run (owner or member per
  the permission matrix — generation is allowed for both, per the PRD).
- `GET /plans/{plan_id}/planning/runs/{run_id}`: poll status/result.
- `POST /plans/{plan_id}/planning/{run_id}/approve`: owner-only (per
  permission matrix) — MUST server-side re-check `draft_status == "fresh"`
  before applying. Reject with a clear error if the run is stale, even if
  the client somehow attempts to force it.
- `POST /plans/{plan_id}/planning/{run_id}/regenerate`: kicks off a fresh
  run with a new `base_planning_version` snapshot.

## Explicit constraints — do NOT do any of the following
- Do NOT call any LLM/external AI API anywhere in this graph — this is a
  deterministic pipeline only.
- Do NOT implement a hard room-lock ("status = generating, disable all
  edits") — human edits must remain possible during generation; staleness
  is detected after the fact via version comparison, not prevented via
  locking.
- Do NOT let the apply endpoint trust a `draft_status` value sent by the
  client — always re-check server-side against the live
  `langgraph_runs.draft_status` (and ideally re-verify the version
  comparison at apply time too, as a defense-in-depth check).
- Do NOT reimplement scoring, weather, or routing logic inside the graph —
  call the existing Phase 2/3 services.
- Do NOT auto-apply a draft under any circumstance, fresh or stale — user
  approval is always an explicit, separate step.

## Required tests before moving on
- [ ] Start a planning run, then (before it completes) add an activity to
      the same plan from a separate request — verify the completed run's
      `draft_status` is `"stale"` and the apply endpoint rejects it.
- [ ] Start a planning run and make NO concurrent changes — verify
      `draft_status` is `"fresh"` and apply succeeds.
- [ ] Attempt to call the approve endpoint on a stale run directly (bypassing
      any frontend disabling) — verify the backend rejects it regardless of
      what the client sends.
- [ ] Verify voting during a run does NOT cause the run to be marked stale
      (since votes don't bump `planning_version`).
- [ ] Verify the produced itinerary JSON fails Pydantic validation cleanly
      (populates `validation_errors`, sets `draft_status = "invalid"`) when
      fed a deliberately malformed intermediate state, rather than crashing
      the run.
```

---

## Phase 5 — Optional AI Polish

### Objective
Layer a strictly optional, quota-aware, cached, fallback-safe LLM polish step on top of the already-correct Phase 4 output. The system must be fully functional with this feature entirely disabled.

### Scope
- `LLMProvider` abstraction: `NoopProvider` (default), `GroqProvider`, `GeminiProvider`, `OllamaProviderLocal` (local dev only).
- `ai_polished_summaries`, `ai_usage_limits` tables.
- Quotas: 15/day global, 1/day/plan, 1/week/user, owner-only generation.
- Input-hash caching.
- Deterministic fallback on quota exhaustion or provider failure.

### Guardrails Active This Phase
- **G12** — `NoopProvider` is the default; the LLM only transforms already-validated structured JSON into prose — it never chooses activities, edits state, or bypasses Pydantic validation from Phase 4.
- Provider failures and quota exhaustion must degrade to a deterministic summary, never a fatal error surfaced to the user.

### Explicit Non-Goals This Phase
- The LLM does not participate in activity selection, scoring, or itinerary ordering — that's fully owned by Phases 3/4.

### Vibe-Coding Prompt

```markdown
You are building Phase 5 of "Basecamp": an OPTIONAL AI polish layer on top of
an already-fully-functional deterministic system. The product must work
perfectly with this feature entirely absent or failing — treat that as the
primary design constraint, not an edge case.

## Provider abstraction

```python
class LLMProvider(Protocol):
    async def polish_itinerary(self, structured_itinerary_json: dict) -> str:
        ...
```

Implement:
- `NoopProvider`: returns a deterministic, template-based summary string
  built directly from `structured_itinerary_json` fields (no external call).
  THIS IS THE DEFAULT PROVIDER (`LLM_PROVIDER=noop` env var default).
- `GroqProvider` / `GeminiProvider`: real provider calls, only reachable when
  `LLM_PROVIDER` env var is explicitly set to `"groq"`/`"gemini"`.
- `OllamaProviderLocal`: for local development only — must not be
  reachable/deployed in the Render production configuration.

The LLM prompt sent to any real provider must instruct it to ONLY rephrase
the given structured itinerary into friendly prose — it must not be asked to
choose activities, invent details not present in the input, or make
decisions. The provider's output is display text only; it is never parsed
back into structured state or written to any table other than
`ai_polished_summaries.polished_text`.

## Tables

- `ai_polished_summaries`: `id`, `plan_id`, `generated_by_user_id`,
  `input_hash`, `provider`, `model`, `polished_text`,
  `structured_input_json`, `created_at`, `expires_at`.
- `ai_usage_limits`: `id`, `user_id`, `date`, `request_count`,
  `created_at`, `updated_at`.

## Quota enforcement (check ALL of these before calling any real provider)
- Global: max 15 generations/day across the whole app.
- Per plan: max 1 generation/day.
- Per user: max 1 generation/week.
- Only the plan OWNER may trigger generation (`POST /plans/{plan_id}/ai/polish`
  is owner-only server-side). Members may only READ a cached summary via
  `GET /plans/{plan_id}/ai/polished-summary`.

If ANY quota is exceeded, do NOT call the real provider — return the
`NoopProvider` deterministic summary and set a response flag indicating
quota-fallback occurred, so the frontend can show "AI polish unavailable
right now — showing deterministic summary" rather than a bare error.

## Caching

`input_hash = sha256(canonical_json(structured_itinerary_json))`. Before
calling any provider (including Noop, for consistency), check
`ai_polished_summaries` for an existing row with the same `input_hash` for
that plan. If found and not expired, return it directly — do not regenerate.

## Failure handling

Wrap every real-provider call in try/except. On ANY exception (timeout, API
error, auth failure, malformed response), fall back to `NoopProvider`'s
deterministic output and mark the response as a fallback — never propagate
the provider exception to the user as a 500.

## Explicit constraints — do NOT do any of the following
- Do NOT make any real LLM provider the default — `LLM_PROVIDER=noop` is the
  default and must remain fully functional with zero external API keys
  configured.
- Do NOT let the LLM's output be parsed back into structured itinerary state
  or influence activity selection/scoring/ordering in any way — it is
  display-only prose layered on top of already-finalized structured data.
- Do NOT deploy `OllamaProviderLocal` to the Render production config.
- Do NOT skip the quota check before a real-provider call under any
  circumstance, including "just for testing" — gate it behind the same
  `LLM_PROVIDER` env var logic every time.
- Do NOT let a member (non-owner) trigger generation, even if they can view
  a cached result.

## Required tests before moving on
- [ ] With `LLM_PROVIDER=noop` (default) and zero API keys configured, the
      full polish flow works end-to-end and returns a deterministic summary.
- [ ] Exceeding the per-plan daily quota causes subsequent requests to return
      the fallback summary with a `fallback: true` flag, not an error.
- [ ] Simulate a real-provider exception (mock a timeout) — verify the
      response still succeeds with a fallback summary, not a 500.
- [ ] A member (non-owner) calling the generate endpoint receives 403; the
      same member calling the read-cached-summary endpoint succeeds.
- [ ] Two identical structured itinerary inputs for the same plan return the
      exact same cached `polished_text` on the second call (verify no
      second provider call was made, via a call-count mock).
```

---

## Phase 6 — Cleanup, Metrics, Docs, Demo Reliability

### Objective
Make the free-tier MVP observable, self-cleaning, and safe to demo — closing the loop on every `expires_at` column introduced since Phase 2.

### Scope
- APScheduler jobs: 30-min cache cleanup, daily AI/LangGraph-run cleanup.
- Opportunistic bounded cleanup triggered on normal requests (since Render Free may be asleep when scheduled jobs would otherwise fire).
- `GET /health`, `GET /admin/metrics`, `POST /admin/cleanup/expired` (protected).
- Seed/demo data + demo mode.
- `/docs/architecture.md`, `/docs/upgrade-triggers.md`.

### Guardrails Active This Phase
- **G11** — This phase is where the "actually delete expired rows" half of G11 gets implemented, not just the schema half from Phase 2.
- Admin endpoints must be protected — don't let cleanup/metrics leak to unauthenticated callers.

### Explicit Non-Goals This Phase
- No new user-facing features — this phase is entirely about reliability, hygiene, and documentation of what already exists.

### Vibe-Coding Prompt

```markdown
You are building Phase 6 of "Basecamp": cleanup jobs, metrics, and demo
reliability. No new user-facing product features in this phase — this is
purely about keeping the free-tier deployment healthy and observable.

## Scheduled cleanup (APScheduler)

Every 30 minutes (when the backend is awake):
- Delete expired `route_cache` rows (`expires_at < now()`).
- Delete expired `weather_snapshots`.
- Delete expired `invite_links`.
- Delete stale `idempotency_records` (past `expires_at`).

Daily:
- Delete old `ai_polished_summaries` past `expires_at`.
- Delete old `langgraph_runs` past `expires_at`.

## Opportunistic cleanup — REQUIRED, do not skip this

Because Render Free can sleep and miss scheduled jobs entirely, implement a
bounded opportunistic cleanup that piggybacks on normal requests (e.g., the
dashboard load endpoint):

```python
if last_cleanup_at is None or (now() - last_cleanup_at) > timedelta(minutes=30):
    await run_bounded_cleanup(limit_per_table=100)
    update_last_cleanup_timestamp()
```

The cleanup MUST be bounded (e.g., `DELETE ... LIMIT 100` per table per
invocation, or an equivalent bounded subquery) — it must never add
noticeable latency to the request it's piggybacking on. Do not run an
unbounded `DELETE FROM ... WHERE expires_at < now()` on every request.

## Admin/health endpoints

- `GET /health`: no auth required, returns basic liveness + DB connectivity
  check.
- `GET /admin/metrics`: PROTECTED (admin-only auth check — reuse/extend the
  JWT + role system; do not leave this open to any authenticated user).
  Surfaces: request counts, WebSocket reconnect counts, auth/CORS failure
  counts, external API failure counts (per provider), AI usage counts.
- `POST /admin/cleanup/expired`: PROTECTED, manually triggers the same
  bounded cleanup logic as the scheduled job (useful for demo-day prep).

## Seed/demo data + demo mode

- A seed script that creates a demo plan with realistic activities, votes,
  itinerary items, and expenses — usable for local dev and demo walkthroughs
  without depending on live external APIs.
- A `DEMO_MODE` flag that, when enabled, serves cached/seeded place/route/
  weather data instead of live external calls, so a demo doesn't depend on
  Nominatim/OSRM/Open-Meteo being up or fast.

## Documentation

- `/docs/architecture.md`: document the free-tier tradeoffs explicitly —
  Render Free sleep is an intentional cost/latency tradeoff, recovered via
  exponential WebSocket backoff + reconnect + `/resync` (built in Phase
  1A.5). Document that an external uptime pinger (UptimeRobot / scheduled
  GitHub Action hitting `/health`) may be used ONLY for demo/test windows,
  never as the production reliability strategy.
- `/docs/upgrade-triggers.md`: document the upgrade order from the PRD —
  backend (first), Redis Pub/Sub (only on horizontal scaling), database,
  routing/geocoding, AI (last) — with the specific triggering conditions
  for each from the PRD's Appendix B.

## Explicit constraints — do NOT do any of the following
- Do NOT run unbounded cleanup deletes on a hot request path.
- Do NOT leave `/admin/metrics` or `/admin/cleanup/expired` unauthenticated.
- Do NOT build new product features in this phase — if you find yourself
  adding a new user-facing capability, stop and flag it as out of scope.
- Do NOT treat an uptime pinger as a substitute for the resync/reconnect
  architecture already built — document it explicitly as a demo-only aid.

## Required tests/checks before moving on
- [ ] Manually expire a handful of cache rows (set `expires_at` in the past)
      and confirm the opportunistic cleanup path removes them on the next
      qualifying request without adding noticeable latency.
- [ ] Confirm `/admin/metrics` returns 403 for a non-admin authenticated user.
- [ ] Run the seed script from a clean database and confirm the demo plan is
      fully walkable end-to-end without any live external API calls (with
      `DEMO_MODE` enabled).
- [ ] Confirm `/docs/architecture.md` and `/docs/upgrade-triggers.md` exist
      and accurately reflect the actual implemented fallback behavior (not
      just aspirational text).
```

---

## Phase 7 — Real-User Beta (Operational — not a code-generation phase)

### Objective
Get real friends using the app and learn from actual failure modes before investing further in features (especially AI polish).

### Why this isn't a vibe-coding prompt
This phase is about actions you take, not code an agent writes: manually adding friends as Google OAuth test users, watching cold-start complaints, reconnect counts, auth failures, external API failures, and split-correctness in the wild. There's no meaningful "generate this phase's code" prompt — the code already exists from Phases 0–6.

### Guardrails Active This Phase
- All of G1–G13 are now under real-world load for the first time. Treat any bug report through the lens of "which guardrail was violated" rather than patching symptoms.

### Operational Checklist (use this instead of a prompt)
- [ ] Add each friend as a Google OAuth test user (Phase 1A allowlist).
- [ ] Watch `/admin/metrics` (Phase 6) daily during the beta window.
- [ ] Log every reconnect complaint — verify it's actually hitting the Phase 1A.5 backoff/resync path correctly rather than a new bug.
- [ ] Log every "my split doesn't add up" report — these should be mathematically impossible per Phase 1B's invariants; if one occurs, it's a real bug, not a rounding "close enough."
- [ ] Do NOT prioritize AI polish work based on beta feedback before core planning/expense/realtime flows are rock solid.

---

## Phase 8 — Public Launch Readiness

### Objective
Make the app safe to accept unknown, non-allowlisted users at scale-appropriate throttling.

### Scope
- Google OAuth production/verification path.
- Privacy Policy, Terms of Service, homepage, contact/support info as live pages.
- `LAUNCH_MODE` enforcement (`private_beta | soft_launch | public_launch | waitlist`).
- Signup/plan-creation/place-search throttles.
- `launch_controls`, `waitlist_entries` tables.

### Guardrails Active This Phase
- **G13** — `LAUNCH_MODE` must be an enforced runtime gate on the actual signup and plan-creation code paths, not documentation.
- **G10** — Admin endpoints for adjusting `launch_controls` must be protected the same way as Phase 6's admin endpoints.

### Explicit Non-Goals This Phase
- Do not actually execute the public launch itself yet — that's Phase 9, and it's sequenced, not a big-bang.

### Vibe-Coding Prompt

```markdown
You are building Phase 8 of "Basecamp": public launch readiness controls.
This phase makes it SAFE to open the app to unknown users — it does not
itself trigger a public launch (that's a manual, staged rollout in Phase 9).

## Launch mode enforcement

Add a `launch_controls` table (per schema): `id`, `mode`,
`max_signups_per_hour`, `max_plans_per_user_per_day`,
`max_place_searches_per_user_per_hour`, `waitlist_enabled`, timestamps.

`LAUNCH_MODE` behavior MUST be enforced in actual request-handling code, not
just documented:

- `private_beta`: signup/login endpoint only allows users already on the
  Google OAuth test-user allowlist (this is largely a Google Cloud Console
  setting, but the APPLICATION must not assume all authenticated users are
  welcome — cross-check against an internal allowlist table if you want
  defense-in-depth beyond Google's own test-user gate).
- `soft_launch`: enforce `max_signups_per_hour` — track signups in a
  rolling-hour counter (a simple timestamped counter table or in-process/
  Upstash counter is fine; this does not require a new architecture).
  Reject signups beyond the cap with a clear "we're onboarding gradually"
  message, not a generic error.
- `public_launch`: normal signups allowed, still subject to
  `max_plans_per_user_per_day` and `max_place_searches_per_user_per_hour`
  throttles (reuse the Phase 2 Nominatim rate-limiting pattern, generalized).
- `waitlist`: new-plan creation is DISABLED for non-approved users; instead,
  `POST /waitlist` collects `email` + `source` into `waitlist_entries`. The
  landing page must render a waitlist form instead of (or alongside) the
  sign-in button when this mode is active.

Implement a single `check_launch_mode_gate(action: str, user)` dependency/
helper used consistently across signup, plan-creation, and place-search
endpoints — do not scatter ad-hoc mode checks across each endpoint
independently, or they will drift out of sync.

## Legal/compliance pages (frontend)

- `/privacy` — must accurately describe: what's collected (Google sign-in
  data), what's stored (plan/activity/expense data), how to contact you, and
  note the app's beta status if still applicable.
- `/terms` — must cover: beta nature, acceptable use, no uptime guarantee,
  user responsibility for outing decisions, contact info.
- Homepage must link both from the footer, and the sign-in flow must not be
  reachable without these pages existing and being linked.

## Admin controls

- `GET /admin/launch-controls` / `PATCH /admin/launch-controls`: protected
  the same way as Phase 6's `/admin/metrics` — admin-role-gated, not just
  "any authenticated user."

## Explicit constraints — do NOT do any of the following
- Do NOT treat `LAUNCH_MODE` as a comment or README note — it must be an
  enforced runtime check with a single shared gate function/dependency.
- Do NOT scatter mode-checking logic ad hoc across multiple endpoints
  independently — centralize it so it can't drift out of sync between
  signup, plan-creation, and place-search paths.
- Do NOT leave `/admin/launch-controls` open to non-admin authenticated
  users.
- Do NOT skip the Privacy Policy/ToS pages "for now" — the sign-in flow
  should not go live in a mode above `private_beta` without them.

## Required tests before moving on
- [ ] With `LAUNCH_MODE=soft_launch` and a low `max_signups_per_hour`,
      verify the (N+1)th signup within the hour is rejected with the
      graceful "onboarding gradually" message, not a generic 500/403.
- [ ] With `LAUNCH_MODE=waitlist`, verify new-plan creation is blocked for a
      non-approved user and the waitlist submission endpoint works.
- [ ] Verify `/admin/launch-controls` PATCH is rejected for a non-admin
      authenticated user.
- [ ] Verify the frontend does not render a working sign-in path without the
      `/privacy` and `/terms` pages present and linked.
```

---

## Phase 9 — Public / Reddit Soft Launch (Operational — not a code-generation phase)

### Objective
A staged, controlled public rollout that leans on Phase 8's throttles and waitlist mode as an escape valve rather than hoping traffic stays manageable.

### Why this isn't a vibe-coding prompt
By this point all necessary code (throttles, waitlist mode, launch-mode gating) already exists from Phase 8. This phase is a sequencing decision and a monitoring exercise, not new development.

### Guardrails Active This Phase
- **G13** is the guardrail actually being exercised live now — you're watching whether the enforced gates from Phase 8 behave correctly under real, possibly bursty, traffic.

### Operational Runbook (use this instead of a prompt)
1. Soft-launch to a small private group or niche Discord first — not a wide subreddit.
2. Watch signup rate, auth errors, external API failure rate, WebSocket reconnect volume, and DB load live via the Phase 6 `/admin/metrics` endpoint.
3. Fix any issues surfaced before widening the audience.
4. Post to a smaller/less-trafficked subreddit before a larger one.
5. Keep `waitlist` mode ready to flip on immediately if traffic exceeds free-tier capacity — this is the deliberate escape valve, not a failure state.
6. During the launch window, be ready to disable AI polish (Phase 5, already fallback-safe) and tighten place-search throttles (Phase 2/8) if quota or rate-limit pressure appears, without needing new code — these are already environment-variable/config-level toggles by design.
7. Only after the above is stable, consider a larger/broader public post.

---

## Closing Note

Every phase prompt above is written to be dropped directly into your coding agent session as-is. The **Definition of Done / Required tests** checklists at the end of each phase are your drift-detection mechanism — if the agent's output can't satisfy every checkbox, do not proceed to the next phase's prompt. Treat a failed checkbox the same way you'd treat a failed CI test: it blocks the merge, not just a note for later.


---

## Codex Drift Correction Prompts

Use these when Codex violates the spec.

### If Codex creates Basecamp references
```md
Stop. You violated the naming requirement. The project is Basecamp everywhere. Remove every Basecamp reference from code, docs, package names, env vars, comments, tests, migrations, and UI copy. Keep the same functionality, but rewrite using Basecamp naming only.
```

### If Codex creates `/backend` or `/frontend`
```md
Stop. You violated the canonical monorepo structure. Do not create root-level `/backend` or `/frontend`. Move backend code into `apps/api` and frontend code into `apps/web`. Update imports, Docker paths, README commands, and tests accordingly.
```

### If Codex adds generic CRUD
```md
Stop. This is generic CRUD drift. Remove placeholder routes, TODO resources, sample `/items`, fake `/todos`, and unauthenticated scaffolds. Rebuild only the Basecamp domain endpoints required by this phase, with auth, membership checks, migrations, and tests.
```

### If Codex uses floats for money
```md
Stop. You violated the integer-cent money invariant. Replace every money float/decimal-path with integer cents. Column names must end in `_cents`. Split math must use `//` and `%`, with deterministic remainder distribution by sorted user_id. Add or update tests proving exact-cent behavior.
```

### If Codex makes WebSockets authoritative
```md
Stop. WebSockets are notifications only. The source of truth is Postgres. The mutation order must be validate -> commit to Postgres -> write `plan_events` -> broadcast. The client must call `/resync` after reconnect and replace local state from the authoritative snapshot.
```

### If Codex skips idempotency correctness
```md
Stop. Idempotency must use an atomic claim insert with `INSERT ... ON CONFLICT DO NOTHING RETURNING id`. Do not use check-then-insert. Implement canonical request hashing and correct replay behavior: same key + same hash returns stored response, same key + different payload returns 409.
```

### If Codex adds Redis too early
```md
Stop. Redis Pub/Sub is explicitly out of scope for the MVP realtime phase. Remove Redis, Celery, workers, and multi-instance broadcast code. Use the single-instance in-memory FastAPI room manager with copied socket-set iteration and `/resync` recovery.
```

---

## Final Reminder

The impressive part of Basecamp is not that it plans trips. The impressive part is that it behaves like a real collaborative production system: authenticated, recoverable, versioned, idempotent, financially exact, cache-safe, and resilient to free-tier deployment constraints.
