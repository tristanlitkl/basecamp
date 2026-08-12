"""Real-PostgreSQL integration coverage for deterministic planning status."""

from uuid import uuid4

from app.db.base import AsyncSessionLocal
from app.models.event import PlanEvent
from app.models.notification import Notification
from app.models.plan import Plan
from app.services import planning_status_service
from sqlalchemy import select, update

from tests.test_phase_1a5 import bearer, client_context, create_activity, create_plan, sync_user


def planning_status(client, token: str, plan_id: str) -> dict:
    response = client.get(f"/plans/{plan_id}/planning-status", headers=bearer(token))
    assert response.status_code == 200
    return response.json()


def snapshot(client, token: str, plan_id: str) -> dict:
    response = client.get(f"/plans/{plan_id}/resync", headers=bearer(token))
    assert response.status_code == 200
    return response.json()


def test_status_is_deterministic_and_read_only() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        before = snapshot(client, token, plan_id)
        first = planning_status(client, token, plan_id)
        second = planning_status(client, token, plan_id)
        after = snapshot(client, token, plan_id)

    assert first == second
    assert first["overall_status"] == "needs_attention"
    assert first["blockers"][0]["reason_code"] == "itinerary_empty"
    assert after["plan"]["version"] == before["plan"]["version"]
    assert after["plan"]["planning_version"] == before["plan"]["planning_version"]
    assert after["latest_plan_events"] == before["latest_plan_events"]


def test_strong_candidate_not_in_itinerary_uses_saved_recommendation() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        activity_id = create_activity(client, token, plan_id)
        assert (
            client.put(
                f"/plans/{plan_id}/activities/{activity_id}/vote",
                json={"vote": "yes"},
                headers=bearer(token),
            ).status_code
            == 200
        )
        result = planning_status(client, token, plan_id)

    candidate = next(
        warning
        for warning in result["warnings"]
        if warning["reason_code"] == "strong_candidate_not_in_itinerary"
    )
    assert candidate["entity_ids"] == [activity_id]
    assert all("vote_score" not in issue for issue in result["warnings"])


def test_unscheduled_item_is_blocking_but_scheduled_item_is_not() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        item = client.post(
            f"/plans/{plan_id}/itinerary-items", json={"title": "Dinner"}, headers=bearer(token)
        ).json()
        unscheduled = planning_status(client, token, plan_id)
        assert (
            client.patch(
                f"/plans/{plan_id}/itinerary-items/{item['id']}",
                json={"starts_at": "2027-01-01T18:00:00Z", "expected_version": item["version"]},
                headers=bearer(token),
            ).status_code
            == 200
        )
        scheduled = planning_status(client, token, plan_id)

    assert any(
        issue["reason_code"] == "itinerary_item_unscheduled" for issue in unscheduled["blockers"]
    )
    assert all(
        issue["reason_code"] != "itinerary_item_unscheduled" for issue in scheduled["blockers"]
    )
    assert scheduled["overall_status"] == "ready"


def test_date_and_budget_conflicts_only_use_authoritative_data() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        plan = client.get(f"/plans/{plan_id}", headers=bearer(token)).json()
        assert (
            client.patch(
                f"/plans/{plan_id}",
                json={
                    "budget_cents": 1000,
                    "starts_on": "2027-01-01T00:00:00Z",
                    "ends_on": "2027-01-01T00:00:00Z",
                    "expected_version": plan["version"],
                },
                headers=bearer(token),
            ).status_code
            == 200
        )
        activity = client.post(
            f"/plans/{plan_id}/activities",
            json={"name": "Expensive", "estimated_cost_cents": 1001},
            headers=bearer(token),
        ).json()
        assert (
            client.post(
                f"/plans/{plan_id}/itinerary-items",
                json={
                    "title": "Expensive",
                    "activity_id": activity["id"],
                    "starts_at": "2027-01-02T12:00:00Z",
                },
                headers=bearer(token),
            ).status_code
            == 201
        )
        result = planning_status(client, token, plan_id)

    assert any(issue["reason_code"] == "date_conflict" for issue in result["blockers"])
    assert any(issue["reason_code"] == "budget_conflict" for issue in result["warnings"])


def test_status_requires_membership_and_finalized_plan_is_finalized() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        outsider = sync_user(client, f"outsider-{uuid4()}")
        assert (
            client.get(f"/plans/{plan_id}/planning-status", headers=bearer(outsider)).status_code
            == 403
        )
        plan = client.get(f"/plans/{plan_id}", headers=bearer(token)).json()
        assert (
            client.post(
                f"/plans/{plan_id}/finalize",
                json={"expected_version": plan["version"]},
                headers=bearer(token),
            ).status_code
            == 200
        )
        result = planning_status(client, token, plan_id)

    assert result["overall_status"] == "finalized"
    assert result["readiness_state"] == "finalized"
    assert result["suggested_actions"] == []


def test_status_never_creates_notifications_or_events() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")

        async def counts() -> tuple[int, int, int, int]:
            async with AsyncSessionLocal() as session:
                plan = (await session.execute(select(Plan).where(Plan.id == plan_id))).scalar_one()
                events = len(
                    (await session.execute(select(PlanEvent).where(PlanEvent.plan_id == plan_id)))
                    .scalars()
                    .all()
                )
                notifications = len(
                    (
                        await session.execute(
                            select(Notification).where(Notification.plan_id == plan_id)
                        )
                    )
                    .scalars()
                    .all()
                )
                return plan.version, plan.planning_version, events, notifications

        before = client.portal.call(counts)
        planning_status(client, token, plan_id)
        after = client.portal.call(counts)

    assert after == before


def test_stale_run_reloads_authoritative_plan_counters(monkeypatch) -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        before = client.get(f"/plans/{plan_id}", headers=bearer(token)).json()
        original_load = planning_status_service._load_state
        calls = 0

        async def change_version_after_first_load(session, requested_plan_id):
            nonlocal calls
            state = await original_load(session, requested_plan_id)
            calls += 1
            if calls == 1:
                async with AsyncSessionLocal() as newer_state_session:
                    await newer_state_session.execute(
                        update(Plan)
                        .where(Plan.id == requested_plan_id)
                        .values(version=Plan.version + 1)
                    )
                    await newer_state_session.commit()
            return state

        monkeypatch.setattr(planning_status_service, "_load_state", change_version_after_first_load)

        async def read() -> dict:
            async with AsyncSessionLocal() as session:
                return (
                    await planning_status_service.read_planning_status(session, plan_id)
                ).model_dump()

        result = client.portal.call(read)

    assert calls == 2
    assert result["plan_version"] == before["version"] + 1
