"""Authenticated, persisted notification inbox endpoints."""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db.base import get_session
from app.models.notification import Notification
from app.models.user import User

router = APIRouter(tags=["notifications"])


class NotificationResponse(BaseModel):
    id: UUID
    plan_id: UUID
    actor_user_id: UUID | None
    event_type: str
    entity_type: str | None
    entity_id: UUID | None
    title: str
    body: str | None
    metadata: dict
    is_read: bool
    created_at: datetime
    read_at: datetime | None


class NotificationListResponse(BaseModel):
    notifications: list[NotificationResponse]
    unread_count: int
    offset: int
    limit: int
    has_more: bool


class MarkAllReadRequest(BaseModel):
    plan_id: UUID | None = None


def serialize(item: Notification) -> NotificationResponse:
    return NotificationResponse(
        id=item.id,
        plan_id=item.plan_id,
        actor_user_id=item.actor_user_id,
        event_type=item.event_type,
        entity_type=item.entity_type,
        entity_id=item.entity_id,
        title=item.title,
        body=item.body,
        metadata=item.metadata_json or {},
        is_read=item.is_read,
        created_at=item.created_at,
        read_at=item.read_at,
    )


@router.get("/notifications", response_model=NotificationListResponse)
async def list_notifications(
    plan_id: UUID | None = None,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=25, ge=1, le=100),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> NotificationListResponse:
    filters = [Notification.recipient_user_id == user.id]
    if plan_id is not None:
        filters.append(Notification.plan_id == plan_id)
    unread_count = (
        await session.execute(
            select(func.count())
            .select_from(Notification)
            .where(*filters, Notification.is_read.is_(False))
        )
    ).scalar_one()
    rows = (
        (
            await session.execute(
                select(Notification)
                .where(*filters)
                .order_by(Notification.created_at.desc(), Notification.id.desc())
                .offset(offset)
                .limit(limit + 1)
            )
        )
        .scalars()
        .all()
    )
    return NotificationListResponse(
        notifications=[serialize(item) for item in rows[:limit]],
        unread_count=unread_count,
        offset=offset,
        limit=limit,
        has_more=len(rows) > limit,
    )


@router.post("/notifications/{notification_id}/read", response_model=NotificationResponse)
async def mark_notification_read(
    notification_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> NotificationResponse:
    result = await session.execute(
        update(Notification)
        .where(Notification.id == notification_id, Notification.recipient_user_id == user.id)
        .values(
            is_read=True, read_at=func.coalesce(Notification.read_at, datetime.now(timezone.utc))
        )
        .returning(Notification)
    )
    item = result.scalar_one_or_none()
    if item is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail={"error": "notification_not_found"}
        )
    await session.commit()
    return serialize(item)


@router.post("/notifications/read-all")
async def mark_all_notifications_read(
    payload: MarkAllReadRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, int]:
    filters = [Notification.recipient_user_id == user.id, Notification.is_read.is_(False)]
    if payload.plan_id is not None:
        filters.append(Notification.plan_id == payload.plan_id)
    result = await session.execute(
        update(Notification)
        .where(*filters)
        .values(is_read=True, read_at=datetime.now(timezone.utc))
    )
    await session.commit()
    return {"marked_read": result.rowcount or 0}
