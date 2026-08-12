"""Read-only deterministic orchestration over Basecamp planning primitives.

There is deliberately no persisted run or graph checkpoint.  Each request
loads PostgreSQL rows, verifies the two plan counters after analysis, and
retries once if either counter changed.  A result is consequently never
returned as current when it was built from an observed stale plan version.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity
from app.models.expense import Expense
from app.models.itinerary import ItineraryItem
from app.models.plan import (
    Plan,
    PlanDateAvailability,
    PlanDateSuggestion,
    PlanMember,
    PlanSuggestion,
)
from app.models.recommendation import ActivityScore
from app.schemas.planning import (
    PlanningAction,
    PlanningActionType,
    PlanningIssue,
    PlanningOverallStatus,
    PlanningReadinessState,
    PlanningReasonCode,
    PlanningStatusResponse,
)
from app.services.recommendation_service import SCORE_VERSION


# Recommendation scores are in the roadmap-defined 0..1000 scale.  The
# orchestration layer consumes that saved score; it does not duplicate its formula.
STRONG_RECOMMENDATION_SCORE = 750
LOW_SUPPORT_SCORE = 250


@dataclass(frozen=True)
class _PlanState:
    plan: Plan
    activities: list[Activity]
    itinerary_items: list[ItineraryItem]
    scores: list[ActivityScore]
    availability: list[PlanDateAvailability]
    members: list[PlanMember]
    expenses: list[Expense]
    date_suggestions: list[PlanDateSuggestion]
    plan_suggestions: list[PlanSuggestion]


def _issue(code: PlanningReasonCode, ids: Iterable[UUID], label: str) -> PlanningIssue:
    return PlanningIssue(reason_code=code, entity_ids=sorted(set(ids), key=str), label=label)


def _action(
    action_type: PlanningActionType,
    code: PlanningReasonCode,
    ids: Iterable[UUID],
    label: str,
) -> PlanningAction:
    return PlanningAction(
        action_type=action_type, reason_code=code, entity_ids=sorted(set(ids), key=str), label=label
    )


async def _load_state(session: AsyncSession, plan_id: UUID) -> _PlanState | None:
    plan = (await session.execute(select(Plan).where(Plan.id == plan_id))).scalar_one_or_none()
    if plan is None:
        return None
    activities = (
        (await session.execute(select(Activity).where(Activity.plan_id == plan_id))).scalars().all()
    )
    itinerary_items = (
        (await session.execute(select(ItineraryItem).where(ItineraryItem.plan_id == plan_id)))
        .scalars()
        .all()
    )
    scores = (
        (
            await session.execute(
                select(ActivityScore).where(
                    ActivityScore.plan_id == plan_id,
                    ActivityScore.score_version == SCORE_VERSION,
                )
            )
        )
        .scalars()
        .all()
    )
    availability = (
        (
            await session.execute(
                select(PlanDateAvailability).where(PlanDateAvailability.plan_id == plan_id)
            )
        )
        .scalars()
        .all()
    )
    members = (
        (await session.execute(select(PlanMember).where(PlanMember.plan_id == plan_id)))
        .scalars()
        .all()
    )
    expenses = (
        (await session.execute(select(Expense).where(Expense.plan_id == plan_id))).scalars().all()
    )
    date_suggestions = (
        (
            await session.execute(
                select(PlanDateSuggestion).where(PlanDateSuggestion.plan_id == plan_id)
            )
        )
        .scalars()
        .all()
    )
    plan_suggestions = (
        (await session.execute(select(PlanSuggestion).where(PlanSuggestion.plan_id == plan_id)))
        .scalars()
        .all()
    )
    return _PlanState(
        plan=plan,
        activities=activities,
        itinerary_items=itinerary_items,
        scores=scores,
        availability=availability,
        members=members,
        expenses=expenses,
        date_suggestions=date_suggestions,
        plan_suggestions=plan_suggestions,
    )


def _scheduled_outside_window(item: ItineraryItem, plan: Plan) -> bool:
    if item.starts_at is None:
        return False
    scheduled_on = item.starts_at.date()
    return (plan.starts_on is not None and scheduled_on < plan.starts_on.date()) or (
        plan.ends_on is not None and scheduled_on > plan.ends_on.date()
    )


def _build_status(state: _PlanState) -> PlanningStatusResponse:
    plan = state.plan
    activity_by_id = {activity.id: activity for activity in state.activities}
    score_by_activity = {
        score.activity_id: score for score in state.scores if score.activity_id in activity_by_id
    }
    itinerary_activity_ids = {
        item.activity_id for item in state.itinerary_items if item.activity_id in activity_by_id
    }
    member_ids = {member.user_id for member in state.members}
    unavailable_dates = {
        row.date
        for row in state.availability
        if row.user_id in member_ids and row.status == "unavailable"
    }

    blockers: list[PlanningIssue] = []
    warnings: list[PlanningIssue] = []
    actions_with_priority: list[tuple[int, str, PlanningAction]] = []

    if plan.status == "finalized":
        return PlanningStatusResponse(
            overall_status=PlanningOverallStatus.FINALIZED,
            readiness_state=PlanningReadinessState.FINALIZED,
            plan_version=plan.version,
            planning_version=plan.planning_version,
            blockers=[],
            warnings=[],
            suggested_actions=[],
        )

    if not state.itinerary_items:
        blockers.append(
            _issue(PlanningReasonCode.ITINERARY_EMPTY, [plan.id], "Add an itinerary item")
        )
        actions_with_priority.append(
            (
                20,
                str(plan.id),
                _action(
                    PlanningActionType.ADD_TO_ITINERARY,
                    PlanningReasonCode.ITINERARY_EMPTY,
                    [plan.id],
                    "Add an itinerary item",
                ),
            )
        )

    date_conflict_items = [
        item
        for item in state.itinerary_items
        if _scheduled_outside_window(item, plan)
        or (item.starts_at is not None and item.starts_at.date() in unavailable_dates)
    ]
    for item in sorted(date_conflict_items, key=lambda row: str(row.id)):
        blockers.append(
            _issue(PlanningReasonCode.DATE_CONFLICT, [item.id], f"Resolve dates for {item.title}")
        )
        actions_with_priority.append(
            (
                10,
                str(item.id),
                _action(
                    PlanningActionType.REVIEW_DATES,
                    PlanningReasonCode.DATE_CONFLICT,
                    [item.id],
                    f"Resolve dates for {item.title}",
                ),
            )
        )

    unscheduled_items = [item for item in state.itinerary_items if item.starts_at is None]
    for item in sorted(unscheduled_items, key=lambda row: str(row.id)):
        blockers.append(
            _issue(
                PlanningReasonCode.ITINERARY_ITEM_UNSCHEDULED, [item.id], f"Schedule {item.title}"
            )
        )
        actions_with_priority.append(
            (
                20,
                str(item.id),
                _action(
                    PlanningActionType.SCHEDULE,
                    PlanningReasonCode.ITINERARY_ITEM_UNSCHEDULED,
                    [item.id],
                    f"Schedule {item.title}",
                ),
            )
        )

    for activity in sorted(state.activities, key=lambda row: str(row.id)):
        score = score_by_activity.get(activity.id)
        if score is None:
            continue
        if (
            activity.id not in itinerary_activity_ids
            and score.total_score >= STRONG_RECOMMENDATION_SCORE
        ):
            warnings.append(
                _issue(
                    PlanningReasonCode.STRONG_CANDIDATE_NOT_IN_ITINERARY,
                    [activity.id],
                    f"Add {activity.name} to itinerary",
                )
            )
            actions_with_priority.append(
                (
                    30,
                    str(activity.id),
                    _action(
                        PlanningActionType.ADD_TO_ITINERARY,
                        PlanningReasonCode.STRONG_CANDIDATE_NOT_IN_ITINERARY,
                        [activity.id],
                        f"Add {activity.name} to itinerary",
                    ),
                )
            )
        if score.budget_score == 0:
            warnings.append(
                _issue(
                    PlanningReasonCode.BUDGET_CONFLICT,
                    [activity.id],
                    f"Review budget for {activity.name}",
                )
            )
            actions_with_priority.append(
                (
                    40,
                    str(activity.id),
                    _action(
                        PlanningActionType.REVIEW_BUDGET,
                        PlanningReasonCode.BUDGET_CONFLICT,
                        [activity.id],
                        f"Review budget for {activity.name}",
                    ),
                )
            )
        if score.vote_score <= LOW_SUPPORT_SCORE and activity.id in itinerary_activity_ids:
            warnings.append(
                _issue(
                    PlanningReasonCode.LIMITED_VOTE_SIGNAL,
                    [activity.id],
                    f"Review votes for {activity.name}",
                )
            )
            actions_with_priority.append(
                (
                    50,
                    str(activity.id),
                    _action(
                        PlanningActionType.REVIEW_VOTES,
                        PlanningReasonCode.LIMITED_VOTE_SIGNAL,
                        [activity.id],
                        f"Review votes for {activity.name}",
                    ),
                )
            )

    active_expense_total = sum(
        expense.amount_cents for expense in state.expenses if expense.status == "active"
    )
    if plan.budget_cents is not None and active_expense_total > plan.budget_cents:
        warnings.append(
            _issue(
                PlanningReasonCode.BUDGET_CONFLICT,
                [plan.id],
                "Recorded expenses exceed the plan budget",
            )
        )
        actions_with_priority.append(
            (
                40,
                str(plan.id),
                _action(
                    PlanningActionType.REVIEW_BUDGET,
                    PlanningReasonCode.BUDGET_CONFLICT,
                    [plan.id],
                    "Review recorded expenses against the budget",
                ),
            )
        )

    open_date_suggestions = [row for row in state.date_suggestions if row.status == "open"]
    open_plan_suggestions = [row for row in state.plan_suggestions if row.status == "open"]
    for suggestion in sorted(open_date_suggestions, key=lambda row: str(row.id)):
        warnings.append(
            _issue(
                PlanningReasonCode.UNRESOLVED_SUGGESTION,
                [suggestion.id],
                "Review an open date suggestion",
            )
        )
        actions_with_priority.append(
            (
                50,
                str(suggestion.id),
                _action(
                    PlanningActionType.REVIEW_DATES,
                    PlanningReasonCode.UNRESOLVED_SUGGESTION,
                    [suggestion.id],
                    "Review date suggestion",
                ),
            )
        )
    for suggestion in sorted(open_plan_suggestions, key=lambda row: str(row.id)):
        warnings.append(
            _issue(
                PlanningReasonCode.UNRESOLVED_SUGGESTION,
                [suggestion.id],
                "Review an open plan suggestion",
            )
        )
        actions_with_priority.append(
            (
                50,
                str(suggestion.id),
                _action(
                    PlanningActionType.REVIEW_SUGGESTIONS,
                    PlanningReasonCode.UNRESOLVED_SUGGESTION,
                    [suggestion.id],
                    "Review plan suggestion",
                ),
            )
        )

    if blockers:
        overall_status = PlanningOverallStatus.NEEDS_ATTENTION
        readiness_state = PlanningReadinessState.NOT_READY
    else:
        overall_status = PlanningOverallStatus.READY
        readiness_state = PlanningReadinessState.READY
        actions_with_priority.append(
            (
                90,
                str(plan.id),
                _action(
                    PlanningActionType.FINALIZE_PLAN,
                    PlanningReasonCode.READY_TO_FINALIZE,
                    [plan.id],
                    "Plan appears ready to finalize",
                ),
            )
        )

    return PlanningStatusResponse(
        overall_status=overall_status,
        readiness_state=readiness_state,
        plan_version=plan.version,
        planning_version=plan.planning_version,
        blockers=sorted(blockers, key=lambda item: (item.reason_code, str(item.entity_ids[0]))),
        warnings=sorted(warnings, key=lambda item: (item.reason_code, str(item.entity_ids[0]))),
        suggested_actions=[
            item
            for _, _, item in sorted(
                actions_with_priority, key=lambda row: (row[0], row[1], row[2].action_type)
            )
        ],
    )


async def read_planning_status(session: AsyncSession, plan_id: UUID) -> PlanningStatusResponse:
    """Return fresh guidance, retrying if an authoritative counter changed during the read."""
    for _ in range(2):
        state = await _load_state(session, plan_id)
        if state is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail={"error": "plan_not_found"}
            )
        result = _build_status(state)
        counters = (
            await session.execute(
                select(Plan.version, Plan.planning_version).where(Plan.id == plan_id)
            )
        ).one_or_none()
        if counters is not None and tuple(counters) == (
            result.plan_version,
            result.planning_version,
        ):
            return result
        # A rollback ends the read transaction before the retry. This matters
        # for deployments using repeatable-read isolation: the next attempt
        # must observe a fresh authoritative snapshot.
        await session.rollback()
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT, detail={"error": "planning_status_stale"}
    )
