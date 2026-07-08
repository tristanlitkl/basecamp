# Codex Guardrails

Follow the roadmap one phase at a time.

- Use `apps/web` and `apps/api`; do not create alternate service roots.
- Keep the project name Basecamp everywhere.
- Do not add generic CRUD routes or fake resources.
- Do not implement future phase logic early.
- Preserve completed behavior from earlier phases.
- Treat WebSocket messages as non-authoritative.
- Keep money as integer cents and ledger entries append-only.
- Keep auth as Google OAuth identity plus app-issued JWT authorization.
- Make deterministic behavior the default; AI polish is optional and fallback-safe.
