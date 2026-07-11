"""Activity routes."""

from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_plan_member, require_plan_owner
from app.db.base import get_session
from app.models.activity import Activity
from app.models.plan import PlanMember
from app.models.user import User
from app.models.vote import ActivityVote
from app.services.event_service import append_plan_event
from app.services.idempotency_service import claim_operation, complete_operation
from app.services.planning_service import bump_planning_version, require_mutable_plan

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
    client_operation_id: str | None = Field(default=None, max_length=120)


class ActivityPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=180)
    description: str | None = None
    address: str | None = Field(default=None, max_length=255)
    lat: Decimal | None = None
    lng: Decimal | None = None
    estimated_cost_cents: int | None = Field(default=None, ge=0)
    estimated_duration_minutes: int | None = Field(default=None, ge=0)
    tags: list[str] | None = None
    notes: str | None = None
    expected_version: int = Field(ge=1)


class ActivityResponse(BaseModel):
    id: UUID
    plan_id: UUID
    name: str
    version: int


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
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail={"error": "activity_not_found"}
        )
    return activity


@router.post(
    "/plans/{plan_id}/activities",
    response_model=ActivityResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_activity(
    plan_id: UUID,
    payload: ActivityCreate,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> ActivityResponse:
    await require_mutable_plan(session, plan_id)
    claim = await claim_operation(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        client_operation_id=payload.client_operation_id,
        payload=payload.model_dump(exclude={"client_operation_id"}, mode="json"),
        resource_type="activity",
    )
    if isinstance(claim, dict):
        return ActivityResponse(**claim)
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
    await session.flush()
    await bump_planning_version(session, plan_id)
    body = {
        "id": activity.id,
        "plan_id": activity.plan_id,
        "name": activity.name,
        "version": activity.version,
    }
    await complete_operation(
        session, claim, activity.id, body, response_status=status.HTTP_201_CREATED
    )
    await append_plan_event(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        event_type="activity.created",
        resource_type="activity",
        resource_id=activity.id,
        resource_version_after=activity.version,
        client_operation_id=payload.client_operation_id,
        payload_json={"name": activity.name},
    )
    await session.commit()
    await session.refresh(activity)
    return ActivityResponse(**body)


@router.patch("/plans/{plan_id}/activities/{activity_id}", response_model=ActivityResponse)
async def patch_activity(
    plan_id: UUID,
    activity_id: UUID,
    payload: ActivityPatch,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> ActivityResponse:
    await require_mutable_plan(session, plan_id)
    changes = payload.model_dump(exclude={"expected_version"}, exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=422, detail={"error": "no_changes"})
    if "address" in changes:
        changes["location_name"] = changes["address"]
    result = await session.execute(
        update(Activity)
        .where(
            Activity.id == activity_id,
            Activity.plan_id == plan_id,
            Activity.version == payload.expected_version,
        )
        .values(**changes, version=Activity.version + 1, updated_at=func.now())
        .returning(Activity)
    )
    activity = result.scalar_one_or_none()
    if activity is None:
        raise HTTPException(status_code=409, detail={"error": "version_conflict"})
    await bump_planning_version(session, plan_id)
    await append_plan_event(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        event_type="activity.updated",
        resource_type="activity",
        resource_id=activity.id,
        resource_version_after=activity.version,
    )
    await session.commit()
    return ActivityResponse(
        id=activity.id, plan_id=activity.plan_id, name=activity.name, version=activity.version
    )


@router.delete("/plans/{plan_id}/activities/{activity_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_activity(
    plan_id: UUID,
    activity_id: UUID,
    expected_version: int = Query(ge=1),
    owner_membership: PlanMember = Depends(require_plan_owner),
    session: AsyncSession = Depends(get_session),
) -> None:
    await require_mutable_plan(session, plan_id)
    if owner_membership.plan_id != plan_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail={"error": "owner_role_required"}
        )

    # Deletion remains conditional too: a stale version must never erase a newer edit.
    await session.execute(delete(ActivityVote).where(ActivityVote.activity_id == activity_id))
    result = await session.execute(
        delete(Activity)
        .where(
            Activity.id == activity_id,
            Activity.plan_id == plan_id,
            Activity.version == expected_version,
        )
        .returning(Activity.id)
    )
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=409, detail={"error": "version_conflict"})
    await bump_planning_version(session, plan_id)
    await append_plan_event(
        session,
        plan_id=plan_id,
        actor_id=owner_membership.user_id,
        event_type="activity.deleted",
        resource_type="activity",
        resource_id=activity_id,
        resource_version_after=None,
    )
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
    await require_mutable_plan(session, plan_id)
    await ensure_activity_in_plan(session, plan_id, activity_id)

    statement = (
        insert(ActivityVote)
        .values(activity_id=activity_id, user_id=user.id, vote=payload.vote)
        .on_conflict_do_update(
            constraint="uq_activity_votes_activity_user",
            set_={"vote": payload.vote, "updated_at": func.now()},
        )
    )
    await session.execute(statement)
    await append_plan_event(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        event_type="activity.vote_updated",
        resource_type="activity_vote",
        resource_id=activity_id,
        resource_version_after=None,
        payload_json={"vote": payload.vote},
    )
    await session.commit()
    return VoteResponse(activity_id=activity_id, vote=payload.vote)
