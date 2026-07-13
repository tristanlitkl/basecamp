"""Plan-authorized external-data convenience endpoints for Phase 2."""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_plan_member
from app.db.base import get_session
from app.schemas.external import PlaceSearchResponse, RouteEstimate, WeatherResponse
from app.services.external_api_service import (
    discover_nearby_places,
    get_route_estimate,
    get_weather,
    search_places,
)

router = APIRouter(tags=["external-data"])


@router.get("/plans/{plan_id}/place-search", response_model=PlaceSearchResponse)
async def place_search(
    plan_id: UUID,
    query: str = Query(min_length=1, max_length=200),
    _membership=Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> PlaceSearchResponse:
    return await search_places(session, query)


@router.get("/plans/{plan_id}/nearby-places", response_model=PlaceSearchResponse)
async def nearby_places(
    plan_id: UUID,
    south: float = Query(ge=-90, le=90),
    west: float = Query(ge=-180, le=180),
    north: float = Query(ge=-90, le=90),
    east: float = Query(ge=-180, le=180),
    place_type: str = Query(min_length=1, max_length=40, pattern="^[a-zA-Z_ -]+$"),
    _membership=Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> PlaceSearchResponse:
    return await discover_nearby_places(session, (south, west, north, east), place_type)


@router.get("/plans/{plan_id}/route-estimate", response_model=RouteEstimate)
async def route_estimate(
    plan_id: UUID,
    origin_lat: float = Query(ge=-90, le=90),
    origin_lng: float = Query(ge=-180, le=180),
    destination_lat: float = Query(ge=-90, le=90),
    destination_lng: float = Query(ge=-180, le=180),
    _membership=Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> RouteEstimate:
    return await get_route_estimate(
        session, (origin_lat, origin_lng), (destination_lat, destination_lng)
    )


@router.get("/plans/{plan_id}/weather", response_model=WeatherResponse)
async def weather(
    plan_id: UUID,
    latitude: float = Query(ge=-90, le=90),
    longitude: float = Query(ge=-180, le=180),
    forecast_hour: datetime | None = None,
    _membership=Depends(require_plan_member),
    session: AsyncSession = Depends(get_session),
) -> WeatherResponse:
    requested = forecast_hour or datetime.now(timezone.utc)
    return await get_weather(session, latitude, longitude, requested.isoformat())
