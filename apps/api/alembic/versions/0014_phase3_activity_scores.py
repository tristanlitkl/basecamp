"""Persist deterministic Phase 3 activity recommendation scores.

Revision ID: 0014_phase3_activity_scores
Revises: 0013_phase2_daily_weather
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0014_phase3_activity_scores"
down_revision = "0013_phase2_daily_weather"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "activity_scores",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("activity_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("plan_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("total_score", sa.Integer(), nullable=False),
        sa.Column("vote_score", sa.Integer(), nullable=False),
        sa.Column("budget_score", sa.Integer(), nullable=False),
        sa.Column("preference_score", sa.Integer(), nullable=False),
        sa.Column("schedule_fit_score", sa.Integer(), nullable=False),
        sa.Column("reasons", sa.JSON(), nullable=False),
        sa.Column("score_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["activity_id"], ["activities.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["plan_id"], ["plans.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("activity_id", name="uq_activity_scores_activity"),
    )
    op.create_index("ix_activity_scores_plan_id", "activity_scores", ["plan_id"])


def downgrade() -> None:
    op.drop_index("ix_activity_scores_plan_id", table_name="activity_scores")
    op.drop_table("activity_scores")
