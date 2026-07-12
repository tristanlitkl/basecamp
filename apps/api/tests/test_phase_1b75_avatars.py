"""Database-backed avatar identity coverage for Phase 1B.75."""

from uuid import uuid4

from test_phase_1a5 import bearer, client_context, create_plan, sync_user


def test_authenticated_user_updates_own_supported_emoji_without_plan_versions() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        before = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()["plan"]
        response = client.patch("/auth/me", json={"avatar_emoji": "🦊"}, headers=bearer(jwt))
        after = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()

    assert response.status_code == 200
    assert response.json()["avatar_emoji"] == "🦊"
    assert after["members"][0]["avatar_emoji"] == "🦊"
    assert after["plan"]["version"] == before["version"]
    assert after["plan"]["planning_version"] == before["planning_version"]


def test_unsupported_or_unauthenticated_avatar_updates_are_rejected() -> None:
    with client_context() as client:
        jwt = sync_user(client, f"owner-{uuid4()}")
        unsupported = client.patch("/auth/me", json={"avatar_emoji": "💥"}, headers=bearer(jwt))
        unauthenticated = client.patch("/auth/me", json={"avatar_emoji": "🦊"})

    assert unsupported.status_code == 422
    assert unauthenticated.status_code == 401


def test_user_cannot_change_another_users_emoji_via_current_user_endpoint() -> None:
    with client_context() as client:
        first_jwt = sync_user(client, f"first-{uuid4()}")
        second_jwt = sync_user(client, f"second-{uuid4()}")
        assert (
            client.patch(
                "/auth/me", json={"avatar_emoji": "🐻"}, headers=bearer(first_jwt)
            ).status_code
            == 200
        )
        second = client.get("/auth/me", headers=bearer(second_jwt))

    assert second.json()["avatar_emoji"] == "🧭"


def test_auth_sync_preserves_existing_avatar_and_invite_join_persists_selected_avatar() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        invite = client.post(f"/plans/{plan_id}/invites", headers=bearer(owner_jwt)).json()
        member_subject = f"member-{uuid4()}"
        member_jwt = sync_user(client, member_subject)
        assert (
            client.patch(
                "/auth/me", json={"avatar_emoji": "🦉"}, headers=bearer(member_jwt)
            ).status_code
            == 200
        )
        assert (
            client.post("/auth/sync-user", headers=bearer(member_jwt)).json()["avatar_emoji"]
            == "🦉"
        )
        joined = client.post(
            f"/invites/{invite['token']}/join",
            json={"avatar_emoji": "🦊"},
            headers=bearer(member_jwt),
        )
        repeated = client.post(f"/invites/{invite['token']}/join", headers=bearer(member_jwt))
        members = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()[
            "members"
        ]

    assert joined.status_code == repeated.status_code == 200
    assert len([member for member in members if member["user_id"] != members[0]["user_id"]]) == 1
    assert next(member for member in members if member["role"] == "member")["avatar_emoji"] == "🦊"


def test_invite_join_without_avatar_keeps_safe_default_and_resync_excludes_removed_member() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        invite = client.post(f"/plans/{plan_id}/invites", headers=bearer(owner_jwt)).json()
        member_jwt = sync_user(client, f"member-{uuid4()}")
        assert (
            client.post(f"/invites/{invite['token']}/join", headers=bearer(member_jwt)).status_code
            == 200
        )
        members = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()[
            "members"
        ]
        member = next(row for row in members if row["role"] == "member")
        removed = client.delete(
            f"/plans/{plan_id}/members/{member['user_id']}?client_operation_id={uuid4()}",
            headers=bearer(owner_jwt),
        )
        after = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()["members"]

    assert member["avatar_emoji"] == "🧭"
    assert removed.status_code == 204
    assert member["user_id"] not in {row["user_id"] for row in after}
