"""Authentication routes."""

from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AppJwtClaims, get_current_user, require_app_jwt
from app.db.base import get_session
from app.models.user import User

router = APIRouter(tags=["auth"])

DEFAULT_AVATAR_EMOJI = "🧭"
SUPPORTED_AVATAR_EMOJIS = frozenset(
    {"🧭", "⛺", "🗺️", "🥾", "🌲", "🏔️", "🌊", "🌙", "🦊", "🐻", "🦉", "🐕", "🎒", "🔥", "✨", "🚐"}
)


class UserResponse(BaseModel):
    id: UUID
    email: str
    display_name: str
    avatar_emoji: str


class UserPatch(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=50)
    avatar_emoji: str | None = Field(default=None, max_length=16)

    @field_validator("display_name")
    @classmethod
    def normalize_display_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized or len(normalized) > 50:
            raise ValueError("display_name must be 1–50 visible characters")
        return normalized

    @field_validator("avatar_emoji")
    @classmethod
    def validate_avatar_emoji(cls, value: str | None) -> str | None:
        if value is not None and value not in SUPPORTED_AVATAR_EMOJIS:
            raise ValueError("avatar_emoji must be a supported Basecamp avatar")
        return value


def serialize_user(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        avatar_emoji=user.avatar_emoji or DEFAULT_AVATAR_EMOJI,
    )


@router.post("/auth/sync-user", response_model=UserResponse)
async def sync_user(
    claims: AppJwtClaims = Depends(require_app_jwt),
    session: AsyncSession = Depends(get_session),
) -> UserResponse:
    result = await session.execute(select(User).where(User.auth_subject == claims.subject))
    user = result.scalar_one_or_none()

    if user is None:
        result = await session.execute(select(User).where(User.email == claims.email))
        user = result.scalar_one_or_none()

    display_name = claims.name or claims.email
    if user is None:
        user = User(
            auth_subject=claims.subject,
            email=claims.email,
            display_name=display_name,
            avatar_emoji=DEFAULT_AVATAR_EMOJI,
        )
        session.add(user)
    else:
        user.auth_subject = claims.subject
        user.email = claims.email

    await session.commit()
    await session.refresh(user)
    return serialize_user(user)


@router.get("/auth/me", response_model=UserResponse)
async def me(user: User = Depends(get_current_user)) -> UserResponse:
    return serialize_user(user)


@router.patch("/auth/me", response_model=UserResponse)
async def update_me(
    payload: UserPatch,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> UserResponse:
    if payload.display_name is not None:
        user.display_name = payload.display_name
    if payload.avatar_emoji is not None:
        user.avatar_emoji = payload.avatar_emoji
    await session.commit()
    await session.refresh(user)
    return serialize_user(user)
