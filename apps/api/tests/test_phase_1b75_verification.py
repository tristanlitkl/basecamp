"""Real-PostgreSQL verification coverage for Phase 1B.75 coordination."""

from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from threading import Barrier
from uuid import uuid4

from test_phase_1a5 import bearer, client_context, create_activity, create_plan, sync_user


def _join_member(client, owner_jwt: str, plan_id: str) -> tuple[str, str]:
    invite = client.post(f"/plans/{plan_id}/invites", headers=bearer(owner_jwt)).json()
    member_jwt = sync_user(client, f"member-{uuid4()}")
    assert (
        client.post(f"/invites/{invite['token']}/join", headers=bearer(member_jwt)).status_code
        == 200
    )
    members = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()["members"]
    member = next(row for row in members if row["role"] == "member")
    return member_jwt, member["user_id"]


def _make_co_owner(client, owner_jwt: str, plan_id: str) -> str:
    member_jwt, member_id = _join_member(client, owner_jwt, plan_id)
    response = client.patch(
        f"/plans/{plan_id}/members/{member_id}/role",
        json={"role": "co_owner", "client_operation_id": str(uuid4())},
        headers=bearer(owner_jwt),
    )
    assert response.status_code == 200
    return member_jwt


def _date_suggestion(client, jwt: str, plan_id: str, start: str = "2026-09-10") -> str:
    response = client.post(
        f"/plans/{plan_id}/date-suggestions",
        json={
            "starts_on": start,
            "ends_on": (date.fromisoformat(start) + timedelta(days=2)).isoformat(),
            "client_operation_id": str(uuid4()),
        },
        headers=bearer(jwt),
    )
    assert response.status_code == 201
    return response.json()["id"]


def _plan_suggestion(client, jwt: str, plan_id: str, title: str = "North coast") -> str:
    response = client.post(
        f"/plans/{plan_id}/plan-suggestions",
        json={
            "title": title,
            "travel_mode": "train",
            "travel_duration_minutes": 145,
            "client_operation_id": str(uuid4()),
        },
        headers=bearer(jwt),
    )
    assert response.status_code == 201
    return response.json()["id"]


def _concurrent_posts(client, path: str, payloads: list[dict], jwt: str) -> list[tuple[int, dict]]:
    """Each FastAPI request receives an independent AsyncSession/transaction."""
    barrier = Barrier(len(payloads))

    def post(payload: dict) -> tuple[int, dict]:
        barrier.wait(timeout=10)
        response = client.post(path, json=payload, headers=bearer(jwt))
        return response.status_code, response.json()

    with ThreadPoolExecutor(max_workers=len(payloads)) as executor:
        return list(executor.map(post, payloads))


def test_concurrent_date_suggestion_accept_increments_versions_once() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, _ = _join_member(client, owner_jwt, plan_id)
        suggestion_id = _date_suggestion(client, member_jwt, plan_id)
        assert (
            client.put(
                f"/plans/{plan_id}/date-suggestions/{suggestion_id}/vote",
                json={"vote": "yes", "client_operation_id": str(uuid4())},
                headers=bearer(member_jwt),
            ).status_code
            == 200
        )
        before = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        results = _concurrent_posts(
            client,
            f"/plans/{plan_id}/date-suggestions/{suggestion_id}/accept",
            [
                {
                    "expected_plan_version": before["plan"]["version"],
                    "client_operation_id": str(uuid4()),
                },
                {
                    "expected_plan_version": before["plan"]["version"],
                    "client_operation_id": str(uuid4()),
                },
            ],
            owner_jwt,
        )
        after = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()

    assert sorted(status for status, _ in results) == [200, 409]
    assert after["plan"]["starts_on"].startswith("2026-09-10")
    assert after["plan"]["ends_on"].startswith("2026-09-12")
    assert after["plan"]["version"] == before["plan"]["version"] + 1
    assert after["plan"]["planning_version"] == before["plan"]["planning_version"] + 1
    assert after["date_suggestions"][0]["status"] == "accepted"
    assert after["date_suggestions"][0]["yes_votes"] == 1
    assert len(after["latest_plan_events"]) == len(before["latest_plan_events"]) + 1
    assert after["latest_plan_events"][0]["event_type"] == "date_suggestion.accepted"


