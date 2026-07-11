"""Plan routes."""

from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_plan_member, require_plan_owner
from app.db.base import get_session
from app.models.activity import Activity
from app.models.coordination import ActivityComment, ActivitySuggestion
from app.models.event import PlanEvent
from app.models.expense import Expense, ExpenseSplit
from app.models.itinerary import ItineraryItem
from app.models.ledger import LedgerEntry
from app.models.plan import Plan, PlanDateAvailability, PlanDateSuggestion, PlanMember
from app.models.user import User
from app.models.vote import ActivityVote
from app.services.event_service import append_plan_event
from app.services.planning_service import bump_planning_version, require_mutable_plan

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
    status: str
    starts_on: datetime | None
    ends_on: datetime | None
    max_drive_minutes: int | None
    vote_visibility: str


class PlanPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = None
    budget_cents: int | None = Field(default=None, ge=0)
    starts_on: datetime | None = None
    ends_on: datetime | None = None
    max_drive_minutes: int | None = Field(default=None, ge=0)
    expected_version: int = Field(ge=1)


class LifecycleRequest(BaseModel):
    expected_version: int = Field(ge=1)


class ActivitySummary(BaseModel):
    id: UUID
    version: int
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
    current_user_id: str
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
    activity_comments: list[dict[str, Any]]
    activity_suggestions: list[dict[str, Any]]
    date_availability: list[dict[str, Any]]
    date_suggestions: list[dict[str, Any]]
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
        status=plan.status,
        starts_on=plan.starts_on,
        ends_on=plan.ends_on,
        max_drive_minutes=plan.max_drive_minutes,
        vote_visibility=plan.vote_visibility,
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
        "version": activity.version,
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


@router.patch("/plans/{plan_id}", response_model=PlanSummary)
async def patch_plan(
    plan_id: UUID,
    payload: PlanPatch,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_owner),
    session: AsyncSession = Depends(get_session),
) -> PlanSummary:
    await require_mutable_plan(session, plan_id)
    changes = payload.model_dump(exclude={"expected_version"}, exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=422, detail={"error": "no_changes"})
    result = await session.execute(
        update(Plan)
        .where(
            Plan.id == plan_id, Plan.version == payload.expected_version, Plan.status != "finalized"
        )
        .values(**changes, version=Plan.version + 1, updated_at=func.now())
        .returning(Plan)
    )
    plan = result.scalar_one_or_none()
    if plan is None:
        raise HTTPException(status_code=409, detail={"error": "version_conflict"})
    if {"budget_cents", "starts_on", "ends_on", "max_drive_minutes"} & changes.keys():
        await bump_planning_version(session, plan_id)
        await session.refresh(plan)
    await append_plan_event(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        event_type="plan.updated",
        resource_type="plan",
        resource_id=plan_id,
        resource_version_after=plan.version,
    )
    await session.commit()
    return serialize_plan(plan, membership.role)


async def set_plan_lifecycle(
    plan_id: UUID,
    payload: LifecycleRequest,
    target_status: str,
    membership: PlanMember,
    session: AsyncSession,
) -> PlanSummary:
    result = await session.execute(
        update(Plan)
        .where(
            Plan.id == plan_id,
            Plan.version == payload.expected_version,
            Plan.status != target_status,
        )
        .values(
            status=target_status,
            version=Plan.version + 1,
            planning_version=Plan.planning_version + 1,
            updated_at=func.now(),
        )
        .returning(Plan)
    )
    plan = result.scalar_one_or_none()
    if plan is None:
        raise HTTPException(
            status_code=409, detail={"error": "version_conflict_or_invalid_lifecycle"}
        )
    await append_plan_event(
        session,
        plan_id=plan_id,
        actor_id=membership.user_id,
        event_type=f"plan.{target_status}",
        resource_type="plan",
        resource_id=plan_id,
        resource_version_after=plan.version,
    )
    await session.commit()
    return serialize_plan(plan, membership.role)


@router.post("/plans/{plan_id}/finalize", response_model=PlanSummary)
async def finalize_plan(
    plan_id: UUID,
    payload: LifecycleRequest,
    membership: PlanMember = Depends(require_plan_owner),
    session: AsyncSession = Depends(get_session),
) -> PlanSummary:
    return await set_plan_lifecycle(plan_id, payload, "finalized", membership, session)


