"""Plan routes."""

from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_plan_member
from app.db.base import get_session
from app.models.activity import Activity
from app.models.event import PlanEvent
from app.models.expense import Expense, ExpenseSplit
from app.models.itinerary import ItineraryItem
from app.models.ledger import LedgerEntry
from app.models.plan import Plan, PlanMember
from app.models.user import User
from app.models.vote import ActivityVote
from app.services.event_service import append_plan_event

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


class ResyncSnapshot(BaseModel):
    plan: dict[str, Any]
    members: list[dict[str, Any]]
    activities: list[dict[str, Any]]
    activity_scores: dict[str, dict[str, int]]
    itinerary_items: list[dict[str, Any]]
    votes: list[dict[str, Any]]
    expenses: list[dict[str, Any]]
    expense_splits: list[dict[str, Any]]
    ledger_entries: list[dict[str, Any]]
    latest_plan_events: list[dict[str, Any]]
    server_version: int


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


def scalar(value: Any) -> Any:
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    return value


def plan_dict(plan: Plan, role: str) -> dict[str, Any]:
    return {key: scalar(value) for key, value in serialize_plan(plan, role).model_dump().items()}


def activity_dict(activity: Activity) -> dict[str, Any]:
    return {
        "id": str(activity.id),
        "plan_id": str(activity.plan_id),
        "name": activity.name,
        "description": activity.description,
        "address": activity.address,
        "location_name": activity.location_name,
        "lat": scalar(activity.lat),
        "lng": scalar(activity.lng),
        "estimated_cost_cents": activity.estimated_cost_cents,
        "estimated_duration_minutes": activity.estimated_duration_minutes,
        "tags": activity.tags or [],
        "notes": activity.notes,
        "created_by_user_id": str(activity.created_by_user_id),
        "created_at": scalar(activity.created_at),
        "updated_at": scalar(activity.updated_at),
    }


def vote_dict(vote: ActivityVote) -> dict[str, Any]:
    return {
        "id": str(vote.id),
        "activity_id": str(vote.activity_id),
        "user_id": str(vote.user_id),
        "vote": vote.vote,
        "created_at": scalar(vote.created_at),
        "updated_at": scalar(vote.updated_at),
    }


def event_dict(event: PlanEvent) -> dict[str, Any]:
    return {
        "id": str(event.id),
        "plan_id": str(event.plan_id),
        "actor_id": str(event.actor_id) if event.actor_id else None,
        "event_type": event.event_type,
        "payload_json": event.payload_json,
        "resource_type": event.resource_type,
        "resource_id": str(event.resource_id) if event.resource_id else None,
        "resource_version_after": event.resource_version_after,
        "client_operation_id": event.client_operation_id,
        "created_at": scalar(event.created_at),
    }


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
    await append_plan_event(
        session,
        plan_id=plan.id,
        actor_id=user.id,
        event_type="plan.created",
        resource_type="plan",
        resource_id=plan.id,
        resource_version_after=plan.version,
        payload_json={"title": plan.title},
    )
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


