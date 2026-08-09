"""Small, timeout-bounded Overpass provider client."""

import os
import logging
from typing import Any
from urllib.parse import urlparse

import httpx


logger = logging.getLogger(__name__)


OVERPASS_USER_AGENT = os.getenv(
    "OVERPASS_USER_AGENT",
    "Basecamp/1.0 (student portfolio project; contact: triskieranli@gmail.com)",
)
OVERPASS_ENDPOINTS = tuple(
    endpoint.strip().rstrip("/")
    for endpoint in os.getenv(
        "OVERPASS_ENDPOINTS",
        "https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter",
    ).split(",")
    if endpoint.strip()
)

# Product categories deliberately map to the OpenStreetMap tagging vocabulary.
# A literal ``amenity=hiking`` query is valid Overpass but finds almost nothing;
# hiking trails are paths/footways and named routes instead.
PLACE_TYPE_FILTERS: dict[str, tuple[str, ...]] = {
    "cafe": ('["amenity"="cafe"]',),
    "restaurant": ('["amenity"="restaurant"]',),
    "park": ('["leisure"="park"]',),
    "museum": ('["tourism"="museum"]',),
    "hiking": (
        '["route"="hiking"]',
        '["highway"~"^(path|footway|track)$"]',
    ),
    "attraction": ('["tourism"="attraction"]',),
}


def build_nearby_query(bbox: tuple[float, float, float, float], place_type: str) -> str:
    """Build a bounded, category-aware Overpass query using nwr selectors."""
    south, west, north, east = bbox
    selectors = PLACE_TYPE_FILTERS.get(place_type, (f'["amenity"="{place_type}"]',))
    bounds = f"({south:.6f},{west:.6f},{north:.6f},{east:.6f})"
    clauses = ";".join(
        f"{element}{selector}{bounds}"
        for selector in selectors
        for element in ("node", "way", "relation")
    )
    return f"[out:json][timeout:15];({clauses};);out center tags;"


async def discover_nearby(
    bbox: tuple[float, float, float, float], place_type: str, *, timeout_seconds: float = 20.0
) -> list[dict[str, Any]]:
    query = build_nearby_query(bbox, place_type)
    timeout = httpx.Timeout(timeout_seconds, connect=min(3.0, timeout_seconds))
    for index, endpoint in enumerate(OVERPASS_ENDPOINTS):
        hostname = urlparse(endpoint).hostname or "invalid-endpoint"
        try:
            # Render has direct egress. Ignore ambient proxy variables so an
            # unavailable proxy cannot turn a direct provider request into a
            # ConnectError before the endpoint is contacted.
            async with httpx.AsyncClient(
                timeout=timeout,
                headers={"User-Agent": OVERPASS_USER_AGENT},
                trust_env=False,
            ) as client:
                response = await client.post(
                    endpoint,
                    # The interpreter expects the QL program in its ``data`` form field.
                    data={"data": query},
                )
                response.raise_for_status()
                data = response.json()
            break
        except (httpx.ConnectError, httpx.ProxyError, httpx.NetworkError) as error:
            logger.warning(
                "overpass_endpoint_attempt_failed endpoint_host=%s attempt=%s error_type=%s",
                hostname,
                index + 1,
                type(error).__name__,
            )
            # Fail over only before an HTTP response exists; 429 and malformed
            # response handling remain explicit service-level fallback states.
            if index + 1 < len(OVERPASS_ENDPOINTS):
                continue
            raise
    else:
        raise RuntimeError("no_overpass_endpoints_configured")
    elements = data.get("elements") if isinstance(data, dict) else None
    if not isinstance(elements, list):
        raise ValueError("malformed_overpass_response")
    results: list[dict[str, Any]] = []
    for item in elements:
        if not isinstance(item, dict):
            continue
        center = item.get("center") if isinstance(item.get("center"), dict) else item
        if "lat" not in center or "lon" not in center:
            continue
        tags = item.get("tags") if isinstance(item.get("tags"), dict) else {}
        results.append(
            {
                "name": str(tags.get("name") or place_type.title()),
                "latitude": float(center["lat"]),
                "longitude": float(center["lon"]),
                "address": tags.get("addr:full"),
                "type": place_type,
            }
        )
    return results
