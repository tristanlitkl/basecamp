"""Archive coordination history without deleting votes or audit records."""

from alembic import op
import sqlalchemy as sa


revision = "0009_phase1b75_history_archival"
down_revision = "0008_phase1b75_coord_ext"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("plan_date_suggestions", sa.Column("archived_at", sa.DateTime(timezone=True)))
    op.add_column("plan_suggestions", sa.Column("archived_at", sa.DateTime(timezone=True)))
    op.drop_constraint("ck_plan_date_suggestion_status", "plan_date_suggestions", type_="check")
    op.create_check_constraint(
        "ck_plan_date_suggestion_status",
        "plan_date_suggestions",
        "status IN ('open', 'accepted', 'dismissed', 'archived')",
    )
    op.drop_constraint("ck_plan_suggestion_status", "plan_suggestions", type_="check")
    op.create_check_constraint(
        "ck_plan_suggestion_status",
        "plan_suggestions",
        "status IN ('open', 'accepted', 'dismissed', 'archived')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_plan_suggestion_status", "plan_suggestions", type_="check")
    op.create_check_constraint(
        "ck_plan_suggestion_status",
        "plan_suggestions",
        "status IN ('open', 'accepted', 'dismissed')",
    )
    op.drop_constraint("ck_plan_date_suggestion_status", "plan_date_suggestions", type_="check")
    op.create_check_constraint(
        "ck_plan_date_suggestion_status",
        "plan_date_suggestions",
        "status IN ('open', 'accepted', 'dismissed')",
    )
    op.drop_column("plan_suggestions", "archived_at")
    op.drop_column("plan_date_suggestions", "archived_at")
