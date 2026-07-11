"""CORS coverage for browser mutations from the Basecamp web application."""

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from test_phase_1a5 import bearer, client_context, create_plan, sync_user


LOCAL_ORIGIN = "http://localhost:3000"
PRODUCTION_ORIGIN = "https://basecamp-production.vercel.app"


def cors_client() -> TestClient:
    return TestClient(
        create_app(
            Settings(
                database_url="postgresql+asyncpg://unused:unused@localhost/unused",
                jwt_secret="test-secret",
                cors_allowed_origins=f"{LOCAL_ORIGIN},{PRODUCTION_ORIGIN}/",
            )
        )
    )


def preflight_headers(origin: str) -> dict[str, str]:
    return {
        "Origin": origin,
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "authorization, content-type",
    }


@pytest.mark.parametrize(
    "path",
    [
        "/auth/me",
        "/plans/00000000-0000-0000-0000-000000000001",
        "/plans/00000000-0000-0000-0000-000000000001/activities/00000000-0000-0000-0000-000000000002",
        "/plans/00000000-0000-0000-0000-000000000001/vote-visibility",
        "/plans/00000000-0000-0000-0000-000000000001/members/00000000-0000-0000-0000-000000000003/role",
    ],
)
def test_patch_preflight_allows_representative_mutation_routes(path: str) -> None:
    with cors_client() as client:
        response = client.options(path, headers=preflight_headers(LOCAL_ORIGIN))

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == LOCAL_ORIGIN
    assert "PATCH" in response.headers["access-control-allow-methods"]
    allowed_headers = response.headers["access-control-allow-headers"].lower()
    assert "authorization" in allowed_headers
    assert "content-type" in allowed_headers


def test_patch_preflight_allows_the_configured_production_origin() -> None:
    with cors_client() as client:
        response = client.options("/auth/me", headers=preflight_headers(PRODUCTION_ORIGIN))

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == PRODUCTION_ORIGIN


def test_patch_preflight_rejects_an_unapproved_origin() -> None:
    with cors_client() as client:
        response = client.options(
            "/auth/me", headers=preflight_headers("https://unapproved.example")
        )

    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers


def test_actual_patch_endpoints_still_require_authentication_and_plan_authorization() -> None:
    with client_context() as client:
        owner_jwt, plan_id = create_plan(client, "cors-owner")
        member_jwt = sync_user(client, "cors-member")
        invite = client.post(f"/plans/{plan_id}/invites", headers=bearer(owner_jwt)).json()
        assert (
            client.post(f"/invites/{invite['token']}/join", headers=bearer(member_jwt)).status_code
            == 200
        )

        unauthenticated = client.patch("/auth/me", json={"display_name": "Nope"})
        authenticated = client.patch(
            "/auth/me", json={"display_name": "Owner"}, headers=bearer(owner_jwt)
        )
        member_mutation = client.patch(
            f"/plans/{plan_id}",
            json={"title": "Not allowed", "expected_version": 1},
            headers=bearer(member_jwt),
        )

    assert unauthenticated.status_code == 401
    assert authenticated.status_code == 200
    assert member_mutation.status_code == 403
