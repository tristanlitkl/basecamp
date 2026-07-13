"""Small, timeout-bounded Overpass provider client."""

from typing import Any

import httpx


async def discover_nearby(
    bbox: tuple[float, float, float, float], place_type: str, *, timeout_seconds: float = 8.0
) -> list[dict[str, Any]]:
    south, west, north, east = bbox
    query = (
        "[out:json][timeout:7];"
        f'(node["amenity"="{place_type}"]({south},{west},{north},{east});'
        f'way["amenity"="{place_type}"]({south},{west},{north},{east}););out center;'
    )
    async with httpx.AsyncClient(timeout=timeout_seconds) as client:
        response = await client.post(
            "https://overpass-api.de/api/interpreter", data={"data": query}
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
