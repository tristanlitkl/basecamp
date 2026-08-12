"""Deterministic LangGraph itinerary-draft workflow.

The graph receives a JSON-compatible PostgreSQL snapshot and returns a Pydantic
``PlanDraft`` only.  It never writes itinerary rows, calls an LLM, or consults
an external provider.  Applying a fresh draft is deliberately a separate,
transactional service operation.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import TypedDict
from uuid import UUID

from langgraph.graph import END, START, StateGraph
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity
from app.models.itinerary import ItineraryItem
from app.models.plan import Plan, PlanDateAvailability, PlanMember
from app.schemas.planning import DraftItineraryDay, DraftItineraryItem, PlanDraft
from app.services.recommendation_service import compute_plan_scores


class PlanPlanningState(TypedDict, total=False):
    """JSON-compatible values only; ORM instances never enter graph state."""

    plan_id: str
    user_id: str
    base_plan_version: int
    base_planning_version: int
    current_planning_version: int
    plan_budget_cents: int | None
    plan_start_date: str | None
    plan_end_date: str | None
    activities: list[dict]
    recommendation_scores: list[dict]
    votes_summary: dict[str, dict[str, int]]
    date_availability: list[dict]
    existing_itinerary: list[dict]
    candidate_activities: list[dict]
    selected_activities: list[dict]
    proposed_itinerary: list[dict]
    warnings: list[str]
    validation_errors: list[str]
    draft_status: str
    draft: dict | None


def _date_value(value: datetime | None) -> str | None:
    return value.date().isoformat() if value else None


async def load_plan_snapshot(
    session: AsyncSession, *, plan_id: UUID, user_id: UUID
) -> PlanPlanningState:
    """Read all authoritative inputs before graph execution, without writing state."""
    plan = (await session.execute(select(Plan).where(Plan.id == plan_id))).scalar_one_or_none()
    if plan is None:
        raise ValueError("plan_not_found")
    activities = (
        (
            await session.execute(
                select(Activity)
                .where(Activity.plan_id == plan_id)
                .order_by(Activity.created_at.asc(), Activity.id.asc())
            )
        )
        .scalars()
        .all()
    )
    itinerary = (
        (
            await session.execute(
                select(ItineraryItem)
                .where(ItineraryItem.plan_id == plan_id)
                .order_by(ItineraryItem.position_key.asc(), ItineraryItem.id.asc())
            )
        )
        .scalars()
        .all()
    )
    availability = (
        (
            await session.execute(
                select(PlanDateAvailability)
                .where(PlanDateAvailability.plan_id == plan_id)
                .order_by(PlanDateAvailability.date.asc(), PlanDateAvailability.user_id.asc())
            )
        )
        .scalars()
        .all()
    )
    members = (
        (
            await session.execute(
                select(PlanMember.user_id)
                .where(PlanMember.plan_id == plan_id)
                .order_by(PlanMember.user_id)
            )
        )
        .scalars()
        .all()
    )
    scores = await compute_plan_scores(session, plan_id)
    activities_by_id = {activity.id: activity for activity in activities}
    ranked_scores = sorted(
        scores,
        key=lambda score: (
            -score.total_score,
            activities_by_id[score.activity_id].created_at,
            str(score.activity_id),
        ),
    )
    return {
        "plan_id": str(plan.id),
        "user_id": str(user_id),
        "base_plan_version": plan.version,
        "base_planning_version": plan.planning_version,
        "current_planning_version": plan.planning_version,
        "plan_budget_cents": plan.budget_cents,
        "plan_start_date": _date_value(plan.starts_on),
        "plan_end_date": _date_value(plan.ends_on),
        "activities": [
            {
                "id": str(activity.id),
                "title": activity.name,
                "estimated_cost_cents": activity.estimated_cost_cents,
                "duration_minutes": activity.estimated_duration_minutes,
                "created_at": activity.created_at.isoformat(),
            }
            for activity in activities
        ],
        "recommendation_scores": [
            {
                "activity_id": str(score.activity_id),
                "rank": index,
                "total_score": score.total_score,
                "vote_score": score.vote_score,
                "budget_score": score.budget_score,
                "schedule_fit_score": score.schedule_fit_score,
                "reasons": list(score.reasons),
            }
            for index, score in enumerate(ranked_scores, start=1)
        ],
        "votes_summary": {},
        "date_availability": [
            {"date": row.date.isoformat(), "user_id": str(row.user_id), "status": row.status}
            for row in availability
        ],
        "existing_itinerary": [
            {
                "id": str(item.id),
                "activity_id": str(item.activity_id) if item.activity_id else None,
                "position_key": str(item.position_key),
                "starts_at": item.starts_at.isoformat() if item.starts_at else None,
            }
            for item in itinerary
        ],
        # The snapshot is intentionally complete and JSON-compatible, including membership.
        "member_ids": [str(member_id) for member_id in members],  # type: ignore[typeddict-unknown-key]
    }


def _load_plan_snapshot_node(state: PlanPlanningState) -> PlanPlanningState:
    return state


def _normalize_constraints(state: PlanPlanningState) -> PlanPlanningState:
    start = state.get("plan_start_date")
    end = state.get("plan_end_date")
    errors: list[str] = []
    if start and end and start > end:
        errors.append("plan_date_window_is_invalid")
    return {"validation_errors": errors, "warnings": []}


def _load_ranked_activities(state: PlanPlanningState) -> PlanPlanningState:
    by_id = {row["id"]: row for row in state["activities"]}
    ranked = []
    for score in state["recommendation_scores"]:
        activity = by_id.get(score["activity_id"])
        if activity is not None:
            ranked.append({**activity, **score})
    return {"candidate_activities": ranked}


def _select_candidates(state: PlanPlanningState) -> PlanPlanningState:
    already_in_itinerary = {
        item["activity_id"]
        for item in state["existing_itinerary"]
        if item["activity_id"] is not None
    }
    selected: list[dict] = []
    warnings = list(state.get("warnings", []))
    for activity in state.get("candidate_activities", []):
        if activity["id"] in already_in_itinerary:
            continue
        # A score <= 250 is the documented strong-negative group-support band.
        if activity["vote_score"] <= 250:
            warnings.append(f"Excluded {activity['title']}: strong negative group support.")
            continue
        selected.append(activity)
    return {"selected_activities": selected, "warnings": warnings}


def _plan_dates(start: str | None, end: str | None) -> list[date]:
    if not start or not end:
        return []
    first, last = date.fromisoformat(start), date.fromisoformat(end)
    return [first + timedelta(days=offset) for offset in range((last - first).days + 1)]


def _assign_candidate_days(state: PlanPlanningState) -> PlanPlanningState:
    dates = _plan_dates(state.get("plan_start_date"), state.get("plan_end_date"))
    if not dates:
        return {
            "proposed_itinerary": [
                {**activity, "assigned_date": None}
                for activity in state.get("selected_activities", [])
            ]
        }
    points = {"available": 1000, "maybe": 500, "unavailable": 0}
    scores: dict[str, list[int]] = defaultdict(list)
    for row in state.get("date_availability", []):
        scores[row["date"]].append(points.get(row["status"], 500))
    ranked_dates = sorted(
        dates,
        key=lambda candidate: (
            -(
                sum(scores[candidate.isoformat()]) // len(scores[candidate.isoformat()])
                if scores[candidate.isoformat()]
                else 500
            ),
            candidate,
        ),
    )
    return {
        "proposed_itinerary": [
            {**activity, "assigned_date": ranked_dates[index % len(ranked_dates)].isoformat()}
            for index, activity in enumerate(state.get("selected_activities", []))
        ]
    }


def _order_itinerary(state: PlanPlanningState) -> PlanPlanningState:
    ordered = sorted(
        state.get("proposed_itinerary", []),
        key=lambda activity: (
            activity["assigned_date"] is None,
            activity["assigned_date"] or "",
            activity["rank"],
            activity["created_at"],
            activity["id"],
        ),
    )
    return {"proposed_itinerary": ordered}


def _produce_structured_draft(state: PlanPlanningState) -> PlanPlanningState:
    items_by_date: dict[str | None, list[DraftItineraryItem]] = defaultdict(list)
    for activity in state.get("proposed_itinerary", []):
        reasons = ["recommendation_ranked"]
        if activity["vote_score"] >= 750:
            reasons.append("strong_group_support")
        if activity["budget_score"] == 1000:
            reasons.append("within_plan_budget")
        if activity["assigned_date"] is None:
            reasons.append("unscheduled_within_day")
        else:
            reasons.append("availability_ranked_date")
        items_by_date[activity["assigned_date"]].append(
            DraftItineraryItem(
                activity_id=UUID(activity["id"]),
                title=activity["title"],
                # The system has no authoritative time-of-day input, so it never invents one.
                proposed_start_at=None,
                duration_minutes=activity["duration_minutes"],
                estimated_cost_cents=activity["estimated_cost_cents"],
                recommendation_rank=activity["rank"],
                reason_codes=reasons,
            )
        )
    days = [
        DraftItineraryDay(
            date=date.fromisoformat(day_value) if day_value else None,
            items=items,
        )
        for day_value, items in sorted(
            items_by_date.items(), key=lambda pair: (pair[0] is None, pair[0] or "")
        )
    ]
    draft = PlanDraft(
        plan_id=UUID(state["plan_id"]),
        base_planning_version=state["base_planning_version"],
        days=days,
        warnings=state.get("warnings", []),
        generated_at=datetime.now(timezone.utc),
    )
    return {"draft": draft.model_dump(mode="json")}


def _validate_draft(state: PlanPlanningState) -> PlanPlanningState:
    errors = list(state.get("validation_errors", []))
    try:
        draft = PlanDraft.model_validate(state.get("draft"))
    except ValidationError as exc:
        return {"validation_errors": [*errors, str(exc)], "draft_status": "invalid"}
    activity_ids = {row["id"] for row in state["activities"]}
    assigned: set[UUID] = set()
    start, end = state.get("plan_start_date"), state.get("plan_end_date")
    for day in draft.days:
        if day.date and (
            (start and day.date.isoformat() < start) or (end and day.date.isoformat() > end)
        ):
            errors.append("draft_date_outside_plan_window")
        for item in day.items:
            if str(item.activity_id) not in activity_ids:
                errors.append(f"unknown_activity:{item.activity_id}")
            if item.activity_id in assigned:
                errors.append(f"duplicate_activity:{item.activity_id}")
            assigned.add(item.activity_id)
            if item.estimated_cost_cents is not None and not isinstance(
                item.estimated_cost_cents, int
            ):
                errors.append(f"non_integer_cost:{item.activity_id}")
            if item.duration_minutes is not None and item.duration_minutes <= 0:
                errors.append(f"invalid_duration:{item.activity_id}")
    return {"validation_errors": errors, "draft_status": "invalid" if errors else "fresh"}


def _check_staleness(state: PlanPlanningState) -> PlanPlanningState:
    if state.get("draft_status") == "invalid":
        return {}
    return {
        "draft_status": (
            "fresh"
            if state["current_planning_version"] == state["base_planning_version"]
            else "stale"
        )
    }


def build_planning_graph():
    graph = StateGraph(PlanPlanningState)
    graph.add_node("load_plan_snapshot", _load_plan_snapshot_node)
    graph.add_node("normalize_constraints", _normalize_constraints)
    graph.add_node("load_ranked_activities", _load_ranked_activities)
    graph.add_node("select_candidates", _select_candidates)
    graph.add_node("assign_candidate_days", _assign_candidate_days)
    graph.add_node("order_itinerary", _order_itinerary)
    graph.add_node("produce_structured_draft", _produce_structured_draft)
    graph.add_node("validate_draft", _validate_draft)
    graph.add_node("check_staleness", _check_staleness)
    graph.add_edge(START, "load_plan_snapshot")
    graph.add_edge("load_plan_snapshot", "normalize_constraints")
    graph.add_edge("normalize_constraints", "load_ranked_activities")
    graph.add_edge("load_ranked_activities", "select_candidates")
    graph.add_edge("select_candidates", "assign_candidate_days")
    graph.add_edge("assign_candidate_days", "order_itinerary")
    graph.add_edge("order_itinerary", "produce_structured_draft")
    graph.add_edge("produce_structured_draft", "validate_draft")
    graph.add_edge("validate_draft", "check_staleness")
    graph.add_edge("check_staleness", END)
    return graph.compile()


planning_graph = build_planning_graph()


def execute_deterministic_draft(snapshot: PlanPlanningState) -> PlanPlanningState:
    """Execute explicit nodes synchronously over a stable JSON-compatible snapshot."""
    return planning_graph.invoke(snapshot)
