"""Typed API responses for Phase 2 external-data endpoints."""

from app.services.external_api_service import (
    PlaceResult,
    PlaceSearchResponse,
    RouteEstimate,
    WeatherResponse,
)

__all__ = ["PlaceResult", "PlaceSearchResponse", "RouteEstimate", "WeatherResponse"]
