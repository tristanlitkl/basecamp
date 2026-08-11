"""Real-PostgreSQL integration coverage for Phase 3 recommendations."""

from uuid import UUID, uuid4

from app.db.base import AsyncSessionLocal, Base
from app.services.recommendation_service import (
    BUDGET_WEIGHT,
    MAX_SCORE,
    PREFERENCE_WEIGHT,
    SCHEDULE_WEIGHT,
    VOTE_WEIGHT,
    _weighted_total,
    recompute_plan_scores,
)
from tests.test_phase_1a5 import bearer, client_context, create_activity, create_plan, sync_user


def recommendations(client, token: str, plan_id: str) -> list[dict]:
    response = client.get(f"/plans/{plan_id}/recommendations", headers=bearer(token))
    assert response.status_code == 200
    return response.json()


def recommendation(client, token: str, plan_id: str, activity_id: str) -> dict:
    return next(
        row for row in recommendations(client, token, plan_id) if row["activity_id"] == activity_id
    )


def snapshot(client, token: str, plan_id: str) -> dict:
    response = client.get(f"/plans/{plan_id}/resync", headers=bearer(token))
    assert response.status_code == 200
    return response.json()


def recompute_derived_scores(client, plan_id: str) -> None:
    async def recompute() -> None:
        async with AsyncSessionLocal() as session:
            await recompute_plan_scores(session, UUID(plan_id))
            await session.commit()

    client.portal.call(recompute)


def test_identical_state_has_identical_ranking_and_stable_tie_breaking() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        first = create_activity(client, token, plan_id)
        second = create_activity(client, token, plan_id)
        first_read = recommendations(client, token, plan_id)
        second_read = recommendations(client, token, plan_id)

    assert first_read == second_read
    assert {item["activity_id"] for item in first_read} == {first, second}
    assert [item["rank"] for item in first_read] == [1, 2]
    assert all(item["total_score"] == 500 for item in first_read)


def test_vote_semantics_anonymous_privacy_and_missing_votes() -> None:
    with client_context() as client:
        owner_token, plan_id = create_plan(client, f"owner-{uuid4()}")
        activity_id = create_activity(client, owner_token, plan_id)
        invite = client.post(f"/plans/{plan_id}/invites", headers=bearer(owner_token)).json()[
            "token"
        ]
        member_token = sync_user(client, f"member-{uuid4()}")
        assert (
            client.post(f"/invites/{invite}/join", headers=bearer(member_token)).status_code == 200
        )
        missing = recommendations(client, owner_token, plan_id)[0]
        assert missing["vote_score"] == 500
        assert "Limited voting data" in missing["reasons"]
        assert (
            client.put(
                f"/plans/{plan_id}/activities/{activity_id}/vote",
                json={"vote": "yes"},
                headers=bearer(owner_token),
            ).status_code
            == 200
        )
        assert (
            client.put(
                f"/plans/{plan_id}/activities/{activity_id}/vote",
                json={"vote": "maybe"},
                headers=bearer(member_token),
            ).status_code
            == 200
        )
        public = recommendations(client, owner_token, plan_id)[0]
        version = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_token)).json()[
            "plan"
        ]["version"]
        assert (
            client.patch(
                f"/plans/{plan_id}/vote-visibility",
                json={"vote_visibility": "anonymous", "expected_version": version},
                headers=bearer(owner_token),
            ).status_code
            == 200
        )
        anonymous = recommendations(client, owner_token, plan_id)[0]

    assert public["vote_score"] == 875  # (+2 yes +1 maybe, scaled across two members)
    assert anonymous["vote_score"] == public["vote_score"]
    assert all("user" not in key and "voter" not in key for key in anonymous)
    assert not any(
        "owner-" in str(value) or "member-" in str(value) for value in anonymous.values()
    )


