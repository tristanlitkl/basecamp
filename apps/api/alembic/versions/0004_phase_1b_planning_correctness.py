"""phase 1b planning correctness

Revision ID: 0004_phase_1b
Revises: 0003_phase_1a5
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0004_phase_1b"
down_revision: str | None = "0003_phase_1a5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "plans", sa.Column("status", sa.String(32), server_default="draft", nullable=False)
    )
    op.add_column("plans", sa.Column("starts_on", sa.DateTime(timezone=True), nullable=True))
    op.add_column("plans", sa.Column("ends_on", sa.DateTime(timezone=True), nullable=True))
    op.add_column("plans", sa.Column("max_drive_minutes", sa.Integer(), nullable=True))
    for table in ("activities", "itinerary_items", "expenses"):
        op.add_column(table, sa.Column("version", sa.Integer(), server_default="1", nullable=False))
    op.add_column(
        "expenses", sa.Column("status", sa.String(32), server_default="active", nullable=False)
    )
    op.create_table(
        "idempotency_records",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("plan_id", sa.Uuid(), nullable=False),
        sa.Column("actor_id", sa.Uuid(), nullable=False),
        sa.Column("client_operation_id", sa.String(120), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("resource_type", sa.String(80), nullable=False),
        sa.Column("resource_id", sa.Uuid(), nullable=True),
        sa.Column("response_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("failure_type", sa.String(32), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
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
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["plan_id"], ["plans.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "plan_id", "actor_id", "client_operation_id", name="uq_idempotency_claim"
        ),
    )
    op.execute("""
        CREATE FUNCTION prevent_ledger_mutation() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'ledger_entries are append-only'; END;
        $$ LANGUAGE plpgsql;
    """)
    op.execute(
        "CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation()"
    )
    op.execute(
        "CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation()"
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER ledger_entries_no_delete ON ledger_entries")
    op.execute("DROP TRIGGER ledger_entries_no_update ON ledger_entries")
    op.execute("DROP FUNCTION prevent_ledger_mutation()")
    op.drop_table("idempotency_records")
    op.drop_column("expenses", "status")
    for table in ("expenses", "itinerary_items", "activities"):
        op.drop_column(table, "version")
    op.drop_column("plans", "max_drive_minutes")
    op.drop_column("plans", "ends_on")
    op.drop_column("plans", "starts_on")
    op.drop_column("plans", "status")
