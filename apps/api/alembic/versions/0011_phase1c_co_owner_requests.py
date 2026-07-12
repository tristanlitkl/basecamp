"""Add durable co-owner access requests for Phase 1C."""

from alembic import op
import sqlalchemy as sa


revision = "0011_phase1c_co_owner_requests"
down_revision = "0010_phase1b75_avatar"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "co_owner_requests",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("plan_id", sa.Uuid(), nullable=False),
        sa.Column("requester_user_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="pending"),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("decided_by_user_id", sa.Uuid(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'denied', 'withdrawn')",
            name="ck_co_owner_request_status",
        ),
        sa.ForeignKeyConstraint(["decided_by_user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["plan_id"], ["plans.id"]),
        sa.ForeignKeyConstraint(["requester_user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_co_owner_request_pending_member",
        "co_owner_requests",
        ["plan_id", "requester_user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index("uq_co_owner_request_pending_member", table_name="co_owner_requests")
    op.drop_table("co_owner_requests")