def test_date_suggestion_accept_vs_dismiss_has_single_terminal_winner() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, _ = _join_member(client, owner_jwt, plan_id)
        suggestion_id = _date_suggestion(client, member_jwt, plan_id)
        before = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        paths = [
            f"/plans/{plan_id}/date-suggestions/{suggestion_id}/accept",
            f"/plans/{plan_id}/date-suggestions/{suggestion_id}/dismiss",
        ]
        barrier = Barrier(2)

        def post(path: str) -> int:
            barrier.wait(timeout=10)
            return client.post(
                path,
                json={
                    "expected_plan_version": before["plan"]["version"],
                    "client_operation_id": str(uuid4()),
                },
                headers=bearer(owner_jwt),
            ).status_code

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(post, paths))
        after = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()

    assert sorted(results) == [200, 409]
    terminal = after["date_suggestions"][0]["status"]
    assert terminal in {"accepted", "dismissed"}
    assert after["plan"]["version"] == before["plan"]["version"] + (terminal == "accepted")
    assert after["plan"]["planning_version"] == before["plan"]["planning_version"] + (
        terminal == "accepted"
    )


def test_concurrent_plan_suggestion_accept_applies_once() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        co_owner_jwt = _make_co_owner(client, owner_jwt, plan_id)
        member_jwt, _ = _join_member(client, owner_jwt, plan_id)
        activity_id = create_activity(client, owner_jwt, plan_id)
        owner_snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        owner_id = next(
            member for member in owner_snapshot["members"] if member["role"] == "owner"
        )["user_id"]
        assert (
            client.post(
                f"/plans/{plan_id}/activities/{activity_id}/comments",
                json={"body": "Keep the discussion", "client_operation_id": str(uuid4())},
                headers=bearer(member_jwt),
            ).status_code
            == 201
        )
        assert (
            client.put(
                f"/plans/{plan_id}/activities/{activity_id}/vote",
                json={"vote": "yes"},
                headers=bearer(member_jwt),
            ).status_code
            == 200
        )
        assert (
            client.post(
                f"/plans/{plan_id}/itinerary-items",
                json={"title": "Keep itinerary", "client_operation_id": str(uuid4())},
                headers=bearer(owner_jwt),
            ).status_code
            == 201
        )
        assert (
            client.post(
                f"/plans/{plan_id}/expenses",
                json={
                    "description": "Keep expense",
                    "amount_cents": 1200,
                    "paid_by_user_id": owner_id,
                    "participant_user_ids": [owner_id],
                    "client_operation_id": str(uuid4()),
                },
                headers=bearer(owner_jwt),
            ).status_code
            == 201
        )
        date_suggestion_id = _date_suggestion(client, member_jwt, plan_id, "2026-11-01")
        assert (
            client.put(
                f"/plans/{plan_id}/date-suggestions/{date_suggestion_id}/vote",
                json={"vote": "yes", "client_operation_id": str(uuid4())},
                headers=bearer(co_owner_jwt),
            ).status_code
            == 200
        )
        suggestion_id = _plan_suggestion(client, member_jwt, plan_id, "Rail escape")
        before = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        results = _concurrent_posts(
            client,
            f"/plans/{plan_id}/plan-suggestions/{suggestion_id}/accept",
            [
                {
                    "expected_plan_version": before["plan"]["version"],
                    "client_operation_id": str(uuid4()),
                },
                {
                    "expected_plan_version": before["plan"]["version"],
                    "client_operation_id": str(uuid4()),
                },
            ],
            owner_jwt,
        )
        after = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()

    assert sorted(status for status, _ in results) == [200, 409]
    assert after["plan"]["title"] == "Rail escape"
    assert after["plan"]["travel_mode"] == "train"
    assert after["plan"]["travel_duration_minutes"] == 145
    assert after["plan"]["version"] == before["plan"]["version"] + 1
    assert after["plan"]["planning_version"] == before["plan"]["planning_version"] + 1
    assert [activity["id"] for activity in after["activities"]] == [activity_id]
    assert after["plan_suggestions"][0]["status"] == "accepted"
    assert after["activities"] == before["activities"]
    assert after["itinerary_items"] == before["itinerary_items"]
    assert after["activity_comments"] == before["activity_comments"]
    assert after["votes"] == before["votes"]
    assert after["date_suggestions"][0] == before["date_suggestions"][0]
    assert after["expenses"] == before["expenses"]
    assert after["expense_splits"] == before["expense_splits"]
    assert after["ledger_entries"] == before["ledger_entries"]
    assert after["members"] == before["members"]
    assert (
        next(member for member in after["members"] if member["role"] == "owner")["user_id"]
        == owner_id
    )
    assert any(member["role"] == "co_owner" for member in after["members"])
    assert len(after["latest_plan_events"]) == len(before["latest_plan_events"]) + 1
    assert after["latest_plan_events"][0]["event_type"] == "plan_suggestion.accepted"


