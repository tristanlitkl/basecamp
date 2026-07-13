"""Nominatim provider client with the public-service rate limit required by Phase 2."""

import asyncio
import os
import time
from typing import Any

import httpx

NOMINATIM_USER_AGENT = os.getenv(
    "NOMINATIM_USER_AGENT",
    "Basecamp/1.0 (student portfolio project; contact: triskieranli@gmail.com)",
)
_rate_lock = asyncio.Lock()
_last_live_request = 0.0


async def _wait_for_global_slot() -> None:
    """Serialize all live Nominatim requests at no more than one per second."""
    global _last_live_request
    async with _rate_lock:
        delay = 1.0 - (time.monotonic() - _last_live_request)
        if delay > 0:
            await asyncio.sleep(delay)
        _last_live_request = time.monotonic()


def reset_rate_limiter() -> None:
    """Test-only reset; production retains one process-wide limiter."""
    global _last_live_request
    _last_live_request = 0.0


async def search_places(
    query: str, *, limit: int = 5, timeout_seconds: float = 5.0
) -> list[dict[str, Any]]:
    await _wait_for_global_slot()
    async with httpx.AsyncClient(
        timeout=timeout_seconds, headers={"User-Agent": NOMINATIM_USER_AGENT}
    ) as client:
        response = await client.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": query, "format": "jsonv2", "limit": limit, "addressdetails": 1},
        )
        response.raise_for_status()
        data = response.json()
    if not isinstance(data, list):
        raise ValueError("malformed_nominatim_response")
    return [
        {
            "name": str(item.get("display_name", "")),
            "latitude": float(item["lat"]),
            "longitude": float(item["lon"]),
            "address": item.get("display_name"),
            "type": item.get("type"),
        }
        for item in data
        if isinstance(item, dict) and "lat" in item and "lon" in item
    ]
