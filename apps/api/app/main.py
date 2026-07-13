"""Basecamp FastAPI application."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import (
    activities,
    auth,
    coordination,
    expenses,
    external,
    invites,
    itinerary,
    plans,
)
from app.config import Settings, get_settings
from app.core.cors import ALLOWED_HEADERS, ALLOWED_METHODS
from app.realtime import websocket_routes


def create_app(settings: Settings | None = None) -> FastAPI:
    app = FastAPI(title="Basecamp API")
    app_settings = settings or get_settings()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=app_settings.cors_origins,
        allow_credentials=True,
        allow_methods=ALLOWED_METHODS,
        allow_headers=ALLOWED_HEADERS,
    )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(auth.router)
    app.include_router(plans.router)
    app.include_router(invites.router)
    app.include_router(activities.router)
    app.include_router(external.router)
    app.include_router(itinerary.router)
    app.include_router(expenses.router)
    app.include_router(coordination.router)
    app.include_router(websocket_routes.router)
    return app


app = create_app()
