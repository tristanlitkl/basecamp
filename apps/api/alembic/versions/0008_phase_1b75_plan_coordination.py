"""Add plan travel details, date polling, and whole-plan suggestions."""

from alembic import op
import sqlalchemy as sa

revision = "0008_phase1b75_coord_ext"
down_revision = "0007_phase_1b75_travel_mode"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("plans", sa.Column("travel_mode", sa.String(16), nullable=True))
    op.add_column("plans", sa.Column("travel_duration_minutes", sa.Integer(), nullable=True))
    op.add_column("plans", sa.Column("travel_notes", sa.Text(), nullable=True))
    op.create_check_constraint(
        "ck_plans_travel_mode",
        "plans",
        "travel_mode IS NULL OR travel_mode IN ('car','plane','train','bus')",
    )
    op.create_check_constraint(
        "ck_plans_travel_duration",
        "plans",
        "travel_duration_minutes IS NULL OR travel_duration_minutes > 0",
    )
    op.create_table(
        "plan_date_suggestion_votes",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("plan_id", sa.Uuid(), sa.ForeignKey("plans.id"), nullable=False),
        sa.Column(
            "suggestion_id", sa.Uuid(), sa.ForeignKey("plan_date_suggestions.id"), nullable=False
        ),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("vote", sa.String(16), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("suggestion_id", "user_id", name="uq_date_suggestion_vote"),
        sa.CheckConstraint("vote IN ('yes','maybe','no')", name="ck_date_suggestion_vote_value"),
    )
    op.create_table(
        "plan_suggestions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("plan_id", sa.Uuid(), sa.ForeignKey("plans.id"), nullable=False),
        sa.Column("suggested_by_user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("title", sa.String(160), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("starts_on", sa.Date(), nullable=True),
        sa.Column("ends_on", sa.Date(), nullable=True),
        sa.Column("budget_cents", sa.Integer(), nullable=True),
        sa.Column("max_drive_minutes", sa.Integer(), nullable=True),
        sa.Column("travel_mode", sa.String(16), nullable=True),
        sa.Column("travel_duration_minutes", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(16), server_default="open", nullable=False),
        sa.Column("reviewed_by_user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "status IN ('open','accepted','dismissed')", name="ck_plan_suggestion_status"
        ),
        sa.CheckConstraint(
            "travel_mode IS NULL OR travel_mode IN ('car','plane','train','bus')",
            name="ck_plan_suggestion_travel_mode",
        ),
    )


def downgrade() -> None:
    op.drop_table("plan_suggestions")
    op.drop_table("plan_date_suggestion_votes")
    op.drop_constraint("ck_plans_travel_duration", "plans", type_="check")
    op.drop_constraint("ck_plans_travel_mode", "plans", type_="check")
    op.drop_column("plans", "travel_notes")
    op.drop_column("plans", "travel_duration_minutes")
    op.drop_column("plans", "travel_mode")
