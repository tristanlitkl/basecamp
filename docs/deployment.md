# Deployment

Canonical deployment targets:

- Web: Vercel
- API: Render
- Database: Neon Postgres

Concrete deployment commands and environment variables are added during the relevant implementation phases.

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
