"""Persisted deterministic itinerary-draft run history."""

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import Uuid

from app.db.base import Base


class LangGraphRun(Base):
    """A non-authoritative deterministic draft and the snapshot that produced it."""

    __tablename__ = "langgraph_runs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'running', 'completed', 'failed')",
            name="ck_langgraph_runs_status",
        ),
        CheckConstraint(
            "draft_status IN ('fresh', 'stale', 'invalid')",
            name="ck_langgraph_runs_draft_status",
        ),
    )

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    plan_id: Mapped[UUID] = mapped_column(Uuid, ForeignKey("plans.id"), nullable=False)
    triggered_by_user_id: Mapped[UUID] = mapped_column(Uuid, ForeignKey("users.id"), nullable=False)
    run_type: Mapped[str] = mapped_column(String(64), nullable=False, default="itinerary_draft")
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    base_plan_version: Mapped[int] = mapped_column(Integer, nullable=False)
    base_planning_version: Mapped[int] = mapped_column(Integer, nullable=False)
    input_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    output_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    validation_errors_json: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    draft_status: Mapped[str] = mapped_column(String(16), nullable=False, default="invalid")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
