# Basecamp Codex Instructions

You are working on Basecamp, a real-time collaborative group outing planner.

Before coding, always read:
- `docs/basecamp.md`
- `docs/codex-guardrails.md`
- `docs/architecture.md`

The roadmap is the source of truth. Implement one phase at a time.

## Repository Rules

- Use the canonical monorepo layout.
- Frontend must live in `apps/web`.
- Backend must live in `apps/api`.
- Do not create `/frontend`, `/backend`, `/client`, or `/server`.
- Do not rename Basecamp.
- Do not create generic placeholder CRUD routes such as `/items`, `/todos`, or fake resources.
- Do not leave TODO stubs as completed work.
- Do not implement future phases early.
- Create all folders/files required for the current phase.
- You may create canonical directory/file skeletons early, but do not implement future phase logic early.
- Every file created must either contain useful documentation, project configuration, harmless structure, or working code for the current phase.

## Existing File Policy

Many canonical files may already exist from repo bootstrap.

When implementing a phase:
- Treat existing files as the starting point.
- Create missing required files.
- Modify existing files in place.
- Replace bootstrap placeholders with real implementation only when that file is in scope for the current phase.
- Do not delete/recreate working files unless absolutely necessary.
- Do not overwrite completed logic from previous phases with placeholders.
- Preserve all behavior and tests from earlier phases.
- If a phase prompt says “create required files,” interpret that as “create missing files or modify existing files in place.”

## Guardrail Rules

- Follow the active guardrails for the current phase.
- If implementation conflicts with a guardrail, stop and explain the conflict instead of coding around it.
- After coding, list which guardrails were active and how the implementation satisfies them.

## Phase Rules

- Implement only the current phase.
- Do not move to the next phase unless the Definition of Done for the current phase passes.
- After implementation, provide exact verification commands.
- Preserve all previously working behavior.