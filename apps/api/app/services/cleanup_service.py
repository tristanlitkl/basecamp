"""Bounded deletion of expired, non-authoritative operational records."""

import asyncio
import logging
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.models.idempotency import IdempotencyRecord
from app.models.langgraph_run import LangGraphRun
from app.services.metrics_service import metrics

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CleanupResourceStats:
    resource: str
    rows_deleted: int


@dataclass(frozen=True)
class CleanupResult:
    started_at: datetime
    completed_at: datetime
    resources: tuple[CleanupResourceStats, ...]

    @property
    def total_deleted(self) -> int:
        return sum(item.rows_deleted for item in self.resources)

    def as_dict(self) -> dict:
        return {
            "started_at": self.started_at.isoformat(),
            "completed_at": self.completed_at.isoformat(),
            "resources": [asdict(item) for item in self.resources],
            "total_deleted": self.total_deleted,
        }


async def _delete_expired_idempotency(session: AsyncSession, now: datetime, limit: int) -> int:
    # Active in-progress claims are never deleted, even if an old expiry is present.
    eligible = (
        select(IdempotencyRecord.id)
        .where(
            IdempotencyRecord.expires_at <= now,
            IdempotencyRecord.status.in_(("completed", "failed")),
        )
        .order_by(IdempotencyRecord.expires_at.asc(), IdempotencyRecord.id.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
        .cte("expired_idempotency")
    )
    deleted = await session.execute(
        delete(IdempotencyRecord)
        .where(IdempotencyRecord.id.in_(select(eligible.c.id)))
        .returning(IdempotencyRecord.id)
    )
    return len(deleted.scalars().all())


async def _delete_expired_langgraph_runs(session: AsyncSession, now: datetime, limit: int) -> int:
    # A running/pending graph run is retained irrespective of expiry; NULL is no expiry policy.
    eligible = (
        select(LangGraphRun.id)
        .where(
            LangGraphRun.expires_at.is_not(None),
            LangGraphRun.expires_at <= now,
            LangGraphRun.status.in_(("completed", "failed")),
        )
        .order_by(LangGraphRun.expires_at.asc(), LangGraphRun.id.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
        .cte("expired_langgraph_runs")
    )
    deleted = await session.execute(
        delete(LangGraphRun)
        .where(LangGraphRun.id.in_(select(eligible.c.id)))
        .returning(LangGraphRun.id)
    )
    return len(deleted.scalars().all())


async def cleanup_expired(session: AsyncSession, *, batch_size: int) -> CleanupResult:
    """Delete one stable, bounded batch from every current expiration-backed resource."""
    if batch_size < 1:
        raise ValueError("batch_size must be positive")
    started_at = datetime.now(timezone.utc)
    now = started_at
    try:
        idempotency_deleted = await _delete_expired_idempotency(session, now, batch_size)
        langgraph_deleted = await _delete_expired_langgraph_runs(session, now, batch_size)
        await session.commit()
    except Exception:
        await session.rollback()
        raise
    result = CleanupResult(
        started_at=started_at,
        completed_at=datetime.now(timezone.utc),
        resources=(
            CleanupResourceStats("idempotency_records", idempotency_deleted),
            CleanupResourceStats("langgraph_runs", langgraph_deleted),
        ),
    )
    metrics.record_cleanup(
        {item.resource: item.rows_deleted for item in result.resources}, successful=True
    )
    return result


async def run_cleanup(
    session_factory: async_sessionmaker[AsyncSession], settings: Settings
) -> CleanupResult | None:
    if not settings.cleanup_enabled:
        return None
    try:
        async with session_factory() as session:
            return await cleanup_expired(session, batch_size=settings.cleanup_batch_size)
    except Exception:
        metrics.record_cleanup({}, successful=False)
        logger.exception("cleanup_failed")
        return None


class OpportunisticCleanup:
    """Process-local throttle only; database state remains authoritative."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._last_attempt = 0.0
        self._tasks: set[asyncio.Task[CleanupResult | None]] = set()

    async def trigger(
        self, session_factory: async_sessionmaker[AsyncSession], settings: Settings
    ) -> bool:
        if not settings.cleanup_enabled:
            return False
        now = time.monotonic()
        async with self._lock:
            if now - self._last_attempt < settings.cleanup_interval_minutes * 60:
                return False
            self._last_attempt = now
        task = asyncio.create_task(run_cleanup(session_factory, settings))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return True

    async def shutdown(self) -> None:
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()

    def reset_for_tests(self) -> None:
        self._last_attempt = 0.0


opportunistic_cleanup = OpportunisticCleanup()