def test_plan_suggestion_accept_vs_dismiss_has_single_terminal_winner() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, _ = _join_member(client, owner_jwt, plan_id)
        suggestion_id = _plan_suggestion(client, member_jwt, plan_id)
        before = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        paths = [
            f"/plans/{plan_id}/plan-suggestions/{suggestion_id}/accept",
            f"/plans/{plan_id}/plan-suggestions/{suggestion_id}/dismiss",
        ]
        barrier = Barrier(2)

        def post(path: str) -> int:
            barrier.wait(timeout=10)
            return client.post(
                path,
                json={
                    "expected_plan_version": before["plan"]["version"],
                    "client_operation_id": str(uuid4()),
                },
                headers=bearer(owner_jwt),
            ).status_code

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(post, paths))
        after = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()

    assert sorted(results) == [200, 409]
    terminal = after["plan_suggestions"][0]["status"]
    assert terminal in {"accepted", "dismissed"}
    assert after["plan"]["version"] == before["plan"]["version"] + (terminal == "accepted")
    assert after["plan"]["planning_version"] == before["plan"]["planning_version"] + (
        terminal == "accepted"
    )


def test_owner_can_edit_plan_title_and_travel_details() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        before = client.get(f"/plans/{plan_id}", headers=bearer(owner_jwt)).json()
        response = client.patch(
            f"/plans/{plan_id}",
            json={
                "expected_version": before["version"],
                "title": "Owner edit",
                "travel_mode": "plane",
                "travel_duration_minutes": 75,
            },
            headers=bearer(owner_jwt),
        )
    assert response.status_code == 200
    assert response.json()["planning_version"] == before["planning_version"] + 1


def test_co_owner_can_edit_plan_title_and_travel_details() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        co_owner_jwt = _make_co_owner(client, owner_jwt, plan_id)
        before = client.get(f"/plans/{plan_id}", headers=bearer(co_owner_jwt)).json()
        response = client.patch(
            f"/plans/{plan_id}",
            json={
                "expected_version": before["version"],
                "title": "Co-owner edit",
                "travel_mode": "bus",
            },
            headers=bearer(co_owner_jwt),
        )
    assert response.status_code == 200
    assert response.json()["title"] == "Co-owner edit"


def test_member_cannot_edit_plan_title_or_travel_details() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, _ = _join_member(client, owner_jwt, plan_id)
        before = client.get(f"/plans/{plan_id}", headers=bearer(owner_jwt)).json()
        response = client.patch(
            f"/plans/{plan_id}",
            json={"expected_version": before["version"], "title": "Nope", "travel_mode": "car"},
            headers=bearer(member_jwt),
        )
    assert response.status_code == 403


