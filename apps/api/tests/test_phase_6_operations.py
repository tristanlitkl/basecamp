"""Real-PostgreSQL Phase 6 cleanup and lightweight operational coverage."""

from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import app.main as main_module
from app.config import get_settings
from app.db.base import AsyncSessionLocal
from app.models.idempotency import IdempotencyRecord
from app.models.langgraph_run import LangGraphRun
from app.models.ledger import LedgerEntry
from app.models.plan import PlanMember
from app.services.cleanup_service import cleanup_expired, opportunistic_cleanup
from app.services.cleanup_scheduler import CleanupScheduler
from app.services.metrics_service import metrics
from app.scripts.seed_demo import DEMO_PLAN_ID, seed_demo
from sqlalchemy import func, select

from test_phase_1a5 import bearer, client_context, create_plan, sync_user


async def add_expiring_records(plan_id: str, user_id: str, *, expired_count: int = 1) -> list[UUID]:
    now = datetime.now(timezone.utc)
    ids: list[UUID] = []
    async with AsyncSessionLocal() as session:
        for index in range(expired_count):
            record = IdempotencyRecord(
                plan_id=UUID(plan_id),
                actor_id=UUID(user_id),
                client_operation_id=f"expired-{uuid4()}",
                request_hash="0" * 64,
                resource_type="test",
                status="completed",
                expires_at=now - timedelta(minutes=index + 1),
            )
            session.add(record)
            await session.flush()
            ids.append(record.id)
        session.add(
            IdempotencyRecord(
                plan_id=UUID(plan_id),
                actor_id=UUID(user_id),
                client_operation_id=f"active-{uuid4()}",
                request_hash="1" * 64,
                resource_type="test",
                status="in_progress",
                expires_at=now - timedelta(days=1),
            )
        )
        session.add(
            LangGraphRun(
                plan_id=UUID(plan_id),
                triggered_by_user_id=UUID(user_id),
                status="completed",
                base_plan_version=1,
                base_planning_version=1,
                expires_at=now - timedelta(days=1),
            )
        )
        session.add(
            LangGraphRun(
                plan_id=UUID(plan_id),
                triggered_by_user_id=UUID(user_id),
                status="running",
                base_plan_version=1,
                base_planning_version=1,
                expires_at=now - timedelta(days=1),
            )
        )
        session.add(
            LangGraphRun(
                plan_id=UUID(plan_id),
                triggered_by_user_id=UUID(user_id),
                status="completed",
                base_plan_version=1,
                base_planning_version=1,
                expires_at=None,
            )
        )
        await session.commit()
    return ids


async def cleanup_for_test(batch_size: int) -> dict:
    async with AsyncSessionLocal() as session:
        return (await cleanup_expired(session, batch_size=batch_size)).as_dict()


async def record_counts(plan_id: str) -> tuple[int, int, int, int]:
    async with AsyncSessionLocal() as session:
        expired_idempotency = await session.execute(
            select(func.count())
            .select_from(IdempotencyRecord)
            .where(
                IdempotencyRecord.plan_id == UUID(plan_id),
                IdempotencyRecord.status == "completed",
            )
        )
        active_idempotency = await session.execute(
            select(func.count())
            .select_from(IdempotencyRecord)
            .where(
                IdempotencyRecord.plan_id == UUID(plan_id),
                IdempotencyRecord.status == "in_progress",
            )
        )
        completed_runs = await session.execute(
            select(func.count())
            .select_from(LangGraphRun)
            .where(LangGraphRun.plan_id == UUID(plan_id), LangGraphRun.status == "completed")
        )
        running_runs = await session.execute(
            select(func.count())
            .select_from(LangGraphRun)
            .where(LangGraphRun.plan_id == UUID(plan_id), LangGraphRun.status == "running")
        )
        return (
            expired_idempotency.scalar_one(),
            active_idempotency.scalar_one(),
            completed_runs.scalar_one(),
            running_runs.scalar_one(),
        )


def test_cleanup_deletes_only_safe_expired_records_and_is_idempotent() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"phase6-cleanup-{uuid4()}")
        user_id = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()[
            "current_user_id"
        ]
        client.portal.call(add_expiring_records, plan_id, user_id)
        first = client.portal.call(cleanup_for_test, 10_000)
        counts_after_first = client.portal.call(record_counts, plan_id)
        second = client.portal.call(cleanup_for_test, 10_000)
        counts_after_second = client.portal.call(record_counts, plan_id)

    assert first["total_deleted"] >= 2
    assert counts_after_first == (0, 1, 1, 1)  # NULL-expiry completed run remains.
    assert second["total_deleted"] == 0
    assert counts_after_second == counts_after_first


