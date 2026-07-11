"""Phase 1B correctness tests (run with the local Postgres service available)."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Barrier
from uuid import uuid4

from app.api.routes.expenses import equal_splits
from app.db.base import AsyncSessionLocal
from app.models.idempotency import IdempotencyRecord
from app.services.idempotency_service import canonical_request_hash
from sqlalchemy import select

from test_phase_1a5 import bearer, client_context, create_plan, sync_user


def concurrently_two(call):
    barrier = Barrier(2)

    def run():
        barrier.wait(timeout=5)
        return call()

    with ThreadPoolExecutor(max_workers=2) as executor:
        return list(executor.map(lambda _: run(), range(2)))


async def idempotency_record(plan_id: str, actor_id: str, operation_id: str) -> IdempotencyRecord:
    async with AsyncSessionLocal() as session:
        return (
            await session.execute(
                select(IdempotencyRecord).where(
                    IdempotencyRecord.plan_id == plan_id,
                    IdempotencyRecord.actor_id == actor_id,
                    IdempotencyRecord.client_operation_id == operation_id,
                )
            )
        ).scalar_one()


def test_equal_split_distributes_remainder_by_sorted_user_id() -> None:
    users = sorted([uuid4(), uuid4(), uuid4()], key=str)
    # Deliberately scramble input: ordering must be independent of caller order.
    splits = equal_splits(1000, [users[2], users[0], users[1]])
    assert splits == [(users[0], 334), (users[1], 333), (users[2], 333)]
    assert sum(amount for _, amount in splits) == 1000


def test_concurrency_itinerary_reorder_stale_version_is_rejected() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        first = client.post(
            f"/plans/{plan_id}/itinerary-items", json={"title": "First"}, headers=bearer(jwt)
        ).json()
        second = client.post(
            f"/plans/{plan_id}/itinerary-items", json={"title": "Second"}, headers=bearer(jwt)
        ).json()

        def reorder(body: dict[str, object]) -> int:
            return client.post(
                f"/plans/{plan_id}/itinerary-items/{second['id']}/reorder",
                json=body,
                headers=bearer(jwt),
            ).status_code

        with ThreadPoolExecutor(max_workers=2) as executor:
            codes = list(
                executor.map(
                    reorder,
                    [
                        {"expected_version": 1, "next_item_id": first["id"]},
                        {"expected_version": 1},
                    ],
                )
            )
    assert sorted(codes) == [200, 409]


def test_idempotency_concurrency_expense_create_replays_one_response() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        payload = {
            "description": "Dinner",
            "amount_cents": 1000,
            "client_operation_id": str(uuid4()),
        }

        def create_once() -> tuple[int, dict[str, object]]:
            response = client.post(f"/plans/{plan_id}/expenses", json=payload, headers=bearer(jwt))
            return response.status_code, response.json()

        first, replay = concurrently_two(create_once)
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt))
    assert first[0] == replay[0] == 201
    assert first[1] == replay[1]
    assert len(snapshot.json()["expenses"]) == 1


def test_finalized_plan_rejects_member_and_owner_mutations() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        invite = client.post(f"/plans/{plan_id}/invites", headers=bearer(owner_jwt)).json()
        member_jwt = sync_user(client, f"member-{uuid4()}")
        assert (
            client.post(f"/invites/{invite['token']}/join", headers=bearer(member_jwt)).status_code
            == 200
        )
        plan = client.get(f"/plans/{plan_id}", headers=bearer(owner_jwt)).json()
        assert (
            client.post(
                f"/plans/{plan_id}/finalize",
                json={"expected_version": plan["version"]},
                headers=bearer(owner_jwt),
            ).status_code
            == 200
        )
        member_mutation = client.post(
            f"/plans/{plan_id}/expenses",
            json={"description": "Late", "amount_cents": 10},
            headers=bearer(member_jwt),
        )
        owner_mutation = client.post(
            f"/plans/{plan_id}/activities", json={"name": "Late"}, headers=bearer(owner_jwt)
        )
    assert member_mutation.status_code in (403, 409)
    assert owner_mutation.status_code in (403, 409)


def test_ledger_stays_zero_sum_through_expense_correction_and_reversal() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        created = client.post(
            f"/plans/{plan_id}/expenses",
            json={"description": "Taxi", "amount_cents": 1000},
            headers=bearer(jwt),
        ).json()
        updated = client.patch(
            f"/plans/{plan_id}/expenses/{created['id']}",
            json={
                "description": "Taxi corrected",
                "amount_cents": 1001,
                "expected_version": created["version"],
            },
            headers=bearer(jwt),
        )
        assert updated.status_code == 200
        assert (
            client.delete(
                f"/plans/{plan_id}/expenses/{created['id']}?expected_version=2", headers=bearer(jwt)
            ).status_code
            == 204
        )
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()
    assert sum(entry["amount_cents"] for entry in snapshot["ledger_entries"]) == 0


def test_expense_reversal_only_reverses_the_current_posting() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        created = client.post(
            f"/plans/{plan_id}/expenses",
            json={"description": "Taxi", "amount_cents": 1000},
            headers=bearer(jwt),
        ).json()
        corrected = client.patch(
            f"/plans/{plan_id}/expenses/{created['id']}",
            json={"description": "Corrected", "amount_cents": 1001, "expected_version": 1},
            headers=bearer(jwt),
        )
        assert corrected.status_code == 200
        assert (
            client.delete(
                f"/plans/{plan_id}/expenses/{created['id']}?expected_version=2", headers=bearer(jwt)
            ).status_code
            == 204
        )
        entries = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()[
            "ledger_entries"
        ]
    # Initial posting (2), its reversal (2), corrected posting (2), corrected reversal (2).
    assert len(entries) == 8
    assert sum(entry["amount_cents"] for entry in entries) == 0


def test_expense_update_and_delete_replays_do_not_duplicate_ledger_entries() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        created = client.post(
            f"/plans/{plan_id}/expenses",
            json={"description": "Taxi", "amount_cents": 1000},
            headers=bearer(jwt),
        ).json()
        update_payload = {
            "description": "Corrected",
            "amount_cents": 1001,
            "expected_version": 1,
            "client_operation_id": str(uuid4()),
        }
        first_update = client.patch(
            f"/plans/{plan_id}/expenses/{created['id']}", json=update_payload, headers=bearer(jwt)
        )
        replay_update = client.patch(
            f"/plans/{plan_id}/expenses/{created['id']}", json=update_payload, headers=bearer(jwt)
        )
        delete_key = str(uuid4())
        first_delete = client.delete(
            f"/plans/{plan_id}/expenses/{created['id']}?expected_version=2&client_operation_id={delete_key}",
            headers=bearer(jwt),
        )
        replay_delete = client.delete(
            f"/plans/{plan_id}/expenses/{created['id']}?expected_version=2&client_operation_id={delete_key}",
            headers=bearer(jwt),
        )
        entries = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()[
            "ledger_entries"
        ]
    assert first_update.status_code == replay_update.status_code == 200
    assert first_update.json() == replay_update.json()
    assert first_delete.status_code == replay_delete.status_code == 204
    assert len(entries) == 8


def test_expense_participant_validation_rejects_empty_duplicates_and_non_members() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        owner_id = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()["members"][0][
            "user_id"
        ]
        empty = client.post(
            f"/plans/{plan_id}/expenses",
            json={"description": "x", "amount_cents": 1, "participant_user_ids": []},
            headers=bearer(jwt),
        )
        duplicate = client.post(
            f"/plans/{plan_id}/expenses",
            json={
                "description": "x",
                "amount_cents": 1,
                "participant_user_ids": [owner_id, owner_id],
            },
            headers=bearer(jwt),
        )
        outsider = client.post(
            f"/plans/{plan_id}/expenses",
            json={"description": "x", "amount_cents": 1, "participant_user_ids": [str(uuid4())]},
            headers=bearer(jwt),
        )
    assert empty.status_code == duplicate.status_code == outsider.status_code == 422


def test_votes_do_not_bump_planning_version_but_activity_writes_do() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        before = client.get(f"/plans/{plan_id}", headers=bearer(jwt)).json()["planning_version"]
        activity = client.post(
            f"/plans/{plan_id}/activities", json={"name": "Museum"}, headers=bearer(jwt)
        ).json()
        after_create = client.get(f"/plans/{plan_id}", headers=bearer(jwt)).json()[
            "planning_version"
        ]
        assert (
            client.put(
                f"/plans/{plan_id}/activities/{activity['id']}/vote",
                json={"vote": "yes"},
                headers=bearer(jwt),
            ).status_code
            == 200
        )
        after_vote = client.get(f"/plans/{plan_id}", headers=bearer(jwt)).json()["planning_version"]
    assert after_create == before + 1
    assert after_vote == after_create


def test_idempotency_permanent_failure_is_stored_and_replayed() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        operation_id = str(uuid4())
        payload = {
            "description": "Invalid",
            "amount_cents": 100,
            "participant_user_ids": [],
            "client_operation_id": operation_id,
        }
        first = client.post(f"/plans/{plan_id}/expenses", json=payload, headers=bearer(jwt))
        replay = client.post(f"/plans/{plan_id}/expenses", json=payload, headers=bearer(jwt))
        actor_id = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()["members"][0][
            "user_id"
        ]
        record = client.portal.call(idempotency_record, plan_id, actor_id, operation_id)
    assert first.status_code == replay.status_code == 422
    assert first.json() == replay.json()
    assert record.status == "failed"
    assert record.failure_type == "permanent"
    assert record.response_status == 422


def test_idempotency_transient_failure_retries_the_business_mutation() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        actor_id = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()["members"][0][
            "user_id"
        ]
        operation_id = str(uuid4())
        payload = {"description": "Retry", "amount_cents": 100, "client_operation_id": operation_id}

        async def seed_transient_failure():
            async with AsyncSessionLocal() as session:
                session.add(
                    IdempotencyRecord(
                        plan_id=plan_id,
                        actor_id=actor_id,
                        client_operation_id=operation_id,
                        request_hash=canonical_request_hash(
                            {
                                "description": "Retry",
                                "amount_cents": 100,
                                "paid_by_user_id": None,
                                "participant_user_ids": None,
                            }
                        ),
                        resource_type="expense",
                        status="failed",
                        failure_type="transient",
                        response_status=503,
                        response_json={"error": "temporary_failure"},
                        expires_at=datetime.now(timezone.utc),
                    )
                )
                await session.commit()

        client.portal.call(seed_transient_failure)
        response = client.post(f"/plans/{plan_id}/expenses", json=payload, headers=bearer(jwt))
        record = client.portal.call(idempotency_record, plan_id, actor_id, operation_id)
    assert response.status_code == 201
    assert record.status == "completed"
    assert record.failure_type is None


def test_idempotency_concurrency_expired_in_progress_recovers_once() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        actor_id = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()["members"][0][
            "user_id"
        ]
        operation_id = str(uuid4())
        payload = {
            "description": "Recover",
            "amount_cents": 101,
            "client_operation_id": operation_id,
        }

        async def seed_expired_claim():
            async with AsyncSessionLocal() as session:
                session.add(
                    IdempotencyRecord(
                        plan_id=plan_id,
                        actor_id=actor_id,
                        client_operation_id=operation_id,
                        request_hash=canonical_request_hash(
                            {
                                "description": "Recover",
                                "amount_cents": 101,
                                "paid_by_user_id": None,
                                "participant_user_ids": None,
                            }
                        ),
                        resource_type="expense",
                        status="in_progress",
                        expires_at=datetime.now(timezone.utc) - timedelta(seconds=1),
                    )
                )
                await session.commit()

        client.portal.call(seed_expired_claim)
        codes = concurrently_two(
            lambda: (
                client.post(
                    f"/plans/{plan_id}/expenses", json=payload, headers=bearer(jwt)
                ).status_code
            )
        )
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()
    assert 201 in codes
    assert set(codes).issubset({201, 409})
    assert len(snapshot["expenses"]) == 1


def test_concurrency_plan_activity_itinerary_and_expense_updates_are_conditional() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        plan = client.get(f"/plans/{plan_id}", headers=bearer(jwt)).json()
        plan_codes = concurrently_two(
            lambda: (
                client.patch(
                    f"/plans/{plan_id}",
                    json={"title": "Concurrent", "expected_version": plan["version"]},
                    headers=bearer(jwt),
                ).status_code
            )
        )
        activity = client.post(
            f"/plans/{plan_id}/activities", json={"name": "Activity"}, headers=bearer(jwt)
        ).json()
        activity_codes = concurrently_two(
            lambda: (
                client.patch(
                    f"/plans/{plan_id}/activities/{activity['id']}",
                    json={"name": "Changed", "expected_version": 1},
                    headers=bearer(jwt),
                ).status_code
            )
        )
        item = client.post(
            f"/plans/{plan_id}/itinerary-items", json={"title": "Item"}, headers=bearer(jwt)
        ).json()
        item_codes = concurrently_two(
            lambda: (
                client.patch(
                    f"/plans/{plan_id}/itinerary-items/{item['id']}",
                    json={"title": "Changed", "expected_version": 1},
                    headers=bearer(jwt),
                ).status_code
            )
        )
        expense = client.post(
            f"/plans/{plan_id}/expenses",
            json={"description": "Expense", "amount_cents": 10},
            headers=bearer(jwt),
        ).json()
        expense_codes = concurrently_two(
            lambda: (
                client.patch(
                    f"/plans/{plan_id}/expenses/{expense['id']}",
                    json={"description": "Changed", "amount_cents": 11, "expected_version": 1},
                    headers=bearer(jwt),
                ).status_code
            )
        )
    for codes in (plan_codes, activity_codes, item_codes, expense_codes):
        assert sorted(codes) == [200, 409]


def test_itinerary_edge_cases_fractional_ordering_and_no_renumbering() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        first = client.post(
            f"/plans/{plan_id}/itinerary-items", json={"title": "First"}, headers=bearer(jwt)
        ).json()
        second = client.post(
            f"/plans/{plan_id}/itinerary-items", json={"title": "Second"}, headers=bearer(jwt)
        ).json()
        third = client.post(
            f"/plans/{plan_id}/itinerary-items", json={"title": "Third"}, headers=bearer(jwt)
        ).json()
        assert [first["position_key"], second["position_key"], third["position_key"]] == [
            "1000",
            "2000",
            "3000",
        ]
        before = client.post(
            f"/plans/{plan_id}/itinerary-items/{third['id']}/reorder",
            json={"expected_version": 1, "next_item_id": first["id"]},
            headers=bearer(jwt),
        ).json()
        assert before["position_key"] == "500"
        between = client.post(
            f"/plans/{plan_id}/itinerary-items/{second['id']}/reorder",
            json={
                "expected_version": 1,
                "previous_item_id": third["id"],
                "next_item_id": first["id"],
            },
            headers=bearer(jwt),
        ).json()
        assert between["position_key"] == "750"
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()
        assert [item["id"] for item in snapshot["itinerary_items"]] == [
            third["id"],
            second["id"],
            first["id"],
        ]
        no_op = client.post(
            f"/plans/{plan_id}/itinerary-items/{second['id']}/reorder",
            json={
                "expected_version": 2,
                "previous_item_id": third["id"],
                "next_item_id": first["id"],
            },
            headers=bearer(jwt),
        ).json()
        assert no_op["version"] == 2
        invalid = client.post(
            f"/plans/{plan_id}/itinerary-items/{first['id']}/reorder",
            json={
                "expected_version": 1,
                "previous_item_id": first["id"],
                "next_item_id": third["id"],
            },
            headers=bearer(jwt),
        )
    assert invalid.status_code == 422


def test_itinerary_edge_cases_cross_plan_equal_neighbors_and_precision() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        other_jwt, other_plan_id = create_plan(client, f"other-{uuid4()}")
        first = client.post(
            f"/plans/{plan_id}/itinerary-items", json={"title": "First"}, headers=bearer(jwt)
        ).json()
        second = client.post(
            f"/plans/{plan_id}/itinerary-items", json={"title": "Second"}, headers=bearer(jwt)
        ).json()
        foreign = client.post(
            f"/plans/{other_plan_id}/itinerary-items",
            json={"title": "Foreign"},
            headers=bearer(other_jwt),
        ).json()
        cross_plan = client.post(
            f"/plans/{plan_id}/itinerary-items/{second['id']}/reorder",
            json={"expected_version": 1, "previous_item_id": foreign["id"]},
            headers=bearer(jwt),
        )
        after_last = client.post(
            f"/plans/{plan_id}/itinerary-items/{first['id']}/reorder",
            json={"expected_version": 1, "previous_item_id": second["id"]},
            headers=bearer(jwt),
        ).json()
        assert after_last["position_key"] == "3000"
        for expected_version in range(2, 3):
            moved = client.post(
                f"/plans/{plan_id}/itinerary-items/{first['id']}/reorder",
                json={"expected_version": expected_version, "next_item_id": second["id"]},
                headers=bearer(jwt),
            )
            assert moved.status_code == 200
        equal_neighbors = client.post(
            f"/plans/{plan_id}/itinerary-items/{second['id']}/reorder",
            json={
                "expected_version": 1,
                "previous_item_id": first["id"],
                "next_item_id": first["id"],
            },
            headers=bearer(jwt),
        )
        snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()
    assert cross_plan.status_code == 404
    assert equal_neighbors.status_code == 422
    assert all(
        "." not in item["position_key"] or len(item["position_key"].split(".")[1]) <= 18
        for item in snapshot["itinerary_items"]
    )


def test_finalized_endpoint_by_endpoint_rejection_and_lifecycle_authorization() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        invite = client.post(f"/plans/{plan_id}/invites", headers=bearer(owner_jwt)).json()
        member_jwt = sync_user(client, f"member-{uuid4()}")
        assert (
            client.post(f"/invites/{invite['token']}/join", headers=bearer(member_jwt)).status_code
            == 200
        )
        activity = client.post(
            f"/plans/{plan_id}/activities", json={"name": "A"}, headers=bearer(owner_jwt)
        ).json()
        item = client.post(
            f"/plans/{plan_id}/itinerary-items", json={"title": "I"}, headers=bearer(owner_jwt)
        ).json()
        expense = client.post(
            f"/plans/{plan_id}/expenses",
            json={"description": "E", "amount_cents": 10},
            headers=bearer(owner_jwt),
        ).json()
        pre_final_invite = client.post(
            f"/plans/{plan_id}/invites", headers=bearer(owner_jwt)
        ).json()
        plan = client.get(f"/plans/{plan_id}", headers=bearer(owner_jwt)).json()
        assert (
            client.post(
                f"/plans/{plan_id}/finalize",
                json={"expected_version": plan["version"]},
                headers=bearer(member_jwt),
            ).status_code
            == 403
        )
        assert (
            client.post(
                f"/plans/{plan_id}/unfinalize",
                json={"expected_version": plan["version"]},
                headers=bearer(member_jwt),
            ).status_code
            == 403
        )
        finalized = client.post(
            f"/plans/{plan_id}/finalize",
            json={"expected_version": plan["version"]},
            headers=bearer(owner_jwt),
        ).json()
        baseline = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        rejected = [
            client.post(
                f"/plans/{plan_id}/activities", json={"name": "blocked"}, headers=bearer(owner_jwt)
            ),
            client.patch(
                f"/plans/{plan_id}/activities/{activity['id']}",
                json={"name": "blocked", "expected_version": 1},
                headers=bearer(owner_jwt),
            ),
            client.delete(
                f"/plans/{plan_id}/activities/{activity['id']}?expected_version=1",
                headers=bearer(owner_jwt),
            ),
            client.put(
                f"/plans/{plan_id}/activities/{activity['id']}/vote",
                json={"vote": "yes"},
                headers=bearer(member_jwt),
            ),
            client.post(
                f"/plans/{plan_id}/itinerary-items",
                json={"title": "blocked"},
                headers=bearer(owner_jwt),
            ),
            client.patch(
                f"/plans/{plan_id}/itinerary-items/{item['id']}",
                json={"title": "blocked", "expected_version": 1},
                headers=bearer(owner_jwt),
            ),
            client.post(
                f"/plans/{plan_id}/itinerary-items/{item['id']}/reorder",
                json={"expected_version": 1},
                headers=bearer(owner_jwt),
            ),
            client.delete(
                f"/plans/{plan_id}/itinerary-items/{item['id']}?expected_version=1",
                headers=bearer(owner_jwt),
            ),
            client.post(
                f"/plans/{plan_id}/expenses",
                json={"description": "blocked", "amount_cents": 1},
                headers=bearer(owner_jwt),
            ),
            client.patch(
                f"/plans/{plan_id}/expenses/{expense['id']}",
                json={"description": "blocked", "amount_cents": 1, "expected_version": 1},
                headers=bearer(owner_jwt),
            ),
            client.delete(
                f"/plans/{plan_id}/expenses/{expense['id']}?expected_version=1",
                headers=bearer(owner_jwt),
            ),
            client.patch(
                f"/plans/{plan_id}",
                json={"budget_cents": 1, "expected_version": finalized["version"]},
                headers=bearer(owner_jwt),
            ),
            client.patch(
                f"/plans/{plan_id}",
                json={
                    "starts_on": "2027-01-01T00:00:00Z",
                    "expected_version": finalized["version"],
                },
                headers=bearer(owner_jwt),
            ),
            client.patch(
                f"/plans/{plan_id}",
                json={"max_drive_minutes": 1, "expected_version": finalized["version"]},
                headers=bearer(owner_jwt),
            ),
            client.post(f"/plans/{plan_id}/invites", headers=bearer(owner_jwt)),
            client.post(
                f"/invites/{pre_final_invite['token']}/join",
                headers=bearer(sync_user(client, f"late-{uuid4()}")),
            ),
        ]
        repeated = client.post(
            f"/plans/{plan_id}/finalize",
            json={"expected_version": finalized["version"]},
            headers=bearer(owner_jwt),
        )
        after_rejected = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()
        unfinalized = client.post(
            f"/plans/{plan_id}/unfinalize",
            json={"expected_version": finalized["version"]},
            headers=bearer(owner_jwt),
        )
    assert all(response.status_code in (403, 409) for response in rejected)
    assert repeated.status_code == 409
    assert after_rejected["plan"]["version"] == baseline["plan"]["version"]
    assert after_rejected["plan"]["planning_version"] == baseline["plan"]["planning_version"]
    assert unfinalized.status_code == 200


def test_resync_phase_1b_state_is_complete_and_authoritative() -> None:
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        activity = client.post(
            f"/plans/{plan_id}/activities", json={"name": "Museum"}, headers=bearer(jwt)
        ).json()
        first = client.post(
            f"/plans/{plan_id}/itinerary-items", json={"title": "First"}, headers=bearer(jwt)
        ).json()
        second = client.post(
            f"/plans/{plan_id}/itinerary-items", json={"title": "Second"}, headers=bearer(jwt)
        ).json()
        reordered = client.post(
            f"/plans/{plan_id}/itinerary-items/{second['id']}/reorder",
            json={"expected_version": 1, "next_item_id": first["id"]},
            headers=bearer(jwt),
        ).json()
        expense = client.post(
            f"/plans/{plan_id}/expenses",
            json={"description": "Dinner", "amount_cents": 1000},
            headers=bearer(jwt),
        ).json()
        corrected = client.patch(
            f"/plans/{plan_id}/expenses/{expense['id']}",
            json={"description": "Dinner corrected", "amount_cents": 1001, "expected_version": 1},
            headers=bearer(jwt),
        ).json()
        after_edit = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()
        assert (
            client.delete(
                f"/plans/{plan_id}/expenses/{expense['id']}?expected_version=2", headers=bearer(jwt)
            ).status_code
            == 204
        )
        plan = client.get(f"/plans/{plan_id}", headers=bearer(jwt)).json()
        finalized = client.post(
            f"/plans/{plan_id}/finalize",
            json={"expected_version": plan["version"]},
            headers=bearer(jwt),
        ).json()
        final_snapshot = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()
        unfinalized = client.post(
            f"/plans/{plan_id}/unfinalize",
            json={"expected_version": finalized["version"]},
            headers=bearer(jwt),
        ).json()
        restored = client.get(f"/plans/{plan_id}/resync", headers=bearer(jwt)).json()
    assert [item["id"] for item in after_edit["itinerary_items"]] == [reordered["id"], first["id"]]
    assert after_edit["activities"][0]["id"] == activity["id"]
    assert after_edit["activities"][0]["version"] == activity["version"] == 1
    assert all("version" in item for item in after_edit["itinerary_items"])
    assert after_edit["expenses"][0]["version"] == corrected["version"] == 2
    assert sum(entry["amount_cents"] for entry in after_edit["ledger_entries"]) == 0
    assert final_snapshot["plan"]["status"] == "finalized"
    assert final_snapshot["server_version"] == finalized["version"]
    assert restored["plan"]["status"] == "draft"
    assert restored["plan"]["version"] == unfinalized["version"]
