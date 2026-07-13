"""OSRM route provider client."""

from typing import Any

import httpx


async def get_route(
    origin: tuple[float, float], destination: tuple[float, float], *, timeout_seconds: float = 5.0
) -> dict[str, Any]:
    origin_lng, origin_lat = origin[1], origin[0]
    destination_lng, destination_lat = destination[1], destination[0]
    url = f"https://router.project-osrm.org/route/v1/driving/{origin_lng},{origin_lat};{destination_lng},{destination_lat}"
    last_error: httpx.HTTPError | None = None
    for _attempt in range(2):  # one bounded retry; callers still receive a deterministic fallback
        try:
            async with httpx.AsyncClient(timeout=timeout_seconds) as client:
                response = await client.get(url, params={"overview": "false"})
                response.raise_for_status()
                data = response.json()
            break
        except httpx.HTTPError as error:
            last_error = error
    else:
        assert last_error is not None
        raise last_error
    routes = data.get("routes") if isinstance(data, dict) else None
    if not isinstance(routes, list) or not routes or not isinstance(routes[0], dict):
        raise ValueError("malformed_osrm_response")
    route = routes[0]
    return {
        "distance_meters": float(route["distance"]),
        "duration_minutes": max(1, round(float(route["duration"]) / 60)),
    }