def test_negative_vote_budget_and_missing_budget_cost_are_bounded() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        plan = client.get(f"/plans/{plan_id}", headers=bearer(token)).json()
        assert (
            client.patch(
                f"/plans/{plan_id}",
                json={"budget_cents": 1000, "expected_version": plan["version"]},
                headers=bearer(token),
            ).status_code
            == 200
        )
        expensive = client.post(
            f"/plans/{plan_id}/activities",
            json={"name": "Expensive", "estimated_cost_cents": 1001},
            headers=bearer(token),
        ).json()["id"]
        neutral = create_activity(client, token, plan_id)
        assert (
            client.put(
                f"/plans/{plan_id}/activities/{expensive}/vote",
                json={"vote": "no"},
                headers=bearer(token),
            ).status_code
            == 200
        )
        rows = {row["activity_id"]: row for row in recommendations(client, token, plan_id)}

    assert rows[expensive]["vote_score"] == 0
    assert rows[expensive]["budget_score"] == 0
    assert rows[expensive]["total_score"] == 125  # 0*50% + 0*25% + 500*25%
    assert rows[neutral]["budget_score"] == 500
    assert all(0 <= row["total_score"] <= 1000 for row in rows.values())


def test_schedule_date_fit_and_unscheduled_neutral_state() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        plan = client.get(f"/plans/{plan_id}", headers=bearer(token)).json()
        assert (
            client.patch(
                f"/plans/{plan_id}",
                json={
                    "starts_on": "2026-12-31T00:00:00Z",
                    "ends_on": "2027-01-01T00:00:00Z",
                    "expected_version": plan["version"],
                },
                headers=bearer(token),
            ).status_code
            == 200
        )
        scheduled = create_activity(client, token, plan_id)
        unscheduled = create_activity(client, token, plan_id)
        assert (
            client.put(
                f"/plans/{plan_id}/date-availability",
                json={"date": "2027-01-01", "status": "available"},
                headers=bearer(token),
            ).status_code
            == 200
        )
        assert (
            client.post(
                f"/plans/{plan_id}/itinerary-items",
                json={
                    "title": "Scheduled",
                    "activity_id": scheduled,
                    "starts_at": "2027-01-01T10:00:00Z",
                    "client_operation_id": str(uuid4()),
                },
                headers=bearer(token),
            ).status_code
            == 201
        )
        rows = {row["activity_id"]: row for row in recommendations(client, token, plan_id)}

    assert rows[scheduled]["schedule_fit_score"] == 1000
    assert "Matches available dates" in rows[scheduled]["reasons"]
    assert rows[unscheduled]["schedule_fit_score"] == 500
    assert "Schedule details unavailable" in rows[unscheduled]["reasons"]


def test_recompute_after_mutation_is_transactional_and_does_not_bump_versions() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        activity_id = create_activity(client, token, plan_id)
        before = client.get(f"/plans/{plan_id}/resync", headers=bearer(token)).json()
        assert (
            client.put(
                f"/plans/{plan_id}/activities/{activity_id}/vote",
                json={"vote": "yes"},
                headers=bearer(token),
            ).status_code
            == 200
        )
        after = client.get(f"/plans/{plan_id}/resync", headers=bearer(token)).json()
        rows = recommendations(client, token, plan_id)

    before_activity = next(item for item in before["activities"] if item["id"] == activity_id)
    after_activity = next(item for item in after["activities"] if item["id"] == activity_id)
    assert after["plan"]["version"] == before["plan"]["version"]
    assert after["plan"]["planning_version"] == before["plan"]["planning_version"]
    assert after_activity["version"] == before_activity["version"]
    assert rows[0]["vote_score"] == 1000


def test_recommendations_require_membership_and_exclude_deleted_activity() -> None:
    with client_context() as client:
        owner_token, plan_id = create_plan(client, f"owner-{uuid4()}")
        activity_id = create_activity(client, owner_token, plan_id)
        outsider_token = sync_user(client, f"outsider-{uuid4()}")
        denied = client.get(f"/plans/{plan_id}/recommendations", headers=bearer(outsider_token))
        detail = client.get(f"/plans/{plan_id}", headers=bearer(owner_token)).json()
        activity = next(item for item in detail["activities"] if item["id"] == activity_id)
        assert (
            client.delete(
                f"/plans/{plan_id}/activities/{activity_id}?expected_version={activity['version']}",
                headers=bearer(owner_token),
            ).status_code
            == 204
        )
        remaining = recommendations(client, owner_token, plan_id)

    assert denied.status_code == 403
    assert remaining == []


def test_weighted_total_uses_documented_integer_formula_truncation_and_bounds() -> None:
    assert (VOTE_WEIGHT, BUDGET_WEIGHT, SCHEDULE_WEIGHT, PREFERENCE_WEIGHT) == (500, 250, 250, 0)
    # 333 * 500 + 666 * 250 + 999 * 250 = 582750: floor division must return 582.
    assert _weighted_total(333, 666, 999) == 582
    assert _weighted_total(0, 0, 0) == 0
    assert _weighted_total(MAX_SCORE, MAX_SCORE, MAX_SCORE) == MAX_SCORE


