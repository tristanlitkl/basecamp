# Architecture

Basecamp uses the canonical monorepo layout:

- `apps/web`: Next.js App Router frontend deployed to Vercel.
- `apps/api`: FastAPI backend deployed to Render.
- Postgres is the source of truth, with Neon in production and Docker Compose locally.

The roadmap architecture centers on offline JWT verification, Postgres-backed state, in-memory WebSockets for the MVP, REST resync after reconnect, integer-cent accounting, immutable ledger entries, idempotent creates, optimistic concurrency, deterministic recommendations, and optional AI polish.
