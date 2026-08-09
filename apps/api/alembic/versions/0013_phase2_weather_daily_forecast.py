"""Store the cached Phase 2 seven-day weather forecast.

Revision ID: 0013_phase2_daily_weather
Revises: 0012_phase2_external_caches
"""

from alembic import op
import sqlalchemy as sa


revision = "0013_phase2_daily_weather"
down_revision = "0012_phase2_external_caches"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("weather_snapshots", sa.Column("daily_forecast", sa.JSON(), nullable=True))
    op.add_column("weather_snapshots", sa.Column("timezone", sa.String(length=64), nullable=True))


def downgrade() -> None:
    op.drop_column("weather_snapshots", "timezone")
    op.drop_column("weather_snapshots", "daily_forecast")
