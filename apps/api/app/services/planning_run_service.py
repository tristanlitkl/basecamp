"""Persistence and atomic application for deterministic itinerary drafts."""

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity
from app.models.itinerary import ItineraryItem
from app.models.langgraph_run import LangGraphRun
from app.models.plan import Plan
from app.schemas.planning import ApplyPlanningRunResponse, PlanDraft, PlanningRunResponse
from app.services.event_service import append_plan_event, broadcast_committed_plan_event
from app.services.notification_service import create_notifications, plan_member_ids
from app.services.planning_graph import execute_deterministic_draft, load_plan_snapshot
from app.services.planning_service import bump_planning_version
from app.services.metrics_service import metrics


def _run_response(run: LangGraphRun, current_planning_version: int) -> PlanningRunResponse:
    draft = None
    if run.output_json.get("draft"):
        draft = PlanDraft.model_validate(run.output_json["draft"])
    effective_draft_status = (
        "stale"
        if run.draft_status == "fresh" and current_planning_version != run.base_planning_version
        else run.draft_status
    )
    return PlanningRunResponse(
        id=run.id,
        plan_id=run.plan_id,
        triggered_by_user_id=run.triggered_by_user_id,
        run_type=run.run_type,
        status=run.status,
        draft_status=effective_draft_status,
        base_plan_version=run.base_plan_version,
        base_planning_version=run.base_planning_version,
        current_planning_version=current_planning_version,
        draft=draft,
        validation_errors=list(run.validation_errors_json),
        created_at=run.created_at,
        completed_at=run.completed_at,
        expires_at=run.expires_at,
    )


async def get_planning_run(
    session: AsyncSession, *, plan_id: UUID, run_id: UUID
) -> PlanningRunResponse:
    run = (
        await session.execute(
            select(LangGraphRun).where(LangGraphRun.id == run_id, LangGraphRun.plan_id == plan_id)
        )
    ).scalar_one_or_none()
    if run is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail={"error": "planning_run_not_found"}
        )
    current = (
        await session.execute(select(Plan.planning_version).where(Plan.id == plan_id))
    ).scalar_one_or_none()
    if current is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail={"error": "plan_not_found"}
        )
    return _run_response(run, current)


async def create_planning_run(
    session: AsyncSession, *, plan_id: UUID, user_id: UUID
) -> PlanningRunResponse:
    """Persist a snapshot, execute its pure graph, then record fresh/stale/invalid."""
    metrics.increment("planning_runs_started")
    snapshot = await load_plan_snapshot(session, plan_id=plan_id, user_id=user_id)
    run = LangGraphRun(
        plan_id=plan_id,
        triggered_by_user_id=user_id,
        run_type="itinerary_draft",
        status="running",
        base_plan_version=snapshot["base_plan_version"],
        base_planning_version=snapshot["base_planning_version"],
        input_json=dict(snapshot),
        expires_at=datetime.now(timezone.utc) + timedelta(days=7),
    )
    session.add(run)
    await session.flush()
    # Persisting the start means a concurrent human edit is never locked behind generation.
    await session.commit()
    try:
        result = execute_deterministic_draft(snapshot)
        current = (
            await session.execute(select(Plan.planning_version).where(Plan.id == plan_id))
        ).scalar_one_or_none()
        if current is None:
            raise ValueError("plan_not_found_after_snapshot")
        draft_status = result["draft_status"]
        if draft_status != "invalid" and current != run.base_planning_version:
            draft_status = "stale"
        metrics.increment("planning_runs_completed")
        if draft_status == "stale":
            metrics.increment("planning_runs_stale")
        if draft_status == "invalid":
            metrics.increment("planning_runs_invalid")
        run.status = "completed"
        run.draft_status = draft_status
        run.output_json = {"draft": result.get("draft")} if result.get("draft") else {}
        run.validation_errors_json = list(result.get("validation_errors", []))
        run.completed_at = datetime.now(timezone.utc)
        await session.commit()
        return _run_response(run, current)
    except Exception as exc:
        metrics.increment("planning_runs_invalid")
        run.status = "failed"
        run.draft_status = "invalid"
        run.validation_errors_json = [str(exc)]
        run.completed_at = datetime.now(timezone.utc)
        await session.commit()
        raise


