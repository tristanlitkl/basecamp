"""Activity routes."""

from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_plan_member, require_plan_owner
from app.db.base import get_session
from app.models.activity import Activity
from app.models.plan import PlanMember
from app.models.user import User
from app.models.vote import ActivityVote

router = APIRouter(tags=["activities"])


class ActivityCreate(BaseModel):
    name: str = Field(min_length=1, max_length=180)
    description: str | None = None
    address: str | None = Field(default=None, max_length=255)
    lat: Decimal | None = None
    lng: Decimal | None = None
    estimated_cost_cents: int | None = Field(default=None, ge=0)
    estimated_duration_minutes: int | None = Field(default=None, ge=0)
    tags: list[str] = Field(default_factory=list)
    notes: str | None = None


class ActivityResponse(BaseModel):
    id: UUID
    plan_id: UUID
    name: str


class VoteRequest(BaseModel):
    vote: str = Field(pattern="^(yes|no|maybe)$")


class VoteResponse(BaseModel):
    activity_id: UUID
    vote: str


async def ensure_activity_in_plan(
    session: AsyncSession,
    plan_id: UUID,
    activity_id: UUID,
) -> Activity:
    result = await session.execute(
        select(Activity).where(Activity.id == activity_id, Activity.plan_id == plan_id)
    )
    activity = result.scalar_one_or_none()
    if activity is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"error": "activity_not_found"})
    return activity


@router.post("/plans/{plan_id}/activities", response_model=ActivityResponse, status_code=status.HTTP_201_CREATED)
async def create_activity(
    plan_id: UUID,
    payload: ActivityCreate,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> ActivityResponse:
    activity = Activity(
        plan_id=membership.plan_id,
        name=payload.name,
        description=payload.description,
        address=payload.address,
        location_name=payload.address,
        lat=payload.lat,
        lng=payload.lng,
        estimated_cost_cents=payload.estimated_cost_cents,
        estimated_duration_minutes=payload.estimated_duration_minutes,
        tags=payload.tags,
        notes=payload.notes,
        created_by_user_id=user.id,
    )
    session.add(activity)
    await session.commit()
    await session.refresh(activity)
    return ActivityResponse(id=activity.id, plan_id=activity.plan_id, name=activity.name)


@router.delete("/plans/{plan_id}/activities/{activity_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_activity(
    plan_id: UUID,
    activity_id: UUID,
    owner_membership: PlanMember = Depends(require_plan_owner),
    session: AsyncSession = Depends(get_session),
) -> None:
    await ensure_activity_in_plan(session, plan_id, activity_id)
    if owner_membership.plan_id != plan_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={"error": "owner_role_required"})

    await session.execute(delete(ActivityVote).where(ActivityVote.activity_id == activity_id))
    await session.execute(delete(Activity).where(Activity.id == activity_id, Activity.plan_id == plan_id))
    await session.commit()


@router.put("/plans/{plan_id}/activities/{activity_id}/vote", response_model=VoteResponse)
async def vote_activity(
    plan_id: UUID,
    activity_id: UUID,
    payload: VoteRequest,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> VoteResponse:
    if membership.plan_id != plan_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "plan_membership_required"},
        )
    await ensure_activity_in_plan(session, plan_id, activity_id)

    statement = (
        insert(ActivityVote)
        .values(activity_id=activity_id, user_id=user.id, vote=payload.vote)
        .on_conflict_do_update(
            constraint="uq_activity_votes_activity_user",
            set_={"vote": payload.vote},
        )
    )
    await session.execute(statement)
    await session.commit()
    return VoteResponse(activity_id=activity_id, vote=payload.vote)
