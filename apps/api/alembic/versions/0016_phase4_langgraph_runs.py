"""Persist deterministic Phase 4 itinerary draft runs.

Revision ID: 0016_phase4_langgraph_runs
Revises: 0015_persisted_notifications
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0016_phase4_langgraph_runs"
down_revision = "0015_persisted_notifications"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "langgraph_runs",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("plan_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("triggered_by_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("run_type", sa.String(length=64), nullable=False, server_default="itinerary_draft"),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="pending"),
        sa.Column("base_plan_version", sa.Integer(), nullable=False),
        sa.Column("base_planning_version", sa.Integer(), nullable=False),
        sa.Column("input_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("output_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("validation_errors_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("draft_status", sa.String(length=16), nullable=False, server_default="invalid"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status IN ('pending', 'running', 'completed', 'failed')", name="ck_langgraph_runs_status"),
        sa.CheckConstraint("draft_status IN ('fresh', 'stale', 'invalid')", name="ck_langgraph_runs_draft_status"),
        sa.ForeignKeyConstraint(["plan_id"], ["plans.id"]),
        sa.ForeignKeyConstraint(["triggered_by_user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_langgraph_runs_plan_created", "langgraph_runs", ["plan_id", "created_at", "id"])


def downgrade() -> None:
    op.drop_index("ix_langgraph_runs_plan_created", table_name="langgraph_runs")
    op.drop_table("langgraph_runs")
