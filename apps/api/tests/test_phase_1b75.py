"""Phase 1B.75 permissions, privacy, and coordination integration tests."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

from test_phase_1a5 import bearer, client_context, create_plan, sync_user


def join_member(client, owner_jwt, plan_id):
    invite = client.post(f"/plans/{plan_id}/invites", headers=bearer(owner_jwt)).json()
    member_jwt = sync_user(client, f"member-{uuid4()}")
    assert (
        client.post(f"/invites/{invite['token']}/join", headers=bearer(member_jwt)).status_code
        == 200
    )
    member = client.get(f"/plans/{plan_id}/resync", headers=bearer(member_jwt)).json()["members"]
    return member_jwt, next(row for row in member if row["role"] == "member")["user_id"]


def test_display_name_roles_and_removed_member_access() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        updated = client.patch("/auth/me", json={"display_name": "Tris"}, headers=bearer(owner_jwt))
        member_jwt, member_id = join_member(client, owner_jwt, plan_id)
        promoted = client.patch(
            f"/plans/{plan_id}/members/{member_id}/role",
            json={"role": "co_owner"},
            headers=bearer(owner_jwt),
        )
        demoted = client.patch(
            f"/plans/{plan_id}/members/{member_id}/role",
            json={"role": "member"},
            headers=bearer(owner_jwt),
        )
        removed = client.delete(f"/plans/{plan_id}/members/{member_id}", headers=bearer(owner_jwt))
        denied = client.get(f"/plans/{plan_id}/resync", headers=bearer(member_jwt))
    assert updated.json()["display_name"] == "Tris"
    assert promoted.status_code == 200 and demoted.status_code == 200
    assert removed.status_code == 204 and denied.status_code == 403


def test_anonymous_votes_hide_other_voter_identity_in_resync() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, _ = join_member(client, owner_jwt, plan_id)
        activity = client.post(
            f"/plans/{plan_id}/activities", json={"name": "Vote"}, headers=bearer(owner_jwt)
        ).json()
        assert (
            client.put(
                f"/plans/{plan_id}/activities/{activity['id']}/vote",
                json={"vote": "yes"},
                headers=bearer(owner_jwt),
            ).status_code
            == 200
        )
        plan = client.get(f"/plans/{plan_id}", headers=bearer(owner_jwt)).json()
        assert (
            client.patch(
                f"/plans/{plan_id}/vote-visibility",
                json={"vote_visibility": "anonymous", "expected_version": plan["version"]},
                headers=bearer(owner_jwt),
            ).status_code
            == 200
        )
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(member_jwt)).json()
    assert snapshot["plan"]["vote_visibility"] == "anonymous"
    assert snapshot["activity_scores"][activity["id"]]["yes"] == 1
    assert snapshot["votes"] == []
    assert all(
        event["event_type"] != "activity.vote_updated" for event in snapshot["latest_plan_events"]
    )


def test_comments_suggestions_and_date_coordination_use_authoritative_state() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, _ = join_member(client, owner_jwt, plan_id)
        activity = client.post(
            f"/plans/{plan_id}/activities",
            json={"name": "Walk", "notes": "Old"},
            headers=bearer(owner_jwt),
        ).json()
        comment = client.post(
            f"/plans/{plan_id}/activities/{activity['id']}/comments",
            json={"body": "Looks good"},
            headers=bearer(member_jwt),
        )
        suggestion = client.post(
            f"/plans/{plan_id}/activities/{activity['id']}/suggestions",
            json={"suggestion_type": "change_notes", "proposed_changes_json": {"notes": "New"}},
            headers=bearer(member_jwt),
        ).json()
        accepted = client.post(
            f"/plans/{plan_id}/activities/{activity['id']}/suggestions/{suggestion['id']}/accept",
            json={"expected_activity_version": activity["version"]},
            headers=bearer(owner_jwt),
        )
        availability = client.put(
            f"/plans/{plan_id}/date-availability",
            json={"date": "2026-08-01", "status": "available"},
            headers=bearer(member_jwt),
        )
        date_suggestion = client.post(
            f"/plans/{plan_id}/date-suggestions",
            json={"starts_on": "2026-08-02", "ends_on": "2026-08-04"},
            headers=bearer(member_jwt),
        ).json()
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        accepted_date = client.post(
            f"/plans/{plan_id}/date-suggestions/{date_suggestion['id']}/accept",
            json={"expected_plan_version": snapshot["plan"]["version"]},
            headers=bearer(owner_jwt),
        )
    assert comment.status_code == 201 and accepted.status_code == 200
    assert availability.status_code == 200 and accepted_date.status_code == 200


def test_resync_includes_named_member_availability_for_calendar_aggregation() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, member_id = join_member(client, owner_jwt, plan_id)
        assert (
            client.patch(
                "/auth/me", json={"display_name": "Trip owner"}, headers=bearer(owner_jwt)
            ).status_code
            == 200
        )
        assert (
            client.patch(
                "/auth/me", json={"display_name": "Trip member"}, headers=bearer(member_jwt)
            ).status_code
            == 200
        )
        assert (
            client.put(
                f"/plans/{plan_id}/date-availability",
                json={"date": "2026-08-01", "status": "available"},
                headers=bearer(owner_jwt),
            ).status_code
            == 200
        )
        assert (
            client.put(
                f"/plans/{plan_id}/date-availability",
                json={"date": "2026-08-01", "status": "maybe"},
                headers=bearer(member_jwt),
            ).status_code
            == 200
        )
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()

    availability = snapshot["date_availability"]
    assert {entry["user_id"]: entry["status"] for entry in availability} == {
        snapshot["current_user_id"]: "available",
        member_id: "maybe",
    }
    assert {entry["member_display_name"] for entry in availability} == {"Trip owner", "Trip member"}
    assert all("email" not in entry for entry in availability)


def test_idempotency_concurrency_comment_suggestion_and_date_suggestion_create() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, _ = join_member(client, owner_jwt, plan_id)
        activity = client.post(
            f"/plans/{plan_id}/activities", json={"name": "Walk"}, headers=bearer(owner_jwt)
        ).json()

        def concurrent_post(path, payload):
            barrier = Barrier(2)

            def call():
                barrier.wait(timeout=5)
                response = client.post(path, json=payload, headers=bearer(member_jwt))
                return response.status_code, response.json()

            with ThreadPoolExecutor(max_workers=2) as executor:
                return list(executor.map(lambda _: call(), range(2)))

        comment_results = concurrent_post(
            f"/plans/{plan_id}/activities/{activity['id']}/comments",
            {"body": "One comment", "client_operation_id": "comment-op"},
        )
        suggestion_results = concurrent_post(
            f"/plans/{plan_id}/activities/{activity['id']}/suggestions",
            {
                "suggestion_type": "notes",
                "proposed_changes_json": {"notes": "New"},
                "client_operation_id": "suggestion-op",
            },
        )
        date_results = concurrent_post(
            f"/plans/{plan_id}/date-suggestions",
            {"starts_on": "2026-08-02", "ends_on": "2026-08-03", "client_operation_id": "date-op"},
        )
        conflicting = client.post(
            f"/plans/{plan_id}/activities/{activity['id']}/comments",
            json={"body": "Different", "client_operation_id": "comment-op"},
            headers=bearer(member_jwt),
        )
        before_decision = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        suggestion_id = suggestion_results[0][1]["id"]
        date_suggestion_id = date_results[0][1]["id"]
        barrier = Barrier(2)

        def accept_suggestion():
            barrier.wait(timeout=5)
            response = client.post(
                f"/plans/{plan_id}/activities/{activity['id']}/suggestions/{suggestion_id}/accept",
                json={
                    "expected_activity_version": activity["version"],
                    "client_operation_id": "accept-suggestion-op",
                },
                headers=bearer(owner_jwt),
            )
            return response.status_code, response.json()

        with ThreadPoolExecutor(max_workers=2) as executor:
            accepted_suggestion = list(executor.map(lambda _: accept_suggestion(), range(2)))
        barrier = Barrier(2)

        def accept_date():
            barrier.wait(timeout=5)
            response = client.post(
                f"/plans/{plan_id}/date-suggestions/{date_suggestion_id}/accept",
                json={
                    "expected_plan_version": before_decision["plan"]["version"],
                    "client_operation_id": "accept-date-op",
                },
                headers=bearer(owner_jwt),
            )
            return response.status_code, response.json()

        with ThreadPoolExecutor(max_workers=2) as executor:
            accepted_date = list(executor.map(lambda _: accept_date(), range(2)))
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
    for results in (comment_results, suggestion_results, date_results):
        assert [result[0] for result in results] == [201, 201]
        assert results[0][1] == results[1][1]
    assert conflicting.status_code == 409
    assert len(snapshot["activity_comments"]) == 1
    assert len(snapshot["activity_suggestions"]) == 1
    assert len(snapshot["date_suggestions"]) == 1
    assert [result[0] for result in accepted_suggestion] == [200, 200]
    assert accepted_suggestion[0][1] == accepted_suggestion[1][1]
    assert [result[0] for result in accepted_date] == [200, 200]
    assert accepted_date[0][1] == accepted_date[1][1]
    assert snapshot["plan"]["planning_version"] == before_decision["plan"]["planning_version"] + 2


def test_plan_travel_date_poll_and_plan_suggestion_adoption_preserve_content() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, _ = join_member(client, owner_jwt, plan_id)
        activity = client.post(
            f"/plans/{plan_id}/activities", json={"name": "Keep me"}, headers=bearer(owner_jwt)
        ).json()
        before = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        patched = client.patch(
            f"/plans/{plan_id}",
            json={
                "expected_version": before["plan"]["version"],
                "title": "Renamed",
                "travel_mode": "train",
                "travel_duration_minutes": 125,
            },
            headers=bearer(owner_jwt),
        )
        option = client.post(
            f"/plans/{plan_id}/date-suggestions",
            json={
                "starts_on": "2026-09-01",
                "ends_on": "2026-09-04",
                "client_operation_id": "date-option",
            },
            headers=bearer(member_jwt),
        ).json()
        vote = client.put(
            f"/plans/{plan_id}/date-suggestions/{option['id']}/vote",
            json={"vote": "yes", "client_operation_id": "date-vote"},
            headers=bearer(member_jwt),
        )
        idea = client.post(
            f"/plans/{plan_id}/plan-suggestions",
            json={
                "title": "Japan trip",
                "budget_cents": 250000,
                "client_operation_id": "plan-idea",
            },
            headers=bearer(member_jwt),
        ).json()
        current = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        adopted = client.post(
            f"/plans/{plan_id}/plan-suggestions/{idea['id']}/accept",
            json={
                "expected_plan_version": current["plan"]["version"],
                "client_operation_id": "adopt-plan",
            },
            headers=bearer(owner_jwt),
        )
        after = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
    assert patched.status_code == 200 and vote.status_code == 200 and adopted.status_code == 200
    assert patched.json()["planning_version"] == before["plan"]["planning_version"] + 1
    assert after["plan"]["title"] == "Japan trip"
    assert after["plan"]["version"] == current["plan"]["version"] + 1
    assert after["plan"]["planning_version"] == current["plan"]["planning_version"] + 1
    assert [row["id"] for row in after["activities"]] == [activity["id"]]
    assert after["ledger_entries"] == before["ledger_entries"]
    assert after["date_suggestions"][0]["yes_votes"] == 1
