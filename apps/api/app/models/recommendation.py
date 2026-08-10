"""Persisted, deterministic activity recommendation scores."""

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import Uuid

from app.db.base import Base


class ActivityScore(Base):
    """Derived score data. Updating it must never change plan or activity versions."""

    __tablename__ = "activity_scores"
    __table_args__ = (UniqueConstraint("activity_id", name="uq_activity_scores_activity"),)

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    activity_id: Mapped[UUID] = mapped_column(
        Uuid, ForeignKey("activities.id", ondelete="CASCADE"), nullable=False
    )
    plan_id: Mapped[UUID] = mapped_column(
        Uuid, ForeignKey("plans.id", ondelete="CASCADE"), nullable=False
    )
    total_score: Mapped[int] = mapped_column(Integer, nullable=False)
    vote_score: Mapped[int] = mapped_column(Integer, nullable=False)
    budget_score: Mapped[int] = mapped_column(Integer, nullable=False)
    preference_score: Mapped[int] = mapped_column(Integer, nullable=False)
    schedule_fit_score: Mapped[int] = mapped_column(Integer, nullable=False)
    reasons: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    score_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
