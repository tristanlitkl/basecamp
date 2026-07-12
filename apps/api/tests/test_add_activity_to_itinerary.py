"""Real-PostgreSQL verification for adding an existing activity to an itinerary."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

from test_phase_1a5 import bearer, client_context, create_plan, sync_user


def join_member(client, owner_jwt: str, plan_id: str) -> str:
    invite = client.post(f"/plans/{plan_id}/invites", headers=bearer(owner_jwt)).json()
    member_jwt = sync_user(client, f"member-{uuid4()}")
    assert (
        client.post(f"/invites/{invite['token']}/join", headers=bearer(member_jwt)).status_code
        == 200
    )
    return member_jwt


def create_rich_activity(client, jwt: str, plan_id: str) -> dict:
    response = client.post(
        f"/plans/{plan_id}/activities",
        json={
            "name": "Canyon hike",
            "description": "Golden-hour loop",
            "address": "Trailhead Road",
            "lat": "37.7749",
            "lng": "-122.4194",
            "estimated_cost_cents": 2500,
            "estimated_duration_minutes": 180,
            "tags": ["outdoors", "sunset"],
            "notes": "Bring water",
            "client_operation_id": str(uuid4()),
        },
        headers=bearer(jwt),
    )
    assert response.status_code == 201
    return response.json()


def add_activity(
    client,
    jwt: str,
    plan_id: str,
    activity: dict,
    *,
    operation_id: str | None = None,
    expected_plan_version: int | None = None,
    title: str | None = None,
):
    payload = {
        "title": title or activity["name"],
        "activity_id": activity["id"],
        "client_operation_id": operation_id or str(uuid4()),
    }
    if expected_plan_version is not None:
        payload["expected_plan_version"] = expected_plan_version
    return client.post(f"/plans/{plan_id}/itinerary-items", json=payload, headers=bearer(jwt))


def test_add_activity_to_itinerary_creates_linked_item() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        activity = create_rich_activity(client, jwt, plan_id)
        before = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()
        response = add_activity(
            client, jwt, plan_id, activity, expected_plan_version=before["plan"]["version"]
        )
        after = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()

    assert response.status_code == 201
    assert len(after["itinerary_items"]) == 1
    item = after["itinerary_items"][0]
    assert item["activity_id"] == activity["id"]
    assert item["title"] == "Canyon hike"
    assert item["position_key"] == "1000"


def test_add_activity_to_itinerary_preserves_activity() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt = join_member(client, owner_jwt, plan_id)
        activity = create_rich_activity(client, owner_jwt, plan_id)
        assert (
            client.post(
                f"/plans/{plan_id}/activities/{activity['id']}/comments",
                json={"body": "Meet at 5", "client_operation_id": str(uuid4())},
                headers=bearer(member_jwt),
            ).status_code
            == 201
        )
        assert (
            client.put(
                f"/plans/{plan_id}/activities/{activity['id']}/vote",
                json={"vote": "yes"},
                headers=bearer(member_jwt),
            ).status_code
            == 200
        )
        before = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        assert (
            add_activity(
                client,
                owner_jwt,
                plan_id,
                activity,
                expected_plan_version=before["plan"]["version"],
            ).status_code
            == 201
        )
        after = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()

    preserved = next(row for row in after["activities"] if row["id"] == activity["id"])
    original = next(row for row in before["activities"] if row["id"] == activity["id"])
    assert preserved == original
    assert preserved["creator_display_name"]
    assert preserved["description"] == "Golden-hour loop"
    assert preserved["address"] == "Trailhead Road"
    assert preserved["estimated_cost_cents"] == 2500
    assert preserved["estimated_duration_minutes"] == 180
    assert preserved["tags"] == ["outdoors", "sunset"]
    assert preserved["notes"] == "Bring water"
    assert after["activity_comments"] == before["activity_comments"]
    assert after["votes"] == before["votes"]


def test_add_activity_to_itinerary_increments_planning_version_once() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        activity = create_rich_activity(client, jwt, plan_id)
        before = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()
        response = add_activity(
            client, jwt, plan_id, activity, expected_plan_version=before["plan"]["version"]
        )
        after = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()

    assert response.status_code == 201
    assert after["plan"]["planning_version"] == before["plan"]["planning_version"] + 1
    assert after["plan"]["version"] == before["plan"]["version"]
    assert len(after["latest_plan_events"]) == len(before["latest_plan_events"]) + 1


def test_add_activity_to_itinerary_rejects_stale_expected_version() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        activity = create_rich_activity(client, jwt, plan_id)
        before = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()
        assert (
            client.patch(
                f"/plans/{plan_id}",
                json={"title": "Changed plan", "expected_version": before["plan"]["version"]},
                headers=bearer(jwt),
            ).status_code
            == 200
        )
        response = add_activity(
            client, jwt, plan_id, activity, expected_plan_version=before["plan"]["version"]
        )
        after = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()

    assert response.status_code == 409
    assert after["itinerary_items"] == []
    assert after["plan"]["planning_version"] == before["plan"]["planning_version"] + 1


def test_add_activity_to_itinerary_rejects_finalized_plan() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        activity = create_rich_activity(client, jwt, plan_id)
        plan = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()["plan"]
        assert (
            client.post(
                f"/plans/{plan_id}/finalize",
                json={"expected_version": plan["version"]},
                headers=bearer(jwt),
            ).status_code
            == 200
        )
        response = add_activity(client, jwt, plan_id, activity)
        after = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()

    assert response.status_code == 409
    assert response.json()["detail"]["error"] == "plan_finalized"
    assert after["itinerary_items"] == []


def test_add_activity_to_itinerary_enforces_permissions() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt = join_member(client, owner_jwt, plan_id)
        outsider_jwt = sync_user(client, f"outsider-{uuid4()}")
        activity = create_rich_activity(client, owner_jwt, plan_id)
        member = add_activity(client, member_jwt, plan_id, activity)
        outsider = add_activity(client, outsider_jwt, plan_id, activity)
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()

    assert member.status_code == 201
    assert outsider.status_code == 403
    assert len(snapshot["itinerary_items"]) == 1


def test_add_activity_to_itinerary_idempotent_replay() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        activity = create_rich_activity(client, jwt, plan_id)
        before = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()
        operation_id = "add-activity-replay"
        first = add_activity(
            client,
            jwt,
            plan_id,
            activity,
            operation_id=operation_id,
            expected_plan_version=before["plan"]["version"],
        )
        replay = add_activity(
            client,
            jwt,
            plan_id,
            activity,
            operation_id=operation_id,
            expected_plan_version=before["plan"]["version"],
        )
        after = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()

    assert first.status_code == replay.status_code == 201
    assert first.json() == replay.json()
    assert len(after["itinerary_items"]) == 1
    assert after["plan"]["planning_version"] == before["plan"]["planning_version"] + 1
    assert len(after["latest_plan_events"]) == len(before["latest_plan_events"]) + 1


def test_add_activity_to_itinerary_changed_payload_returns_409() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        activity = create_rich_activity(client, jwt, plan_id)
        operation_id = "add-activity-changed-payload"
        assert (
            add_activity(client, jwt, plan_id, activity, operation_id=operation_id).status_code
            == 201
        )
        changed = add_activity(
            client, jwt, plan_id, activity, operation_id=operation_id, title="Different title"
        )
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()

    assert changed.status_code == 409
    assert changed.json()["detail"]["error"] == "idempotency_key_reused"
    assert len(snapshot["itinerary_items"]) == 1


def test_add_activity_to_itinerary_prevents_duplicate_item() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        activity = create_rich_activity(client, jwt, plan_id)
        before = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()
        barrier = Barrier(2)

        def attempt(operation_id: str):
            barrier.wait(timeout=10)
            return add_activity(client, jwt, plan_id, activity, operation_id=operation_id)

        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(attempt, ["duplicate-one", "duplicate-two"]))
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()

    assert sorted(response.status_code for response in responses) == [201, 409]
    assert len(snapshot["itinerary_items"]) == 1
    assert snapshot["itinerary_items"][0]["activity_id"] == activity["id"]
    assert snapshot["plan"]["planning_version"] == 3
    assert len(snapshot["latest_plan_events"]) == len(before["latest_plan_events"]) + 1
