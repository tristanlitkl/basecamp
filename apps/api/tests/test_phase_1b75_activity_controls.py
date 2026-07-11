"""Regression coverage for Phase 1B.75 activity editing and travel persistence."""

from uuid import uuid4

from test_phase_1a5 import bearer, client_context, create_plan


def test_activity_edit_accepts_null_optional_cost_and_resyncs_authoritative_state() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        created = client.post(
            f"/plans/{plan_id}/activities",
            json={"name": "Walk", "estimated_duration_minutes": 90},
            headers=bearer(jwt),
        ).json()
        response = client.patch(
            f"/plans/{plan_id}/activities/{created['id']}",
            json={
                "name": "Sunset walk",
                "estimated_cost_cents": None,
                "estimated_duration_minutes": 125,
                "tags": ["outdoors"],
                "expected_version": created["version"],
            },
            headers=bearer(jwt),
        )
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()

    assert response.status_code == 200
    activity = snapshot["activities"][0]
    assert activity["name"] == "Sunset walk"
    assert activity["estimated_cost_cents"] is None
    assert activity["estimated_duration_minutes"] == 125
    assert activity["tags"] == ["outdoors"]
    assert activity["version"] == 2


def test_activity_travel_mode_create_edit_validation_and_resync() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        created = client.post(
            f"/plans/{plan_id}/activities",
            json={"name": "Museum", "travel_mode": "train"},
            headers=bearer(jwt),
        ).json()
        invalid = client.patch(
            f"/plans/{plan_id}/activities/{created['id']}",
            json={"travel_mode": "boat", "expected_version": created["version"]},
            headers=bearer(jwt),
        )
        edited = client.patch(
            f"/plans/{plan_id}/activities/{created['id']}",
            json={"travel_mode": "plane", "expected_version": created["version"]},
            headers=bearer(jwt),
        )
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()

    assert created["travel_mode"] == "train"
    assert invalid.status_code == 422
    assert edited.status_code == 200
    assert edited.json()["travel_mode"] == "plane"
    assert snapshot["activities"][0]["travel_mode"] == "plane"


def test_existing_activity_without_travel_mode_returns_null() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        client.post(f"/plans/{plan_id}/activities", json={"name": "Coffee"}, headers=bearer(jwt))
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()

    assert snapshot["activities"][0]["travel_mode"] is None