def test_owner_can_accept_and_dismiss_date_suggestions() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        accepted_id = _date_suggestion(client, owner_jwt, plan_id, "2026-10-01")
        current = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        accepted = client.post(
            f"/plans/{plan_id}/date-suggestions/{accepted_id}/accept",
            json={
                "expected_plan_version": current["plan"]["version"],
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(owner_jwt),
        )
        dismissed_id = _date_suggestion(client, owner_jwt, plan_id, "2026-10-15")
        current = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        dismissed = client.post(
            f"/plans/{plan_id}/date-suggestions/{dismissed_id}/dismiss",
            json={
                "expected_plan_version": current["plan"]["version"],
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(owner_jwt),
        )
    assert accepted.status_code == dismissed.status_code == 200


def test_co_owner_can_accept_and_dismiss_date_suggestions() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        co_owner_jwt = _make_co_owner(client, owner_jwt, plan_id)
        accepted_id = _date_suggestion(client, owner_jwt, plan_id, "2026-10-01")
        current = client.get(f"/plans/{plan_id}/resync", headers=bearer(co_owner_jwt)).json()
        accepted = client.post(
            f"/plans/{plan_id}/date-suggestions/{accepted_id}/accept",
            json={
                "expected_plan_version": current["plan"]["version"],
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(co_owner_jwt),
        )
        dismissed_id = _date_suggestion(client, owner_jwt, plan_id, "2026-10-15")
        current = client.get(f"/plans/{plan_id}/resync", headers=bearer(co_owner_jwt)).json()
        dismissed = client.post(
            f"/plans/{plan_id}/date-suggestions/{dismissed_id}/dismiss",
            json={
                "expected_plan_version": current["plan"]["version"],
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(co_owner_jwt),
        )
    assert accepted.status_code == dismissed.status_code == 200


def test_member_cannot_accept_or_dismiss_date_suggestions() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, _ = _join_member(client, owner_jwt, plan_id)
        accepted_id = _date_suggestion(client, owner_jwt, plan_id, "2026-10-01")
        dismissed_id = _date_suggestion(client, owner_jwt, plan_id, "2026-10-15")
        current = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        accepted = client.post(
            f"/plans/{plan_id}/date-suggestions/{accepted_id}/accept",
            json={
                "expected_plan_version": current["plan"]["version"],
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(member_jwt),
        )
        dismissed = client.post(
            f"/plans/{plan_id}/date-suggestions/{dismissed_id}/dismiss",
            json={
                "expected_plan_version": current["plan"]["version"],
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(member_jwt),
        )
    assert accepted.status_code == dismissed.status_code == 403


def test_owner_can_accept_and_dismiss_plan_suggestions() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        accepted_id = _plan_suggestion(client, owner_jwt, plan_id, "Owner accepts")
        current = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        accepted = client.post(
            f"/plans/{plan_id}/plan-suggestions/{accepted_id}/accept",
            json={
                "expected_plan_version": current["plan"]["version"],
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(owner_jwt),
        )
        dismissed_id = _plan_suggestion(client, owner_jwt, plan_id, "Owner dismisses")
        current = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        dismissed = client.post(
            f"/plans/{plan_id}/plan-suggestions/{dismissed_id}/dismiss",
            json={
                "expected_plan_version": current["plan"]["version"],
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(owner_jwt),
        )
    assert accepted.status_code == dismissed.status_code == 200


def test_co_owner_can_accept_and_dismiss_plan_suggestions() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        co_owner_jwt = _make_co_owner(client, owner_jwt, plan_id)
        accepted_id = _plan_suggestion(client, owner_jwt, plan_id, "Co-owner accepts")
        current = client.get(f"/plans/{plan_id}/resync", headers=bearer(co_owner_jwt)).json()
        accepted = client.post(
            f"/plans/{plan_id}/plan-suggestions/{accepted_id}/accept",
            json={
                "expected_plan_version": current["plan"]["version"],
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(co_owner_jwt),
        )
        dismissed_id = _plan_suggestion(client, owner_jwt, plan_id, "Co-owner dismisses")
        current = client.get(f"/plans/{plan_id}/resync", headers=bearer(co_owner_jwt)).json()
        dismissed = client.post(
            f"/plans/{plan_id}/plan-suggestions/{dismissed_id}/dismiss",
            json={
                "expected_plan_version": current["plan"]["version"],
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(co_owner_jwt),
        )
    assert accepted.status_code == dismissed.status_code == 200


def test_member_cannot_accept_or_dismiss_plan_suggestions() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, _ = _join_member(client, owner_jwt, plan_id)
        accepted_id = _plan_suggestion(client, owner_jwt, plan_id, "Member cannot accept")
        dismissed_id = _plan_suggestion(client, owner_jwt, plan_id, "Member cannot dismiss")
        current = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        accepted = client.post(
            f"/plans/{plan_id}/plan-suggestions/{accepted_id}/accept",
            json={
                "expected_plan_version": current["plan"]["version"],
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(member_jwt),
        )
        dismissed = client.post(
            f"/plans/{plan_id}/plan-suggestions/{dismissed_id}/dismiss",
            json={
                "expected_plan_version": current["plan"]["version"],
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(member_jwt),
        )
    assert accepted.status_code == dismissed.status_code == 403


def test_date_suggestion_accept_idempotency_replays_completed_response() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, _ = _join_member(client, owner_jwt, plan_id)
        suggestion_id = _date_suggestion(client, member_jwt, plan_id)
        before = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        payload = {
            "expected_plan_version": before["plan"]["version"],
            "client_operation_id": "date-replay",
        }
        first = client.post(
            f"/plans/{plan_id}/date-suggestions/{suggestion_id}/accept",
            json=payload,
            headers=bearer(owner_jwt),
        )
        replay = client.post(
            f"/plans/{plan_id}/date-suggestions/{suggestion_id}/accept",
            json=payload,
            headers=bearer(owner_jwt),
        )
        changed = client.post(
            f"/plans/{plan_id}/date-suggestions/{suggestion_id}/accept",
            json={**payload, "expected_plan_version": payload["expected_plan_version"] + 1},
            headers=bearer(owner_jwt),
        )
        after = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()

    assert first.status_code == replay.status_code == 200
    assert first.json() == replay.json()
    assert changed.status_code == 409
    assert after["plan"]["version"] == before["plan"]["version"] + 1
    assert after["plan"]["planning_version"] == before["plan"]["planning_version"] + 1


def test_plan_suggestion_accept_permanent_failure_replays_same_error() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, _ = _join_member(client, owner_jwt, plan_id)
        suggestion_id = _plan_suggestion(client, member_jwt, plan_id)
        before = client.get(f"/plans/{plan_id}", headers=bearer(owner_jwt)).json()
        assert (
            client.post(
                f"/plans/{plan_id}/finalize",
                json={"expected_version": before["version"]},
                headers=bearer(owner_jwt),
            ).status_code
            == 200
        )
        finalized = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        payload = {
            "expected_plan_version": finalized["plan"]["version"],
            "client_operation_id": "finalized-adoption",
        }
        first = client.post(
            f"/plans/{plan_id}/plan-suggestions/{suggestion_id}/accept",
            json=payload,
            headers=bearer(owner_jwt),
        )
        replay = client.post(
            f"/plans/{plan_id}/plan-suggestions/{suggestion_id}/accept",
            json=payload,
            headers=bearer(owner_jwt),
        )
        after = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()

    assert first.status_code == replay.status_code == 409
    assert first.json() == replay.json()
    assert after["plan"]["version"] == finalized["plan"]["version"]
    assert after["plan"]["planning_version"] == finalized["plan"]["planning_version"]
    assert after["plan_suggestions"][0]["status"] == "open"


def test_date_vote_upsert_keeps_one_vote_per_member_and_does_not_increment_plan_versions() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, _ = _join_member(client, owner_jwt, plan_id)
        suggestion_id = _date_suggestion(client, member_jwt, plan_id)
        before = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        for vote in ("yes", "maybe"):
            assert (
                client.put(
                    f"/plans/{plan_id}/date-suggestions/{suggestion_id}/vote",
                    json={"vote": vote, "client_operation_id": str(uuid4())},
                    headers=bearer(member_jwt),
                ).status_code
                == 200
            )
        after = client.get(f"/plans/{plan_id}/resync", headers=bearer(member_jwt)).json()

    option = after["date_suggestions"][0]
    assert (option["yes_votes"], option["maybe_votes"], option["no_votes"], option["vote"]) == (
        0,
        1,
        0,
        "maybe",
    )
    assert after["plan"]["version"] == before["plan"]["version"]
    assert after["plan"]["planning_version"] == before["plan"]["planning_version"]
