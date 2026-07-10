"""Invite routes."""

import hashlib
import secrets
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_plan_owner
from app.db.base import get_session
from app.models.invite import PlanInvite
from app.models.plan import Plan, PlanMember
from app.models.user import User
from app.services.event_service import append_plan_event

router = APIRouter(tags=["invites"])


class InviteResponse(BaseModel):
    token: str
    plan_id: UUID


class JoinResponse(BaseModel):
    plan_id: UUID
    role: str


def hash_invite_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


@router.post("/plans/{plan_id}/invites", response_model=InviteResponse, status_code=status.HTTP_201_CREATED)
async def create_invite(
    plan_id: UUID,
    owner_membership: PlanMember = Depends(require_plan_owner),
    session: AsyncSession = Depends(get_session),
) -> InviteResponse:
    result = await session.execute(select(Plan.id).where(Plan.id == plan_id))
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"error": "plan_not_found"})

    token = secrets.token_urlsafe(32)
    invite = PlanInvite(
        plan_id=plan_id,
        created_by_user_id=owner_membership.user_id,
        token_hash=hash_invite_token(token),
    )
    session.add(invite)
    await session.flush()
    await append_plan_event(
        session,
        plan_id=plan_id,
        actor_id=owner_membership.user_id,
        event_type="invite.created",
        resource_type="invite",
        resource_id=invite.id,
        resource_version_after=None,
    )
    await session.commit()
    return InviteResponse(token=token, plan_id=plan_id)


@router.post("/invites/{token}/join", response_model=JoinResponse)
async def join_invite(
    token: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> JoinResponse:
    token_hash = hash_invite_token(token)
    result = await session.execute(select(PlanInvite).where(PlanInvite.token_hash == token_hash))
    invite = result.scalar_one_or_none()
    if invite is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"error": "invite_not_found"})

    result = await session.execute(
        select(PlanMember).where(PlanMember.plan_id == invite.plan_id, PlanMember.user_id == user.id)
    )
    membership = result.scalar_one_or_none()
    if membership is None:
        membership = PlanMember(plan_id=invite.plan_id, user_id=user.id, role="member")
        session.add(membership)
        await session.flush()
        await append_plan_event(
            session,
            plan_id=invite.plan_id,
            actor_id=user.id,
            event_type="member.joined",
            resource_type="plan_member",
            resource_id=membership.id,
            resource_version_after=None,
        )
        await session.commit()

    return JoinResponse(plan_id=invite.plan_id, role=membership.role)
