"""Phase 2 cache-first external-data contracts (PostgreSQL-backed through TestClient)."""

import asyncio
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError

from app.db.base import AsyncSessionLocal
from app.external import nominatim
from app.models.cache import PlaceCache, RouteCache, WeatherSnapshot
from app.services.cleanup_service import cleanup_expired_external_cache
from app.services.external_api_service import (
    canonical_coordinate,
    coordinate_text,
    get_weather,
    nearby_places_key,
    place_search_key,
    reset_external_service_state,
    route_key,
    search_places,
    weather_key,
)
from test_phase_1a5 import bearer, client_context, create_plan, sync_user


def test_phase2_normalized_cache_keys_are_deterministic() -> None:
    assert place_search_key("  Golden   Gate PARK ") == place_search_key("golden gate park")
    assert nearby_places_key((1.123456, 2.0, 3.0, 4.0), "Cafe") == nearby_places_key(
        (1.123459, 2.0, 3.0, 4.0), " cafe "
    )
    assert route_key((1.0, 2.0), (3.0, 4.0)) == route_key((1.0, 2.0), (3.0, 4.0))
    assert weather_key(1.23449, 2.34551, "2026-01-01T12:45:00+00:00") == weather_key(
        1.23449, 2.34551, "2026-01-01T12:00:00Z"
    )
    latitude_values = (37.3349, 37.334900, Decimal("37.3349"), Decimal("37.334900"))
    longitude_values = (-122.009, Decimal("-122.009000"))
    assert {canonical_coordinate(value) for value in latitude_values} == {Decimal("37.334900")}
    assert {coordinate_text(value) for value in longitude_values} == {"-122.009000"}
    assert (
        len(
            {
                weather_key(value, longitude_values[0], "2026-01-01T12:00:00Z")
                for value in latitude_values
            }
        )
        == 1
    )
    assert (
        len(
            {
                weather_key(latitude_values[0], value, "2026-01-01T12:00:00Z")
                for value in longitude_values
            }
        )
        == 1
    )


def test_phase2_equivalent_decimal_weather_coordinates_share_one_postgres_cache_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_weather(*_args, **_kwargs):
        return {"temperature_celsius": 20.0, "weather_code": 1}

    monkeypatch.setattr("app.services.external_api_service.open_meteo.get_weather", fake_weather)
    forecast = "2031-01-01T12:00:00Z"
    key = weather_key(Decimal("37.334900"), Decimal("-122.009000"), forecast)

    async def exercise() -> tuple[str, str, int, Decimal, Decimal]:
        async with AsyncSessionLocal() as first:
            await first.execute(delete(WeatherSnapshot).where(WeatherSnapshot.cache_key == key))
            await first.commit()
            first_response = await get_weather(
                first, Decimal("37.3349"), Decimal("-122.009"), forecast
            )
        async with AsyncSessionLocal() as second:
            second_response = await get_weather(second, 37.334900, Decimal("-122.009000"), forecast)
        async with AsyncSessionLocal() as verify:
            row = (
                await verify.execute(
                    select(WeatherSnapshot).where(WeatherSnapshot.cache_key == key)
                )
            ).scalar_one()
            count = (
                await verify.execute(
                    select(func.count())
                    .select_from(WeatherSnapshot)
                    .where(WeatherSnapshot.cache_key == key)
                )
            ).scalar_one()
            return first_response.status, second_response.status, count, row.latitude, row.longitude

    with client_context() as client:
        first_status, second_status, count, latitude, longitude = client.portal.call(exercise)
    assert (first_status, second_status) == ("ok", "cached")
    assert count == 1
    assert latitude == Decimal("37.334900")
    assert longitude == Decimal("-122.009000")


def test_phase2_nominatim_fresh_cache_avoids_second_live_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    async def fake_search(query: str, **_kwargs):
        nonlocal calls
        calls += 1
        return [{"name": "Golden Gate Park", "latitude": 37.769, "longitude": -122.486}]

    monkeypatch.setattr("app.services.external_api_service.nominatim.search_places", fake_search)
    query = f"Golden Gate Park {uuid4()}"
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        first = client.get(
            f"/plans/{plan_id}/place-search?query={query.replace(' ', '%20')}", headers=bearer(jwt)
        )
        second = client.get(
            f"/plans/{plan_id}/place-search?query=%20{query.lower().replace(' ', '%20%20')}%20",
            headers=bearer(jwt),
        )
    assert first.status_code == second.status_code == 200
    assert first.json()["status"] == "ok"
    assert second.json()["status"] == "cached"
    assert calls == 1


