# Deployment

Canonical deployment targets:

- Web: Vercel
- API: Render
- Database: Neon Postgres

Concrete deployment commands and environment variables are added during the relevant implementation phases.

## Render API service

Configure the Render backend service to use this repository's API project, not
the monorepo root:

- **Root Directory:** `apps/api`
- **Build Command:** `uv sync --frozen`
- **Start Command:** `uv run --frozen uvicorn app.main:app --host 0.0.0.0 --port $PORT`

The dependency source of truth is `apps/api/pyproject.toml` plus
`apps/api/uv.lock`. Do not configure a separate `requirements.txt` install.
`langgraph` is a normal production dependency, not a dev extra. The API
Dockerfile follows the same lockfile-based production installation with
`uv sync --frozen --no-dev` and performs an import smoke test while building.

For a Render Docker service, leave the dashboard **Docker Command** override
empty so the image `CMD` runs. If an override is required, it must be:

```bash
uv run --frozen uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

After a dependency-layer failure or an unexpected old deployment, select
**Clear build cache & deploy** in Render. Confirm the deployment log runs the
commands above from `apps/api`, then verify its deployed commit is the latest
repository commit.

No migration is required for this runtime-only change; production is already
at `0016_phase4_langgraph_runs` (head).

### Production dependency/import smoke checks

After `uv sync --frozen`, run these from `apps/api` (or use them as a Render
pre-deploy smoke step):

```bash
uv run --frozen python -c "from langgraph.graph import END, START, StateGraph; print('langgraph import ok')"
uv run --frozen python -c "import app.main; print('app import ok')"
```

They catch a missing production dependency before the server process starts.

## Browser bridge

Render must use the same `JWT_SECRET` as Vercel and set
`CORS_ALLOWED_ORIGINS` to Basecamp's stable Vercel URL. The API additionally
allows the Basecamp project's immutable Vercel deployment URLs through
`CORS_ALLOWED_ORIGIN_REGEX`; do not broaden this to arbitrary `*.vercel.app`
origins.

## Phase 6 operations

Set `ADMIN_EMAILS` to the exact application-administrator email allowlist.
`GET /admin/metrics` and `POST /admin/cleanup/expired` require a valid app JWT
for one of those users; plan owners are not implicitly admins. Enable
`CLEANUP_SCHEDULER_ENABLED=true` only on the intended single API process.
`CLEANUP_ENABLED`, `CLEANUP_INTERVAL_MINUTES` (default `30`), and
`CLEANUP_BATCH_SIZE` (default `100`) control bounded temporary-record cleanup.
