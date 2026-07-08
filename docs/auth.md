# Auth

Basecamp auth is two-phase:

1. Google OAuth establishes identity in the Next.js app.
2. The app issues a JWT signed with the shared `JWT_SECRET`.

FastAPI validates the app JWT offline with PyJWT. It must not call Google on each request.
