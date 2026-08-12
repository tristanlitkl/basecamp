"""Transaction-local notification creation and recipient selection helpers.

Notifications are created in the same database transaction as their source
mutation.  They are deliberately independent from websocket packets.
"""

from collections.abc import Iterable
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notification import Notification
from app.models.plan import PlanMember
from app.services.metrics_service import metrics


async def plan_member_ids(
    session: AsyncSession, plan_id: UUID, *, exclude: UUID | None = None
) -> list[UUID]:
    ids = (
        (
            await session.execute(
                select(PlanMember.user_id)
                .where(PlanMember.plan_id == plan_id)
                .order_by(PlanMember.user_id)
            )
        )
        .scalars()
        .all()
    )
    return [user_id for user_id in ids if user_id != exclude]


async def owner_ids(
    session: AsyncSession, plan_id: UUID, *, exclude: UUID | None = None
) -> list[UUID]:
    ids = (
        (
            await session.execute(
                select(PlanMember.user_id)
                .where(PlanMember.plan_id == plan_id, PlanMember.role.in_(("owner", "co_owner")))
                .order_by(PlanMember.user_id)
            )
        )
        .scalars()
        .all()
    )
    return [user_id for user_id in ids if user_id != exclude]


async def create_notifications(
    session: AsyncSession,
    *,
    plan_id: UUID,
    recipients: Iterable[UUID],
    actor_id: UUID | None,
    event_type: str,
    entity_type: str | None,
    entity_id: UUID | None,
    title: str,
    body: str | None = None,
    metadata: dict | None = None,
    source_key: str,
) -> None:
    """Insert recipient rows idempotently, without changing plan versions."""
    unique_recipients = sorted(set(recipients), key=str)
    if actor_id is not None:
        unique_recipients = [recipient for recipient in unique_recipients if recipient != actor_id]
    if not unique_recipients:
        return
    rows = [
        {
            "plan_id": plan_id,
            "recipient_user_id": recipient,
            "actor_user_id": actor_id,
            "event_type": event_type,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "title": title,
            "body": body,
            "metadata_json": metadata or {},
            "source_key": source_key,
        }
        for recipient in unique_recipients
    ]
    result = await session.execute(
        insert(Notification)
        .values(rows)
        .on_conflict_do_nothing(constraint="uq_notifications_recipient_source")
    )
    if result.rowcount and result.rowcount > 0:
        metrics.increment("notifications_created", result.rowcount)
