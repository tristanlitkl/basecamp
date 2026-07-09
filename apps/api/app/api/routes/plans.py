"""Plan routes."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_plan_member
from app.db.base import get_session
from app.models.activity import Activity
from app.models.plan import Plan, PlanMember
from app.models.user import User
from app.models.vote import ActivityVote

router = APIRouter(tags=["plans"])


class PlanCreate(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    description: str | None = None
    budget_cents: int | None = Field(default=None, ge=0)


class PlanSummary(BaseModel):
    id: UUID
    title: str
    description: str | None
    budget_cents: int | None
    role: str
    version: int
    planning_version: int


class ActivitySummary(BaseModel):
    id: UUID
    name: str
    description: str | None
    address: str | None
    location_name: str | None
    lat: str | None
    lng: str | None
    estimated_cost_cents: int | None
    estimated_duration_minutes: int | None
    tags: list[str]
    notes: str | None
    vote: str | None
    yes_votes: int
    no_votes: int
    maybe_votes: int


class PlanDetail(PlanSummary):
    activities: list[ActivitySummary]


def serialize_plan(plan: Plan, role: str) -> PlanSummary:
    return PlanSummary(
        id=plan.id,
        title=plan.title,
        description=plan.description,
        budget_cents=plan.budget_cents,
        role=role,
        version=plan.version,
        planning_version=plan.planning_version,
    )


@router.get("/plans", response_model=list[PlanSummary])
async def list_plans(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> list[PlanSummary]:
    result = await session.execute(
        select(Plan, PlanMember.role)
        .join(PlanMember, PlanMember.plan_id == Plan.id)
        .where(PlanMember.user_id == user.id)
        .order_by(Plan.created_at.desc())
    )
    return [serialize_plan(plan, role) for plan, role in result.all()]


@router.post("/plans", response_model=PlanSummary, status_code=status.HTTP_201_CREATED)
async def create_plan(
    payload: PlanCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> PlanSummary:
    plan = Plan(
        owner_id=user.id,
        title=payload.title,
        description=payload.description,
        budget_cents=payload.budget_cents,
    )
    session.add(plan)
    await session.flush()

    membership = PlanMember(plan_id=plan.id, user_id=user.id, role="owner")
    session.add(membership)
    await session.commit()
    await session.refresh(plan)
    return serialize_plan(plan, "owner")


@router.get("/plans/{plan_id}", response_model=PlanDetail)
async def get_plan(
    plan_id: UUID,
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> PlanDetail:
    result = await session.execute(select(Plan).where(Plan.id == plan_id))
    plan = result.scalar_one_or_none()
    if plan is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"error": "plan_not_found"})

    activity_result = await session.execute(
        select(Activity).where(Activity.plan_id == plan_id).order_by(Activity.created_at.asc())
    )
    activities = activity_result.scalars().all()

    vote_result = await session.execute(
        select(ActivityVote).join(Activity, Activity.id == ActivityVote.activity_id).where(Activity.plan_id == plan_id)
    )
    votes_by_activity: dict[UUID, list[ActivityVote]] = {}
    for vote in vote_result.scalars().all():
        votes_by_activity.setdefault(vote.activity_id, []).append(vote)

    summaries: list[ActivitySummary] = []
    for activity in activities:
        votes = votes_by_activity.get(activity.id, [])
        current_vote = next((vote.vote for vote in votes if vote.user_id == membership.user_id), None)
        summaries.append(
            ActivitySummary(
                id=activity.id,
                name=activity.name,
                description=activity.description,
                address=activity.address,
                location_name=activity.location_name,
                lat=str(activity.lat) if activity.lat is not None else None,
                lng=str(activity.lng) if activity.lng is not None else None,
                estimated_cost_cents=activity.estimated_cost_cents,
                estimated_duration_minutes=activity.estimated_duration_minutes,
                tags=activity.tags or [],
                notes=activity.notes,
                vote=current_vote,
                yes_votes=sum(1 for vote in votes if vote.vote == "yes"),
                no_votes=sum(1 for vote in votes if vote.vote == "no"),
                maybe_votes=sum(1 for vote in votes if vote.vote == "maybe"),
            )
        )

    base = serialize_plan(plan, membership.role)
    return PlanDetail(**base.model_dump(), activities=summaries)
