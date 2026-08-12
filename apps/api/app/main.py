"""Basecamp FastAPI application."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import (
    activities,
    admin,
    auth,
    coordination,
    expenses,
    invites,
    itinerary,
    notifications,
    planning,
    plans,
    recommendations,
)
from app.config import Settings, get_settings
from app.core.cors import ALLOWED_HEADERS, ALLOWED_METHODS
from app.db.base import AsyncSessionLocal
from app.realtime import websocket_routes
from app.services.cleanup_scheduler import cleanup_scheduler
from app.services.cleanup_service import opportunistic_cleanup
from app.services.metrics_service import metrics

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    app_settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        cleanup_scheduler.start(app_settings)
        try:
            yield
        finally:
            await opportunistic_cleanup.shutdown()
            cleanup_scheduler.shutdown()

    app = FastAPI(title="Basecamp API", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=app_settings.cors_origins,
        allow_origin_regex=app_settings.cors_allowed_origin_regex,
        allow_credentials=True,
        allow_methods=ALLOWED_METHODS,
        allow_headers=ALLOWED_HEADERS,
    )

    @app.middleware("http")
    async def record_request_metrics(request: Request, call_next):
        try:
            response = await call_next(request)
        except Exception:
            metrics.increment("requests_total")
            metrics.increment("requests_5xx")
            raise
        metrics.increment("requests_total")
        if 400 <= response.status_code < 500:
            metrics.increment("requests_4xx")
        elif response.status_code >= 500:
            metrics.increment("requests_5xx")
        return response

    @app.get("/health")
    async def health() -> JSONResponse:
        try:
            async with AsyncSessionLocal() as session:
                await session.execute(text("SELECT 1"))
            return JSONResponse(
                {"status": "ok", "database": "ok", "environment": app_settings.environment},
                status_code=200,
            )
        except Exception:
            metrics.increment("database_errors")
            logger.exception("database_health_failed")
            return JSONResponse(
                {
                    "status": "unhealthy",
                    "database": "unavailable",
                    "environment": app_settings.environment,
                },
                status_code=503,
            )

    app.include_router(auth.router)
    app.include_router(admin.router)
    app.include_router(plans.router)
    app.include_router(recommendations.router)
    app.include_router(planning.router)
    app.include_router(invites.router)
    app.include_router(activities.router)
    app.include_router(itinerary.router)
    app.include_router(expenses.router)
    app.include_router(notifications.router)
    app.include_router(coordination.router)
    app.include_router(websocket_routes.router)
    return app


app = create_app()
