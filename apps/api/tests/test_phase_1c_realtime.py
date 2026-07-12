"""Phase 1C realtime collaboration coverage using the real PostgreSQL test setup."""

import asyncio
from uuid import uuid4

import pytest

from test_phase_1a5 import bearer, client_context, create_plan, sync_user

from app.realtime.connection_manager import ConnectionManager
from app.realtime.connection_manager import connection_manager


class FakeSocket:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.messages: list[dict] = []
        self.accepted = False
        self.closed = False

    async def accept(self) -> None:
        self.accepted = True

    async def send_json(self, payload: dict) -> None:
        if self.fail:
            raise RuntimeError("disconnected")
        self.messages.append(payload)

    async def close(self, *, code: int, reason: str) -> None:
        self.closed = True


def test_connection_manager_uses_snapshot_and_evicts_dead_sockets() -> None:
    async def exercise() -> None:
        manager = ConnectionManager()
        plan_id, user_id = uuid4(), uuid4()
        healthy = FakeSocket()
        dead = FakeSocket()
        healthy_connection = await manager.connect(healthy, user_id=user_id, plan_id=plan_id)  # type: ignore[arg-type]
        dead_connection = await manager.connect(dead, user_id=uuid4(), plan_id=plan_id)  # type: ignore[arg-type]
        dead.fail = True
        await manager.broadcast(plan_id, {"type": "plan_event", "event_id": "event"})
        assert dead_connection not in manager.active_rooms[plan_id]
        assert healthy.messages[-1]["event_sequence"] == 1

        # Concurrent room churn must not mutate the copied broadcast iteration.
        churn = [
            manager.connect(FakeSocket(), user_id=uuid4(), plan_id=plan_id)  # type: ignore[arg-type]
            for _ in range(20)
        ]
        connections = await asyncio.gather(*churn)
        await asyncio.gather(
            manager.broadcast(plan_id, {"type": "plan_event", "event_id": "event-2"}),
            *(manager.disconnect(plan_id, connection) for connection in connections),
        )
        manager.debounce_broadcast(
            plan_id,
            "itinerary_item:item",
            {"type": "plan_event", "event_id": "reorder-1"},
            delay_seconds=0.01,
        )
        manager.debounce_broadcast(
            plan_id,
            "itinerary_item:item",
            {"type": "plan_event", "event_id": "reorder-2"},
            delay_seconds=0.01,
        )
        await asyncio.sleep(0.02)
        assert healthy.messages[-1]["event_id"] == "reorder-2"
        await manager.disconnect(plan_id, healthy_connection)
        assert plan_id not in manager.active_rooms
        assert not manager._debounced_tasks

    asyncio.run(exercise())


def test_connection_manager_keeps_same_user_sockets_distinct_and_cleans_tasks() -> None:
    async def exercise() -> None:
        manager = ConnectionManager()
        plan_id, other_plan_id, user_id = uuid4(), uuid4(), uuid4()
        first_socket, second_socket = FakeSocket(), FakeSocket()
        first = await manager.connect(first_socket, user_id=user_id, plan_id=plan_id)  # type: ignore[arg-type]
        second = await manager.connect(second_socket, user_id=user_id, plan_id=plan_id)  # type: ignore[arg-type]
        assert first.connection_id != second.connection_id
        await manager.disconnect(plan_id, first)
        await manager.disconnect(plan_id, first)  # Repeated cleanup is harmless.
        assert manager.active_rooms[plan_id] == {second}

        manager.debounce_broadcast(
            plan_id, "itinerary_item:first", {"type": "plan_event", "event_id": "first"}
        )
        manager.debounce_broadcast(
            other_plan_id, "itinerary_item:first", {"type": "plan_event", "event_id": "other"}
        )
        assert len(manager._debounced_tasks) == 2
        await manager.disconnect(plan_id, second)
        assert plan_id not in manager.active_rooms
        assert (other_plan_id, "itinerary_item:first") in manager._debounced_tasks
        assert not any(key[0] == plan_id for key in manager._debounced_tasks)
        await asyncio.sleep(0.21)
        assert not manager._debounced_tasks

    asyncio.run(exercise())


def test_two_members_receive_a_committed_activity_invalidation() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        invite = client.post(f"/plans/{plan_id}/invites", headers=bearer(owner_jwt)).json()
        member_jwt = sync_user(client, f"member-{uuid4()}")
        assert (
            client.post(f"/invites/{invite['token']}/join", headers=bearer(member_jwt)).status_code
            == 200
        )

        with client.websocket_connect(f"/ws/plans/{plan_id}?token={owner_jwt}") as owner_socket:
            with client.websocket_connect(
                f"/ws/plans/{plan_id}?token={member_jwt}"
            ) as member_socket:
                assert owner_socket.receive_json() == {"type": "connected"}
                assert member_socket.receive_json() == {"type": "connected"}
                response = client.post(
                    f"/plans/{plan_id}/activities",
                    json={"name": "Committed hike"},
                    headers=bearer(owner_jwt),
                )
                assert response.status_code == 201
                owner_event = owner_socket.receive_json()
                member_event = member_socket.receive_json()
                assert owner_event["type"] == member_event["type"] == "plan_event"
                assert owner_event["event_id"] == member_event["event_id"]
                assert owner_event["event_type"] == "activity.created"
                snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(member_jwt)).json()
                assert [activity["name"] for activity in snapshot["activities"]] == [
                    "Committed hike"
                ]


