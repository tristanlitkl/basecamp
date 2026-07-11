"""Integer-cent expenses and append-only ledger mutations."""

from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_plan_member
from app.db.base import get_session
from app.models.expense import Expense, ExpenseSplit
from app.models.plan import PlanMember
from app.models.user import User
from app.services.event_service import append_plan_event
from app.services.idempotency_service import claim_operation, complete_operation, fail_operation
from app.services.ledger_service import reverse_expense_ledger, write_expense_ledger
from app.services.planning_service import require_mutable_plan

router = APIRouter(tags=["expenses"])


class ExpenseCreate(BaseModel):
    description: str = Field(min_length=1, max_length=1000)
    amount_cents: int = Field(gt=0)
    paid_by_user_id: UUID | None = None
    participant_user_ids: list[UUID] | None = None
    client_operation_id: str | None = Field(default=None, max_length=120)


class ExpensePatch(ExpenseCreate):
    expected_version: int = Field(ge=1)


class ExpenseResponse(BaseModel):
    id: UUID
    plan_id: UUID
    paid_by_user_id: UUID
    description: str
    amount_cents: int
    status: str
    version: int
    splits: list[dict[str, Any]]


def equal_splits(amount_cents: int, user_ids: list[UUID]) -> list[tuple[UUID, int]]:
    ordered = sorted(set(user_ids), key=str)
    if not ordered or len(ordered) != len(user_ids):
        raise ValueError("participants must be a non-empty unique set")
    base_share = amount_cents // len(ordered)
    remainder = amount_cents % len(ordered)
    splits = [
        (user_id, base_share + (1 if index < remainder else 0))
        for index, user_id in enumerate(ordered)
    ]
    if sum(amount for _, amount in splits) != amount_cents:
        raise ValueError("expense splits do not equal amount")
    return splits


async def members_for_expense(
    session: AsyncSession, plan_id: UUID, requested: list[UUID] | None
) -> list[UUID]:
    members = (
        (await session.execute(select(PlanMember.user_id).where(PlanMember.plan_id == plan_id)))
        .scalars()
        .all()
    )
    participants = members if requested is None else requested
    if not participants or len(set(participants)) != len(participants):
        raise HTTPException(status_code=422, detail={"error": "expense_participants_invalid"})
    if not set(participants).issubset(set(members)):
        raise HTTPException(status_code=422, detail={"error": "expense_participant_not_member"})
    return participants


def expense_response(expense: Expense, splits: list[tuple[UUID, int]]) -> dict[str, Any]:
    return {
        "id": expense.id,
        "plan_id": expense.plan_id,
        "paid_by_user_id": expense.paid_by_user_id,
        "description": expense.description,
        "amount_cents": expense.amount_cents,
        "status": expense.status,
        "version": expense.version,
        "splits": [{"user_id": user_id, "amount_cents": amount} for user_id, amount in splits],
    }


def error_body(error: HTTPException | ValueError) -> dict[str, Any]:
    if isinstance(error, HTTPException) and isinstance(error.detail, dict):
        return error.detail
    return {"error": str(error)}


async def create_expense_rows(
    session: AsyncSession, plan_id: UUID, user: User, payload: ExpenseCreate
) -> tuple[Expense, list[tuple[UUID, int]]]:
    participants = await members_for_expense(session, plan_id, payload.participant_user_ids)
    payer = payload.paid_by_user_id or user.id
    if payer not in participants:
        raise HTTPException(status_code=422, detail={"error": "expense_payer_not_participant"})
    splits = equal_splits(payload.amount_cents, participants)
    expense = Expense(
        plan_id=plan_id,
        paid_by_user_id=payer,
        description=payload.description,
        amount_cents=payload.amount_cents,
    )
    session.add(expense)
    await session.flush()
    session.add_all(
        ExpenseSplit(expense_id=expense.id, user_id=user_id, amount_cents=amount)
        for user_id, amount in splits
    )
    await write_expense_ledger(
        session,
        plan_id=plan_id,
        expense_id=expense.id,
        payer_id=payer,
        splits=splits,
        memo=f"expense:{expense.id}",
    )
    return expense, splits


