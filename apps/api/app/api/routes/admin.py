"""Protected operational endpoints; application admin is not a plan role."""

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_app_admin
from app.config import Settings, get_settings
from app.db.base import get_session
from app.models.user import User
from app.services.cleanup_service import cleanup_expired
from app.services.metrics_service import metrics

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/metrics")
async def read_metrics(user: User = Depends(require_app_admin)) -> dict[str, Any]:
    """Return safe aggregate process counters without resource/user identifiers."""
    del user
    return metrics.snapshot()


@router.post("/cleanup/expired")
async def cleanup_expired_records(
    user: User = Depends(require_app_admin),
    settings: Settings = Depends(get_settings),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Run exactly the shared bounded cleanup policy, with no caller-controlled target."""
    del user
    return (await cleanup_expired(session, batch_size=settings.cleanup_batch_size)).as_dict()
