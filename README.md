# Basecamp

Basecamp is a real-time collaborative group outing planner.

## Local Setup

```bash
cp .env.example .env
docker compose up --build
```

If another local Postgres is already using port `5432`, set `POSTGRES_PORT=5433`
in `.env` and rerun `docker compose up --build`. The backend still connects to
the Compose Postgres service on container port `5432`.

Confirm the API health check:

```bash
curl http://localhost:8000/health
```

Expected response:

```json
{"status":"ok","database":"ok","environment":"local"}
```

## Operations and deterministic demo data

Set `ADMIN_EMAILS` to a comma-separated allowlist for the protected operational
endpoints. Plan ownership does not grant application administration. Enable
`CLEANUP_SCHEDULER_ENABLED=true` only for the single long-lived API process;
expired temporary records are also checked, at most once per 30 minutes per
process, after an authenticated plan resync.

Seed the repeatable local demo after migrations are current:

```bash
cd apps/api
DATABASE_URL=postgresql+asyncpg://basecamp:basecamp@localhost:5433/basecamp uv run python -m app.scripts.seed_demo
```

Running it again is intentionally a no-op. It creates a realistic plan with
three roles, ideas, votes, availability, scheduled/unscheduled itinerary
items, deterministic recommendation rows, and a zero-sum shared expense.
