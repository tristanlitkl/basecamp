"""Provider-level Overpass query and response contracts."""

import asyncio

import httpx
import pytest

from app.external import overpass


@pytest.mark.parametrize(
    ("category", "expected"),
    [
        ("cafe", '["amenity"="cafe"]'),
        ("restaurant", '["amenity"="restaurant"]'),
        ("park", '["leisure"="park"]'),
        ("museum", '["tourism"="museum"]'),
        ("hiking", '["highway"~"^(path|footway|track)$"]'),
        ("attraction", '["tourism"="attraction"]'),
    ],
)
def test_overpass_builds_category_aware_lake_tahoe_queries(category: str, expected: str) -> None:
    query = overpass.build_nearby_query((38.9175, -120.0040, 38.9775, -119.9440), category)
    assert expected in query
    assert "38.917500,-120.004000,38.977500,-119.944000" in query
    assert "out center tags;" in query


def test_overpass_posts_identifying_header_and_parses_node_way_and_relation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class Response:
        def raise_for_status(self) -> None:
            pass

        def json(self):
            return {
                "elements": [
                    {"lat": 38.94, "lon": -119.97, "tags": {"name": "Cafe"}},
                    {"center": {"lat": 38.95, "lon": -119.96}, "tags": {"name": "Park"}},
                ]
            }

    class Client:
        def __init__(self, *, headers, **_kwargs):
            captured["client_headers"] = headers

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _url, **kwargs):
            captured.update(kwargs)
            return Response()

    monkeypatch.setattr(overpass.httpx, "AsyncClient", Client)
    result = asyncio.run(overpass.discover_nearby((38.9175, -120.004, 38.9775, -119.944), "cafe"))
    assert captured["client_headers"] == {"User-Agent": overpass.OVERPASS_USER_AGENT}
    assert "amenity" in str(captured["data"])
    assert [place["name"] for place in result] == ["Cafe", "Park"]


def test_overpass_malformed_payload_and_timeout_propagate_for_safe_service_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Response:
        def raise_for_status(self) -> None:
            pass

        def json(self):
            return {"elements": "not-a-list"}

    class MalformedClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr(overpass.httpx, "AsyncClient", MalformedClient)
    with pytest.raises(ValueError, match="malformed_overpass_response"):
        asyncio.run(overpass.discover_nearby((1, 2, 3, 4), "cafe"))

    class TimeoutClient(MalformedClient):
        async def post(self, *_args, **_kwargs):
            raise httpx.ReadTimeout("slow provider")

    monkeypatch.setattr(overpass.httpx, "AsyncClient", TimeoutClient)
    with pytest.raises(httpx.TimeoutException):
        asyncio.run(overpass.discover_nearby((1, 2, 3, 4), "cafe"))
