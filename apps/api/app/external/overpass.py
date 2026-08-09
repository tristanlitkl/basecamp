"""Small, timeout-bounded Overpass provider client."""

import os
from typing import Any

import httpx


OVERPASS_USER_AGENT = os.getenv(
    "OVERPASS_USER_AGENT",
    "Basecamp/1.0 (student portfolio project; contact: triskieranli@gmail.com)",
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
    async with httpx.AsyncClient(
        timeout=timeout, headers={"User-Agent": OVERPASS_USER_AGENT}
    ) as client:
        response = await client.post(
            "https://overpass-api.de/api/interpreter",
            # The interpreter expects the QL program in its ``data`` form field.
            data={"data": query},
        )
        response.raise_for_status()
        data = response.json()
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
