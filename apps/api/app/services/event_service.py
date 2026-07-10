"""Plan event persistence helpers."""

from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import PlanEvent


async def append_plan_event(
    session: AsyncSession,
    *,
    plan_id: UUID,
    actor_id: UUID | None,
    event_type: str,
    resource_type: str,
    resource_id: UUID | None,
    resource_version_after: int | None,
    payload_json: dict | None = None,
    client_operation_id: str | None = None,
) -> PlanEvent:
    event = PlanEvent(
        plan_id=plan_id,
        actor_id=actor_id,
        event_type=event_type,
        payload_json=payload_json or {},
        resource_type=resource_type,
        resource_id=resource_id,
        resource_version_after=resource_version_after,
        client_operation_id=client_operation_id,
    )
    session.add(event)
    return event
