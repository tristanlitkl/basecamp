"""Cache-first, typed, fallback-safe external data orchestration for Phase 2."""

from __future__ import annotations

import hashlib
import logging
import math
import asyncio
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Literal

import httpx
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.external import nominatim, open_meteo, osrm, overpass
from app.models.cache import PlaceCache, RouteCache, WeatherSnapshot
from app.services.cleanup_service import cleanup_expired_external_cache

PLACE_TTL = timedelta(days=7)
ROUTE_TTL = timedelta(days=7)
WEATHER_TTL = timedelta(hours=24)
CACHE_RETENTION = timedelta(days=30)
CLEANUP_EVERY_REQUESTS = 20

_nominatim_inflight_lock = asyncio.Lock()
_nominatim_inflight: dict[str, asyncio.Future["PlaceSearchResponse"]] = {}
_cleanup_request_count = 0
logger = logging.getLogger(__name__)

ExternalErrorCategory = Literal["rate_limit", "provider_unavailable", "malformed_response"]


class PlaceResult(BaseModel):
    name: str
    latitude: float
    longitude: float
    address: str | None = None
    type: str | None = None


class PlaceSearchResponse(BaseModel):
    status: Literal["ok", "cached", "stale", "unavailable"]
    results: list[PlaceResult] = Field(default_factory=list)
    error_category: ExternalErrorCategory | None = None


class RouteEstimate(BaseModel):
    status: Literal["ok", "cached", "stale", "unavailable"]
    distance_meters: float
    duration_minutes: int
    approximate: bool = False
    error_category: ExternalErrorCategory | None = None


class WeatherResponse(BaseModel):
    status: Literal["ok", "cached", "stale", "unavailable"]
    temperature_celsius: float | None = None
    weather_code: int | None = None
    weather_score: float
    error_category: ExternalErrorCategory | None = None


def _provider_error_category(error: Exception) -> ExternalErrorCategory:
    if isinstance(error, httpx.HTTPStatusError) and error.response.status_code == 429:
        return "rate_limit"
    if isinstance(error, (ValueError, TypeError, KeyError)):
        return "malformed_response"
    return "provider_unavailable"


def _log_provider_failure(provider: str, error: Exception, **context: object) -> None:
    status_code = error.response.status_code if isinstance(error, httpx.HTTPStatusError) else None
    logger.warning(
        "external_provider_failure provider=%s category=%s status_code=%s context=%s",
        provider,
        _provider_error_category(error),
        status_code,
        context,
    )


def normalize_query(query: str) -> str:
    return " ".join(query.casefold().strip().split())


def cache_key(*parts: object) -> str:
    normalized = "|".join(str(part) for part in parts)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def place_search_key(query: str) -> str:
    return cache_key("nominatim", normalize_query(query))


def nearby_places_key(bbox: tuple[float, float, float, float], place_type: str) -> str:
    coordinates = ",".join(f"{coordinate:.5f}" for coordinate in bbox)
    return cache_key("overpass", coordinates, normalize_query(place_type))


def route_key(origin: tuple[float, float], destination: tuple[float, float]) -> str:
    return cache_key("osrm", *(f"{value:.6f}" for value in (*origin, *destination)))


def canonical_coordinate(value: Decimal | float | int | str) -> Decimal:
    """Normalize provider/API coordinates before cache keys or Numeric persistence."""
    return Decimal(str(value)).quantize(Decimal("0.000001"))


def coordinate_text(value: Decimal | float | int | str) -> str:
    return format(canonical_coordinate(value), ".6f")


def weather_key(
    latitude: Decimal | float | int | str,
    longitude: Decimal | float | int | str,
    forecast_hour: str,
) -> str:
    return cache_key(
        "open-meteo",
        coordinate_text(latitude),
        coordinate_text(longitude),
        canonical_hour(forecast_hour),
    )


def canonical_hour(value: str) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0).isoformat()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _fresh(expires_at: datetime, now: datetime) -> bool:
    return (
        expires_at.replace(tzinfo=timezone.utc) >= now
        if expires_at.tzinfo is None
        else expires_at >= now
    )


def reset_external_service_state() -> None:
    """Reset process-local coordination for deterministic tests only."""
    global _cleanup_request_count
    _cleanup_request_count = 0
    _nominatim_inflight.clear()


