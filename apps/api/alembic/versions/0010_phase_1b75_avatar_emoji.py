"""Add global curated emoji avatars for Basecamp users."""

from alembic import op
import sqlalchemy as sa


revision = "0010_phase1b75_avatar"
down_revision = "0009_phase1b75_history_archival"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("avatar_emoji", sa.String(length=16), nullable=False, server_default="🧭"),
    )
    op.alter_column("users", "avatar_emoji", server_default=None)


def downgrade() -> None:
    op.drop_column("users", "avatar_emoji")
