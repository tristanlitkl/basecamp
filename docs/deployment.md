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
