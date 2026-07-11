"""Add persisted activity travel mode for Phase 1B.75."""

from alembic import op
import sqlalchemy as sa


revision = "0007_phase_1b75_travel_mode"
down_revision = "0006_phase_1b75"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("activities", sa.Column("travel_mode", sa.String(length=16), nullable=True))
    op.create_check_constraint(
        "ck_activities_travel_mode",
        "activities",
        "travel_mode IN ('car', 'plane', 'train', 'bus')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_activities_travel_mode", "activities", type_="check")
    op.drop_column("activities", "travel_mode")
