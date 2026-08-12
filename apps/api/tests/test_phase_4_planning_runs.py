"""Real-PostgreSQL Phase 4 deterministic draft and stale-apply coverage."""

from uuid import uuid4

from tests.test_phase_1a5 import bearer, client_context, create_activity, create_plan


def planning_run(client, token: str, plan_id: str) -> dict:
    response = client.post(f"/plans/{plan_id}/planning-runs", headers=bearer(token))
    assert response.status_code == 201, response.text
    return response.json()


def resync(client, token: str, plan_id: str) -> dict:
    response = client.get(f"/plans/{plan_id}/resync", headers=bearer(token))
    assert response.status_code == 200
    return response.json()


def test_draft_is_fresh_deterministic_and_has_no_authoritative_side_effects() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"phase4-owner-{uuid4()}")
        create_activity(client, token, plan_id)
        before = resync(client, token, plan_id)
        first = planning_run(client, token, plan_id)
        second = planning_run(client, token, plan_id)
        after = resync(client, token, plan_id)

    assert first["status"] == "completed"
    assert first["draft_status"] == "fresh"
    assert first["base_planning_version"] == before["plan"]["planning_version"]
    assert first["draft"]["days"] == second["draft"]["days"]
    assert after["plan"]["version"] == before["plan"]["version"]
    assert after["plan"]["planning_version"] == before["plan"]["planning_version"]
    assert after["itinerary_items"] == before["itinerary_items"]
    assert after["latest_plan_events"] == before["latest_plan_events"]


def test_stale_apply_is_409_and_writes_no_partial_itinerary_rows() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"phase4-stale-owner-{uuid4()}")
        activity_id = create_activity(client, token, plan_id)
        run = planning_run(client, token, plan_id)
        assert (
            client.put(
                f"/plans/{plan_id}/activities/{activity_id}/vote",
                json={"vote": "yes"},
                headers=bearer(token),
            ).status_code
            == 200
        )
        before_apply = resync(client, token, plan_id)
        response = client.post(
            f"/plans/{plan_id}/planning-runs/{run['id']}/apply", headers=bearer(token)
        )
        after_apply = resync(client, token, plan_id)
        read = client.get(f"/plans/{plan_id}/planning-runs/{run['id']}", headers=bearer(token))

    assert response.status_code == 409
    assert response.json()["detail"]["error"] == "draft_stale"
    assert after_apply["itinerary_items"] == before_apply["itinerary_items"]
    assert after_apply["plan"]["planning_version"] == before_apply["plan"]["planning_version"]
    assert read.json()["draft_status"] == "stale"


def test_fresh_apply_is_atomic_single_planning_mutation_and_cannot_repeat() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"phase4-apply-owner-{uuid4()}")
        create_activity(client, token, plan_id)
        create_activity(client, token, plan_id)
        run = planning_run(client, token, plan_id)
        before = resync(client, token, plan_id)
        applied = client.post(
            f"/plans/{plan_id}/planning-runs/{run['id']}/apply", headers=bearer(token)
        )
        after = resync(client, token, plan_id)
        repeated = client.post(
            f"/plans/{plan_id}/planning-runs/{run['id']}/apply", headers=bearer(token)
        )

    assert applied.status_code == 200, applied.text
    assert len(applied.json()["applied_item_ids"]) == 2
    assert len(after["itinerary_items"]) == 2
    assert after["plan"]["version"] == before["plan"]["version"]
    assert after["plan"]["planning_version"] == before["plan"]["planning_version"] + 1
    assert after["latest_plan_events"][0]["event_type"] == "itinerary_draft.applied"
    assert repeated.status_code == 409