def test_removed_member_socket_is_terminal_and_remaining_member_is_notified() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        invite = client.post(f"/plans/{plan_id}/invites", headers=bearer(owner_jwt)).json()
        member_jwt = sync_user(client, f"member-{uuid4()}")
        assert (
            client.post(f"/invites/{invite['token']}/join", headers=bearer(member_jwt)).status_code
            == 200
        )
        member_id = next(
            member
            for member in client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()[
                "members"
            ]
            if member["role"] == "member"
        )["user_id"]

        with client.websocket_connect(f"/ws/plans/{plan_id}?token={owner_jwt}") as owner_socket:
            with client.websocket_connect(
                f"/ws/plans/{plan_id}?token={member_jwt}"
            ) as member_socket:
                assert owner_socket.receive_json() == {"type": "connected"}
                assert member_socket.receive_json() == {"type": "connected"}
                assert (
                    client.delete(
                        f"/plans/{plan_id}/members/{member_id}", headers=bearer(owner_jwt)
                    ).status_code
                    == 204
                )
                assert owner_socket.receive_json()["event_type"] == "member.removed"
                closed = member_socket.receive()
                assert closed["type"] == "websocket.close"
                assert closed["code"] == 1008
                assert closed["reason"] == "plan_membership_required"

        assert client.get(f"/plans/{plan_id}/resync", headers=bearer(member_jwt)).status_code == 403
        with pytest.raises(Exception):
            with client.websocket_connect(f"/ws/plans/{plan_id}?token={member_jwt}"):
                pass


def test_anonymous_vote_invalidation_contains_no_voter_identity() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        activity_id = client.post(
            f"/plans/{plan_id}/activities", json={"name": "Private vote"}, headers=bearer(owner_jwt)
        ).json()["id"]
        invite = client.post(f"/plans/{plan_id}/invites", headers=bearer(owner_jwt)).json()
        member_jwt = sync_user(client, f"member-{uuid4()}")
        assert (
            client.post(f"/invites/{invite['token']}/join", headers=bearer(member_jwt)).status_code
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
        with client.websocket_connect(f"/ws/plans/{plan_id}?token={owner_jwt}") as owner_socket:
            assert owner_socket.receive_json() == {"type": "connected"}
            assert (
                client.put(
                    f"/plans/{plan_id}/activities/{activity_id}/vote",
                    json={"vote": "yes"},
                    headers=bearer(member_jwt),
                ).status_code
                == 200
            )
            packet = owner_socket.receive_json()

    assert packet["event_type"] == "activity.vote_updated"
    assert (
        not {"actor_id", "user_id", "display_name", "avatar_emoji", "membership_id", "payload_json"}
        & packet.keys()
    )


def test_idempotent_replay_creates_one_event_and_one_broadcast(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def record_broadcast(plan_id, payload) -> None:
        broadcasts.append((plan_id, payload))

    broadcasts: list[tuple[object, dict]] = []
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        monkeypatch.setattr(connection_manager, "broadcast", record_broadcast)
        operation_id = str(uuid4())
        payload = {"name": "Exactly once", "client_operation_id": operation_id}
        first = client.post(f"/plans/{plan_id}/activities", json=payload, headers=bearer(jwt))
        replay = client.post(f"/plans/{plan_id}/activities", json=payload, headers=bearer(jwt))
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()

    assert first.status_code == replay.status_code == 201
    assert len(snapshot["activities"]) == 1
    assert [event["event_type"] for event in snapshot["latest_plan_events"]].count(
        "activity.created"
    ) == 1
    assert [packet[1]["event_type"] for packet in broadcasts] == ["activity.created"]


def test_event_write_failure_rolls_back_mutation_and_skips_broadcast(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fail_event(*args, **kwargs):
        raise RuntimeError("event store unavailable")

    async def record_broadcast(plan_id, payload) -> None:
        broadcasts.append((plan_id, payload))

    broadcasts: list[tuple[object, dict]] = []
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        monkeypatch.setattr("app.api.routes.activities.append_plan_event", fail_event)
        monkeypatch.setattr(connection_manager, "broadcast", record_broadcast)
        with pytest.raises(RuntimeError, match="event store unavailable"):
            client.post(
                f"/plans/{plan_id}/activities",
                json={"name": "Never committed"},
                headers=bearer(jwt),
            )
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()

    assert snapshot["activities"] == []
    assert broadcasts == []
