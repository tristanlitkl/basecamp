"""Integer-cent, append-only ledger write and balance operations."""

from uuid import UUID

from sqlalchemy import exists, func, select
from sqlalchemy.orm import aliased
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ledger import LedgerEntry


async def write_expense_ledger(
    session: AsyncSession,
    *,
    plan_id: UUID,
    expense_id: UUID,
    payer_id: UUID,
    splits: list[tuple[UUID, int]],
    memo: str,
) -> list[LedgerEntry]:
    """Append a zero-sum representation: payer credit followed by member debits."""
    total = sum(amount for _, amount in splits)
    entries = [
        LedgerEntry(
            plan_id=plan_id,
            expense_id=expense_id,
            to_user_id=payer_id,
            amount_cents=total,
            memo=memo,
        )
    ]
    entries.extend(
        LedgerEntry(
            plan_id=plan_id,
            expense_id=expense_id,
            from_user_id=user_id,
            amount_cents=-amount,
            memo=memo,
        )
        for user_id, amount in splits
    )
    if sum(entry.amount_cents for entry in entries) != 0:
        raise ValueError("ledger entries must be zero-sum")
    session.add_all(entries)
    await session.flush()
    return entries


async def reverse_expense_ledger(session: AsyncSession, expense_id: UUID, memo: str) -> None:
    reversal = aliased(LedgerEntry)
    originals = (
        (
            await session.execute(
                select(LedgerEntry).where(
                    LedgerEntry.expense_id == expense_id,
                    LedgerEntry.reversed_by_entry_id.is_(None),
                    ~exists(select(1).where(reversal.reversed_by_entry_id == LedgerEntry.id)),
                )
            )
        )
        .scalars()
        .all()
    )
    if not originals:
        raise ValueError("expense has no active ledger posting to reverse")
    reversals = [
        LedgerEntry(
            plan_id=entry.plan_id,
            expense_id=expense_id,
            from_user_id=entry.to_user_id,
            to_user_id=entry.from_user_id,
            amount_cents=-entry.amount_cents,
            memo=memo,
            reversed_by_entry_id=entry.id,
        )
        for entry in originals
    ]
    if sum(entry.amount_cents for entry in reversals) != 0:
        raise ValueError("expense reversal must be zero-sum")
    session.add_all(reversals)


async def plan_balances(session: AsyncSession, plan_id: UUID) -> dict[UUID, int]:
    credits = await session.execute(
        select(LedgerEntry.to_user_id, func.sum(LedgerEntry.amount_cents))
        .where(LedgerEntry.plan_id == plan_id, LedgerEntry.to_user_id.is_not(None))
        .group_by(LedgerEntry.to_user_id)
    )
    debits = await session.execute(
        select(LedgerEntry.from_user_id, func.sum(LedgerEntry.amount_cents))
        .where(LedgerEntry.plan_id == plan_id, LedgerEntry.from_user_id.is_not(None))
        .group_by(LedgerEntry.from_user_id)
    )
    balances: dict[UUID, int] = {}
    for user_id, amount in list(credits) + list(debits):
        balances[user_id] = balances.get(user_id, 0) + amount
    return balances
