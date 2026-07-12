"""Real-PostgreSQL terminal-state and rollback coverage for co-owner requests."""

from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select

from app.db.base import AsyncSessionLocal
from app.models.coordination import CoOwnerRequest
from app.models.event import PlanEvent
from app.models.idempotency import IdempotencyRecord
from app.models.plan import PlanMember
from app.realtime.connection_manager import connection_manager
from test_phase_1a5 import bearer, client_context, create_plan, sync_user


def _join(client, owner_jwt: str, plan_id: str) -> tuple[str, str]:
    invite = client.post(f"/plans/{plan_id}/invites", headers=bearer(owner_jwt)).json()
    member_jwt = sync_user(client, f"member-{uuid4()}")
    assert (
        client.post(f"/invites/{invite['token']}/join", headers=bearer(member_jwt)).status_code
        == 200
    )
    members = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()["members"]
    return member_jwt, next(member["user_id"] for member in members if member["role"] == "member")


def _request(client, member_jwt: str, plan_id: str, operation_id: str | None = None) -> dict:
    response = client.post(
        f"/plans/{plan_id}/co-owner-requests",
        json={"note": "I can coordinate", "client_operation_id": operation_id or str(uuid4())},
        headers=bearer(member_jwt),
    )
    assert response.status_code == 201
    return response.json()


def _terminal_status(client, owner_jwt: str, plan_id: str, request_id: str) -> str:
    return next(
        request["status"]
        for request in client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()[
            "co_owner_requests"
        ]
        if request["id"] == request_id
    )


def _race(*calls):
    barrier = Barrier(len(calls))

    def run(call):
        barrier.wait(timeout=10)
        return call()

    with ThreadPoolExecutor(max_workers=len(calls)) as executor:
        return list(executor.map(run, calls))


async def _removal_race_state(
    plan_id: str, request_id: str, member_id: str, operation_ids: set[str]
) -> dict:
    plan_uuid = UUID(plan_id)
    request_uuid = UUID(request_id)
    member_uuid = UUID(member_id)
    async with AsyncSessionLocal() as session:
        request = (
            await session.execute(select(CoOwnerRequest).where(CoOwnerRequest.id == request_uuid))
        ).scalar_one()
        membership = (
            await session.execute(
                select(PlanMember).where(
                    PlanMember.plan_id == plan_uuid,
                    PlanMember.user_id == member_uuid,
                )
            )
        ).scalar_one_or_none()
        events = (
            (
                await session.execute(
                    select(PlanEvent)
                    .where(
                        PlanEvent.plan_id == plan_uuid,
                        PlanEvent.event_type.in_(
                            {
                                "co_owner_request.approved",
                                "member.role_updated",
                                "member.removed",
                            }
                        ),
                    )
                    .order_by(PlanEvent.created_at, PlanEvent.id)
                )
            )
            .scalars()
            .all()
        )
        operations = (
            (
                await session.execute(
                    select(IdempotencyRecord).where(
                        IdempotencyRecord.plan_id == plan_uuid,
                        IdempotencyRecord.client_operation_id.in_(operation_ids),
                    )
                )
            )
            .scalars()
            .all()
        )
        pending_count = await session.scalar(
            select(func.count())
            .select_from(CoOwnerRequest)
            .where(
                CoOwnerRequest.plan_id == plan_uuid,
                CoOwnerRequest.requester_user_id == member_uuid,
                CoOwnerRequest.status == "pending",
            )
        )
        return {
            "request_status": request.status,
            "request_version": request.version,
            "membership_role": membership.role if membership else None,
            "event_types": [event.event_type for event in events],
            "event_operation_ids": [event.client_operation_id for event in events],
            "operations": {
                operation.client_operation_id: (operation.status, operation.response_status)
                for operation in operations
            },
            "pending_count": pending_count,
        }


