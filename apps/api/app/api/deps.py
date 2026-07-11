"""Shared FastAPI dependencies."""

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.core.security import decode_app_jwt
from app.db.base import get_session
from app.models.plan import PlanMember
from app.models.user import User

bearer_scheme = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class AppJwtClaims:
    subject: str
    email: str
    name: str | None
    raw: dict[str, Any]


async def require_app_jwt(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    settings: Settings = Depends(get_settings),
) -> AppJwtClaims:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "missing_bearer_token"},
        )

    payload = decode_app_jwt(credentials.credentials, settings)
    subject = str(payload.get("sub", ""))
    email = str(payload.get("email", ""))
    if not subject or not email:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "invalid_token_claims"},
        )

    name_claim = payload.get("name")
    return AppJwtClaims(
        subject=subject,
        email=email,
        name=str(name_claim) if name_claim else None,
        raw=payload,
    )


async def get_current_user(
    claims: AppJwtClaims = Depends(require_app_jwt),
    session: AsyncSession = Depends(get_session),
) -> User:
    result = await session.execute(select(User).where(User.auth_subject == claims.subject))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "user_not_synced"},
        )
    return user


async def require_plan_member(
    plan_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> PlanMember:
    result = await session.execute(
        select(PlanMember).where(PlanMember.plan_id == plan_id, PlanMember.user_id == user.id)
    )
    membership = result.scalar_one_or_none()
    if membership is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "plan_membership_required"},
        )
    return membership


async def require_plan_owner(
    membership: PlanMember = Depends(require_plan_member),
) -> PlanMember:
    if membership.role not in {"owner", "co_owner"}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "owner_role_required"},
        )
    return membership


async def require_primary_owner(
    membership: PlanMember = Depends(require_plan_member),
) -> PlanMember:
    if membership.role != "owner":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "primary_owner_role_required"},
        )
    return membership