async def _validate_apply_draft(
    session: AsyncSession, *, plan_id: UUID, run: LangGraphRun
) -> PlanDraft:
    try:
        draft = PlanDraft.model_validate(run.output_json.get("draft"))
    except Exception as exc:
        run.draft_status = "invalid"
        run.validation_errors_json = [str(exc)]
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail={"error": "draft_invalid"}
        ) from exc
    if draft.plan_id != plan_id or draft.base_planning_version != run.base_planning_version:
        run.draft_status = "invalid"
        run.validation_errors_json = ["draft_snapshot_mismatch"]
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"error": "draft_invalid"})
    proposed = [item for day in draft.days for item in day.items]
    activity_ids = [item.activity_id for item in proposed]
    if len(activity_ids) != len(set(activity_ids)):
        run.draft_status = "invalid"
        run.validation_errors_json = ["duplicate_activity_assignment"]
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"error": "draft_invalid"})
    valid_ids = (
        set(
            (
                await session.execute(
                    select(Activity.id).where(
                        Activity.plan_id == plan_id, Activity.id.in_(activity_ids)
                    )
                )
            ).scalars()
        )
        if activity_ids
        else set()
    )
    existing_ids = (
        set(
            (
                await session.execute(
                    select(ItineraryItem.activity_id).where(
                        ItineraryItem.plan_id == plan_id,
                        ItineraryItem.activity_id.in_(activity_ids),
                    )
                )
            ).scalars()
        )
        if activity_ids
        else set()
    )
    if valid_ids != set(activity_ids) or existing_ids:
        run.draft_status = "invalid"
        run.validation_errors_json = ["draft_activity_no_longer_applicable"]
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"error": "draft_invalid"})
    return draft


async def apply_planning_run(
    session: AsyncSession, *, plan_id: UUID, run_id: UUID, user_id: UUID
) -> ApplyPlanningRunResponse:
    """Atomically add every draft activity or none, after an apply-time stale check."""
    # Serializes applies and all itinerary create-path activity membership checks for this plan.
    await session.execute(select(func.pg_advisory_xact_lock(func.hashtext(str(plan_id)))))
    plan = (
        await session.execute(select(Plan).where(Plan.id == plan_id).with_for_update())
    ).scalar_one_or_none()
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail={"error": "plan_not_found"}
        )
    if plan.status == "finalized":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail={"error": "plan_finalized"}
        )
    run = (
        await session.execute(
            select(LangGraphRun)
            .where(LangGraphRun.id == run_id, LangGraphRun.plan_id == plan_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if run is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail={"error": "planning_run_not_found"}
        )
    if run.output_json.get("applied_at"):
        metrics.increment("planning_apply_conflicts")
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail={"error": "draft_already_applied"}
        )
    if run.draft_status != "fresh" or plan.planning_version != run.base_planning_version:
        if run.draft_status != "invalid":
            run.draft_status = "stale"
            await session.commit()
        metrics.increment("planning_apply_conflicts")
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"error": "draft_stale"})
    draft = await _validate_apply_draft(session, plan_id=plan_id, run=run)
    proposed = [item for day in draft.days for item in day.items]
    largest = (
        await session.execute(
            select(func.max(ItineraryItem.position_key)).where(ItineraryItem.plan_id == plan_id)
        )
    ).scalar_one()
    base_key = largest or Decimal(0)
    created: list[ItineraryItem] = []
    try:
        for index, item in enumerate(proposed, start=1):
            created_item = ItineraryItem(
                plan_id=plan_id,
                activity_id=item.activity_id,
                title=item.title,
                position_key=base_key + Decimal(1000 * index),
                # A day assignment without a source time is not a timestamp and is intentionally unscheduled.
                starts_at=None,
                ends_at=None,
            )
            session.add(created_item)
            created.append(created_item)
        await session.flush()
        planning_version = await bump_planning_version(session, plan_id)
        run.output_json = {
            **run.output_json,
            "applied_at": datetime.now(timezone.utc).isoformat(),
            "applied_by_user_id": str(user_id),
            "applied_item_ids": [str(item.id) for item in created],
        }
        event = await append_plan_event(
            session,
            plan_id=plan_id,
            actor_id=user_id,
            event_type="itinerary_draft.applied",
            resource_type="langgraph_run",
            resource_id=run.id,
            resource_version_after=planning_version,
            payload_json={"item_count": len(created)},
        )
        if created:
            await create_notifications(
                session,
                plan_id=plan_id,
                recipients=await plan_member_ids(session, plan_id),
                actor_id=user_id,
                event_type="itinerary_draft.applied",
                entity_type="langgraph_run",
                entity_id=run.id,
                title="An itinerary draft was applied",
                body=f"{len(created)} activities were added to the itinerary.",
                metadata={"item_count": len(created)},
                source_key=f"itinerary-draft-applied:{run.id}",
            )
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail={"error": "draft_apply_conflict"}
        ) from exc
    await broadcast_committed_plan_event(event)
    metrics.increment("planning_runs_applied")
    return ApplyPlanningRunResponse(
        run_id=run.id,
        applied_item_ids=[item.id for item in created],
        planning_version=planning_version,
    )
