# Deterministic planning orchestration

Planning status is a read-only, deterministic view over Basecamp’s existing
authoritative PostgreSQL rows. It is distinct from Phase 4's persisted
LangGraph itinerary-draft workflow: status answers what needs attention,
whereas a draft previews one deterministic suggested schedule.

## Workflow

Each request follows these fixed stages:

1. Load the plan and its current `version` and `planning_version`.
2. Load itinerary membership and scheduling state.
3. Identify explicit date conflicts.
4. Read persisted Phase 3 recommendation scores; do not recalculate them.
5. Identify budget and open-suggestion signals.
6. Evaluate readiness and order suggested actions.
7. Re-read both plan counters. If either changed, reload all authoritative rows
   once. A second change returns `409 planning_status_stale` rather than stale
   guidance.

The database remains authoritative throughout. The read creates no plan event,
notification, WebSocket broadcast, mutation, or derived-score update.

## Status model and readiness

`GET /plans/{plan_id}/planning-status` requires plan membership and returns
`overall_status`, `readiness_state`, both plan counters, `blockers`, `warnings`,
and `suggested_actions`. Issues and actions contain explicit reason codes and
supporting entity IDs only; they never include voter identities.

The status is `not_ready` when the itinerary is empty, an itinerary item is
unscheduled, or a scheduled item is outside the selected date window or on a
date with an explicit current-member `unavailable` response. It is `ready` when
none of those blockers exist. Optional plan dates and budget do not become
requirements merely by being absent. A finalized plan reports `finalized` and
has no actions.

Warnings supported by current authoritative data are: strong saved
recommendations outside the itinerary (score at least 750), recommendation
budget conflicts, low-supported itinerary activities (score at most 250),
recorded active expenses above a present plan budget, and open date/plan
suggestions.

## Ordering

Suggested actions are ordered by fixed priority, then stable entity UUID:

1. Date conflicts
2. Empty or unscheduled itinerary work
3. Strong recommendations outside the itinerary
4. Budget conflicts
5. Vote and suggestion review
6. Finalize when ready

The dashboard’s action buttons open the corresponding existing scheduling,
date, budget, or itinerary flow. They do not mutate a plan automatically.

## Phase 4 itinerary drafts

`POST /plans/{plan_id}/planning-runs` is owner/co-owner only and snapshots
authoritative Basecamp state in `langgraph_runs`. Its explicit deterministic
LangGraph sequence is `load_plan_snapshot → normalize_constraints →
load_ranked_activities → select_candidates → assign_candidate_days →
order_itinerary → produce_structured_draft → validate_draft → check_staleness`.
There are no external provider calls or LLM calls. `GET` of a particular run is
available to plan members; regenerate and apply require owner/co-owner.

The graph reuses Phase 3 scores and excludes currently represented itinerary
activities plus score-≤250 negative-support candidates. It assigns a date by
availability aggregate then ISO date and never manufactures a start time. Its
Pydantic output is `PlanDraft(plan_id, base_planning_version, days[],
warnings[], generated_at)`, with each day carrying nullable `date` and each
item carrying activity/title/nullable start/duration/cost/rank/reason codes.

Draft generation changes neither plan counter nor itinerary, votes, activity
versions, events, notifications, broadcasts, or persisted recommendation rows.
At completion and again inside the apply transaction, the server compares
`plans.planning_version` with `base_planning_version`; a mismatch is stale and
returns HTTP 409 with no partial application. Fresh apply inserts all items in
one transaction, increments `planning_version` once, records one event, then
broadcasts after commit. The UI makes stale review read-only and offers only
Review anyway or Regenerate.