async def _maybe_cleanup(session: AsyncSession) -> None:
    """Bound deletion work and keep cleanup failures out of user-facing provider flows."""
    global _cleanup_request_count
    _cleanup_request_count += 1
    if _cleanup_request_count % CLEANUP_EVERY_REQUESTS:
        return
    try:
        await cleanup_expired_external_cache(session, now=_now() - CACHE_RETENTION)
        await session.commit()
    except Exception:
        await session.rollback()


async def _store_place(
    session: AsyncSession, key: str, kind: str, source: str, results: list[dict]
) -> None:
    statement = (
        insert(PlaceCache)
        .values(
            cache_key=key,
            kind=kind,
            source=source,
            status="ok",
            payload=results,
            expires_at=_now() + PLACE_TTL,
        )
        .on_conflict_do_update(
            constraint="uq_place_cache_key",
            set_={
                "payload": results,
                "source": source,
                "status": "ok",
                "expires_at": _now() + PLACE_TTL,
            },
        )
    )
    await session.execute(statement)
    await session.commit()


async def _place_cache(session: AsyncSession, key: str) -> PlaceCache | None:
    return (
        await session.execute(select(PlaceCache).where(PlaceCache.cache_key == key))
    ).scalar_one_or_none()


def _place_response(record: PlaceCache, status: Literal["cached", "stale"]) -> PlaceSearchResponse:
    return PlaceSearchResponse(
        status=status, results=[PlaceResult(**item) for item in record.payload]
    )


async def search_places(session: AsyncSession, query: str) -> PlaceSearchResponse:
    await _maybe_cleanup(session)
    normalized = normalize_query(query)
    key = place_search_key(normalized)
    record = await _place_cache(session, key)
    now = _now()
    if record and _fresh(record.expires_at, now):
        return _place_response(record, "cached")
    async with _nominatim_inflight_lock:
        future = _nominatim_inflight.get(key)
        if future is None:
            future = asyncio.get_running_loop().create_future()
            _nominatim_inflight[key] = future
            leader = True
        else:
            leader = False
    if not leader:
        return (await asyncio.shield(future)).model_copy(deep=True)

    try:
        results = await nominatim.search_places(normalized)
        await _store_place(session, key, "geocode", "nominatim", results)
        response = PlaceSearchResponse(
            status="ok", results=[PlaceResult(**item) for item in results]
        )
    except Exception as error:  # provider failures are expected; never expose internals
        _log_provider_failure("nominatim", error, query_length=len(normalized))
        response = (
            _place_response(record, "stale")
            if record
            else PlaceSearchResponse(
                status="unavailable", error_category=_provider_error_category(error)
            )
        )
    except BaseException as error:
        if not future.done():
            future.set_exception(error)
        raise
    finally:
        async with _nominatim_inflight_lock:
            _nominatim_inflight.pop(key, None)
    if not future.done():
        future.set_result(response)
    return response


async def discover_nearby_places(
    session: AsyncSession, bbox: tuple[float, float, float, float], place_type: str
) -> PlaceSearchResponse:
    await _maybe_cleanup(session)
    key = nearby_places_key(bbox, place_type)
    record = await _place_cache(session, key)
    now = _now()
    if record and _fresh(record.expires_at, now):
        return _place_response(record, "cached")
    try:
        results = await overpass.discover_nearby(bbox, normalize_query(place_type))
        await _store_place(session, key, "nearby", "overpass", results)
        return PlaceSearchResponse(status="ok", results=[PlaceResult(**item) for item in results])
    except Exception as error:
        _log_provider_failure("overpass", error, place_type=normalize_query(place_type))
        if record:
            return _place_response(record, "stale")
        return PlaceSearchResponse(
            status="unavailable", error_category=_provider_error_category(error)
        )


def straight_line_route(
    origin: tuple[float, float],
    destination: tuple[float, float],
    error_category: ExternalErrorCategory = "provider_unavailable",
) -> RouteEstimate:
    lat1, lng1, lat2, lng2 = map(math.radians, (*origin, *destination))
    haversine = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    )
    meters = 6_371_000 * 2 * math.asin(math.sqrt(haversine))
    miles = meters / 1609.344
    return RouteEstimate(
        status="unavailable",
        distance_meters=round(meters, 2),
        duration_minutes=max(1, round(miles * 2.5)),
        approximate=True,
        error_category=error_category,
    )


