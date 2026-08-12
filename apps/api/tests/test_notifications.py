"""Real-Postgres coverage for persisted collaboration notifications."""

from uuid import uuid4

from sqlalchemy import func, select

from app.db.base import AsyncSessionLocal
from app.models.event import PlanEvent
from app.models.notification import Notification
from app.models.plan import Plan
from app.services.notification_service import create_notifications
from test_phase_1a5 import bearer, client_context, create_plan, sync_user


def add_member(client, owner_jwt: str, plan_id: str) -> str:
    invite = client.post(f"/plans/{plan_id}/invites", headers=bearer(owner_jwt))
    assert invite.status_code == 201
    member_jwt = sync_user(client, f"member-{uuid4()}")
    joined = client.post(f"/invites/{invite.json()['token']}/join", headers=bearer(member_jwt))
    assert joined.status_code == 200
    return member_jwt


def inbox(client, jwt: str, plan_id: str) -> dict:
    response = client.get(f"/notifications?plan_id={plan_id}", headers=bearer(jwt))
    assert response.status_code == 200
    return response.json()


async def notification_count(plan_id: str) -> int:
    async with AsyncSessionLocal() as session:
        return (
            await session.execute(
                select(func.count())
                .select_from(Notification)
                .where(Notification.plan_id == plan_id)
            )
        ).scalar_one()


async def plan_state(plan_id: str) -> tuple[int, int, int]:
    async with AsyncSessionLocal() as session:
        plan = (await session.execute(select(Plan).where(Plan.id == plan_id))).scalar_one()
        event_count = (
            await session.execute(
                select(func.count()).select_from(PlanEvent).where(PlanEvent.plan_id == plan_id)
            )
        ).scalar_one()
        return plan.version, plan.planning_version, event_count


async def insert_then_rollback_notification(plan_id: str) -> None:
    """Use the real transaction boundary that source mutations share."""
    async with AsyncSessionLocal() as session:
        plan = (await session.execute(select(Plan).where(Plan.id == plan_id))).scalar_one()
        await create_notifications(
            session,
            plan_id=plan.id,
            recipients=[plan.owner_id],
            actor_id=None,
            event_type="rollback.proof",
            entity_type="plan",
            entity_id=plan.id,
            title="Rollback proof",
            source_key=f"rollback-proof:{uuid4()}",
        )
        await session.flush()
        await session.rollback()


def test_member_join_and_promotion_notify_only_the_intended_recipient() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt = add_member(client, owner_jwt, plan_id)
        member_id = client.get(f"/plans/{plan_id}/resync", headers=bearer(member_jwt)).json()[
            "current_user_id"
        ]
        client.post("/notifications/read-all", json={"plan_id": plan_id}, headers=bearer(owner_jwt))
        changed = client.patch(
            f"/plans/{plan_id}/members/{member_id}/role",
            json={"role": "co_owner", "client_operation_id": str(uuid4())},
            headers=bearer(owner_jwt),
        )
        assert changed.status_code == 200
        owner_inbox = inbox(client, owner_jwt, plan_id)
        member_items = inbox(client, member_jwt, plan_id)["notifications"]
    assert owner_inbox["unread_count"] == 0
    assert [item["event_type"] for item in member_items] == ["member.promoted"]


def test_co_owner_request_and_notification_read_access_are_recipient_scoped() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt = add_member(client, owner_jwt, plan_id)
        client.post("/notifications/read-all", json={"plan_id": plan_id}, headers=bearer(owner_jwt))
        request = client.post(
            f"/plans/{plan_id}/co-owner-requests",
            json={"client_operation_id": str(uuid4())},
            headers=bearer(member_jwt),
        )
        assert request.status_code == 201
        owner_item = inbox(client, owner_jwt, plan_id)["notifications"][0]
        denied = client.post(f"/notifications/{owner_item['id']}/read", headers=bearer(member_jwt))
        marked = client.post(f"/notifications/{owner_item['id']}/read", headers=bearer(owner_jwt))
        again = client.post(f"/notifications/{owner_item['id']}/read", headers=bearer(owner_jwt))
    assert owner_item["event_type"] == "co_owner_request.created"
    assert denied.status_code == 404
    assert marked.status_code == 200 and again.status_code == 200
    assert again.json()["is_read"] is True