def test_co_owner_request_approve_vs_deny_has_exactly_one_terminal_outcome() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, _ = _join(client, owner_jwt, plan_id)
        request = _request(client, member_jwt, plan_id)
        path = f"/plans/{plan_id}/co-owner-requests/{request['id']}"
        codes = _race(
            lambda: (
                client.post(
                    f"{path}/approve",
                    json={"expected_version": 1, "client_operation_id": str(uuid4())},
                    headers=bearer(owner_jwt),
                ).status_code
            ),
            lambda: (
                client.post(
                    f"{path}/deny",
                    json={"expected_version": 1, "client_operation_id": str(uuid4())},
                    headers=bearer(owner_jwt),
                ).status_code
            ),
        )
        terminal = _terminal_status(client, owner_jwt, plan_id, request["id"])

    assert sorted(codes) == [200, 409]
    assert terminal in {"approved", "denied"}


def test_co_owner_request_approve_vs_withdrawal_has_exactly_one_terminal_outcome() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, _ = _join(client, owner_jwt, plan_id)
        request = _request(client, member_jwt, plan_id)
        path = f"/plans/{plan_id}/co-owner-requests/{request['id']}"
        codes = _race(
            lambda: (
                client.post(
                    f"{path}/approve",
                    json={"expected_version": 1, "client_operation_id": str(uuid4())},
                    headers=bearer(owner_jwt),
                ).status_code
            ),
            lambda: (
                client.post(
                    f"{path}/withdraw",
                    json={"expected_version": 1, "client_operation_id": str(uuid4())},
                    headers=bearer(member_jwt),
                ).status_code
            ),
        )
        terminal = _terminal_status(client, owner_jwt, plan_id, request["id"])

    assert sorted(codes) == [200, 409]
    assert terminal in {"approved", "withdrawn"}


