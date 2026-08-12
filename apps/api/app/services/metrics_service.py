"""Small, process-local operational counters for the single-instance MVP."""

from collections import Counter
from datetime import datetime, timezone
from threading import Lock
from typing import Any


class MetricsService:
    """Counters are intentionally per-process and reset when the API restarts."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._counters: Counter[str] = Counter()
        self._cleanup_deleted: Counter[str] = Counter()
        self._last_cleanup_success_at: datetime | None = None

    def increment(self, name: str, value: int = 1) -> None:
        with self._lock:
            self._counters[name] += value

    def record_cleanup(self, deleted: dict[str, int], *, successful: bool) -> None:
        with self._lock:
            self._counters["cleanup_runs"] += 1
            if not successful:
                self._counters["cleanup_failures"] += 1
                return
            self._last_cleanup_success_at = datetime.now(timezone.utc)
            for resource, count in deleted.items():
                self._cleanup_deleted[resource] += count

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "scope": "process_local",
                "resets_on_restart": True,
                "requests": {
                    "total": self._counters["requests_total"],
                    "4xx": self._counters["requests_4xx"],
                    "5xx": self._counters["requests_5xx"],
                },
                "auth": {"failures": self._counters["auth_failures"]},
                "realtime": {
                    "websocket_connects": self._counters["websocket_connects"],
                    "websocket_disconnects": self._counters["websocket_disconnects"],
                    "resync_requests": self._counters["resync_requests"],
                },
                "planning": {
                    "runs_started": self._counters["planning_runs_started"],
                    "runs_completed": self._counters["planning_runs_completed"],
                    "runs_invalid": self._counters["planning_runs_invalid"],
                    "runs_stale": self._counters["planning_runs_stale"],
                    "runs_applied": self._counters["planning_runs_applied"],
                    "apply_conflicts": self._counters["planning_apply_conflicts"],
                },
                "notifications": {"created": self._counters["notifications_created"]},
                "cleanup": {
                    "runs": self._counters["cleanup_runs"],
                    "failures": self._counters["cleanup_failures"],
                    "rows_deleted": dict(sorted(self._cleanup_deleted.items())),
                    "last_successful_at": (
                        self._last_cleanup_success_at.isoformat()
                        if self._last_cleanup_success_at
                        else None
                    ),
                },
                "database": {"errors": self._counters["database_errors"]},
            }

    def reset_for_tests(self) -> None:
        with self._lock:
            self._counters.clear()
            self._cleanup_deleted.clear()
            self._last_cleanup_success_at = None


metrics = MetricsService()
