"""Plan event persistence helpers."""

from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import PlanEvent
from app.realtime.connection_manager import connection_manager


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


def realtime_payload(event: PlanEvent) -> dict[str, str | int | None]:
    """A non-authoritative invalidation packet for a committed plan event."""
    return {
        "type": "plan_event",
        "event_id": str(event.id),
        "plan_id": str(event.plan_id),
        "event_type": event.event_type,
        "resource_type": event.resource_type,
        "resource_id": str(event.resource_id) if event.resource_id else None,
        "resource_version_after": event.resource_version_after,
    }


async def broadcast_committed_plan_event(event: PlanEvent, *, debounce: bool = False) -> None:
    """Publish only after the caller's transaction has committed successfully."""
    payload = realtime_payload(event)
    if debounce:
        connection_manager.debounce_broadcast(
            event.plan_id, f"{event.resource_type}:{event.resource_id}", payload
        )
        return
    await connection_manager.broadcast(event.plan_id, payload)
