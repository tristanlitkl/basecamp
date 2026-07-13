"""Add expiring external API caches for Phase 2.

Revision ID: 0012_phase2_external_caches
Revises: 0011_phase1c_co_owner_requests
"""

from alembic import op
import sqlalchemy as sa


revision = "0012_phase2_external_caches"
down_revision = "0011_phase1c_co_owner_requests"
branch_labels = None
depends_on = None


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "place_cache",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("cache_key", sa.String(length=64), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="ok"),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("cache_key", name="uq_place_cache_key"),
    )
    op.create_index("ix_place_cache_expires_at", "place_cache", ["expires_at"])
    op.create_table(
        "route_cache",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("cache_key", sa.String(length=64), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("estimate_status", sa.String(length=16), nullable=False, server_default="ok"),
        sa.Column("distance_meters", sa.Float(), nullable=False),
        sa.Column("duration_minutes", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("cache_key", name="uq_route_cache_key"),
    )
    op.create_index("ix_route_cache_expires_at", "route_cache", ["expires_at"])
    op.create_table(
        "weather_snapshots",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("cache_key", sa.String(length=64), nullable=False),
        sa.Column("latitude", sa.Numeric(precision=9, scale=6), nullable=False),
        sa.Column("longitude", sa.Numeric(precision=9, scale=6), nullable=False),
        sa.Column("forecast_hour", sa.String(length=32), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="ok"),
        sa.Column("temperature_celsius", sa.Float(), nullable=True),
        sa.Column("weather_code", sa.Integer(), nullable=True),
        sa.Column("weather_score", sa.Float(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("cache_key", name="uq_weather_snapshots_key"),
    )
    op.create_index("ix_weather_snapshots_expires_at", "weather_snapshots", ["expires_at"])


def downgrade() -> None:
    op.drop_index("ix_weather_snapshots_expires_at", table_name="weather_snapshots")
    op.drop_table("weather_snapshots")
    op.drop_index("ix_route_cache_expires_at", table_name="route_cache")
    op.drop_table("route_cache")
    op.drop_index("ix_place_cache_expires_at", table_name="place_cache")
    op.drop_table("place_cache")