def test_phase2_stale_place_cache_is_explicit_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fail_search(*_args, **_kwargs):
        raise httpx.TimeoutException("offline")

    monkeypatch.setattr("app.services.external_api_service.nominatim.search_places", fail_search)
    query = f"stale-place-{uuid4()}"
    key = place_search_key(query)

    async def seed() -> None:
        async with AsyncSessionLocal() as session:
            await session.execute(delete(PlaceCache).where(PlaceCache.cache_key == key))
            session.add(
                PlaceCache(
                    cache_key=key,
                    kind="geocode",
                    source="nominatim",
                    status="ok",
                    payload=[{"name": "Old", "latitude": 1.0, "longitude": 2.0}],
                    expires_at=datetime.now(timezone.utc) - timedelta(minutes=1),
                )
            )
            await session.commit()

    with client_context() as client:
        client.portal.call(seed)
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        response = client.get(f"/plans/{plan_id}/place-search?query={query}", headers=bearer(jwt))
    assert response.status_code == 200
    assert response.json()["status"] == "stale"
    assert response.json()["results"][0]["name"] == "Old"


def test_phase2_unavailable_provider_returns_typed_empty_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fail_search(*_args, **_kwargs):
        raise httpx.HTTPError("offline")

    monkeypatch.setattr("app.services.external_api_service.nominatim.search_places", fail_search)
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        response = client.get(
            f"/plans/{plan_id}/place-search?query=unfindable-{uuid4()}", headers=bearer(jwt)
        )
    assert response.status_code == 200
    assert response.json() == {
        "status": "unavailable",
        "results": [],
        "error_category": "provider_unavailable",
    }


def test_phase2_malformed_nominatim_response_is_explicit_and_logged(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    async def malformed_search(*_args, **_kwargs):
        raise ValueError("malformed_nominatim_response")

    monkeypatch.setattr(
        "app.services.external_api_service.nominatim.search_places", malformed_search
    )
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        response = client.get(
            f"/plans/{plan_id}/place-search?query=malformed-{uuid4()}", headers=bearer(jwt)
        )
    assert response.status_code == 200
    assert response.json()["error_category"] == "malformed_response"
    assert response.json()["results"] == []
    assert "provider=nominatim" in caplog.text
    assert "category=malformed_response" in caplog.text


def test_phase2_nominatim_user_agent_is_identifying_and_contactable() -> None:
    assert nominatim.NOMINATIM_USER_AGENT.startswith("Basecamp/")
    assert "contact:" in nominatim.NOMINATIM_USER_AGENT
    assert "example.invalid" not in nominatim.NOMINATIM_USER_AGENT


def test_phase2_nominatim_rate_limiter_serializes_immediate_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_get(*_args, **_kwargs):
        return None

    monkeypatch.setattr(nominatim, "search_places", fake_get)

    async def exercise() -> float:
        nominatim.reset_rate_limiter()
        started = time.monotonic()
        await asyncio.gather(nominatim._wait_for_global_slot(), nominatim._wait_for_global_slot())
        return time.monotonic() - started

    assert asyncio.run(exercise()) >= 0.95


def test_phase2_nominatim_sends_identifying_user_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, str] = {}

    class Response:
        def raise_for_status(self):
            pass

        def json(self):
            return []

    class Client:
        def __init__(self, *, headers, **_kwargs):
            captured.update(headers)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr(nominatim.httpx, "AsyncClient", Client)
    nominatim.reset_rate_limiter()
    assert asyncio.run(nominatim.search_places("one")) == []
    assert captured["User-Agent"] == nominatim.NOMINATIM_USER_AGENT