def test_idempotent_itinerary_replay_creates_one_notification_and_read_state_has_no_plan_version_effect() -> (
    None
):
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt = add_member(client, owner_jwt, plan_id)
        client.post(
            "/notifications/read-all", json={"plan_id": plan_id}, headers=bearer(member_jwt)
        )
        before = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()["plan"]
        operation_id = str(uuid4())
        payload = {"title": "Coffee", "client_operation_id": operation_id}
        first = client.post(
            f"/plans/{plan_id}/itinerary-items", json=payload, headers=bearer(owner_jwt)
        )
        replay = client.post(
            f"/plans/{plan_id}/itinerary-items", json=payload, headers=bearer(owner_jwt)
        )
        items = inbox(client, member_jwt, plan_id)
        notification_id = items["notifications"][0]["id"]
        state_after_source = client.portal.call(plan_state, plan_id)
        read = client.post(f"/notifications/{notification_id}/read", headers=bearer(member_jwt))
        state_after_read = client.portal.call(plan_state, plan_id)
        after = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()["plan"]
    assert first.status_code == 201 and replay.status_code == 201
    assert first.json() == replay.json()
    assert [item["event_type"] for item in items["notifications"]] == ["itinerary_item.created"]
    assert items["unread_count"] == 1 and read.status_code == 200
    assert state_after_read == state_after_source
    assert (after["version"], after["planning_version"]) == (
        before["version"],
        before["planning_version"] + 1,
    )


def test_demotion_removal_finalize_and_reopen_have_exact_recipients_and_safe_history() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt = add_member(client, owner_jwt, plan_id)
        member_id = client.get(f"/plans/{plan_id}/resync", headers=bearer(member_jwt)).json()[
            "current_user_id"
        ]
        client.post("/notifications/read-all", json={"plan_id": plan_id}, headers=bearer(owner_jwt))
        promoted = client.patch(
            f"/plans/{plan_id}/members/{member_id}/role",
            json={"role": "co_owner", "client_operation_id": str(uuid4())},
            headers=bearer(owner_jwt),
        )
        demoted = client.patch(
            f"/plans/{plan_id}/members/{member_id}/role",
            json={"role": "member", "client_operation_id": str(uuid4())},
            headers=bearer(owner_jwt),
        )
        current = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()["plan"]
        finalized = client.post(
            f"/plans/{plan_id}/finalize",
            json={"expected_version": current["version"]},
            headers=bearer(owner_jwt),
        )
        reopened = client.post(
            f"/plans/{plan_id}/unfinalize",
            json={"expected_version": finalized.json()["version"]},
            headers=bearer(owner_jwt),
        )
        removed = client.delete(
            f"/plans/{plan_id}/members/{member_id}?client_operation_id={uuid4()}",
            headers=bearer(owner_jwt),
        )
        recipient_events = [
            item["event_type"] for item in inbox(client, member_jwt, plan_id)["notifications"]
        ]
        owner_unread = inbox(client, owner_jwt, plan_id)["unread_count"]
    assert promoted.status_code == 200 and demoted.status_code == 200
    assert reopened.status_code == 200 and removed.status_code == 204
    assert recipient_events == [
        "member.removed",
        "plan.draft",
        "plan.finalized",
        "member.demoted",
        "member.promoted",
    ]
    assert owner_unread == 0


