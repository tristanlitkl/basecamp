"""Lifecycle-managed APScheduler wrapper for the shared cleanup service."""

import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from app.config import Settings
from app.db.base import AsyncSessionLocal
from app.services.cleanup_service import run_cleanup

logger = logging.getLogger(__name__)


class CleanupScheduler:
    def __init__(self) -> None:
        self._scheduler: AsyncIOScheduler | None = None

    @property
    def running(self) -> bool:
        return self._scheduler is not None and self._scheduler.running

    def start(self, settings: Settings) -> None:
        if not settings.cleanup_enabled or not settings.cleanup_scheduler_enabled or self.running:
            return
        try:
            scheduler = AsyncIOScheduler(timezone="UTC")
            scheduler.add_job(
                run_cleanup,
                trigger="interval",
                minutes=settings.cleanup_interval_minutes,
                args=[AsyncSessionLocal, settings],
                id="basecamp-expired-cleanup",
                replace_existing=True,
                max_instances=1,
                coalesce=True,
            )
            scheduler.start()
            self._scheduler = scheduler
        except Exception:
            logger.exception("cleanup_scheduler_start_failed")

    def shutdown(self) -> None:
        if self._scheduler is None:
            return
        try:
            self._scheduler.shutdown(wait=False)
        except Exception:
            logger.exception("cleanup_scheduler_shutdown_failed")
        finally:
            self._scheduler = None


cleanup_scheduler = CleanupScheduler()
