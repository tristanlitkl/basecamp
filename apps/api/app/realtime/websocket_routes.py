"""Authenticated plan WebSocket lifecycle, invalidations, and ephemeral presence."""

import json
from uuid import UUID

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select

from app.config import get_settings
from app.core.security import decode_app_jwt
from app.db.base import AsyncSessionLocal
from app.models.plan import PlanMember
from app.models.user import User
from app.realtime.connection_manager import connection_manager
from app.services.metrics_service import metrics

router = APIRouter()


async def close_auth_failure(websocket: WebSocket, reason: str) -> None:
    await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason=reason)


@router.websocket("/ws/plans/{plan_id}")
async def plan_socket(websocket: WebSocket, plan_id: UUID) -> None:
    token = websocket.query_params.get("token")
    if not token:
        await close_auth_failure(websocket, "missing_token")
        return

    settings = get_settings()
    try:
        payload = decode_app_jwt(token, settings)
    except Exception:
        await close_auth_failure(websocket, "invalid_token")
        return

    subject = str(payload.get("sub", ""))
    if not subject:
        await close_auth_failure(websocket, "invalid_token_claims")
        return

    async with AsyncSessionLocal() as session:
        user_result = await session.execute(select(User).where(User.auth_subject == subject))
        user = user_result.scalar_one_or_none()
        if user is None:
            await close_auth_failure(websocket, "user_not_synced")
            return

        member_result = await session.execute(
            select(PlanMember).where(PlanMember.plan_id == plan_id, PlanMember.user_id == user.id)
        )
        if member_result.scalar_one_or_none() is None:
            await close_auth_failure(websocket, "plan_membership_required")
            return

    connection = await connection_manager.connect(
        websocket,
        user_id=user.id,
        plan_id=plan_id,
        display_name=user.display_name,
        avatar_emoji=user.avatar_emoji,
    )
    metrics.increment("websocket_connects")

    try:
        while True:
            raw_message = await websocket.receive_text()
            await connection_manager.touch(connection)
            try:
                message = json.loads(raw_message)
            except json.JSONDecodeError:
                continue
            if not isinstance(message, dict):
                continue
            if message.get("type") == "presence.heartbeat":
                continue
            if message.get("type") != "presence.context":
                continue
            active_context = message.get("active_context")
            entity_type = message.get("editing_entity_type")
            entity_id = message.get("editing_entity_id")
            if active_context is not None and not isinstance(active_context, str):
                continue
            if entity_type is not None and entity_type not in {"activity", "itinerary_item"}:
                continue
            try:
                parsed_entity_id = UUID(entity_id) if entity_id is not None else None
            except (TypeError, ValueError):
                continue
            if active_context is None and (entity_type is not None or parsed_entity_id is not None):
                continue
            if active_context is not None and len(active_context) > 64:
                continue
            await connection_manager.update_presence_context(
                connection,
                active_context=active_context,
                editing_entity_type=entity_type,
                editing_entity_id=parsed_entity_id,
            )
    except WebSocketDisconnect:
        pass
    finally:
        await connection_manager.disconnect(plan_id, connection)
        metrics.increment("websocket_disconnects")
