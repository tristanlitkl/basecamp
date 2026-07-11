"""Phase 1B.75 group coordination and membership."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0006_phase_1b75"
down_revision = "0005_phase_1b_idempotency"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "plans",
        sa.Column("vote_visibility", sa.String(length=16), nullable=False, server_default="public"),
    )
    op.create_check_constraint(
        "ck_plans_vote_visibility", "plans", "vote_visibility IN ('public', 'anonymous')"
    )
    op.create_check_constraint(
        "ck_plan_member_role", "plan_members", "role IN ('owner', 'co_owner', 'member')"
    )
    op.create_table(
        "activity_comments",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("plan_id", sa.Uuid(), sa.ForeignKey("plans.id"), nullable=False),
        sa.Column("activity_id", sa.Uuid(), sa.ForeignKey("activities.id"), nullable=False),
        sa.Column("author_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
    )
    op.create_table(
        "activity_suggestions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("plan_id", sa.Uuid(), sa.ForeignKey("plans.id"), nullable=False),
        sa.Column("activity_id", sa.Uuid(), sa.ForeignKey("activities.id"), nullable=False),
        sa.Column("author_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("suggestion_type", sa.String(length=48), nullable=False),
        sa.Column(
            "proposed_changes_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="{}",
        ),
        sa.Column("message", sa.Text()),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="open"),
        sa.Column("reviewed_by_user_id", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("reviewed_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.CheckConstraint(
            "status IN ('open', 'accepted', 'dismissed')", name="ck_activity_suggestion_status"
        ),
    )
    op.create_table(
        "plan_date_availability",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("plan_id", sa.Uuid(), sa.ForeignKey("plans.id"), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("plan_id", "user_id", "date", name="uq_plan_availability"),
        sa.CheckConstraint(
            "status IN ('available', 'maybe', 'unavailable')", name="ck_plan_availability_status"
        ),
    )
    op.create_table(
        "plan_date_suggestions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("plan_id", sa.Uuid(), sa.ForeignKey("plans.id"), nullable=False),
        sa.Column("suggested_by_user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("starts_on", sa.Date(), nullable=False),
        sa.Column("ends_on", sa.Date(), nullable=False),
        sa.Column("message", sa.Text()),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="open"),
        sa.Column("reviewed_by_user_id", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("reviewed_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.CheckConstraint("starts_on <= ends_on", name="ck_plan_date_suggestion_range"),
        sa.CheckConstraint(
            "status IN ('open', 'accepted', 'dismissed')", name="ck_plan_date_suggestion_status"
        ),
    )


def downgrade() -> None:
    op.drop_table("plan_date_suggestions")
    op.drop_table("plan_date_availability")
    op.drop_table("activity_suggestions")
    op.drop_table("activity_comments")
    op.drop_constraint("ck_plan_member_role", "plan_members", type_="check")
    op.drop_constraint("ck_plans_vote_visibility", "plans", type_="check")
    op.drop_column("plans", "vote_visibility")
