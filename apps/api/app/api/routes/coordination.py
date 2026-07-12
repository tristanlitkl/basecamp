"""Phase 1B.75 group coordination REST routes; resync remains authoritative."""

from datetime import date, datetime, time, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import (
    get_current_user,
    require_plan_member,
    require_plan_owner,
    require_primary_owner,
)
from app.db.base import get_session
from app.models.activity import Activity
from app.models.coordination import ActivityComment, ActivitySuggestion
from app.models.plan import (
    Plan,
    PlanDateAvailability,
    PlanDateSuggestion,
    PlanDateSuggestionVote,
    PlanMember,
    PlanSuggestion,
)
from app.models.user import User
from app.services.planning_service import bump_planning_version, require_mutable_plan
from app.services.idempotency_service import claim_operation, complete_operation, fail_operation

router = APIRouter(tags=["coordination"])


class RolePatch(BaseModel):
    role: str = Field(pattern="^(co_owner|member)$")
    client_operation_id: str | None = Field(default=None, max_length=120)


class VoteVisibilityPatch(BaseModel):
    vote_visibility: str = Field(pattern="^(public|anonymous)$")
    expected_version: int = Field(ge=1)


class CommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=2000)
    client_operation_id: str | None = Field(default=None, max_length=120)

    @field_validator("body")
    @classmethod
    def trim_body(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("comment body cannot be blank")
        return value


class CommentPatch(CommentCreate):
    expected_version: int = Field(ge=1)


class SuggestionCreate(BaseModel):
    suggestion_type: str = Field(min_length=1, max_length=48)
    proposed_changes_json: dict[str, Any] = Field(default_factory=dict)
    message: str | None = Field(default=None, max_length=2000)
    client_operation_id: str | None = Field(default=None, max_length=120)


class SuggestionDecision(BaseModel):
    expected_activity_version: int = Field(ge=1)
    client_operation_id: str | None = Field(default=None, max_length=120)


class AvailabilityUpsert(BaseModel):
    date: date
    status: str = Field(pattern="^(available|maybe|unavailable)$")


class DateSuggestionCreate(BaseModel):
    starts_on: date
    ends_on: date
    message: str | None = Field(default=None, max_length=2000)
    client_operation_id: str | None = Field(default=None, max_length=120)

    @model_validator(mode="after")
    def valid_range(self) -> "DateSuggestionCreate":
        if self.starts_on > self.ends_on:
            raise ValueError("starts_on must be on or before ends_on")
        if (self.ends_on - self.starts_on).days > 31:
            raise ValueError("date suggestions may span at most 31 days")
        return self


class DateSuggestionDecision(BaseModel):
    expected_plan_version: int = Field(ge=1)
    client_operation_id: str | None = Field(default=None, max_length=120)


class DateSuggestionVoteUpsert(BaseModel):
    vote: str = Field(pattern="^(yes|maybe|no)$")
    client_operation_id: str | None = Field(default=None, max_length=120)


class ArchiveSuggestionRequest(BaseModel):
    client_operation_id: str | None = Field(default=None, max_length=120)


class PlanSuggestionCreate(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=4000)
    starts_on: date | None = None
    ends_on: date | None = None
    budget_cents: int | None = Field(default=None, ge=0)
    max_drive_minutes: int | None = Field(default=None, ge=0)
    travel_mode: str | None = Field(default=None, pattern="^(car|plane|train|bus)$")
    travel_duration_minutes: int | None = Field(default=None, gt=0)
    client_operation_id: str = Field(max_length=120)

    @model_validator(mode="after")
    def valid_dates(self) -> "PlanSuggestionCreate":
        if self.starts_on and self.ends_on and self.starts_on > self.ends_on:
            raise ValueError("starts_on must be on or before ends_on")
        return self


class PlanSuggestionDecision(BaseModel):
    expected_plan_version: int = Field(ge=1)
    client_operation_id: str = Field(max_length=120)


def member_response(member: PlanMember, user: User) -> dict[str, Any]:
    return {
        "id": str(member.id),
        "plan_id": str(member.plan_id),
        "user_id": str(member.user_id),
        "role": member.role,
        "display_name": user.display_name,
        "created_at": member.created_at.isoformat(),
    }


async def target_member(session: AsyncSession, plan_id: UUID, user_id: UUID) -> PlanMember:
    member = (
        await session.execute(
            select(PlanMember).where(PlanMember.plan_id == plan_id, PlanMember.user_id == user_id)
        )
    ).scalar_one_or_none()
    if member is None:
        raise HTTPException(status_code=404, detail={"error": "plan_member_not_found"})
    return member


def assert_member_action(actor: PlanMember, target: PlanMember, *, changing_role: bool) -> None:
    if actor.user_id == target.user_id or target.role == "owner":
        raise HTTPException(status_code=409, detail={"error": "protected_primary_owner"})
    if actor.role == "co_owner" and (changing_role or target.role != "member"):
        raise HTTPException(status_code=403, detail={"error": "member_management_not_permitted"})


@router.get("/plans/{plan_id}/members")
async def list_members(
    plan_id: UUID,
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, Any]]:
    rows = (
        await session.execute(
            select(PlanMember, User)
            .join(User, User.id == PlanMember.user_id)
            .where(PlanMember.plan_id == plan_id)
            .order_by(PlanMember.created_at)
        )
    ).all()
    return [member_response(member, user) for member, user in rows]


