import time
from collections.abc import Iterator
from contextlib import contextmanager
from uuid import uuid4

import jwt
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.db.base import engine
from app.main import app


def token(
    subject: str,
    *,
    issuer: str = "basecamp-web",
    audience: str = "basecamp-api",
    exp: int | None = None,
) -> str:
    now = int(time.time())
    return jwt.encode(
        {
            "sub": subject,
            "email": f"{subject}@example.com",
            "name": subject,
            "iss": issuer,
            "aud": audience,
            "iat": now,
            "exp": exp if exp is not None else now + 3600,
        },
        get_settings().jwt_secret,
        algorithm="HS256",
    )


def bearer(value: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {value}"}


@contextmanager
def client_context() -> Iterator[TestClient]:
    with TestClient(app) as client:
        try:
            yield client
        finally:
            client.portal.call(engine.dispose)


def sync_user(client: TestClient, subject: str) -> str:
    app_jwt = token(subject)
    response = client.post("/auth/sync-user", headers=bearer(app_jwt))
    assert response.status_code == 200
    return app_jwt


def create_plan(client: TestClient, subject: str) -> tuple[str, str]:
    app_jwt = sync_user(client, subject)
    response = client.post(
        "/plans",
        json={"title": f"Plan {uuid4()}"},
        headers=bearer(app_jwt),
    )
    assert response.status_code == 201
    return app_jwt, response.json()["id"]


def create_activity(client: TestClient, app_jwt: str, plan_id: str) -> str:
    response = client.post(
        f"/plans/{plan_id}/activities",
        json={"name": "Coffee"},
        headers=bearer(app_jwt),
    )
    assert response.status_code == 201
    return response.json()["id"]


def test_resync_rejects_unauthenticated_user():
    with client_context() as client:
        _, plan_id = create_plan(client, f"owner-{uuid4()}")
        response = client.get(f"/plans/{plan_id}/resync")
    assert response.status_code == 401


def test_resync_rejects_authenticated_non_member():
    with client_context() as client:
        _, plan_id = create_plan(client, f"owner-{uuid4()}")
        non_member_jwt = sync_user(client, f"non-member-{uuid4()}")
        response = client.get(f"/plans/{plan_id}/resync", headers=bearer(non_member_jwt))
    assert response.status_code == 403


def test_resync_returns_complete_authoritative_snapshot():
    with client_context() as client:
        app_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        activity_id = create_activity(client, app_jwt, plan_id)
        response = client.get(f"/plans/{plan_id}/resync", headers=bearer(app_jwt))

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "current_user_id",
        "plan",
        "members",
        "activities",
        "activity_scores",
        "itinerary_items",
        "votes",
        "expenses",
        "expense_splits",
        "ledger_entries",
        "latest_plan_events",
        "activity_comments",
        "activity_suggestions",
        "date_availability",
        "date_suggestions",
        "plan_suggestions",
        "server_version",
    }
    assert body["plan"]["id"] == plan_id
    assert body["members"]
    assert [activity["id"] for activity in body["activities"]] == [activity_id]
    assert activity_id in body["activity_scores"]


@pytest.mark.parametrize(
    "bad_token",
    [
        "",
        "not-a-jwt",
        token("expired", exp=int(time.time()) - 1),
        token("wrong-issuer", issuer="wrong"),
        token("wrong-audience", audience="wrong"),
    ],
)
def test_websocket_rejects_bad_authentication(bad_token: str):
    with client_context() as client:
        _, plan_id = create_plan(client, f"owner-{uuid4()}")
        path = f"/ws/plans/{plan_id}"
        if bad_token:
            path = f"{path}?token={bad_token}"
        with pytest.raises(Exception):
            with client.websocket_connect(path):
                pass


def test_websocket_rejects_non_member():
    with client_context() as client:
        _, plan_id = create_plan(client, f"owner-{uuid4()}")
        non_member_jwt = sync_user(client, f"non-member-{uuid4()}")
        with pytest.raises(Exception):
            with client.websocket_connect(f"/ws/plans/{plan_id}?token={non_member_jwt}"):
                pass


def test_websocket_valid_member_receives_connected():
    with client_context() as client:
        app_jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        with client.websocket_connect(f"/ws/plans/{plan_id}?token={app_jwt}") as websocket:
            assert websocket.receive_json() == {"type": "connected"}