def test_cleanup_batch_limit_and_authoritative_plan_rows_unchanged() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"phase6-batch-{uuid4()}")
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()
        user_id = snapshot["current_user_id"]
        client.portal.call(lambda: add_expiring_records(plan_id, user_id, expired_count=3))
        result = client.portal.call(cleanup_for_test, 1)
        after = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()

    resources = {item["resource"]: item["rows_deleted"] for item in result["resources"]}
    assert resources == {"idempotency_records": 1, "langgraph_runs": 1}
    assert after["plan"]["version"] == snapshot["plan"]["version"]
    assert after["plan"]["planning_version"] == snapshot["plan"]["planning_version"]
    assert after["latest_plan_events"] == snapshot["latest_plan_events"]
    assert after["ledger_entries"] == snapshot["ledger_entries"]


def test_admin_operations_require_explicit_application_admin_and_expose_safe_metrics() -> None:
    settings = get_settings()
    original_admin_emails = settings.admin_emails
    admin_subject = f"phase6-admin-{uuid4()}"
    settings.admin_emails = f"{admin_subject}@example.com"
    metrics.reset_for_tests()
    try:
        with client_context() as client:
            assert client.get("/admin/metrics").status_code == 401
            non_admin_jwt = sync_user(client, f"phase6-non-admin-{uuid4()}")
            assert client.get("/admin/metrics", headers=bearer(non_admin_jwt)).status_code == 403
            admin_jwt = sync_user(client, admin_subject)
            response = client.get("/admin/metrics", headers=bearer(admin_jwt))
            cleanup = client.post("/admin/cleanup/expired", headers=bearer(admin_jwt))
            health = client.get("/health")
    finally:
        settings.admin_emails = original_admin_emails

    assert response.status_code == 200
    assert cleanup.status_code == 200
    assert health.status_code == 200
    body = response.json()
    assert body["scope"] == "process_local"
    assert body["auth"]["failures"] >= 1
    assert "user" not in str(body).lower()
    assert "plan_id" not in str(body).lower()


def test_opportunistic_cleanup_is_throttled() -> None:
    settings = get_settings()
    opportunistic_cleanup.reset_for_tests()
    with client_context() as client:
        first = client.portal.call(opportunistic_cleanup.trigger, AsyncSessionLocal, settings)
        second = client.portal.call(opportunistic_cleanup.trigger, AsyncSessionLocal, settings)
    assert first is True
    assert second is False


async def demo_invariants() -> tuple[int, int]:
    async with AsyncSessionLocal() as session:
        member_count = (
            await session.execute(
                select(func.count())
                .select_from(PlanMember)
                .where(PlanMember.plan_id == DEMO_PLAN_ID)
            )
        ).scalar_one()
        ledger_total = (
            await session.execute(
                select(func.coalesce(func.sum(LedgerEntry.amount_cents), 0)).where(
                    LedgerEntry.plan_id == DEMO_PLAN_ID
                )
            )
        ).scalar_one()
        return member_count, ledger_total


def test_demo_seed_is_repeatable_and_ledger_is_zero_sum() -> None:
    with client_context() as client:
        first = client.portal.call(seed_demo)
        members, ledger_total = client.portal.call(demo_invariants)
        second = client.portal.call(seed_demo)

    assert first in {
        "Created deterministic Basecamp demo plan: Redwood Weekend.",
        "Basecamp demo already exists; no changes made.",
    }
    assert members == 3
    assert ledger_total == 0
    assert second == "Basecamp demo already exists; no changes made."


async def scheduler_lifecycle(settings) -> tuple[bool, bool]:
    scheduler = CleanupScheduler()
    settings.cleanup_scheduler_enabled = False
    scheduler.start(settings)
    disabled_running = scheduler.running
    settings.cleanup_scheduler_enabled = True
    scheduler.start(settings)
    enabled_running = scheduler.running
    scheduler.shutdown()
    return disabled_running, enabled_running


def test_scheduler_startup_is_explicit_and_shutdown_is_clean() -> None:
    settings = get_settings()
    original_enabled = settings.cleanup_scheduler_enabled
    try:
        with client_context() as client:
            disabled_running, enabled_running = client.portal.call(scheduler_lifecycle, settings)
    finally:
        settings.cleanup_scheduler_enabled = original_enabled
    assert disabled_running is False
    assert enabled_running is True


class UnavailableSession:
    async def __aenter__(self):
        raise OSError("database unavailable")

    async def __aexit__(self, *args):
        return False


def test_health_reports_database_failure_without_sensitive_details() -> None:
    original_factory = main_module.AsyncSessionLocal
    main_module.AsyncSessionLocal = UnavailableSession  # type: ignore[assignment]
    try:
        with client_context() as client:
            response = client.get("/health")
    finally:
        main_module.AsyncSessionLocal = original_factory

    assert response.status_code == 503
    assert response.json()["database"] == "unavailable"
    assert "database_url" not in response.text.lower()