def test_phase2_osrm_failure_returns_deterministic_approximate_route(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fail_route(*_args, **_kwargs):
        raise httpx.TimeoutException("timeout")

    monkeypatch.setattr("app.services.external_api_service.osrm.get_route", fail_route)
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        response = client.get(
            f"/plans/{plan_id}/route-estimate?origin_lat=37&origin_lng=-122&destination_lat=38&destination_lng=-123",
            headers=bearer(jwt),
        )
    assert response.status_code == 200
    assert response.json()["status"] == "unavailable"
    assert response.json()["approximate"] is True
    assert response.json()["distance_meters"] > 0


def test_phase2_weather_stale_cache_beats_neutral_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fail_weather(*_args, **_kwargs):
        raise httpx.TimeoutException("timeout")

    monkeypatch.setattr("app.services.external_api_service.open_meteo.get_weather", fail_weather)
    forecast = f"2026-02-{uuid4().int % 28 + 1:02d}T12:00:00+00:00"
    key = weather_key(37.701, -122.4, forecast)

    async def seed() -> None:
        async with AsyncSessionLocal() as session:
            await session.execute(delete(WeatherSnapshot).where(WeatherSnapshot.cache_key == key))
            session.add(
                WeatherSnapshot(
                    cache_key=key,
                    latitude=37.701,
                    longitude=-122.4,
                    forecast_hour=forecast,
                    source="open-meteo",
                    status="ok",
                    temperature_celsius=18.0,
                    weather_code=1,
                    weather_score=0.8,
                    expires_at=datetime.now(timezone.utc) - timedelta(minutes=1),
                )
            )
            await session.commit()

    with client_context() as client:
        client.portal.call(seed)
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        response = client.get(
            f"/plans/{plan_id}/weather?latitude=37.701&longitude=-122.4&forecast_hour={forecast.replace('+00:00', 'Z').replace(':', '%3A')}",
            headers=bearer(jwt),
        )
    assert response.status_code == 200
    assert response.json()["status"] == "stale"
    assert response.json()["weather_score"] == 0.8


def test_phase2_weather_failure_without_cache_is_neutral(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fail_weather(*_args, **_kwargs):
        raise httpx.TimeoutException("timeout")

    monkeypatch.setattr("app.services.external_api_service.open_meteo.get_weather", fail_weather)
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        response = client.get(
            f"/plans/{plan_id}/weather?latitude=11&longitude=12&forecast_hour=2030-01-01T00%3A00%3A00Z",
            headers=bearer(jwt),
        )
    assert response.status_code == 200
    assert response.json() == {
        "status": "unavailable",
        "temperature_celsius": None,
        "weather_code": None,
        "weather_score": 0.5,
        "error_category": "provider_unavailable",
    }


def test_phase2_overpass_failure_is_typed_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fail_overpass(*_args, **_kwargs):
        raise httpx.TimeoutException("timeout")

    monkeypatch.setattr("app.services.external_api_service.overpass.discover_nearby", fail_overpass)
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        response = client.get(
            f"/plans/{plan_id}/nearby-places?south=1&west=2&north=3&east=4&place_type=cafe",
            headers=bearer(jwt),
        )
    assert response.status_code == 200
    assert response.json() == {
        "status": "unavailable",
        "results": [],
        "error_category": "provider_unavailable",
    }


def test_phase2_each_external_endpoint_requires_membership_and_allows_members(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fail_provider(*_args, **_kwargs):
        raise httpx.TimeoutException("offline")

    monkeypatch.setattr("app.services.external_api_service.nominatim.search_places", fail_provider)
    monkeypatch.setattr("app.services.external_api_service.overpass.discover_nearby", fail_provider)
    monkeypatch.setattr("app.services.external_api_service.osrm.get_route", fail_provider)
    monkeypatch.setattr("app.services.external_api_service.open_meteo.get_weather", fail_provider)
    with client_context() as client:
        member, plan_id = create_plan(client, f"owner-{uuid4()}")
        outsider = sync_user(client, f"outsider-{uuid4()}")
        routes = (
            f"/plans/{plan_id}/place-search?query=x",
            f"/plans/{plan_id}/nearby-places?south=1&west=2&north=3&east=4&place_type=cafe",
            f"/plans/{plan_id}/route-estimate?origin_lat=1&origin_lng=2&destination_lat=3&destination_lng=4",
            f"/plans/{plan_id}/weather?latitude=1&longitude=2",
        )
        for path in routes:
            assert client.get(path, headers=bearer(outsider)).status_code == 403
            assert client.get(path, headers=bearer(member)).status_code == 200


def test_phase2_all_provider_failures_leave_manual_activity_and_plan_workflows_available(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fail_provider(*_args, **_kwargs):
        raise httpx.TimeoutException("offline")

    monkeypatch.setattr("app.services.external_api_service.nominatim.search_places", fail_provider)
    monkeypatch.setattr("app.services.external_api_service.overpass.discover_nearby", fail_provider)
    monkeypatch.setattr("app.services.external_api_service.osrm.get_route", fail_provider)
    monkeypatch.setattr("app.services.external_api_service.open_meteo.get_weather", fail_provider)
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        assert (
            client.get(f"/plans/{plan_id}/place-search?query=manual", headers=bearer(jwt)).json()[
                "status"
            ]
            == "unavailable"
        )
        assert (
            client.get(
                f"/plans/{plan_id}/nearby-places?south=1&west=2&north=3&east=4&place_type=cafe",
                headers=bearer(jwt),
            ).json()["status"]
            == "unavailable"
        )
        assert (
            client.get(
                f"/plans/{plan_id}/route-estimate?origin_lat=1&origin_lng=2&destination_lat=3&destination_lng=4",
                headers=bearer(jwt),
            ).json()["approximate"]
            is True
        )
        assert (
            client.get(
                f"/plans/{plan_id}/weather?latitude=1&longitude=2", headers=bearer(jwt)
            ).json()["weather_score"]
            == 0.5
        )
        manual = client.post(
            f"/plans/{plan_id}/activities",
            json={"name": "Manual cabin", "address": "Typed by hand"},
            headers=bearer(jwt),
        )
        assert manual.status_code == 201
        plan = client.get(f"/plans/{plan_id}", headers=bearer(jwt)).json()
        assert (
            client.patch(
                f"/plans/{plan_id}",
                json={
                    "expected_version": plan["version"],
                    "travel_mode": "car",
                    "travel_duration_minutes": 45,
                },
                headers=bearer(jwt),
            ).status_code
            == 200
        )
        assert (
            client.post(
                f"/plans/{plan_id}/itinerary-items",
                json={"title": "Manual travel", "client_operation_id": str(uuid4())},
                headers=bearer(jwt),
            ).status_code
            == 201
        )
        assert client.get(f"/plans/{plan_id}", headers=bearer(jwt)).status_code == 200


def test_phase2_concurrent_identical_nominatim_cache_miss_is_single_flight(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    async def fake_search(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.05)
        return [{"name": "One flight", "latitude": 1.0, "longitude": 2.0}]

    monkeypatch.setattr("app.services.external_api_service.nominatim.search_places", fake_search)
    query = f"single-flight-{uuid4()}"
    key = place_search_key(query)

    async def exercise() -> tuple[list[dict], int]:
        reset_external_service_state()
        async with AsyncSessionLocal() as first, AsyncSessionLocal() as second:
            responses = await asyncio.gather(
                search_places(first, query), search_places(second, query)
            )
        async with AsyncSessionLocal() as verify:
            rows = (
                await verify.execute(
                    select(func.count()).select_from(PlaceCache).where(PlaceCache.cache_key == key)
                )
            ).scalar_one()
        return [response.model_dump() for response in responses], rows

    with client_context() as client:
        responses, rows = client.portal.call(exercise)
    assert calls == 1
    assert responses[0] == responses[1]
    assert responses[0]["status"] == "ok"
    assert rows == 1


def test_phase2_cleanup_runs_through_cache_access_and_preserves_recent_stale_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.services.external_api_service as external_service

    async def fail_search(*_args, **_kwargs):
        raise httpx.TimeoutException("offline")

    monkeypatch.setattr(external_service, "CLEANUP_EVERY_REQUESTS", 1)
    monkeypatch.setattr(external_service.nominatim, "search_places", fail_search)
    reset_external_service_state()
    expired_key, stale_key = f"expired-{uuid4()}", f"stale-{uuid4()}"

    async def seed() -> None:
        async with AsyncSessionLocal() as session:
            session.add_all(
                [
                    RouteCache(
                        cache_key=expired_key,
                        source="test",
                        estimate_status="ok",
                        distance_meters=1,
                        duration_minutes=1,
                        expires_at=datetime.now(timezone.utc) - timedelta(days=31),
                    ),
                    PlaceCache(
                        cache_key=stale_key,
                        kind="geocode",
                        source="test",
                        status="ok",
                        payload=[],
                        expires_at=datetime.now(timezone.utc) - timedelta(days=1),
                    ),
                ]
            )
            await session.commit()

    async def verify() -> tuple[bool, bool]:
        async with AsyncSessionLocal() as session:
            expired = (
                await session.execute(select(RouteCache).where(RouteCache.cache_key == expired_key))
            ).scalar_one_or_none()
            stale = (
                await session.execute(select(PlaceCache).where(PlaceCache.cache_key == stale_key))
            ).scalar_one_or_none()
            return expired is None, stale is not None

    with client_context() as client:
        client.portal.call(seed)
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        assert (
            client.get(
                f"/plans/{plan_id}/place-search?query=cleanup-{uuid4()}", headers=bearer(jwt)
            ).status_code
            == 200
        )
        assert client.portal.call(verify) == (True, True)


def test_phase2_cleanup_failure_does_not_break_external_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.services.external_api_service as external_service

    async def fail_cleanup(*_args, **_kwargs):
        raise RuntimeError("cleanup unavailable")

    async def fake_search(*_args, **_kwargs):
        return [{"name": "Available", "latitude": 1.0, "longitude": 2.0}]

    monkeypatch.setattr(external_service, "CLEANUP_EVERY_REQUESTS", 1)
    monkeypatch.setattr(external_service, "cleanup_expired_external_cache", fail_cleanup)
    monkeypatch.setattr(external_service.nominatim, "search_places", fake_search)
    reset_external_service_state()
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        response = client.get(
            f"/plans/{plan_id}/place-search?query=cleanup-safe-{uuid4()}", headers=bearer(jwt)
        )
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_phase2_postgres_cache_uniqueness_expiration_cleanup_and_versions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_search(*_args, **_kwargs):
        return [{"name": "Persistent", "latitude": 1.0, "longitude": 2.0}]

    monkeypatch.setattr("app.services.external_api_service.nominatim.search_places", fake_search)
    with client_context() as client:
        jwt, plan_id = create_plan(client, f"owner-{uuid4()}")
        before = client.get(f"/plans/{plan_id}", headers=bearer(jwt)).json()
        assert (
            client.get(
                f"/plans/{plan_id}/place-search?query=persistent-{plan_id}", headers=bearer(jwt)
            ).status_code
            == 200
        )
        after = client.get(f"/plans/{plan_id}", headers=bearer(jwt)).json()
    assert (before["version"], before["planning_version"]) == (
        after["version"],
        after["planning_version"],
    )
    key = place_search_key(f"persistent-{plan_id}")

    async def verify() -> None:
        async with AsyncSessionLocal() as session:
            weather_columns = (
                await session.execute(
                    text(
                        "SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable "
                        "FROM information_schema.columns WHERE table_schema = 'public' "
                        "AND table_name = 'weather_snapshots' AND column_name IN ('latitude', 'longitude') "
                        "ORDER BY column_name"
                    )
                )
            ).all()
            assert weather_columns == [
                ("latitude", "numeric", 9, 6, "NO"),
                ("longitude", "numeric", 9, 6, "NO"),
            ]
            constraints = set(
                (
                    await session.execute(
                        text(
                            "SELECT conname FROM pg_constraint WHERE conname IN "
                            "('uq_place_cache_key', 'uq_route_cache_key', 'uq_weather_snapshots_key')"
                        )
                    )
                ).scalars()
            )
            indexes = set(
                (
                    await session.execute(
                        text(
                            "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN "
                            "('ix_place_cache_expires_at', 'ix_route_cache_expires_at', 'ix_weather_snapshots_expires_at')"
                        )
                    )
                ).scalars()
            )
            assert constraints == {
                "uq_place_cache_key",
                "uq_route_cache_key",
                "uq_weather_snapshots_key",
            }
            assert indexes == {
                "ix_place_cache_expires_at",
                "ix_route_cache_expires_at",
                "ix_weather_snapshots_expires_at",
            }
            assert (
                await session.execute(select(PlaceCache).where(PlaceCache.cache_key == key))
            ).scalar_one().payload[0]["name"] == "Persistent"
            with pytest.raises(IntegrityError):
                await session.execute(
                    PlaceCache.__table__.insert().values(
                        id=uuid4(),
                        cache_key=key,
                        kind="geocode",
                        source="test",
                        status="ok",
                        payload=[],
                        expires_at=datetime.now(timezone.utc),
                    )
                )
                await session.commit()
            await session.rollback()
            session.add(
                RouteCache(
                    cache_key=f"expired-{uuid4()}",
                    source="test",
                    estimate_status="ok",
                    distance_meters=1,
                    duration_minutes=1,
                    expires_at=datetime.now(timezone.utc) - timedelta(days=31),
                )
            )
            await session.commit()
            assert (
                await cleanup_expired_external_cache(
                    session, now=datetime.now(timezone.utc) - timedelta(days=30)
                )
                >= 1
            )
            await session.commit()

    asyncio.run(verify())
