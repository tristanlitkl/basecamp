"""Append-only ledger entry model."""

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import Uuid

from app.db.base import Base


class LedgerEntry(Base):
    __tablename__ = "ledger_entries"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    plan_id: Mapped[UUID] = mapped_column(Uuid, ForeignKey("plans.id"), nullable=False)
    expense_id: Mapped[UUID | None] = mapped_column(Uuid, ForeignKey("expenses.id"))
    from_user_id: Mapped[UUID | None] = mapped_column(Uuid, ForeignKey("users.id"))
    to_user_id: Mapped[UUID | None] = mapped_column(Uuid, ForeignKey("users.id"))
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    memo: Mapped[str | None] = mapped_column(Text)
    reversed_by_entry_id: Mapped[UUID | None] = mapped_column(
        Uuid, ForeignKey("ledger_entries.id")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