@router.post("/plans/{plan_id}/unfinalize", response_model=PlanSummary)
async def unfinalize_plan(
    plan_id: UUID,
    payload: LifecycleRequest,
    membership: PlanMember = Depends(require_plan_owner),
    session: AsyncSession = Depends(get_session),
) -> PlanSummary:
    return await set_plan_lifecycle(plan_id, payload, "draft", membership, session)


@router.get("/plans/{plan_id}", response_model=PlanDetail)
async def get_plan(
    plan_id: UUID,
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> PlanDetail:
    result = await session.execute(select(Plan).where(Plan.id == plan_id))
    plan = result.scalar_one_or_none()
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail={"error": "plan_not_found"}
        )

    activity_result = await session.execute(
        select(Activity).where(Activity.plan_id == plan_id).order_by(Activity.created_at.asc())
    )
    activities = activity_result.scalars().all()

    vote_result = await session.execute(
        select(ActivityVote)
        .join(Activity, Activity.id == ActivityVote.activity_id)
        .where(Activity.plan_id == plan_id)
    )
    votes_by_activity: dict[UUID, list[ActivityVote]] = {}
    for vote in vote_result.scalars().all():
        votes_by_activity.setdefault(vote.activity_id, []).append(vote)

    summaries: list[ActivitySummary] = []
    for activity in activities:
        votes = votes_by_activity.get(activity.id, [])
        current_vote = next(
            (vote.vote for vote in votes if vote.user_id == membership.user_id), None
        )
        summaries.append(
            ActivitySummary(
                id=activity.id,
                version=activity.version,
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
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail={"error": "plan_not_found"}
        )

    member_rows = (
        await session.execute(
            select(PlanMember, User)
            .join(User, User.id == PlanMember.user_id)
            .where(PlanMember.plan_id == plan_id)
            .order_by(PlanMember.created_at.asc())
        )
    ).all()
    activities = (
        (
            await session.execute(
                select(Activity)
                .where(Activity.plan_id == plan_id)
                .order_by(Activity.created_at.asc())
            )
        )
        .scalars()
        .all()
    )
    activity_ids = [activity.id for activity in activities]

    votes = []
    if activity_ids:
        votes = (
            (
                await session.execute(
                    select(ActivityVote)
                    .where(ActivityVote.activity_id.in_(activity_ids))
                    .order_by(ActivityVote.created_at.asc())
                )
            )
            .scalars()
            .all()
        )

    itinerary_items = (
        (
            await session.execute(
                select(ItineraryItem)
                .where(ItineraryItem.plan_id == plan_id)
                .order_by(ItineraryItem.position_key.asc())
            )
        )
        .scalars()
        .all()
    )
    expenses = (
        (
            await session.execute(
                select(Expense).where(Expense.plan_id == plan_id).order_by(Expense.created_at.asc())
            )
        )
        .scalars()
        .all()
    )
    expense_ids = [expense.id for expense in expenses]
    expense_splits = []
    if expense_ids:
        expense_splits = (
            (
                await session.execute(
                    select(ExpenseSplit)
                    .where(ExpenseSplit.expense_id.in_(expense_ids))
                    .order_by(ExpenseSplit.created_at.asc())
                )
            )
            .scalars()
            .all()
        )
    ledger_entries = (
        (
            await session.execute(
                select(LedgerEntry)
                .where(LedgerEntry.plan_id == plan_id)
                .order_by(LedgerEntry.created_at.asc())
            )
        )
        .scalars()
        .all()
    )
    events = (
        (
            await session.execute(
                select(PlanEvent)
                .where(PlanEvent.plan_id == plan_id)
                .order_by(PlanEvent.created_at.desc())
                .limit(50)
            )
        )
        .scalars()
        .all()
    )
    comments = (
        await session.execute(
            select(ActivityComment, User)
            .join(User, User.id == ActivityComment.author_id)
            .where(ActivityComment.plan_id == plan_id)
            .order_by(ActivityComment.created_at.asc())
        )
    ).all()
    suggestions = (
        await session.execute(
            select(ActivitySuggestion, User)
            .join(User, User.id == ActivitySuggestion.author_id)
            .where(ActivitySuggestion.plan_id == plan_id)
            .order_by(ActivitySuggestion.created_at.asc())
        )
    ).all()
    availability_rows = (
        (
            await session.execute(
                select(PlanDateAvailability)
                .where(PlanDateAvailability.plan_id == plan_id)
                .order_by(PlanDateAvailability.date.asc())
            )
        )
        .scalars()
        .all()
    )
    date_suggestions = (
        await session.execute(
            select(PlanDateSuggestion, User)
            .join(User, User.id == PlanDateSuggestion.suggested_by_user_id)
            .where(PlanDateSuggestion.plan_id == plan_id)
            .order_by(PlanDateSuggestion.created_at.asc())
        )
    ).all()

    activity_scores = {
        str(activity.id): {
            "yes": sum(
                1 for vote in votes if vote.activity_id == activity.id and vote.vote == "yes"
            ),
            "maybe": sum(
                1 for vote in votes if vote.activity_id == activity.id and vote.vote == "maybe"
            ),
            "no": sum(1 for vote in votes if vote.activity_id == activity.id and vote.vote == "no"),
        }
        for activity in activities
    }

    return ResyncSnapshot(
        current_user_id=str(membership.user_id),
        plan=plan_dict(plan, membership.role),
        members=[
            {
                "id": str(member.id),
                "plan_id": str(member.plan_id),
                "user_id": str(member.user_id),
                "role": member.role,
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
                "version": item.version,
            }
            for item in itinerary_items
        ],
        votes=[
            vote_dict(vote)
            for vote in votes
            if plan.vote_visibility == "public" or vote.user_id == membership.user_id
        ],
        expenses=[
            {
                "id": str(expense.id),
                "plan_id": str(expense.plan_id),
                "paid_by_user_id": str(expense.paid_by_user_id),
                "description": expense.description,
                "amount_cents": expense.amount_cents,
                "created_at": scalar(expense.created_at),
                "updated_at": scalar(expense.updated_at),
                "status": expense.status,
                "version": expense.version,
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
                "reversed_by_entry_id": str(entry.reversed_by_entry_id)
                if entry.reversed_by_entry_id
                else None,
                "created_at": scalar(entry.created_at),
            }
            for entry in ledger_entries
        ],
        latest_plan_events=[
            event_dict(event)
            for event in events
            if plan.vote_visibility != "anonymous" or event.event_type != "activity.vote_updated"
        ],
        activity_comments=[
            {
                "id": str(comment.id),
                "plan_id": str(comment.plan_id),
                "activity_id": str(comment.activity_id),
                "author_id": str(comment.author_id),
                "author_display_name": author.display_name,
                "body": comment.body,
                "version": comment.version,
                "deleted_at": scalar(comment.deleted_at),
                "created_at": scalar(comment.created_at),
                "updated_at": scalar(comment.updated_at),
            }
            for comment, author in comments
        ],
        activity_suggestions=[
            {
                "id": str(suggestion.id),
                "activity_id": str(suggestion.activity_id),
                "author_id": str(suggestion.author_id),
                "author_display_name": author.display_name,
                "suggestion_type": suggestion.suggestion_type,
                "proposed_changes_json": suggestion.proposed_changes_json,
                "message": suggestion.message,
                "status": suggestion.status,
                "created_at": scalar(suggestion.created_at),
            }
            for suggestion, author in suggestions
        ],
        date_availability=[
            {
                "date": availability.date.isoformat(),
                "status": availability.status,
                "is_current_user": availability.user_id == membership.user_id,
            }
            for availability in availability_rows
        ],
        date_suggestions=[
            {
                "id": str(suggestion.id),
                "starts_on": suggestion.starts_on.isoformat(),
                "ends_on": suggestion.ends_on.isoformat(),
                "message": suggestion.message,
                "status": suggestion.status,
                "author_id": str(suggestion.suggested_by_user_id),
                "author_display_name": author.display_name,
            }
            for suggestion, author in date_suggestions
        ],
        server_version=plan.version,
    )
