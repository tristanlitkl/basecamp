"""phase 1b idempotency failure responses

Revision ID: 0005_phase_1b_idempotency_failures
Revises: 0004_phase_1b
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "0005_phase_1b_idempotency"
down_revision: str | None = "0004_phase_1b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("idempotency_records", sa.Column("response_status", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("idempotency_records", "response_status")
