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
{"status":"ok"}
```
