"""Atomic idempotency claims and canonical request fingerprints."""

import hashlib
import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.idempotency import IdempotencyRecord


def _canonical(value: Any) -> Any:
    if isinstance(value, Decimal):
        return format(value.normalize(), "f")
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _canonical(item) for key, item in sorted(value.items())}
    if isinstance(value, (list, tuple)):
        return [_canonical(item) for item in value]
    if isinstance(value, float):
        raise ValueError("floating point values are not valid idempotent mutation payloads")
    return value


def canonical_request_hash(payload: dict[str, Any]) -> str:
    body = json.dumps(
        _canonical(payload), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


async def claim_operation(
    session: AsyncSession,
    *,
    plan_id: UUID,
    actor_id: UUID,
    client_operation_id: str | None,
    payload: dict[str, Any],
    resource_type: str,
) -> IdempotencyRecord | dict[str, Any] | None:
    """Claim once with INSERT..ON CONFLICT; return a stored response on replay."""
    if not client_operation_id:
        return None
    request_hash = canonical_request_hash(payload)
    expiry = datetime.now(timezone.utc) + timedelta(hours=24)
    claim = (
        insert(IdempotencyRecord)
        .values(
            plan_id=plan_id,
            actor_id=actor_id,
            client_operation_id=client_operation_id,
            request_hash=request_hash,
            resource_type=resource_type,
            status="in_progress",
            expires_at=expiry,
        )
        .on_conflict_do_nothing(constraint="uq_idempotency_claim")
        .returning(IdempotencyRecord.id)
    )
    claim_id = (await session.execute(claim)).scalar_one_or_none()
    if claim_id is not None:
        return await session.get(IdempotencyRecord, claim_id)

    record = (
        await session.execute(
            select(IdempotencyRecord).where(
                IdempotencyRecord.plan_id == plan_id,
                IdempotencyRecord.actor_id == actor_id,
                IdempotencyRecord.client_operation_id == client_operation_id,
            )
        )
    ).scalar_one()
    if record.request_hash != request_hash:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail={"error": "idempotency_key_reused"}
        )
    if record.status == "completed":
        return record.response_json or {}
    if record.status == "failed" and record.failure_type == "permanent":
        raise HTTPException(
            status_code=record.response_status or status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=record.response_json or {"error": "idempotency_operation_failed"},
        )
    now = datetime.now(timezone.utc)
    if (record.status == "in_progress" and record.expires_at <= now) or (
        record.status == "failed" and record.failure_type == "transient"
    ):
        recovered_id = (
            await session.execute(
                update(IdempotencyRecord)
                .where(
                    IdempotencyRecord.id == record.id,
                    (
                        (
                            (IdempotencyRecord.status == "in_progress")
                            & (IdempotencyRecord.expires_at <= now)
                        )
                        | (
                            (IdempotencyRecord.status == "failed")
                            & (IdempotencyRecord.failure_type == "transient")
                        )
                    ),
                )
                .values(
                    status="in_progress",
                    failure_type=None,
                    response_json=None,
                    response_status=None,
                    expires_at=expiry,
                    updated_at=now,
                )
                .returning(IdempotencyRecord.id)
            )
        ).scalar_one_or_none()
        if recovered_id is not None:
            return record
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "error": "idempotency_operation_in_progress"
            if record.status == "in_progress"
            else "idempotency_operation_failed"
        },
    )


async def complete_operation(
    session: AsyncSession,
    record: IdempotencyRecord | None,
    resource_id: UUID,
    response: dict[str, Any],
    *,
    response_status: int,
) -> None:
    if record is None:
        return
    await session.execute(
        update(IdempotencyRecord)
        .where(IdempotencyRecord.id == record.id)
        .values(
            status="completed",
            resource_id=resource_id,
            response_json=_canonical(response),
            response_status=response_status,
            failure_type=None,
        )
    )


async def fail_operation(
    session: AsyncSession,
    record: IdempotencyRecord | None,
    *,
    response_status: int,
    response: dict[str, Any],
    failure_type: str,
) -> None:
    """Persist a replayable business failure after its savepoint is rolled back."""
    if record is None:
        return
    await session.execute(
        update(IdempotencyRecord)
        .where(IdempotencyRecord.id == record.id)
        .values(
            status="failed",
            failure_type=failure_type,
            response_json=_canonical(response),
            response_status=response_status,
        )
    )
