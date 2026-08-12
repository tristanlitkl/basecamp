"""Authenticated read-only deterministic planning-status access."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_plan_member, require_plan_owner
from app.db.base import get_session
from app.models.plan import PlanMember
from app.models.user import User
from app.schemas.planning import (
    ApplyPlanningRunResponse,
    PlanningRunResponse,
    PlanningStatusResponse,
)
from app.services.planning_run_service import (
    apply_planning_run,
    create_planning_run,
    get_planning_run,
)
from app.services.planning_status_service import read_planning_status

router = APIRouter(tags=["planning"])


@router.get("/plans/{plan_id}/planning-status", response_model=PlanningStatusResponse)
async def get_planning_status(
    plan_id: UUID,
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> PlanningStatusResponse:
    if membership.plan_id != plan_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail={"error": "plan_membership_required"}
        )
    return await read_planning_status(session, plan_id)


@router.post(
    "/plans/{plan_id}/planning-runs",
    response_model=PlanningRunResponse,
    status_code=status.HTTP_201_CREATED,
)
async def start_planning_run(
    plan_id: UUID,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_owner),
    session: AsyncSession = Depends(get_session),
) -> PlanningRunResponse:
    if membership.plan_id != plan_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail={"error": "owner_role_required"}
        )
    return await create_planning_run(session, plan_id=plan_id, user_id=user.id)


@router.get("/plans/{plan_id}/planning-runs/{run_id}", response_model=PlanningRunResponse)
async def read_planning_run(
    plan_id: UUID,
    run_id: UUID,
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> PlanningRunResponse:
    if membership.plan_id != plan_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail={"error": "plan_membership_required"}
        )
    return await get_planning_run(session, plan_id=plan_id, run_id=run_id)


@router.post(
    "/plans/{plan_id}/planning-runs/{run_id}/apply", response_model=ApplyPlanningRunResponse
)
async def apply_run(
    plan_id: UUID,
    run_id: UUID,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_owner),
    session: AsyncSession = Depends(get_session),
) -> ApplyPlanningRunResponse:
    if membership.plan_id != plan_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail={"error": "owner_role_required"}
        )
    return await apply_planning_run(session, plan_id=plan_id, run_id=run_id, user_id=user.id)


@router.post(
    "/plans/{plan_id}/planning-runs/{run_id}/regenerate",
    response_model=PlanningRunResponse,
    status_code=status.HTTP_201_CREATED,
)
async def regenerate_run(
    plan_id: UUID,
    run_id: UUID,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_owner),
    session: AsyncSession = Depends(get_session),
) -> PlanningRunResponse:
    if membership.plan_id != plan_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail={"error": "owner_role_required"}
        )
    await get_planning_run(session, plan_id=plan_id, run_id=run_id)
    return await create_planning_run(session, plan_id=plan_id, user_id=user.id)
