"""phase 1a auth product shell

Revision ID: 0002_phase_1a
Revises: 0001_initial_phase_0
Create Date: 2026-07-09 00:00:00.000000
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "0002_phase_1a"
down_revision: str | None = "0001_initial_phase_0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("auth_subject", sa.String(length=255), nullable=True))
    op.create_unique_constraint("uq_users_auth_subject", "users", ["auth_subject"])

    op.add_column("activities", sa.Column("address", sa.String(length=255), nullable=True))
    op.add_column(
        "activities", sa.Column("estimated_duration_minutes", sa.Integer(), nullable=True)
    )
    op.add_column("activities", sa.Column("tags", sa.JSON(), nullable=True))
    op.add_column("activities", sa.Column("notes", sa.Text(), nullable=True))

    op.create_table(
        "plan_invites",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("plan_id", sa.Uuid(), nullable=False),
        sa.Column("created_by_user_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["plan_id"], ["plans.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash"),
    )
    op.create_table(
        "activity_votes",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("activity_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("vote", sa.String(length=16), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["activity_id"], ["activities.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("activity_id", "user_id", name="uq_activity_votes_activity_user"),
    )


def downgrade() -> None:
    op.drop_table("activity_votes")
    op.drop_table("plan_invites")
    op.drop_column("activities", "notes")
    op.drop_column("activities", "tags")
    op.drop_column("activities", "estimated_duration_minutes")
    op.drop_column("activities", "address")
    op.drop_constraint("uq_users_auth_subject", "users", type_="unique")
    op.drop_column("users", "auth_subject")