def test_preference_is_neutral_unweighted_and_cannot_change_ranking() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        first = create_activity(client, token, plan_id)
        second = create_activity(client, token, plan_id)
        rows = recommendations(client, token, plan_id)
        state = snapshot(client, token, plan_id)

    assert PREFERENCE_WEIGHT == 0
    assert all(row["preference_score"] == 500 for row in rows)
    assert all(row["total_score"] == 500 for row in rows)
    assert [row["activity_id"] for row in rows] == [first, second]
    assert len(rows) == len(state["activities"])
    assert all("preference" not in vote for vote in state["votes"])
    assert not any("preference" in table_name for table_name in Base.metadata.tables)


def test_recompute_after_activity_cost_mutation_refreshes_only_score_inputs() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        plan = client.get(f"/plans/{plan_id}", headers=bearer(token)).json()
        assert (
            client.patch(
                f"/plans/{plan_id}",
                json={"budget_cents": 1000, "expected_version": plan["version"]},
                headers=bearer(token),
            ).status_code
            == 200
        )
        activity = client.post(
            f"/plans/{plan_id}/activities",
            json={"name": "Cost", "estimated_cost_cents": 1001},
            headers=bearer(token),
        ).json()
        before = recommendation(client, token, plan_id, activity["id"])
        assert (
            client.patch(
                f"/plans/{plan_id}/activities/{activity['id']}",
                json={"estimated_cost_cents": 1000, "expected_version": activity["version"]},
                headers=bearer(token),
            ).status_code
            == 200
        )
        after = recommendation(client, token, plan_id, activity["id"])

    assert before["budget_score"] == 0
    assert after["budget_score"] == 1000
    assert after["total_score"] > before["total_score"]


def test_recompute_after_plan_budget_update_refreshes_budget_score() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        activity_id = client.post(
            f"/plans/{plan_id}/activities",
            json={"name": "Budget", "estimated_cost_cents": 1000},
            headers=bearer(token),
        ).json()["id"]
        before = recommendation(client, token, plan_id, activity_id)
        plan = client.get(f"/plans/{plan_id}", headers=bearer(token)).json()
        assert (
            client.patch(
                f"/plans/{plan_id}",
                json={"budget_cents": 1000, "expected_version": plan["version"]},
                headers=bearer(token),
            ).status_code
            == 200
        )
        after = recommendation(client, token, plan_id, activity_id)

    assert before["budget_score"] == 500
    assert after["budget_score"] == 1000
    assert after["total_score"] > before["total_score"]


def test_recompute_after_plan_date_update_refreshes_schedule_score() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        plan = client.get(f"/plans/{plan_id}", headers=bearer(token)).json()
        assert (
            client.patch(
                f"/plans/{plan_id}",
                json={
                    "starts_on": "2027-01-01T00:00:00Z",
                    "ends_on": "2027-01-01T00:00:00Z",
                    "expected_version": plan["version"],
                },
                headers=bearer(token),
            ).status_code
            == 200
        )
        activity_id = create_activity(client, token, plan_id)
        assert (
            client.put(
                f"/plans/{plan_id}/date-availability",
                json={"date": "2027-01-02", "status": "available"},
                headers=bearer(token),
            ).status_code
            == 200
        )
        assert (
            client.post(
                f"/plans/{plan_id}/itinerary-items",
                json={
                    "title": "Scheduled",
                    "activity_id": activity_id,
                    "starts_at": "2027-01-02T10:00:00Z",
                    "client_operation_id": str(uuid4()),
                },
                headers=bearer(token),
            ).status_code
            == 201
        )
        before = recommendation(client, token, plan_id, activity_id)
        current = client.get(f"/plans/{plan_id}", headers=bearer(token)).json()
        assert (
            client.patch(
                f"/plans/{plan_id}",
                json={
                    "starts_on": "2027-01-02T00:00:00Z",
                    "ends_on": "2027-01-02T00:00:00Z",
                    "expected_version": current["version"],
                },
                headers=bearer(token),
            ).status_code
            == 200
        )
        after = recommendation(client, token, plan_id, activity_id)

    assert before["schedule_fit_score"] == 0
    assert after["schedule_fit_score"] == 1000


