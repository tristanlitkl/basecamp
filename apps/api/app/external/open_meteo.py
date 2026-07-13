"""Open-Meteo forecast provider client."""

from datetime import datetime
from typing import Any

import httpx


async def get_weather(
    latitude: float, longitude: float, forecast_hour: str, *, timeout_seconds: float = 5.0
) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=timeout_seconds) as client:
        response = await client.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": latitude,
                "longitude": longitude,
                "hourly": "temperature_2m,weather_code",
                "timezone": "UTC",
            },
        )
        response.raise_for_status()
        data = response.json()
    hourly = data.get("hourly") if isinstance(data, dict) else None
    if not isinstance(hourly, dict) or not isinstance(hourly.get("time"), list):
        raise ValueError("malformed_open_meteo_response")
    hour = forecast_hour.replace("Z", "+00:00")
    wanted = datetime.fromisoformat(hour).strftime("%Y-%m-%dT%H:00")
    try:
        index = hourly["time"].index(wanted)
        return {
            "temperature_celsius": float(hourly["temperature_2m"][index]),
            "weather_code": int(hourly["weather_code"][index]),
        }
    except (ValueError, IndexError, KeyError, TypeError) as exc:
        raise ValueError("missing_open_meteo_forecast_hour") from exc
