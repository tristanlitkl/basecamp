"""Open-Meteo seven-day and location-local time contracts."""

import asyncio

import pytest

from app.external import open_meteo


def test_open_meteo_keeps_seven_ordered_location_local_days_at_timezone_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Response:
        def raise_for_status(self) -> None:
            pass

        def json(self):
            return {
                "timezone": "America/Los_Angeles",
                "utc_offset_seconds": -25_200,
                "hourly": {
                    # 02:00 UTC is 19:00 of the preceding local day.
                    "time": ["2026-08-09T19:00"],
                    "temperature_2m": [9.7],
                    "weather_code": [0],
                },
                "daily": {
                    "time": [f"2026-08-{day:02d}" for day in range(9, 16)],
                    "weather_code": [0, 1, 2, 3, 61, 80, 95],
                    "temperature_2m_max": [20, 21, 22, 23, 24, 25, 26],
                    "temperature_2m_min": [8, 9, 10, 11, 12, 13, 14],
                },
            }

    class Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr(open_meteo.httpx, "AsyncClient", Client)
    result = asyncio.run(open_meteo.get_weather(38.95, -119.96, "2026-08-10T02:00:00Z"))

    assert result["temperature_celsius"] == 9.7
    assert result["timezone"] == "America/Los_Angeles"
    assert [day["date"] for day in result["daily_forecast"]] == [
        f"2026-08-{day:02d}" for day in range(9, 16)
    ]
    assert [day["temperature_max_celsius"] for day in result["daily_forecast"]] == [
        float(day) for day in range(20, 27)
    ]
    assert [day["temperature_min_celsius"] for day in result["daily_forecast"]] == [
        float(day) for day in range(8, 15)
    ]


def test_open_meteo_rejects_malformed_daily_or_timezone_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Response:
        def raise_for_status(self) -> None:
            pass

        def json(self):
            return {"hourly": {"time": []}, "daily": {"time": []}}

    class Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr(open_meteo.httpx, "AsyncClient", Client)
    with pytest.raises(ValueError, match="malformed_open_meteo_timezone"):
        asyncio.run(open_meteo.get_weather(1, 2, "2026-01-01T00:00:00Z"))
