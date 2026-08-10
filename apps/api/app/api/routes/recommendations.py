"""Authenticated plan-scoped deterministic recommendation reads."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_plan_member
from app.db.base import get_session
from app.models.activity import Activity
from app.models.plan import Plan, PlanMember
from app.models.recommendation import ActivityScore
from app.services.recommendation_service import (
    SCORE_VERSION,
    recommendation_dict,
    recompute_plan_scores,
)

router = APIRouter(tags=["recommendations"])


class RecommendationResponse(BaseModel):
    activity_id: UUID
    activity_name: str
    rank: int
    total_score: int
    vote_score: int
    budget_score: int
    preference_score: int
    schedule_fit_score: int
    reasons: list[str]
    score_version: int
    is_neutral: bool


@router.get("/plans/{plan_id}/recommendations", response_model=list[RecommendationResponse])
async def get_recommendations(
    plan_id: UUID,
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> list[RecommendationResponse]:
    if membership.plan_id != plan_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail={"error": "plan_membership_required"}
        )
    plan = (await session.execute(select(Plan.id).where(Plan.id == plan_id))).scalar_one_or_none()
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail={"error": "plan_not_found"}
        )
    activities = (
        (await session.execute(select(Activity).where(Activity.plan_id == plan_id))).scalars().all()
    )
    score_rows = (
        (await session.execute(select(ActivityScore).where(ActivityScore.plan_id == plan_id)))
        .scalars()
        .all()
    )
    if len(score_rows) != len(activities) or any(
        row.score_version != SCORE_VERSION for row in score_rows
    ):
        await recompute_plan_scores(session, plan_id)
        await session.commit()
        score_rows = (
            (await session.execute(select(ActivityScore).where(ActivityScore.plan_id == plan_id)))
            .scalars()
            .all()
        )
    scores_by_activity = {score.activity_id: score for score in score_rows}
    ranked = sorted(
        (activity for activity in activities if activity.id in scores_by_activity),
        key=lambda activity: (
            -scores_by_activity[activity.id].total_score,
            activity.created_at,
            str(activity.id),
        ),
    )
    return [
        RecommendationResponse(
            rank=index, **recommendation_dict(scores_by_activity[activity.id], activity)
        )
        for index, activity in enumerate(ranked, start=1)
    ]
