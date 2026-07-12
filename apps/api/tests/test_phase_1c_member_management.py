"""Focused real-PostgreSQL coverage for Phase 1C member-management projections."""

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


def test_date_poll_resync_projects_only_the_authenticated_viewer_vote_and_suggester() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt = join_member(client, owner_jwt, plan_id)
        suggestion = client.post(
            f"/plans/{plan_id}/date-suggestions",
            json={
                "starts_on": "2026-10-01",
                "ends_on": "2026-10-03",
                "client_operation_id": "option",
            },
            headers=bearer(member_jwt),
        ).json()
        assert (
            client.put(
                f"/plans/{plan_id}/date-suggestions/{suggestion['id']}/vote",
                json={"vote": "yes", "client_operation_id": "owner-vote"},
                headers=bearer(owner_jwt),
            ).status_code
            == 200
        )
        assert (
            client.put(
                f"/plans/{plan_id}/date-suggestions/{suggestion['id']}/vote",
                json={"vote": "no", "client_operation_id": "member-vote"},
                headers=bearer(member_jwt),
            ).status_code
            == 200
        )
        owner_option = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()[
            "date_suggestions"
        ][0]
        member_option = client.get(f"/plans/{plan_id}/resync", headers=bearer(member_jwt)).json()[
            "date_suggestions"
        ][0]

    assert (
        owner_option["yes_votes"],
        owner_option["no_votes"],
        owner_option["current_user_vote"],
    ) == (1, 1, "yes")
    assert (
        member_option["yes_votes"],
        member_option["no_votes"],
        member_option["current_user_vote"],
    ) == (1, 1, "no")
    assert member_option["author_display_name"]
    assert member_option["author_avatar_emoji"]
    assert "vote" not in owner_option


def test_co_owner_request_is_idempotent_private_and_transactionally_promotes_member() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt = join_member(client, owner_jwt, plan_id)
        payload = {"note": "I can coordinate rides", "client_operation_id": "request-1"}
        created = client.post(
            f"/plans/{plan_id}/co-owner-requests", json=payload, headers=bearer(member_jwt)
        )
        replay = client.post(
            f"/plans/{plan_id}/co-owner-requests", json=payload, headers=bearer(member_jwt)
        )
        owner_requests = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()[
            "co_owner_requests"
        ]
        member_requests = client.get(f"/plans/{plan_id}/resync", headers=bearer(member_jwt)).json()[
            "co_owner_requests"
        ]
        denied = client.post(
            f"/plans/{plan_id}/co-owner-requests/{created.json()['id']}/approve",
            json={
                "expected_version": created.json()["version"],
                "client_operation_id": "not-owner",
            },
            headers=bearer(member_jwt),
        )
        approved = client.post(
            f"/plans/{plan_id}/co-owner-requests/{created.json()['id']}/approve",
            json={
                "expected_version": created.json()["version"],
                "client_operation_id": "approve-1",
            },
            headers=bearer(owner_jwt),
        )
        after = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()

    assert created.status_code == replay.status_code == 201
    assert created.json() == replay.json()
    assert len(owner_requests) == len(member_requests) == 1
    assert denied.status_code == 403
    assert approved.status_code == 200
    assert after["co_owner_requests"][0]["status"] == "approved"
    assert after["co_owner_requests"][0]["decided_by_user_id"] == after["current_user_id"]
    assert (
        next(
            member
            for member in after["members"]
            if member["user_id"] == member_requests[0]["requester_user_id"]
        )["role"]
        == "co_owner"
    )
