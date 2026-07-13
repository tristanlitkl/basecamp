"""Opportunistic expiry cleanup shared by Phase 2 cache reads and future jobs."""

from datetime import datetime, timezone

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cache import PlaceCache, RouteCache, WeatherSnapshot


async def cleanup_expired_external_cache(
    session: AsyncSession, *, now: datetime | None = None
) -> int:
    """Delete expired Phase 2 cache records without changing planning state."""
    cutoff = now or datetime.now(timezone.utc)
    total = 0
    for model in (PlaceCache, RouteCache, WeatherSnapshot):
        result = await session.execute(delete(model).where(model.expires_at < cutoff))
        total += result.rowcount or 0
    return total