def test_recompute_after_date_availability_mutation_refreshes_schedule_score() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        plan = client.get(f"/plans/{plan_id}", headers=bearer(token)).json()
        assert (
            client.patch(
                f"/plans/{plan_id}",
                json={
                    "starts_on": "2027-01-01T00:00:00Z",
                    "ends_on": "2027-01-01T00:00:00Z",
                    "expected_version": plan["version"],
                },
                headers=bearer(token),
            ).status_code
            == 200
        )
        activity_id = create_activity(client, token, plan_id)
        assert (
            client.post(
                f"/plans/{plan_id}/itinerary-items",
                json={
                    "title": "Scheduled",
                    "activity_id": activity_id,
                    "starts_at": "2027-01-01T10:00:00Z",
                    "client_operation_id": str(uuid4()),
                },
                headers=bearer(token),
            ).status_code
            == 201
        )
        before = recommendation(client, token, plan_id, activity_id)
        assert (
            client.put(
                f"/plans/{plan_id}/date-availability",
                json={"date": "2027-01-01", "status": "unavailable"},
                headers=bearer(token),
            ).status_code
            == 200
        )
        after = recommendation(client, token, plan_id, activity_id)

    assert before["schedule_fit_score"] == 500
    assert after["schedule_fit_score"] == 0
    assert after["total_score"] < before["total_score"]


def test_recompute_after_accepted_activity_cost_suggestion_refreshes_budget_score() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        plan = client.get(f"/plans/{plan_id}", headers=bearer(token)).json()
        assert (
            client.patch(
                f"/plans/{plan_id}",
                json={"budget_cents": 1000, "expected_version": plan["version"]},
                headers=bearer(token),
            ).status_code
            == 200
        )
        activity = client.post(
            f"/plans/{plan_id}/activities",
            json={"name": "Suggested cost", "estimated_cost_cents": 1001},
            headers=bearer(token),
        ).json()
        suggestion = client.post(
            f"/plans/{plan_id}/activities/{activity['id']}/suggestions",
            json={
                "suggestion_type": "cost",
                "proposed_changes_json": {"estimated_cost_cents": 1000},
            },
            headers=bearer(token),
        ).json()
        before = recommendation(client, token, plan_id, activity["id"])
        assert (
            client.post(
                f"/plans/{plan_id}/activities/{activity['id']}/suggestions/{suggestion['id']}/accept",
                json={"expected_activity_version": activity["version"]},
                headers=bearer(token),
            ).status_code
            == 200
        )
        after = recommendation(client, token, plan_id, activity["id"])

    assert before["budget_score"] == 0
    assert after["budget_score"] == 1000


def test_recompute_after_accepted_date_suggestion_refreshes_schedule_score() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        plan = client.get(f"/plans/{plan_id}", headers=bearer(token)).json()
        assert (
            client.patch(
                f"/plans/{plan_id}",
                json={
                    "starts_on": "2027-01-01T00:00:00Z",
                    "ends_on": "2027-01-01T00:00:00Z",
                    "expected_version": plan["version"],
                },
                headers=bearer(token),
            ).status_code
            == 200
        )
        activity_id = create_activity(client, token, plan_id)
        assert (
            client.put(
                f"/plans/{plan_id}/date-availability",
                json={"date": "2027-01-02", "status": "available"},
                headers=bearer(token),
            ).status_code
            == 200
        )
        assert (
            client.post(
                f"/plans/{plan_id}/itinerary-items",
                json={
                    "title": "Scheduled",
                    "activity_id": activity_id,
                    "starts_at": "2027-01-02T10:00:00Z",
                    "client_operation_id": str(uuid4()),
                },
                headers=bearer(token),
            ).status_code
            == 201
        )
        before = recommendation(client, token, plan_id, activity_id)
        current = snapshot(client, token, plan_id)
        suggestion = client.post(
            f"/plans/{plan_id}/date-suggestions",
            json={"starts_on": "2027-01-02", "ends_on": "2027-01-02"},
            headers=bearer(token),
        ).json()
        assert (
            client.post(
                f"/plans/{plan_id}/date-suggestions/{suggestion['id']}/accept",
                json={"expected_plan_version": current["plan"]["version"]},
                headers=bearer(token),
            ).status_code
            == 200
        )
        after = recommendation(client, token, plan_id, activity_id)

    assert before["schedule_fit_score"] == 0
    assert after["schedule_fit_score"] == 1000