def test_co_owner_accept_and_reject_notify_requesters_only() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        approved_jwt = add_member(client, owner_jwt, plan_id)
        denied_jwt = add_member(client, owner_jwt, plan_id)
        client.post("/notifications/read-all", json={"plan_id": plan_id}, headers=bearer(owner_jwt))
        approve_request = client.post(
            f"/plans/{plan_id}/co-owner-requests",
            json={"client_operation_id": str(uuid4())},
            headers=bearer(approved_jwt),
        ).json()
        approve = client.post(
            f"/plans/{plan_id}/co-owner-requests/{approve_request['id']}/approve",
            json={
                "expected_version": approve_request["version"],
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(owner_jwt),
        )
        deny_request = client.post(
            f"/plans/{plan_id}/co-owner-requests",
            json={"client_operation_id": str(uuid4())},
            headers=bearer(denied_jwt),
        ).json()
        deny = client.post(
            f"/plans/{plan_id}/co-owner-requests/{deny_request['id']}/deny",
            json={"expected_version": deny_request["version"], "client_operation_id": str(uuid4())},
            headers=bearer(owner_jwt),
        )
        approved_events = [
            item["event_type"] for item in inbox(client, approved_jwt, plan_id)["notifications"]
        ]
        denied_events = [
            item["event_type"] for item in inbox(client, denied_jwt, plan_id)["notifications"]
        ]
    assert approve.status_code == 200 and deny.status_code == 200
    assert "co_owner_request.approved" in approved_events
    assert "co_owner_request.denied" in denied_events


def test_activity_date_and_plan_suggestion_decisions_notify_original_suggester() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt = add_member(client, owner_jwt, plan_id)
        activity = client.post(
            f"/plans/{plan_id}/activities", json={"name": "Kayaking"}, headers=bearer(owner_jwt)
        ).json()
        activity_suggestion = client.post(
            f"/plans/{plan_id}/activities/{activity['id']}/suggestions",
            json={
                "suggestion_type": "notes",
                "proposed_changes_json": {"notes": "Bring water"},
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(member_jwt),
        ).json()
        accepted_activity = client.post(
            f"/plans/{plan_id}/activities/{activity['id']}/suggestions/{activity_suggestion['id']}/accept",
            json={
                "expected_activity_version": activity["version"],
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(owner_jwt),
        )
        date_suggestion = client.post(
            f"/plans/{plan_id}/date-suggestions",
            json={
                "starts_on": "2027-01-02",
                "ends_on": "2027-01-03",
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(member_jwt),
        ).json()
        version = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()["plan"][
            "version"
        ]
        dismissed_date = client.post(
            f"/plans/{plan_id}/date-suggestions/{date_suggestion['id']}/dismiss",
            json={"expected_plan_version": version, "client_operation_id": str(uuid4())},
            headers=bearer(owner_jwt),
        )
        plan_suggestion = client.post(
            f"/plans/{plan_id}/plan-suggestions",
            json={"title": "Coast", "client_operation_id": str(uuid4())},
            headers=bearer(member_jwt),
        ).json()
        version = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()["plan"][
            "version"
        ]
        accepted_plan = client.post(
            f"/plans/{plan_id}/plan-suggestions/{plan_suggestion['id']}/accept",
            json={"expected_plan_version": version, "client_operation_id": str(uuid4())},
            headers=bearer(owner_jwt),
        )
        events = [
            item["event_type"] for item in inbox(client, member_jwt, plan_id)["notifications"]
        ]
    assert accepted_activity.status_code == 200 and dismissed_date.status_code == 200
    assert accepted_plan.status_code == 200
    assert events == [
        "plan_suggestion.accepted",
        "date_suggestion.dismissed",
        "activity_suggestion.accepted",
    ]


def test_itinerary_deleted_source_remains_readable_and_expense_recipients_are_filtered() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt = add_member(client, owner_jwt, plan_id)
        uninvolved_jwt = add_member(client, owner_jwt, plan_id)
        member_id = client.get(f"/plans/{plan_id}/resync", headers=bearer(member_jwt)).json()[
            "current_user_id"
        ]
        owner_id = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()[
            "current_user_id"
        ]
        item = client.post(
            f"/plans/{plan_id}/itinerary-items",
            json={"title": "Lunch", "client_operation_id": str(uuid4())},
            headers=bearer(owner_jwt),
        ).json()
        scheduled = client.patch(
            f"/plans/{plan_id}/itinerary-items/{item['id']}",
            json={"starts_at": "2027-01-02T12:00:00Z", "expected_version": item["version"]},
            headers=bearer(owner_jwt),
        ).json()
        removed = client.delete(
            f"/plans/{plan_id}/itinerary-items/{item['id']}?expected_version={scheduled['version']}",
            headers=bearer(owner_jwt),
        )
        expense = client.post(
            f"/plans/{plan_id}/expenses",
            json={
                "description": "Cabin",
                "amount_cents": 1000,
                "participant_user_ids": [owner_id, member_id],
                "paid_by_user_id": owner_id,
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(owner_jwt),
        )
        member_events = [
            item["event_type"] for item in inbox(client, member_jwt, plan_id)["notifications"]
        ]
        member_items = inbox(client, member_jwt, plan_id)["notifications"]
        uninvolved_events = [
            item["event_type"] for item in inbox(client, uninvolved_jwt, plan_id)["notifications"]
        ]
    assert removed.status_code == 204 and expense.status_code == 201
    assert [event for event in member_events if event.startswith("itinerary_item.")] == [
        "itinerary_item.deleted",
        "itinerary_item.scheduled_changed",
        "itinerary_item.created",
    ]
    assert "expense.created" in member_events
    assert any(
        item["event_type"] == "itinerary_item.deleted" and item["body"] == "Lunch"
        for item in member_items
    )
    assert [event for event in uninvolved_events if event.startswith("itinerary_item.")] == [
        "itinerary_item.deleted",
        "itinerary_item.scheduled_changed",
        "itinerary_item.created",
    ]


def test_failed_mutation_and_explicit_transaction_rollback_leave_no_notification_rows() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        before = client.portal.call(notification_count, plan_id)
        failed = client.post(
            f"/plans/{plan_id}/expenses",
            json={
                "description": "Bad",
                "amount_cents": 1,
                "participant_user_ids": [],
                "client_operation_id": str(uuid4()),
            },
            headers=bearer(owner_jwt),
        )
        after = client.portal.call(notification_count, plan_id)
        client.portal.call(insert_then_rollback_notification, plan_id)
        after_rollback = client.portal.call(notification_count, plan_id)
    assert failed.status_code == 422
    assert before == after == after_rollback


def test_anonymous_vote_changes_create_no_notifications_and_read_all_is_idempotent() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        member_jwt = add_member(client, owner_jwt, plan_id)
        activity = client.post(
            f"/plans/{plan_id}/activities", json={"name": "Vote"}, headers=bearer(owner_jwt)
        ).json()
        version = client.get(f"/plans/{plan_id}/resync", headers=bearer(owner_jwt)).json()["plan"][
            "version"
        ]
        private = client.patch(
            f"/plans/{plan_id}/vote-visibility",
            json={"vote_visibility": "anonymous", "expected_version": version},
            headers=bearer(owner_jwt),
        )
        before = client.portal.call(notification_count, plan_id)
        vote = client.put(
            f"/plans/{plan_id}/activities/{activity['id']}/vote",
            json={"vote": "no"},
            headers=bearer(member_jwt),
        )
        after = client.portal.call(notification_count, plan_id)
        state_before_read_all = client.portal.call(plan_state, plan_id)
        first = client.post(
            "/notifications/read-all", json={"plan_id": plan_id}, headers=bearer(owner_jwt)
        )
        second = client.post(
            "/notifications/read-all", json={"plan_id": plan_id}, headers=bearer(owner_jwt)
        )
        state_after_read_all = client.portal.call(plan_state, plan_id)
    assert private.status_code == 200 and vote.status_code == 200
    assert before == after
    assert first.json()["marked_read"] >= 1 and second.json() == {"marked_read": 0}
    assert state_after_read_all == state_before_read_all
