"""Shared Phase 1B plan lifecycle and counter operations."""

from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.plan import Plan


async def require_mutable_plan(session: AsyncSession, plan_id: UUID) -> Plan:
    plan = (await session.execute(select(Plan).where(Plan.id == plan_id))).scalar_one_or_none()
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail={"error": "plan_not_found"}
        )
    if plan.status == "finalized":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail={"error": "plan_finalized"}
        )
    return plan


async def bump_planning_version(session: AsyncSession, plan_id: UUID) -> int:
    """Atomically bump only the counter that invalidates planning drafts."""
    result = await session.execute(
        update(Plan)
        .where(Plan.id == plan_id)
        .values(planning_version=Plan.planning_version + 1)
        .returning(Plan.planning_version)
    )
    value = result.scalar_one_or_none()
    if value is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail={"error": "plan_not_found"}
        )
    return value