@router.get("/plans/{plan_id}/resync", response_model=ResyncSnapshot)
async def resync_plan(
    plan_id: UUID,
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> ResyncSnapshot:
    result = await session.execute(select(Plan).where(Plan.id == plan_id))
    plan = result.scalar_one_or_none()
    if plan is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"error": "plan_not_found"})

    member_rows = (
        await session.execute(
            select(PlanMember, User)
            .join(User, User.id == PlanMember.user_id)
            .where(PlanMember.plan_id == plan_id)
            .order_by(PlanMember.created_at.asc())
        )
    ).all()
    activities = (
        await session.execute(
            select(Activity).where(Activity.plan_id == plan_id).order_by(Activity.created_at.asc())
        )
    ).scalars().all()
    activity_ids = [activity.id for activity in activities]

    votes = []
    if activity_ids:
        votes = (
            await session.execute(
                select(ActivityVote)
                .where(ActivityVote.activity_id.in_(activity_ids))
                .order_by(ActivityVote.created_at.asc())
            )
        ).scalars().all()

    itinerary_items = (
        await session.execute(
            select(ItineraryItem).where(ItineraryItem.plan_id == plan_id).order_by(ItineraryItem.created_at.asc())
        )
    ).scalars().all()
    expenses = (
        await session.execute(select(Expense).where(Expense.plan_id == plan_id).order_by(Expense.created_at.asc()))
    ).scalars().all()
    expense_ids = [expense.id for expense in expenses]
    expense_splits = []
    if expense_ids:
        expense_splits = (
            await session.execute(
                select(ExpenseSplit)
                .where(ExpenseSplit.expense_id.in_(expense_ids))
                .order_by(ExpenseSplit.created_at.asc())
            )
        ).scalars().all()
    ledger_entries = (
        await session.execute(
            select(LedgerEntry).where(LedgerEntry.plan_id == plan_id).order_by(LedgerEntry.created_at.asc())
        )
    ).scalars().all()
    events = (
        await session.execute(
            select(PlanEvent)
            .where(PlanEvent.plan_id == plan_id)
            .order_by(PlanEvent.created_at.desc())
            .limit(50)
        )
    ).scalars().all()

    activity_scores = {
        str(activity.id): {
            "yes": sum(1 for vote in votes if vote.activity_id == activity.id and vote.vote == "yes"),
            "maybe": sum(1 for vote in votes if vote.activity_id == activity.id and vote.vote == "maybe"),
            "no": sum(1 for vote in votes if vote.activity_id == activity.id and vote.vote == "no"),
        }
        for activity in activities
    }

    return ResyncSnapshot(
        plan=plan_dict(plan, membership.role),
        members=[
            {
                "id": str(member.id),
                "plan_id": str(member.plan_id),
                "user_id": str(member.user_id),
                "role": member.role,
                "email": user.email,
                "display_name": user.display_name,
                "created_at": scalar(member.created_at),
            }
            for member, user in member_rows
        ],
        activities=[activity_dict(activity) for activity in activities],
        activity_scores=activity_scores,
        itinerary_items=[
            {
                "id": str(item.id),
                "plan_id": str(item.plan_id),
                "activity_id": str(item.activity_id) if item.activity_id else None,
                "title": item.title,
                "position_key": scalar(item.position_key),
                "starts_at": scalar(item.starts_at),
                "ends_at": scalar(item.ends_at),
                "created_at": scalar(item.created_at),
                "updated_at": scalar(item.updated_at),
            }
            for item in itinerary_items
        ],
        votes=[vote_dict(vote) for vote in votes],
        expenses=[
            {
                "id": str(expense.id),
                "plan_id": str(expense.plan_id),
                "paid_by_user_id": str(expense.paid_by_user_id),
                "description": expense.description,
                "amount_cents": expense.amount_cents,
                "created_at": scalar(expense.created_at),
                "updated_at": scalar(expense.updated_at),
            }
            for expense in expenses
        ],
        expense_splits=[
            {
                "id": str(split.id),
                "expense_id": str(split.expense_id),
                "user_id": str(split.user_id),
                "amount_cents": split.amount_cents,
                "status": split.status,
                "created_at": scalar(split.created_at),
                "updated_at": scalar(split.updated_at),
            }
            for split in expense_splits
        ],
        ledger_entries=[
            {
                "id": str(entry.id),
                "plan_id": str(entry.plan_id),
                "expense_id": str(entry.expense_id) if entry.expense_id else None,
                "from_user_id": str(entry.from_user_id) if entry.from_user_id else None,
                "to_user_id": str(entry.to_user_id) if entry.to_user_id else None,
                "amount_cents": entry.amount_cents,
                "memo": entry.memo,
                "reversed_by_entry_id": str(entry.reversed_by_entry_id) if entry.reversed_by_entry_id else None,
                "created_at": scalar(entry.created_at),
            }
            for entry in ledger_entries
        ],
        latest_plan_events=[event_dict(event) for event in events],
        server_version=plan.version,
    )
