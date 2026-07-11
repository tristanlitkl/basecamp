"""Versioned, fractionally ordered itinerary write paths."""

from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_plan_member
from app.db.base import get_session
from app.models.itinerary import ItineraryItem
from app.models.plan import PlanMember
from app.models.user import User
from app.services.event_service import append_plan_event
from app.services.idempotency_service import claim_operation, complete_operation
from app.services.planning_service import bump_planning_version, require_mutable_plan

router = APIRouter(tags=["itinerary"])


class ItineraryCreate(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    activity_id: UUID | None = None
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    client_operation_id: str | None = Field(default=None, max_length=120)


class ItineraryPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    expected_version: int = Field(ge=1)


class ReorderRequest(BaseModel):
    expected_version: int = Field(ge=1)
    previous_item_id: UUID | None = None
    next_item_id: UUID | None = None


class ItineraryResponse(BaseModel):
    id: UUID
    plan_id: UUID
    title: str
    position_key: Decimal
    version: int


def response(item: ItineraryItem) -> dict[str, Any]:
    return {
        "id": item.id,
        "plan_id": item.plan_id,
        "title": item.title,
        "position_key": item.position_key,
        "version": item.version,
    }


async def item_in_plan(session: AsyncSession, plan_id: UUID, item_id: UUID) -> ItineraryItem:
    item = (
        await session.execute(
            select(ItineraryItem).where(
                ItineraryItem.id == item_id, ItineraryItem.plan_id == plan_id
            )
        )
    ).scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=404, detail={"error": "itinerary_item_not_found"})
    return item


@router.post(
    "/plans/{plan_id}/itinerary-items",
    response_model=ItineraryResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_item(
    plan_id: UUID,
    payload: ItineraryCreate,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> Any:
    await require_mutable_plan(session, plan_id)
    data = payload.model_dump(exclude={"client_operation_id"})
    claim = await claim_operation(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        client_operation_id=payload.client_operation_id,
        payload=payload.model_dump(exclude={"client_operation_id"}, mode="json"),
        resource_type="itinerary_item",
    )
    if isinstance(claim, dict):
        return claim
    largest = (
        await session.execute(
            select(func.max(ItineraryItem.position_key)).where(ItineraryItem.plan_id == plan_id)
        )
    ).scalar_one()
    item = ItineraryItem(
        plan_id=plan_id, position_key=(largest or Decimal(0)) + Decimal(1000), **data
    )
    session.add(item)
    await session.flush()
    await bump_planning_version(session, plan_id)
    body = response(item)
    await complete_operation(session, claim, item.id, body, response_status=status.HTTP_201_CREATED)
    await append_plan_event(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        event_type="itinerary_item.created",
        resource_type="itinerary_item",
        resource_id=item.id,
        resource_version_after=item.version,
        client_operation_id=payload.client_operation_id,
        payload_json={"position_key": str(item.position_key)},
    )
    await session.commit()
    return body


@router.patch("/plans/{plan_id}/itinerary-items/{item_id}", response_model=ItineraryResponse)
async def patch_item(
    plan_id: UUID,
    item_id: UUID,
    payload: ItineraryPatch,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> Any:
    await require_mutable_plan(session, plan_id)
    changes = payload.model_dump(exclude={"expected_version"}, exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=422, detail={"error": "no_changes"})
    result = await session.execute(
        update(ItineraryItem)
        .where(
            ItineraryItem.id == item_id,
            ItineraryItem.plan_id == plan_id,
            ItineraryItem.version == payload.expected_version,
        )
        .values(**changes, version=ItineraryItem.version + 1, updated_at=func.now())
        .returning(ItineraryItem)
    )
    item = result.scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=409, detail={"error": "version_conflict"})
    await bump_planning_version(session, plan_id)
    await append_plan_event(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        event_type="itinerary_item.updated",
        resource_type="itinerary_item",
        resource_id=item.id,
        resource_version_after=item.version,
    )
    await session.commit()
    return response(item)


@router.post("/plans/{plan_id}/itinerary-items/{item_id}/reorder", response_model=ItineraryResponse)
async def reorder_item(
    plan_id: UUID,
    item_id: UUID,
    payload: ReorderRequest,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> Any:
    await require_mutable_plan(session, plan_id)
    if (
        payload.previous_item_id == item_id
        or payload.next_item_id == item_id
        or (
            payload.previous_item_id is not None
            and payload.previous_item_id == payload.next_item_id
        )
    ):
        raise HTTPException(status_code=422, detail={"error": "invalid_reorder_neighbors"})
    previous = (
        await item_in_plan(session, plan_id, payload.previous_item_id)
        if payload.previous_item_id
        else None
    )
    following = (
        await item_in_plan(session, plan_id, payload.next_item_id) if payload.next_item_id else None
    )
    if previous and following and previous.position_key >= following.position_key:
        raise HTTPException(status_code=422, detail={"error": "invalid_reorder_neighbors"})
    if previous and following:
        key = (previous.position_key + following.position_key) / Decimal(2)
    elif previous:
        key = previous.position_key + Decimal(1000)
    elif following:
        key = following.position_key / Decimal(2)
    else:
        key = Decimal(1000)
    current = await item_in_plan(session, plan_id, item_id)
    if current.version != payload.expected_version:
        raise HTTPException(status_code=409, detail={"error": "version_conflict"})
    if current.position_key == key:
        return response(current)
    result = await session.execute(
        update(ItineraryItem)
        .where(
            ItineraryItem.id == item_id,
            ItineraryItem.plan_id == plan_id,
            ItineraryItem.version == payload.expected_version,
        )
        .values(position_key=key, version=ItineraryItem.version + 1, updated_at=func.now())
        .returning(ItineraryItem)
    )
    item = result.scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=409, detail={"error": "version_conflict"})
    await bump_planning_version(session, plan_id)
    await append_plan_event(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        event_type="itinerary_item.reordered",
        resource_type="itinerary_item",
        resource_id=item.id,
        resource_version_after=item.version,
        payload_json={"position_key": str(key)},
    )
    await session.commit()
    return response(item)


@router.delete("/plans/{plan_id}/itinerary-items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_item(
    plan_id: UUID,
    item_id: UUID,
    expected_version: int = Query(ge=1),
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> None:
    await require_mutable_plan(session, plan_id)
    result = await session.execute(
        ItineraryItem.__table__.delete()
        .where(
            ItineraryItem.id == item_id,
            ItineraryItem.plan_id == plan_id,
            ItineraryItem.version == expected_version,
        )
        .returning(ItineraryItem.id)
    )
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=409, detail={"error": "version_conflict"})
    await bump_planning_version(session, plan_id)
    await append_plan_event(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        event_type="itinerary_item.deleted",
        resource_type="itinerary_item",
        resource_id=item_id,
        resource_version_after=None,
    )
    await session.commit()
