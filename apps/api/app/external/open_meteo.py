"""Open-Meteo forecast provider client."""

from datetime import datetime, timedelta, timezone
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
                "daily": "weather_code,temperature_2m_max,temperature_2m_min",
                "timezone": "auto",
            },
        )
        response.raise_for_status()
        data = response.json()
    hourly = data.get("hourly") if isinstance(data, dict) else None
    daily = data.get("daily") if isinstance(data, dict) else None
    if (
        not isinstance(hourly, dict)
        or not isinstance(hourly.get("time"), list)
        or not isinstance(daily, dict)
        or not isinstance(daily.get("time"), list)
    ):
        raise ValueError("malformed_open_meteo_response")
    hour = datetime.fromisoformat(forecast_hour.replace("Z", "+00:00"))
    if hour.tzinfo is None:
        hour = hour.replace(tzinfo=timezone.utc)
    offset_seconds = data.get("utc_offset_seconds") if isinstance(data, dict) else None
    if not isinstance(offset_seconds, (int, float)):
        raise ValueError("malformed_open_meteo_timezone")
    # Open-Meteo's hourly keys are in the requested location's local wall time.
    # Translate the canonical UTC cache hour before lookup, while retaining the
    # provider's daily local dates unmodified for the seven-day strip.
    wanted = (hour.astimezone(timezone.utc) + timedelta(seconds=offset_seconds)).strftime(
        "%Y-%m-%dT%H:00"
    )
    try:
        index = hourly["time"].index(wanted)
        days = [
            {
                "date": str(day),
                "weather_code": int(code),
                "temperature_max_celsius": float(high),
                "temperature_min_celsius": float(low),
            }
            for day, code, high, low in zip(
                daily["time"][:7],
                daily["weather_code"][:7],
                daily["temperature_2m_max"][:7],
                daily["temperature_2m_min"][:7],
                strict=True,
            )
        ]
        if len(days) != 7:
            raise ValueError("incomplete_open_meteo_daily_forecast")
        return {
            "temperature_celsius": float(hourly["temperature_2m"][index]),
            "weather_code": int(hourly["weather_code"][index]),
            "daily_forecast": days,
            "timezone": data.get("timezone") if isinstance(data.get("timezone"), str) else None,
        }
    except (ValueError, IndexError, KeyError, TypeError) as exc:
        raise ValueError("missing_open_meteo_forecast_hour") from exc
