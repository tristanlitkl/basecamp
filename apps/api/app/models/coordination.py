"""Discussion and structured coordination records for Phase 1B.75."""

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import Uuid

from app.db.base import Base


class ActivityComment(Base):
    __tablename__ = "activity_comments"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    plan_id: Mapped[UUID] = mapped_column(Uuid, ForeignKey("plans.id"), nullable=False)
    activity_id: Mapped[UUID] = mapped_column(Uuid, ForeignKey("activities.id"), nullable=False)
    author_id: Mapped[UUID] = mapped_column(Uuid, ForeignKey("users.id"), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ActivitySuggestion(Base):
    __tablename__ = "activity_suggestions"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    plan_id: Mapped[UUID] = mapped_column(Uuid, ForeignKey("plans.id"), nullable=False)
    activity_id: Mapped[UUID] = mapped_column(Uuid, ForeignKey("activities.id"), nullable=False)
    author_id: Mapped[UUID] = mapped_column(Uuid, ForeignKey("users.id"), nullable=False)
    suggestion_type: Mapped[str] = mapped_column(String(48), nullable=False)
    proposed_changes_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    message: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="open")
    reviewed_by_user_id: Mapped[UUID | None] = mapped_column(Uuid, ForeignKey("users.id"))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class CoOwnerRequest(Base):
    """An auditable request by a regular member to become a co-owner."""

    __tablename__ = "co_owner_requests"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'approved', 'denied', 'withdrawn')",
            name="ck_co_owner_request_status",
        ),
        # PostgreSQL enforces the active-request invariant, including under concurrent submits.
        Index(
            "uq_co_owner_request_pending_member",
            "plan_id",
            "requester_user_id",
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
    )

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    plan_id: Mapped[UUID] = mapped_column(Uuid, ForeignKey("plans.id"), nullable=False)
    requester_user_id: Mapped[UUID] = mapped_column(Uuid, ForeignKey("users.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    note: Mapped[str | None] = mapped_column(Text)
    decided_by_user_id: Mapped[UUID | None] = mapped_column(Uuid, ForeignKey("users.id"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