@router.patch("/plans/{plan_id}/members/{member_user_id}/role")
async def change_member_role(
    plan_id: UUID,
    member_user_id: UUID,
    payload: RolePatch,
    actor: PlanMember = Depends(require_primary_owner),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    target = await target_member(session, plan_id, member_user_id)
    assert_member_action(actor, target, changing_role=True)
    claim = await claim_operation(
        session,
        plan_id=plan_id,
        actor_id=actor.user_id,
        client_operation_id=payload.client_operation_id,
        payload={"member_user_id": member_user_id, "role": payload.role},
        resource_type="member_role",
    )
    if isinstance(claim, dict):
        return claim
    target.role = payload.role
    body = {"user_id": str(target.user_id), "role": target.role}
    await complete_operation(session, claim, target.id, body, response_status=status.HTTP_200_OK)
    await session.commit()
    return body


@router.delete("/plans/{plan_id}/members/{member_user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(
    plan_id: UUID,
    member_user_id: UUID,
    client_operation_id: str | None = Query(default=None, max_length=120),
    actor: PlanMember = Depends(require_plan_owner),
    session: AsyncSession = Depends(get_session),
) -> None:
    target = await target_member(session, plan_id, member_user_id)
    assert_member_action(actor, target, changing_role=False)
    claim = await claim_operation(
        session,
        plan_id=plan_id,
        actor_id=actor.user_id,
        client_operation_id=client_operation_id,
        payload={"member_user_id": member_user_id},
        resource_type="member_remove",
    )
    if isinstance(claim, dict):
        return None
    target_id = target.id
    await session.delete(target)
    await complete_operation(
        session, claim, target_id, {"removed": True}, response_status=status.HTTP_204_NO_CONTENT
    )
    await session.commit()


@router.patch("/plans/{plan_id}/vote-visibility")
async def update_vote_visibility(
    plan_id: UUID,
    payload: VoteVisibilityPatch,
    actor: PlanMember = Depends(require_plan_owner),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    result = await session.execute(
        update(Plan)
        .where(Plan.id == plan_id, Plan.version == payload.expected_version)
        .values(
            vote_visibility=payload.vote_visibility, version=Plan.version + 1, updated_at=func.now()
        )
        .returning(Plan)
    )
    plan = result.scalar_one_or_none()
    if plan is None:
        raise HTTPException(status_code=409, detail={"error": "version_conflict"})
    await session.commit()
    return {"vote_visibility": plan.vote_visibility, "version": plan.version}


@router.post(
    "/plans/{plan_id}/activities/{activity_id}/comments", status_code=status.HTTP_201_CREATED
)
async def create_comment(
    plan_id: UUID,
    activity_id: UUID,
    payload: CommentCreate,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    if (
        await session.execute(
            select(Activity.id).where(Activity.id == activity_id, Activity.plan_id == plan_id)
        )
    ).scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail={"error": "activity_not_found"})
    request = payload.model_dump(exclude={"client_operation_id"})
    claim = await claim_operation(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        client_operation_id=payload.client_operation_id,
        payload={"activity_id": activity_id, **request},
        resource_type="activity_comment",
    )
    if isinstance(claim, dict):
        return claim
    comment = ActivityComment(
        plan_id=plan_id, activity_id=activity_id, author_id=user.id, body=payload.body
    )
    session.add(comment)
    body = {"id": str(comment.id), "version": comment.version}
    await complete_operation(
        session, claim, comment.id, body, response_status=status.HTTP_201_CREATED
    )
    await session.commit()
    return body


@router.patch("/plans/{plan_id}/activities/{activity_id}/comments/{comment_id}")
async def update_comment(
    plan_id: UUID,
    activity_id: UUID,
    comment_id: UUID,
    payload: CommentPatch,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    result = await session.execute(
        update(ActivityComment)
        .where(
            ActivityComment.id == comment_id,
            ActivityComment.plan_id == plan_id,
            ActivityComment.activity_id == activity_id,
            ActivityComment.author_id == user.id,
            ActivityComment.deleted_at.is_(None),
            ActivityComment.version == payload.expected_version,
        )
        .values(body=payload.body, version=ActivityComment.version + 1, updated_at=func.now())
        .returning(ActivityComment)
    )
    comment = result.scalar_one_or_none()
    if comment is None:
        raise HTTPException(status_code=409, detail={"error": "version_conflict_or_not_author"})
    await session.commit()
    return {"id": str(comment.id), "version": comment.version}


@router.delete(
    "/plans/{plan_id}/activities/{activity_id}/comments/{comment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_comment(
    plan_id: UUID,
    activity_id: UUID,
    comment_id: UUID,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> None:
    comment = (
        await session.execute(
            select(ActivityComment).where(
                ActivityComment.id == comment_id,
                ActivityComment.plan_id == plan_id,
                ActivityComment.activity_id == activity_id,
                ActivityComment.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if comment is None:
        raise HTTPException(status_code=404, detail={"error": "comment_not_found"})
    if comment.author_id != user.id and membership.role not in {"owner", "co_owner"}:
        raise HTTPException(status_code=403, detail={"error": "comment_moderation_not_permitted"})
    comment.deleted_at = datetime.now(timezone.utc)
    await session.commit()


@router.post(
    "/plans/{plan_id}/activities/{activity_id}/suggestions", status_code=status.HTTP_201_CREATED
)
async def create_suggestion(
    plan_id: UUID,
    activity_id: UUID,
    payload: SuggestionCreate,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    if (
        await session.execute(
            select(Activity.id).where(Activity.id == activity_id, Activity.plan_id == plan_id)
        )
    ).scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail={"error": "activity_not_found"})
    request = payload.model_dump(exclude={"client_operation_id"})
    claim = await claim_operation(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        client_operation_id=payload.client_operation_id,
        payload={"activity_id": activity_id, **request},
        resource_type="activity_suggestion",
    )
    if isinstance(claim, dict):
        return claim
    suggestion = ActivitySuggestion(
        plan_id=plan_id,
        activity_id=activity_id,
        author_id=user.id,
        suggestion_type=payload.suggestion_type,
        proposed_changes_json=payload.proposed_changes_json,
        message=payload.message,
    )
    session.add(suggestion)
    await session.flush()
    body = {"id": str(suggestion.id), "status": suggestion.status}
    await complete_operation(
        session, claim, suggestion.id, body, response_status=status.HTTP_201_CREATED
    )
    await session.commit()
    return body


async def decide_suggestion(
    plan_id: UUID,
    activity_id: UUID,
    suggestion_id: UUID,
    decision: str,
    payload: SuggestionDecision,
    user: User,
    session: AsyncSession,
    claim: Any = None,
) -> dict[str, Any]:
    suggestion = (
        await session.execute(
            select(ActivitySuggestion).where(
                ActivitySuggestion.id == suggestion_id,
                ActivitySuggestion.plan_id == plan_id,
                ActivitySuggestion.activity_id == activity_id,
                ActivitySuggestion.status == "open",
            )
        )
    ).scalar_one_or_none()
    if suggestion is None:
        raise HTTPException(status_code=409, detail={"error": "suggestion_not_open"})
    if decision == "accepted":
        await require_mutable_plan(session, plan_id)
        allowed = {
            "name",
            "description",
            "address",
            "estimated_cost_cents",
            "estimated_duration_minutes",
            "tags",
            "notes",
        }
        changes = {
            key: value for key, value in suggestion.proposed_changes_json.items() if key in allowed
        }
        if not changes:
            raise HTTPException(
                status_code=422, detail={"error": "suggestion_has_no_supported_changes"}
            )
        if "address" in changes:
            changes["location_name"] = changes["address"]
        result = await session.execute(
            update(Activity)
            .where(
                Activity.id == activity_id,
                Activity.plan_id == plan_id,
                Activity.version == payload.expected_activity_version,
            )
            .values(**changes, version=Activity.version + 1, updated_at=func.now())
            .returning(Activity)
        )
        activity = result.scalar_one_or_none()
        if activity is None:
            raise HTTPException(status_code=409, detail={"error": "version_conflict"})
        await bump_planning_version(session, plan_id)
    suggestion.status = decision
    suggestion.reviewed_by_user_id = user.id
    suggestion.reviewed_at = datetime.now(timezone.utc)
    body = {"id": str(suggestion.id), "status": suggestion.status}
    await complete_operation(
        session, claim, suggestion.id, body, response_status=status.HTTP_200_OK
    )
    await session.commit()
    return body


@router.post("/plans/{plan_id}/activities/{activity_id}/suggestions/{suggestion_id}/accept")
async def accept_suggestion(
    plan_id: UUID,
    activity_id: UUID,
    suggestion_id: UUID,
    payload: SuggestionDecision,
    user: User = Depends(get_current_user),
    actor: PlanMember = Depends(require_plan_owner),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    claim = await claim_operation(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        client_operation_id=payload.client_operation_id,
        payload={
            "activity_id": activity_id,
            "suggestion_id": suggestion_id,
            "decision": "accepted",
            "expected_activity_version": payload.expected_activity_version,
        },
        resource_type="activity_suggestion_decision",
    )
    if isinstance(claim, dict):
        return claim
    return await decide_suggestion(
        plan_id, activity_id, suggestion_id, "accepted", payload, user, session, claim
    )


@router.post("/plans/{plan_id}/activities/{activity_id}/suggestions/{suggestion_id}/dismiss")
async def dismiss_suggestion(
    plan_id: UUID,
    activity_id: UUID,
    suggestion_id: UUID,
    payload: SuggestionDecision,
    user: User = Depends(get_current_user),
    actor: PlanMember = Depends(require_plan_owner),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    claim = await claim_operation(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        client_operation_id=payload.client_operation_id,
        payload={
            "activity_id": activity_id,
            "suggestion_id": suggestion_id,
            "decision": "dismissed",
            "expected_activity_version": payload.expected_activity_version,
        },
        resource_type="activity_suggestion_decision",
    )
    if isinstance(claim, dict):
        return claim
    return await decide_suggestion(
        plan_id, activity_id, suggestion_id, "dismissed", payload, user, session, claim
    )


@router.put("/plans/{plan_id}/date-availability")
async def upsert_availability(
    plan_id: UUID,
    payload: AvailabilityUpsert,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    statement = (
        insert(PlanDateAvailability)
        .values(plan_id=plan_id, user_id=user.id, date=payload.date, status=payload.status)
        .on_conflict_do_update(
            constraint="uq_plan_availability",
            set_={"status": payload.status, "updated_at": func.now()},
        )
    )
    await session.execute(statement)
    await session.commit()
    return {"date": payload.date.isoformat(), "status": payload.status}


@router.post("/plans/{plan_id}/date-suggestions", status_code=status.HTTP_201_CREATED)
async def create_date_suggestion(
    plan_id: UUID,
    payload: DateSuggestionCreate,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    request = payload.model_dump(exclude={"client_operation_id"}, mode="json")
    claim = await claim_operation(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        client_operation_id=payload.client_operation_id,
        payload=request,
        resource_type="date_suggestion",
    )
    if isinstance(claim, dict):
        return claim
    suggestion = PlanDateSuggestion(
        plan_id=plan_id,
        suggested_by_user_id=user.id,
        starts_on=payload.starts_on,
        ends_on=payload.ends_on,
        message=payload.message,
    )
    session.add(suggestion)
    await session.flush()
    body = {"id": str(suggestion.id), "status": suggestion.status}
    await complete_operation(
        session, claim, suggestion.id, body, response_status=status.HTTP_201_CREATED
    )
    await session.commit()
    return body


async def decide_date_suggestion(
    plan_id: UUID,
    suggestion_id: UUID,
    decision: str,
    payload: DateSuggestionDecision,
    user: User,
    session: AsyncSession,
    claim: Any = None,
) -> dict[str, Any]:
    suggestion = (
        await session.execute(
            select(PlanDateSuggestion)
            .where(
                PlanDateSuggestion.id == suggestion_id,
                PlanDateSuggestion.plan_id == plan_id,
                PlanDateSuggestion.status == "open",
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if suggestion is None:
        raise HTTPException(status_code=409, detail={"error": "date_suggestion_not_open"})
    if decision == "accepted":
        await require_mutable_plan(session, plan_id)
        result = await session.execute(
            update(Plan)
            .where(Plan.id == plan_id, Plan.version == payload.expected_plan_version)
            .values(
                starts_on=datetime.combine(suggestion.starts_on, time.min, tzinfo=timezone.utc),
                ends_on=datetime.combine(suggestion.ends_on, time.min, tzinfo=timezone.utc),
                version=Plan.version + 1,
                planning_version=Plan.planning_version + 1,
                updated_at=func.now(),
            )
            .returning(Plan)
        )
        if result.scalar_one_or_none() is None:
            raise HTTPException(status_code=409, detail={"error": "version_conflict"})
    suggestion.status = decision
    suggestion.reviewed_by_user_id = user.id
    suggestion.reviewed_at = datetime.now(timezone.utc)
    body = {"id": str(suggestion.id), "status": suggestion.status}
    await complete_operation(
        session, claim, suggestion.id, body, response_status=status.HTTP_200_OK
    )
    return body


async def run_date_suggestion_decision(
    plan_id: UUID,
    suggestion_id: UUID,
    decision: str,
    payload: DateSuggestionDecision,
    user: User,
    session: AsyncSession,
) -> dict[str, Any]:
    """Persist terminal business failures so an idempotent retry is deterministic."""
    claim = await claim_operation(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        client_operation_id=payload.client_operation_id,
        payload={
            "suggestion_id": suggestion_id,
            "decision": decision,
            "expected_plan_version": payload.expected_plan_version,
        },
        resource_type="date_suggestion_decision",
    )
    if isinstance(claim, dict):
        return claim
    try:
        body = await decide_date_suggestion(
            plan_id, suggestion_id, decision, payload, user, session, claim
        )
    except HTTPException as error:
        await fail_operation(
            session,
            claim,
            response_status=error.status_code,
            response=error.detail if isinstance(error.detail, dict) else {"error": error.detail},
            failure_type="permanent",
        )
        await session.commit()
        raise
    await session.commit()
    return body


@router.post("/plans/{plan_id}/date-suggestions/{suggestion_id}/accept")
async def accept_date_suggestion(
    plan_id: UUID,
    suggestion_id: UUID,
    payload: DateSuggestionDecision,
    user: User = Depends(get_current_user),
    actor: PlanMember = Depends(require_plan_owner),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    return await run_date_suggestion_decision(
        plan_id, suggestion_id, "accepted", payload, user, session
    )


@router.post("/plans/{plan_id}/date-suggestions/{suggestion_id}/dismiss")
async def dismiss_date_suggestion(
    plan_id: UUID,
    suggestion_id: UUID,
    payload: DateSuggestionDecision,
    user: User = Depends(get_current_user),
    actor: PlanMember = Depends(require_plan_owner),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    return await run_date_suggestion_decision(
        plan_id, suggestion_id, "dismissed", payload, user, session
    )


@router.post("/plans/{plan_id}/date-suggestions/{suggestion_id}/archive")
async def archive_date_suggestion(
    plan_id: UUID,
    suggestion_id: UUID,
    payload: ArchiveSuggestionRequest,
    user: User = Depends(get_current_user),
    actor: PlanMember = Depends(require_plan_owner),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    """Hide a poll option without deleting its votes or audit history."""
    claim = await claim_operation(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        client_operation_id=payload.client_operation_id,
        payload={"suggestion_id": suggestion_id, "action": "archive"},
        resource_type="date_suggestion_archive",
    )
    if isinstance(claim, dict):
        return claim
    suggestion = (
        await session.execute(
            select(PlanDateSuggestion)
            .where(PlanDateSuggestion.id == suggestion_id, PlanDateSuggestion.plan_id == plan_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if suggestion is None or suggestion.status == "archived":
        detail = {"error": "date_suggestion_not_archivable"}
        await fail_operation(
            session, claim, response_status=409, response=detail, failure_type="permanent"
        )
        await session.commit()
        raise HTTPException(status_code=409, detail=detail)
    plan = (await session.execute(select(Plan).where(Plan.id == plan_id))).scalar_one()
    current_range = (
        plan.starts_on is not None
        and plan.ends_on is not None
        and suggestion.starts_on == plan.starts_on.date()
        and suggestion.ends_on == plan.ends_on.date()
    )
    if current_range:
        detail = {"error": "current_date_suggestion_cannot_be_archived"}
        await fail_operation(
            session, claim, response_status=409, response=detail, failure_type="permanent"
        )
        await session.commit()
        raise HTTPException(status_code=409, detail=detail)
    suggestion.status = "archived"
    suggestion.archived_at = datetime.now(timezone.utc)
    body = {"id": str(suggestion.id), "status": suggestion.status}
    await complete_operation(
        session, claim, suggestion.id, body, response_status=status.HTTP_200_OK
    )
    await session.commit()
    return body


@router.put("/plans/{plan_id}/date-suggestions/{suggestion_id}/vote")
async def vote_date_suggestion(
    plan_id: UUID,
    suggestion_id: UUID,
    payload: DateSuggestionVoteUpsert,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    suggestion = (
        await session.execute(
            select(PlanDateSuggestion.id).where(
                PlanDateSuggestion.id == suggestion_id,
                PlanDateSuggestion.plan_id == plan_id,
                PlanDateSuggestion.status == "open",
            )
        )
    ).scalar_one_or_none()
    if suggestion is None:
        raise HTTPException(status_code=409, detail={"error": "date_suggestion_not_open"})
    claim = await claim_operation(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        client_operation_id=payload.client_operation_id,
        payload={"suggestion_id": suggestion_id, "vote": payload.vote},
        resource_type="date_suggestion_vote",
    )
    if isinstance(claim, dict):
        return claim
    await session.execute(
        insert(PlanDateSuggestionVote)
        .values(plan_id=plan_id, suggestion_id=suggestion_id, user_id=user.id, vote=payload.vote)
        .on_conflict_do_update(
            constraint="uq_date_suggestion_vote",
            set_={"vote": payload.vote, "updated_at": func.now()},
        )
    )
    body = {"suggestion_id": str(suggestion_id), "vote": payload.vote}
    await complete_operation(
        session, claim, suggestion_id, body, response_status=status.HTTP_200_OK
    )
    await session.commit()
    return body


@router.post("/plans/{plan_id}/plan-suggestions", status_code=status.HTTP_201_CREATED)
async def create_plan_suggestion(
    plan_id: UUID,
    payload: PlanSuggestionCreate,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    request = payload.model_dump(exclude={"client_operation_id"}, mode="json")
    claim = await claim_operation(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        client_operation_id=payload.client_operation_id,
        payload=request,
        resource_type="plan_suggestion",
    )
    if isinstance(claim, dict):
        return claim
    suggestion = PlanSuggestion(
        plan_id=plan_id,
        suggested_by_user_id=user.id,
        **payload.model_dump(exclude={"client_operation_id"}),
    )
    session.add(suggestion)
    await session.flush()
    body = {"id": str(suggestion.id), "status": suggestion.status}
    await complete_operation(
        session, claim, suggestion.id, body, response_status=status.HTTP_201_CREATED
    )
    await session.commit()
    return body


async def decide_plan_suggestion(
    plan_id: UUID,
    suggestion_id: UUID,
    decision: str,
    payload: PlanSuggestionDecision,
    user: User,
    session: AsyncSession,
    claim: Any,
) -> dict[str, str]:
    suggestion = (
        await session.execute(
            select(PlanSuggestion)
            .where(PlanSuggestion.id == suggestion_id, PlanSuggestion.plan_id == plan_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if suggestion is None or suggestion.status != "open":
        raise HTTPException(status_code=409, detail={"error": "plan_suggestion_not_open"})
    if decision == "accepted":
        values: dict[str, Any] = {"title": suggestion.title}
        for field in (
            "description",
            "budget_cents",
            "max_drive_minutes",
            "travel_mode",
            "travel_duration_minutes",
        ):
            value = getattr(suggestion, field)
            if value is not None:
                values[field] = value
        if suggestion.starts_on is not None:
            values["starts_on"] = datetime.combine(
                suggestion.starts_on, time.min, tzinfo=timezone.utc
            )
        if suggestion.ends_on is not None:
            values["ends_on"] = datetime.combine(suggestion.ends_on, time.min, tzinfo=timezone.utc)
        result = await session.execute(
            update(Plan)
            .where(
                Plan.id == plan_id,
                Plan.version == payload.expected_plan_version,
                Plan.status != "finalized",
            )
            .values(
                **values,
                version=Plan.version + 1,
                planning_version=Plan.planning_version + 1,
                updated_at=func.now(),
            )
            .returning(Plan.id)
        )
        if result.scalar_one_or_none() is None:
            raise HTTPException(status_code=409, detail={"error": "version_conflict"})
    suggestion.status = decision
    suggestion.reviewed_by_user_id = user.id
    suggestion.reviewed_at = datetime.now(timezone.utc)
    body = {"id": str(suggestion.id), "status": decision}
    await complete_operation(
        session, claim, suggestion.id, body, response_status=status.HTTP_200_OK
    )
    return body


async def plan_suggestion_decision_endpoint(
    plan_id: UUID,
    suggestion_id: UUID,
    decision: str,
    payload: PlanSuggestionDecision,
    user: User,
    session: AsyncSession,
) -> dict[str, str]:
    claim = await claim_operation(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        client_operation_id=payload.client_operation_id,
        payload={
            "suggestion_id": suggestion_id,
            "decision": decision,
            "expected_plan_version": payload.expected_plan_version,
        },
        resource_type="plan_suggestion_decision",
    )
    if isinstance(claim, dict):
        return claim
    try:
        body = await decide_plan_suggestion(
            plan_id, suggestion_id, decision, payload, user, session, claim
        )
    except HTTPException as error:
        await fail_operation(
            session,
            claim,
            response_status=error.status_code,
            response=error.detail if isinstance(error.detail, dict) else {"error": error.detail},
            failure_type="permanent",
        )
        await session.commit()
        raise
    await session.commit()
    return body


@router.post("/plans/{plan_id}/plan-suggestions/{suggestion_id}/accept")
async def accept_plan_suggestion(
    plan_id: UUID,
    suggestion_id: UUID,
    payload: PlanSuggestionDecision,
    user: User = Depends(get_current_user),
    actor: PlanMember = Depends(require_plan_owner),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    return await plan_suggestion_decision_endpoint(
        plan_id, suggestion_id, "accepted", payload, user, session
    )


@router.post("/plans/{plan_id}/plan-suggestions/{suggestion_id}/dismiss")
async def dismiss_plan_suggestion(
    plan_id: UUID,
    suggestion_id: UUID,
    payload: PlanSuggestionDecision,
    user: User = Depends(get_current_user),
    actor: PlanMember = Depends(require_plan_owner),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    return await plan_suggestion_decision_endpoint(
        plan_id, suggestion_id, "dismissed", payload, user, session
    )


@router.post("/plans/{plan_id}/plan-suggestions/{suggestion_id}/archive")
async def archive_plan_suggestion(
    plan_id: UUID,
    suggestion_id: UUID,
    payload: ArchiveSuggestionRequest,
    user: User = Depends(get_current_user),
    actor: PlanMember = Depends(require_plan_owner),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    """Hide a completed plan-idea request without undoing its applied change."""
    claim = await claim_operation(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        client_operation_id=payload.client_operation_id,
        payload={"suggestion_id": suggestion_id, "action": "archive"},
        resource_type="plan_suggestion_archive",
    )
    if isinstance(claim, dict):
        return claim
    suggestion = (
        await session.execute(
            select(PlanSuggestion)
            .where(PlanSuggestion.id == suggestion_id, PlanSuggestion.plan_id == plan_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if suggestion is None or suggestion.status in {"open", "archived"}:
        detail = {"error": "plan_suggestion_not_archivable"}
        await fail_operation(
            session, claim, response_status=409, response=detail, failure_type="permanent"
        )
        await session.commit()
        raise HTTPException(status_code=409, detail=detail)
    suggestion.status = "archived"
    suggestion.archived_at = datetime.now(timezone.utc)
    body = {"id": str(suggestion.id), "status": suggestion.status}
    await complete_operation(
        session, claim, suggestion.id, body, response_status=status.HTTP_200_OK
    )
    await session.commit()
    return body