async def _route_cache(session: AsyncSession, key: str) -> RouteCache | None:
    return (
        await session.execute(select(RouteCache).where(RouteCache.cache_key == key))
    ).scalar_one_or_none()


def _route_response(record: RouteCache, status: Literal["cached", "stale"]) -> RouteEstimate:
    return RouteEstimate(
        status=status,
        distance_meters=record.distance_meters,
        duration_minutes=record.duration_minutes,
        approximate=record.estimate_status != "ok",
    )


async def get_route_estimate(
    session: AsyncSession, origin: tuple[float, float], destination: tuple[float, float]
) -> RouteEstimate:
    await _maybe_cleanup(session)
    key = route_key(origin, destination)
    record = await _route_cache(session, key)
    if record and _fresh(record.expires_at, _now()):
        return _route_response(record, "cached")
    try:
        live = await osrm.get_route(origin, destination)
        statement = (
            insert(RouteCache)
            .values(
                cache_key=key,
                source="osrm",
                estimate_status="ok",
                distance_meters=live["distance_meters"],
                duration_minutes=live["duration_minutes"],
                expires_at=_now() + ROUTE_TTL,
            )
            .on_conflict_do_update(
                constraint="uq_route_cache_key",
                set_={
                    "source": "osrm",
                    "estimate_status": "ok",
                    "distance_meters": live["distance_meters"],
                    "duration_minutes": live["duration_minutes"],
                    "expires_at": _now() + ROUTE_TTL,
                },
            )
        )
        await session.execute(statement)
        await session.commit()
        return RouteEstimate(status="ok", **live)
    except Exception as error:
        _log_provider_failure("osrm", error)
        if record:
            return _route_response(record, "stale")
        return straight_line_route(origin, destination, _provider_error_category(error))


async def _weather_cache(session: AsyncSession, key: str) -> WeatherSnapshot | None:
    return (
        await session.execute(select(WeatherSnapshot).where(WeatherSnapshot.cache_key == key))
    ).scalar_one_or_none()


def _weather_response(
    record: WeatherSnapshot, status: Literal["cached", "stale"]
) -> WeatherResponse:
    return WeatherResponse(
        status=status,
        temperature_celsius=record.temperature_celsius,
        weather_code=record.weather_code,
        weather_score=record.weather_score,
    )


def weather_score(weather_code: int) -> float:
    return 0.8 if weather_code <= 3 else 0.5 if weather_code <= 48 else 0.25


async def get_weather(
    session: AsyncSession, latitude: float, longitude: float, forecast_hour: str
) -> WeatherResponse:
    await _maybe_cleanup(session)
    canonical = canonical_hour(forecast_hour)
    normalized_lat, normalized_lng = canonical_coordinate(latitude), canonical_coordinate(longitude)
    key = weather_key(normalized_lat, normalized_lng, canonical)
    record = await _weather_cache(session, key)
    if record and _fresh(record.expires_at, _now()):
        return _weather_response(record, "cached")
    try:
        live = await open_meteo.get_weather(float(normalized_lat), float(normalized_lng), canonical)
        score = weather_score(live["weather_code"])
        statement = (
            insert(WeatherSnapshot)
            .values(
                cache_key=key,
                latitude=normalized_lat,
                longitude=normalized_lng,
                forecast_hour=canonical,
                source="open-meteo",
                status="ok",
                temperature_celsius=live["temperature_celsius"],
                weather_code=live["weather_code"],
                weather_score=score,
                expires_at=_now() + WEATHER_TTL,
            )
            .on_conflict_do_update(
                constraint="uq_weather_snapshots_key",
                set_={
                    "temperature_celsius": live["temperature_celsius"],
                    "weather_code": live["weather_code"],
                    "weather_score": score,
                    "status": "ok",
                    "expires_at": _now() + WEATHER_TTL,
                },
            )
        )
        await session.execute(statement)
        await session.commit()
        return WeatherResponse(
            status="ok",
            temperature_celsius=live["temperature_celsius"],
            weather_code=live["weather_code"],
            weather_score=score,
        )
    except Exception as error:
        _log_provider_failure("open-meteo", error, forecast_hour=canonical)
        if record:
            return _weather_response(record, "stale")
        return WeatherResponse(
            status="unavailable",
            weather_score=0.5,
            error_category=_provider_error_category(error),
        )
