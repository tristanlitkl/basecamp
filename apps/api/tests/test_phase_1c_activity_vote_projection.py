"""Real-PostgreSQL coverage for viewer-specific activity vote projections."""

from uuid import uuid4

from test_phase_1a5 import bearer, client_context, create_plan, sync_user


def _join_member(client, owner_jwt: str, plan_id: str) -> str:
    invite = client.post(f"/plans/{plan_id}/invites", headers=bearer(owner_jwt)).json()
    member_jwt = sync_user(client, f"member-{uuid4()}")
    assert (
        client.post(f"/invites/{invite['token']}/join", headers=bearer(member_jwt)).status_code
        == 200
    )
    return member_jwt


def _activity_projection(snapshot: dict, activity_id: str) -> dict:
    return next(activity for activity in snapshot["activities"] if activity["id"] == activity_id)


def test_activity_vote_resync_projects_only_the_authenticated_viewer_selection() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt = _join_member(client, owner_jwt, plan_id)
        activity = client.post(
            f"/plans/{plan_id}/activities", json={"name": "Kayak"}, headers=bearer(owner_jwt)
        ).json()
        assert (
            client.put(
                f"/plans/{plan_id}/activities/{activity['id']}/vote",
                json={"vote": "yes"},
                headers=bearer(owner_jwt),
            ).status_code
            == 200
        )
        assert (
            client.put(
                f"/plans/{plan_id}/activities/{activity['id']}/vote",
                json={"vote": "no"},
                headers=bearer(member_jwt),
            ).status_code
            == 200
        )
        owner = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        member = client.get(f"/plans/{plan_id}/resync", headers=bearer(member_jwt)).json()

    owner_activity = _activity_projection(owner, activity["id"])
    member_activity = _activity_projection(member, activity["id"])
    assert owner_activity["current_user_vote"] == "yes"
    assert member_activity["current_user_vote"] == "no"
    assert (
        owner["activity_scores"][activity["id"]]
        == member["activity_scores"][activity["id"]]
        == {"yes": 1, "maybe": 0, "no": 1}
    )
    assert owner_activity["current_user_vote"] != member_activity["current_user_vote"]


def test_anonymous_activity_vote_keeps_viewer_selection_without_other_voter_identity() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt = _join_member(client, owner_jwt, plan_id)
        activity = client.post(
            f"/plans/{plan_id}/activities", json={"name": "Walk"}, headers=bearer(owner_jwt)
        ).json()
        client.put(
            f"/plans/{plan_id}/activities/{activity['id']}/vote",
            json={"vote": "yes"},
            headers=bearer(owner_jwt),
        )
        client.put(
            f"/plans/{plan_id}/activities/{activity['id']}/vote",
            json={"vote": "maybe"},
            headers=bearer(member_jwt),
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
        member = client.get(f"/plans/{plan_id}/resync", headers=bearer(member_jwt)).json()

    projection = _activity_projection(member, activity["id"])
    assert projection["current_user_vote"] == "maybe"
    assert member["activity_scores"][activity["id"]] == {"yes": 1, "maybe": 1, "no": 0}
    assert member["votes"] == []
    assert all(
        event["event_type"] != "activity.vote_updated" for event in member["latest_plan_events"]
    )


def test_activity_vote_invalidation_followed_by_resync_preserves_each_viewer_projection() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt = _join_member(client, owner_jwt, plan_id)
        activity = client.post(
            f"/plans/{plan_id}/activities", json={"name": "Climb"}, headers=bearer(owner_jwt)
        ).json()
        with client.websocket_connect(f"/ws/plans/{plan_id}?token={owner_jwt}") as owner_socket:
            with client.websocket_connect(
                f"/ws/plans/{plan_id}?token={member_jwt}"
            ) as member_socket:
                owner_socket.receive_json()
                member_socket.receive_json()
                client.put(
                    f"/plans/{plan_id}/activities/{activity['id']}/vote",
                    json={"vote": "yes"},
                    headers=bearer(owner_jwt),
                )
                assert owner_socket.receive_json()["event_type"] == "activity.vote_updated"
                assert member_socket.receive_json()["event_type"] == "activity.vote_updated"
                client.put(
                    f"/plans/{plan_id}/activities/{activity['id']}/vote",
                    json={"vote": "no"},
                    headers=bearer(member_jwt),
                )
                owner_socket.receive_json()
                member_socket.receive_json()
                owner = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
                member = client.get(f"/plans/{plan_id}/resync", headers=bearer(member_jwt)).json()

    assert _activity_projection(owner, activity["id"])["current_user_vote"] == "yes"
    assert _activity_projection(member, activity["id"])["current_user_vote"] == "no"
