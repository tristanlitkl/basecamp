"""Basecamp FastAPI application."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import activities, auth, expenses, invites, itinerary, plans
from app.config import get_settings
from app.realtime import websocket_routes

app = FastAPI(title="Basecamp API")

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(auth.router)
app.include_router(plans.router)
app.include_router(invites.router)
app.include_router(activities.router)
app.include_router(itinerary.router)
app.include_router(expenses.router)
app.include_router(websocket_routes.router)
