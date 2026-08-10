"""Deterministic, explainable activity recommendation scoring.

All component scores are integer points in ``0..1000``.  The authoritative
formula is ``(vote * 500 + budget * 250 + schedule * 250) // 1000``.  The
project has no stored member-preference signal, so ``preference_score`` is
persisted as neutral 500 with a zero weight instead of fabricating one.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import func

from app.models.activity import Activity
from app.models.itinerary import ItineraryItem
from app.models.plan import Plan, PlanDateAvailability, PlanMember
from app.models.recommendation import ActivityScore
from app.models.vote import ActivityVote

SCORE_VERSION = 1
NEUTRAL_SCORE = 500
MAX_SCORE = 1000
VOTE_WEIGHT = 500
BUDGET_WEIGHT = 250
SCHEDULE_WEIGHT = 250
PREFERENCE_WEIGHT = 0


@dataclass(frozen=True)
class ComputedScore:
    activity_id: UUID
    plan_id: UUID
    total_score: int
    vote_score: int
    budget_score: int
    preference_score: int
    schedule_fit_score: int
    reasons: list[str]
    is_neutral: bool


def _vote_score(votes: Iterable[str], member_count: int) -> tuple[int, str, bool]:
    values = list(votes)
    if not values or member_count <= 0:
        return NEUTRAL_SCORE, "Limited voting data", True
    yes = sum(vote == "yes" for vote in values)
    maybe = sum(vote == "maybe" for vote in values)
    no = sum(vote == "no" for vote in values)
    # Yes is +2, Maybe is +1, No is -2.  Scaling against all current
    # members makes score bounds independent of group size.
    raw = 2 * yes + maybe - 2 * no
    score = max(0, min(MAX_SCORE, ((raw + 2 * member_count) * MAX_SCORE) // (4 * member_count)))
    reason = (
        "Strong group support"
        if score >= 750
        else "Group concerns"
        if score <= 250
        else "Mixed group support"
    )
    return score, reason, False


def _budget_score(cost_cents: int | None, budget_cents: int | None) -> tuple[int, str, bool]:
    if cost_cents is None or budget_cents is None:
        return NEUTRAL_SCORE, "Budget details unavailable", True
    if cost_cents <= budget_cents:
        return MAX_SCORE, "Fits the current budget", False
    return 0, "Over the current budget", False


def _schedule_score(
    scheduled_on: date | None,
    plan: Plan,
    member_ids: list[UUID],
    availability_by_user: dict[UUID, str],
) -> tuple[int, str, bool]:
    if scheduled_on is None:
        return NEUTRAL_SCORE, "Schedule details unavailable", True
    start = plan.starts_on.date() if plan.starts_on else None
    end = plan.ends_on.date() if plan.ends_on else None
    if (start is not None and scheduled_on < start) or (end is not None and scheduled_on > end):
        return 0, "Scheduled outside the current date window", False
    if not availability_by_user:
        return NEUTRAL_SCORE, "Schedule details unavailable", True
    status_points = {"available": MAX_SCORE, "maybe": NEUTRAL_SCORE, "unavailable": 0}
    # A member with no response stays neutral; absence is never inferred as unavailable.
    score = sum(
        status_points.get(availability_by_user.get(user_id, "maybe"), NEUTRAL_SCORE)
        for user_id in member_ids
    ) // max(1, len(member_ids))
    reason = (
        "Matches available dates"
        if score >= 750
        else "Date availability is limited"
        if score <= 250
        else "Schedule availability is mixed"
    )
    return score, reason, False


async def compute_plan_scores(session: AsyncSession, plan_id: UUID) -> list[ComputedScore]:
    """Compute scores from current authoritative rows without writing or mutating versions."""
    plan = (await session.execute(select(Plan).where(Plan.id == plan_id))).scalar_one_or_none()
    if plan is None:
        return []
    activities = (
        (await session.execute(select(Activity).where(Activity.plan_id == plan_id))).scalars().all()
    )
    members = (
        (await session.execute(select(PlanMember.user_id).where(PlanMember.plan_id == plan_id)))
        .scalars()
        .all()
    )
    member_ids = sorted(members, key=str)
    member_set = set(member_ids)
    activity_ids = [activity.id for activity in activities]
    votes = (
        []
        if not activity_ids
        else (
            await session.execute(
                select(ActivityVote).where(ActivityVote.activity_id.in_(activity_ids))
            )
        )
        .scalars()
        .all()
    )
    votes_by_activity: dict[UUID, list[str]] = {}
    for vote in votes:
        if vote.user_id in member_set:
            votes_by_activity.setdefault(vote.activity_id, []).append(vote.vote)
    itinerary = (
        (
            await session.execute(
                select(ItineraryItem)
                .where(ItineraryItem.plan_id == plan_id)
                .order_by(ItineraryItem.created_at.asc(), ItineraryItem.id.asc())
            )
        )
        .scalars()
        .all()
    )
    scheduled_dates: dict[UUID, date] = {}
    for item in itinerary:
        if (
            item.activity_id is not None
            and item.activity_id not in scheduled_dates
            and item.starts_at is not None
        ):
            scheduled_dates[item.activity_id] = item.starts_at.date()
    availability = (
        (
            await session.execute(
                select(PlanDateAvailability).where(PlanDateAvailability.plan_id == plan_id)
            )
        )
        .scalars()
        .all()
    )
    availability_by_date: dict[date, dict[UUID, str]] = {}
    for row in availability:
        if row.user_id in member_set:
            availability_by_date.setdefault(row.date, {})[row.user_id] = row.status

    results: list[ComputedScore] = []
    for activity in activities:
        vote_score, vote_reason, vote_neutral = _vote_score(
            votes_by_activity.get(activity.id, []), len(member_ids)
        )
        budget_score, budget_reason, budget_neutral = _budget_score(
            activity.estimated_cost_cents, plan.budget_cents
        )
        scheduled_on = scheduled_dates.get(activity.id)
        schedule_score, schedule_reason, schedule_neutral = _schedule_score(
            scheduled_on,
            plan,
            member_ids,
            availability_by_date.get(scheduled_on, {}) if scheduled_on else {},
        )
        preference_score = NEUTRAL_SCORE
        total = (
            vote_score * VOTE_WEIGHT
            + budget_score * BUDGET_WEIGHT
            + schedule_score * SCHEDULE_WEIGHT
        ) // MAX_SCORE
        results.append(
            ComputedScore(
                activity_id=activity.id,
                plan_id=plan_id,
                total_score=total,
                vote_score=vote_score,
                budget_score=budget_score,
                preference_score=preference_score,
                schedule_fit_score=schedule_score,
                reasons=[vote_reason, budget_reason, schedule_reason, "No stored preferences yet"],
                is_neutral=vote_neutral and budget_neutral and schedule_neutral,
            )
        )
    return results


async def recompute_plan_scores(session: AsyncSession, plan_id: UUID) -> list[ComputedScore]:
    """Atomically upsert derived rows in the caller's authoritative mutation transaction."""
    computed = await compute_plan_scores(session, plan_id)
    for score in computed:
        values = {
            "activity_id": score.activity_id,
            "plan_id": score.plan_id,
            "total_score": score.total_score,
            "vote_score": score.vote_score,
            "budget_score": score.budget_score,
            "preference_score": score.preference_score,
            "schedule_fit_score": score.schedule_fit_score,
            "reasons": score.reasons,
            "score_version": SCORE_VERSION,
        }
        statement = (
            insert(ActivityScore)
            .values(**values)
            .on_conflict_do_update(
                constraint="uq_activity_scores_activity",
                set_={
                    **{
                        key: value
                        for key, value in values.items()
                        if key not in {"activity_id", "plan_id"}
                    },
                    "updated_at": func.now(),
                },
            )
        )
        await session.execute(statement)
    return computed


def recommendation_dict(score: ActivityScore, activity: Activity) -> dict[str, object]:
    return {
        "activity_id": str(activity.id),
        "activity_name": activity.name,
        "total_score": score.total_score,
        "vote_score": score.vote_score,
        "budget_score": score.budget_score,
        "preference_score": score.preference_score,
        "schedule_fit_score": score.schedule_fit_score,
        "reasons": list(score.reasons),
        "score_version": score.score_version,
        "is_neutral": score.vote_score == NEUTRAL_SCORE
        and score.budget_score == NEUTRAL_SCORE
        and score.schedule_fit_score == NEUTRAL_SCORE,
    }