@router.post(
    "/plans/{plan_id}/expenses", response_model=ExpenseResponse, status_code=status.HTTP_201_CREATED
)
async def create_expense(
    plan_id: UUID,
    payload: ExpenseCreate,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> Any:
    await require_mutable_plan(session, plan_id)
    data = payload.model_dump(exclude={"client_operation_id"}, mode="json")
    claim = await claim_operation(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        client_operation_id=payload.client_operation_id,
        payload=data,
        resource_type="expense",
    )
    if isinstance(claim, dict):
        return claim
    try:
        async with session.begin_nested():
            expense, splits = await create_expense_rows(session, plan_id, user, payload)
            body = expense_response(expense, splits)
            await complete_operation(
                session, claim, expense.id, body, response_status=status.HTTP_201_CREATED
            )
            await append_plan_event(
                session,
                plan_id=plan_id,
                actor_id=user.id,
                event_type="expense.created",
                resource_type="expense",
                resource_id=expense.id,
                resource_version_after=expense.version,
                client_operation_id=payload.client_operation_id,
            )
    except (HTTPException, ValueError) as error:
        code = (
            error.status_code
            if isinstance(error, HTTPException)
            else status.HTTP_422_UNPROCESSABLE_ENTITY
        )
        await fail_operation(
            session,
            claim,
            response_status=code,
            response=error_body(error),
            failure_type="permanent",
        )
        await session.commit()
        raise
    await session.commit()
    return body


@router.patch("/plans/{plan_id}/expenses/{expense_id}", response_model=ExpenseResponse)
async def patch_expense(
    plan_id: UUID,
    expense_id: UUID,
    payload: ExpensePatch,
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> Any:
    await require_mutable_plan(session, plan_id)
    request_data = payload.model_dump(exclude={"client_operation_id"}, mode="json")
    claim = await claim_operation(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        client_operation_id=payload.client_operation_id,
        payload=request_data,
        resource_type="expense_update",
    )
    if isinstance(claim, dict):
        return claim
    try:
        async with session.begin_nested():
            participants = await members_for_expense(session, plan_id, payload.participant_user_ids)
            payer = payload.paid_by_user_id or user.id
            if payer not in participants:
                raise HTTPException(
                    status_code=422, detail={"error": "expense_payer_not_participant"}
                )
            splits = equal_splits(payload.amount_cents, participants)
            result = await session.execute(
                update(Expense)
                .where(
                    Expense.id == expense_id,
                    Expense.plan_id == plan_id,
                    Expense.status == "active",
                    Expense.version == payload.expected_version,
                )
                .values(
                    description=payload.description,
                    amount_cents=payload.amount_cents,
                    paid_by_user_id=payer,
                    version=Expense.version + 1,
                )
                .returning(Expense)
            )
            expense = result.scalar_one_or_none()
            if expense is None:
                raise HTTPException(status_code=409, detail={"error": "version_conflict"})
            await reverse_expense_ledger(session, expense_id, f"expense:{expense_id}:reversal")
            await session.execute(delete(ExpenseSplit).where(ExpenseSplit.expense_id == expense_id))
            session.add_all(
                ExpenseSplit(expense_id=expense_id, user_id=user_id, amount_cents=amount)
                for user_id, amount in splits
            )
            await write_expense_ledger(
                session,
                plan_id=plan_id,
                expense_id=expense_id,
                payer_id=payer,
                splits=splits,
                memo=f"expense:{expense_id}:correction",
            )
            body = expense_response(expense, splits)
            await complete_operation(
                session, claim, expense.id, body, response_status=status.HTTP_200_OK
            )
            await append_plan_event(
                session,
                plan_id=plan_id,
                actor_id=user.id,
                event_type="expense.updated",
                resource_type="expense",
                resource_id=expense_id,
                resource_version_after=expense.version,
            )
    except (HTTPException, ValueError) as error:
        code = (
            error.status_code
            if isinstance(error, HTTPException)
            else status.HTTP_422_UNPROCESSABLE_ENTITY
        )
        await fail_operation(
            session,
            claim,
            response_status=code,
            response=error_body(error),
            failure_type="permanent",
        )
        await session.commit()
        raise
    await session.commit()
    return body


@router.delete("/plans/{plan_id}/expenses/{expense_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_expense(
    plan_id: UUID,
    expense_id: UUID,
    expected_version: int = Query(ge=1),
    client_operation_id: str | None = Query(default=None, max_length=120),
    user: User = Depends(get_current_user),
    membership: PlanMember = Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> None:
    await require_mutable_plan(session, plan_id)
    claim = await claim_operation(
        session,
        plan_id=plan_id,
        actor_id=user.id,
        client_operation_id=client_operation_id,
        payload={"expense_id": expense_id, "expected_version": expected_version},
        resource_type="expense_delete",
    )
    if isinstance(claim, dict):
        return None
    try:
        async with session.begin_nested():
            result = await session.execute(
                update(Expense)
                .where(
                    Expense.id == expense_id,
                    Expense.plan_id == plan_id,
                    Expense.status == "active",
                    Expense.version == expected_version,
                )
                .values(status="reversed", version=Expense.version + 1)
                .returning(Expense)
            )
            expense = result.scalar_one_or_none()
            if expense is None:
                raise HTTPException(status_code=409, detail={"error": "version_conflict"})
            await reverse_expense_ledger(session, expense_id, f"expense:{expense_id}:reversal")
            await complete_operation(
                session,
                claim,
                expense.id,
                {"deleted": True},
                response_status=status.HTTP_204_NO_CONTENT,
            )
            await append_plan_event(
                session,
                plan_id=plan_id,
                actor_id=user.id,
                event_type="expense.deleted",
                resource_type="expense",
                resource_id=expense_id,
                resource_version_after=expense.version,
            )
    except (HTTPException, ValueError) as error:
        code = (
            error.status_code
            if isinstance(error, HTTPException)
            else status.HTTP_422_UNPROCESSABLE_ENTITY
        )
        await fail_operation(
            session,
            claim,
            response_status=code,
            response=error_body(error),
            failure_type="permanent",
        )
        await session.commit()
        raise
    await session.commit()