def test_co_owner_request_approve_vs_member_removal_has_exactly_one_terminal_outcome(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    broadcasts: list[tuple[UUID, dict]] = []

    async def record_broadcast(plan_id: UUID, payload: dict) -> None:
        broadcasts.append((plan_id, payload))

    monkeypatch.setattr(connection_manager, "broadcast", record_broadcast)
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, member_id = _join(client, owner_jwt, plan_id)
        request = _request(client, member_jwt, plan_id)
        broadcasts.clear()
        approval_operation_id = str(uuid4())
        removal_operation_id = str(uuid4())
        codes = _race(
            lambda: (
                client.post(
                    f"/plans/{plan_id}/co-owner-requests/{request['id']}/approve",
                    json={
                        "expected_version": 1,
                        "client_operation_id": approval_operation_id,
                    },
                    headers=bearer(owner_jwt),
                ).status_code
            ),
            lambda: (
                client.delete(
                    f"/plans/{plan_id}/members/{member_id}"
                    f"?client_operation_id={removal_operation_id}",
                    headers=bearer(owner_jwt),
                ).status_code
            ),
        )
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        state = client.portal.call(
            lambda: _removal_race_state(
                plan_id,
                request["id"],
                member_id,
                {approval_operation_id, removal_operation_id},
            )
        )

    assert tuple(codes) in {(200, 204), (409, 204)}
    assert all(member["user_id"] != member_id for member in snapshot["members"])
    assert state["membership_role"] is None
    assert state["pending_count"] == 0
    assert state["request_version"] == 2
    assert state["operations"][removal_operation_id] == ("completed", 204)

    if codes[0] == 200:
        assert state["request_status"] == "approved"
        assert Counter(state["event_types"]) == Counter(
            {
                "co_owner_request.approved": 1,
                "member.role_updated": 1,
                "member.removed": 1,
            }
        )
        assert Counter(state["event_operation_ids"]) == Counter(
            {approval_operation_id: 2, removal_operation_id: 1}
        )
        assert state["operations"][approval_operation_id] == ("completed", 200)
    else:
        assert state["request_status"] == "withdrawn"
        assert state["event_types"] == ["member.removed"]
        assert state["event_operation_ids"] == [removal_operation_id]
        assert approval_operation_id not in state["operations"]

    assert Counter(payload["event_type"] for _, payload in broadcasts) == Counter(
        state["event_types"]
    )
    plan_uuid = UUID(plan_id)
    assert all(broadcast_plan_id == plan_uuid for broadcast_plan_id, _ in broadcasts)
    assert plan_uuid not in connection_manager.active_rooms
    assert all(key[0] != plan_uuid for key in connection_manager._debounced_tasks)
    assert plan_uuid not in connection_manager._event_sequences


def test_co_owner_request_duplicate_approval_replays_once_and_duplicate_pending_is_rejected() -> (
    None
):
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, _ = _join(client, owner_jwt, plan_id)
        request = _request(client, member_jwt, plan_id)
        duplicate = client.post(
            f"/plans/{plan_id}/co-owner-requests",
            json={"note": "second", "client_operation_id": str(uuid4())},
            headers=bearer(member_jwt),
        )
        body = {"expected_version": 1, "client_operation_id": "approve-once"}
        first = client.post(
            f"/plans/{plan_id}/co-owner-requests/{request['id']}/approve",
            json=body,
            headers=bearer(owner_jwt),
        )
        replay = client.post(
            f"/plans/{plan_id}/co-owner-requests/{request['id']}/approve",
            json=body,
            headers=bearer(owner_jwt),
        )
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()

    assert duplicate.status_code == 409
    assert first.status_code == replay.status_code == 200
    assert first.json() == replay.json()
    assert [event["event_type"] for event in snapshot["latest_plan_events"]].count(
        "co_owner_request.approved"
    ) == 1


def test_co_owner_request_changed_payload_idempotency_conflicts() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, _ = _join(client, owner_jwt, plan_id)
        operation_id = "changed-payload"
        assert (
            client.post(
                f"/plans/{plan_id}/co-owner-requests",
                json={"note": "first", "client_operation_id": operation_id},
                headers=bearer(member_jwt),
            ).status_code
            == 201
        )
        reused = client.post(
            f"/plans/{plan_id}/co-owner-requests",
            json={"note": "changed", "client_operation_id": operation_id},
            headers=bearer(member_jwt),
        )

    assert reused.status_code == 409
    assert reused.json()["detail"]["error"] == "idempotency_key_reused"


async def _set_requester_state(
    plan_id: str, request_id: str, *, role: str | None = None, delete: bool = False
) -> None:
    async with AsyncSessionLocal() as session:
        request = (
            await session.execute(
                select(CoOwnerRequest).where(CoOwnerRequest.id == UUID(request_id))
            )
        ).scalar_one()
        member = (
            await session.execute(
                select(PlanMember).where(
                    PlanMember.plan_id == UUID(plan_id),
                    PlanMember.user_id == request.requester_user_id,
                )
            )
        ).scalar_one()
        if delete:
            await session.delete(member)
        elif role:
            member.role = role
        await session.commit()


@pytest.mark.parametrize(
    ("role", "delete", "expected"),
    [
        ("co_owner", False, "co_owner_request_not_eligible"),
        (None, True, "co_owner_requester_removed"),
    ],
)
def test_co_owner_request_rejects_already_promoted_or_removed_requester(
    role: str | None, delete: bool, expected: str
) -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, _ = _join(client, owner_jwt, plan_id)
        request = _request(client, member_jwt, plan_id)
        client.portal.call(
            lambda: _set_requester_state(plan_id, request["id"], role=role, delete=delete)
        )
        response = client.post(
            f"/plans/{plan_id}/co-owner-requests/{request['id']}/approve",
            json={"expected_version": 1, "client_operation_id": str(uuid4())},
            headers=bearer(owner_jwt),
        )

    assert response.status_code == 409
    assert response.json()["detail"]["error"] == expected


def test_co_owner_request_event_failure_rolls_back_and_does_not_broadcast(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fail_event(*args, **kwargs):
        raise RuntimeError("event store unavailable")

    async def record_broadcast(plan_id, payload) -> None:
        broadcasts.append((plan_id, payload))

    broadcasts: list[tuple[object, dict]] = []
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt, _ = _join(client, owner_jwt, plan_id)
        monkeypatch.setattr("app.api.routes.coordination.append_plan_event", fail_event)
        monkeypatch.setattr(connection_manager, "broadcast", record_broadcast)
        with pytest.raises(RuntimeError, match="event store unavailable"):
            client.post(
                f"/plans/{plan_id}/co-owner-requests",
                json={"note": "never committed", "client_operation_id": str(uuid4())},
                headers=bearer(member_jwt),
            )
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()

    assert snapshot["co_owner_requests"] == []
    assert broadcasts == []
