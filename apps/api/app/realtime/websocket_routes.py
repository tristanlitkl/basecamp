"""Phase 1A.5 authenticated WebSocket lifecycle route."""

from uuid import UUID

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select

from app.config import get_settings
from app.core.security import decode_app_jwt
from app.db.base import AsyncSessionLocal
from app.models.plan import PlanMember
from app.models.user import User
from app.realtime.connection_manager import connection_manager

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

    connection = await connection_manager.connect(websocket, user_id=user.id, plan_id=plan_id)

    try:
        while True:
            await websocket.receive_text()
            connection_manager.touch(connection)
    except WebSocketDisconnect:
        pass
    finally:
        await connection_manager.disconnect(plan_id, connection)