def test_recompute_after_accepted_plan_budget_suggestion_refreshes_budget_score() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        plan = client.get(f"/plans/{plan_id}", headers=bearer(token)).json()
        assert (
            client.patch(
                f"/plans/{plan_id}",
                json={"budget_cents": 1000, "expected_version": plan["version"]},
                headers=bearer(token),
            ).status_code
            == 200
        )
        activity_id = client.post(
            f"/plans/{plan_id}/activities",
            json={"name": "Plan-suggested budget", "estimated_cost_cents": 1001},
            headers=bearer(token),
        ).json()["id"]
        before = recommendation(client, token, plan_id, activity_id)
        suggestion = client.post(
            f"/plans/{plan_id}/plan-suggestions",
            json={
                "title": "Raise budget",
                "budget_cents": 2000,
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(token),
        ).json()
        current = snapshot(client, token, plan_id)
        assert (
            client.post(
                f"/plans/{plan_id}/plan-suggestions/{suggestion['id']}/accept",
                json={
                    "expected_plan_version": current["plan"]["version"],
                    "client_operation_id": str(uuid4()),
                },
                headers=bearer(token),
            ).status_code
            == 200
        )
        after = recommendation(client, token, plan_id, activity_id)

    assert before["budget_score"] == 0
    assert after["budget_score"] == 1000


def test_recompute_after_scheduled_itinerary_mutation_refreshes_schedule_score() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        plan = client.get(f"/plans/{plan_id}", headers=bearer(token)).json()
        assert (
            client.patch(
                f"/plans/{plan_id}",
                json={
                    "starts_on": "2027-01-01T00:00:00Z",
                    "ends_on": "2027-01-01T00:00:00Z",
                    "expected_version": plan["version"],
                },
                headers=bearer(token),
            ).status_code
            == 200
        )
        activity_id = create_activity(client, token, plan_id)
        assert (
            client.put(
                f"/plans/{plan_id}/date-availability",
                json={"date": "2027-01-01", "status": "available"},
                headers=bearer(token),
            ).status_code
            == 200
        )
        before = recommendation(client, token, plan_id, activity_id)
        assert (
            client.post(
                f"/plans/{plan_id}/itinerary-items",
                json={
                    "title": "Scheduled",
                    "activity_id": activity_id,
                    "starts_at": "2027-01-01T10:00:00Z",
                    "client_operation_id": str(uuid4()),
                },
                headers=bearer(token),
            ).status_code
            == 201
        )
        after = recommendation(client, token, plan_id, activity_id)

    assert before["schedule_fit_score"] == 500
    assert after["schedule_fit_score"] == 1000


def test_recompute_after_scheduled_itinerary_start_update_refreshes_schedule_score() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        plan = client.get(f"/plans/{plan_id}", headers=bearer(token)).json()
        assert (
            client.patch(
                f"/plans/{plan_id}",
                json={
                    "starts_on": "2027-01-01T00:00:00Z",
                    "ends_on": "2027-01-02T00:00:00Z",
                    "expected_version": plan["version"],
                },
                headers=bearer(token),
            ).status_code
            == 200
        )
        activity_id = create_activity(client, token, plan_id)
        assert (
            client.put(
                f"/plans/{plan_id}/date-availability",
                json={"date": "2027-01-01", "status": "available"},
                headers=bearer(token),
            ).status_code
            == 200
        )
        item = client.post(
            f"/plans/{plan_id}/itinerary-items",
            json={
                "title": "Scheduled",
                "activity_id": activity_id,
                "starts_at": "2027-01-01T10:00:00Z",
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(token),
        ).json()
        before = recommendation(client, token, plan_id, activity_id)
        assert (
            client.patch(
                f"/plans/{plan_id}/itinerary-items/{item['id']}",
                json={"starts_at": "2027-01-02T10:00:00Z", "expected_version": item["version"]},
                headers=bearer(token),
            ).status_code
            == 200
        )
        after = recommendation(client, token, plan_id, activity_id)

    assert before["schedule_fit_score"] == 1000
    assert after["schedule_fit_score"] == 500


def test_recompute_after_scheduled_itinerary_removal_refreshes_schedule_score() -> None:
    with client_context() as client:
        token, plan_id = create_plan(client, f"owner-{uuid4()}")
        plan = client.get(f"/plans/{plan_id}", headers=bearer(token)).json()
        assert (
            client.patch(
                f"/plans/{plan_id}",
                json={
                    "starts_on": "2027-01-01T00:00:00Z",
                    "ends_on": "2027-01-01T00:00:00Z",
                    "expected_version": plan["version"],
                },
                headers=bearer(token),
            ).status_code
            == 200
        )
        activity_id = create_activity(client, token, plan_id)
        assert (
            client.put(
                f"/plans/{plan_id}/date-availability",
                json={"date": "2027-01-01", "status": "available"},
                headers=bearer(token),
            ).status_code
            == 200
        )
        item = client.post(
            f"/plans/{plan_id}/itinerary-items",
            json={
                "title": "Scheduled",
                "activity_id": activity_id,
                "starts_at": "2027-01-01T10:00:00Z",
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(token),
        ).json()
        before = recommendation(client, token, plan_id, activity_id)
        assert (
            client.delete(
                f"/plans/{plan_id}/itinerary-items/{item['id']}?expected_version={item['version']}",
                headers=bearer(token),
            ).status_code
            == 204
        )
        after = recommendation(client, token, plan_id, activity_id)

    assert before["schedule_fit_score"] == 1000
    assert after["schedule_fit_score"] == 500


def test_recompute_after_member_join_refreshes_vote_normalization() -> None:
    with client_context() as client:
        owner_token, plan_id = create_plan(client, f"owner-{uuid4()}")
        activity_id = create_activity(client, owner_token, plan_id)
        assert (
            client.put(
                f"/plans/{plan_id}/activities/{activity_id}/vote",
                json={"vote": "yes"},
                headers=bearer(owner_token),
            ).status_code
            == 200
        )
        before = recommendation(client, owner_token, plan_id, activity_id)
        invite = client.post(f"/plans/{plan_id}/invites", headers=bearer(owner_token)).json()[
            "token"
        ]
        member_token = sync_user(client, f"member-{uuid4()}")
        assert (
            client.post(f"/invites/{invite}/join", headers=bearer(member_token)).status_code == 200
        )
        after = recommendation(client, owner_token, plan_id, activity_id)

    assert before["vote_score"] == 1000
    assert after["vote_score"] == 750


def test_recompute_after_member_removal_refreshes_vote_normalization() -> None:
    with client_context() as client:
        owner_token, plan_id = create_plan(client, f"owner-{uuid4()}")
        activity_id = create_activity(client, owner_token, plan_id)
        assert (
            client.put(
                f"/plans/{plan_id}/activities/{activity_id}/vote",
                json={"vote": "yes"},
                headers=bearer(owner_token),
            ).status_code
            == 200
        )
        invite = client.post(f"/plans/{plan_id}/invites", headers=bearer(owner_token)).json()[
            "token"
        ]
        member_token = sync_user(client, f"member-{uuid4()}")
        assert (
            client.post(f"/invites/{invite}/join", headers=bearer(member_token)).status_code == 200
        )
        member_id = next(
            member["user_id"]
            for member in snapshot(client, owner_token, plan_id)["members"]
            if member["user_id"] != snapshot(client, owner_token, plan_id)["current_user_id"]
        )
        before = recommendation(client, owner_token, plan_id, activity_id)
        assert (
            client.delete(
                f"/plans/{plan_id}/members/{member_id}", headers=bearer(owner_token)
            ).status_code
            == 204
        )
        after = recommendation(client, owner_token, plan_id, activity_id)

    assert before["vote_score"] == 750
    assert after["vote_score"] == 1000


def test_derived_recompute_preserves_versions_content_votes_and_plan_events() -> None:
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
        before = snapshot(client, token, plan_id)
        before_recommendations = recommendations(client, token, plan_id)
        recompute_derived_scores(client, plan_id)
        after = snapshot(client, token, plan_id)
        after_recommendations = recommendations(client, token, plan_id)

    assert after["plan"]["version"] == before["plan"]["version"]
    assert after["plan"]["planning_version"] == before["plan"]["planning_version"]
    assert after["activities"] == before["activities"]
    assert after["votes"] == before["votes"]
    assert after["latest_plan_events"] == before["latest_plan_events"]
    assert after_recommendations == before_recommendations
    implementation = recompute_plan_scores.__code__.co_names
    assert "append_plan_event" not in implementation
    assert "broadcast_committed_plan_event" not in implementation
