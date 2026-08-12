"""Structured, deterministic planning-status response models."""

from datetime import date as Date, datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel


class PlanningOverallStatus(StrEnum):
    NEEDS_ATTENTION = "needs_attention"
    READY = "ready"
    FINALIZED = "finalized"


class PlanningReadinessState(StrEnum):
    NOT_READY = "not_ready"
    READY = "ready"
    FINALIZED = "finalized"


class PlanningReasonCode(StrEnum):
    ITINERARY_EMPTY = "itinerary_empty"
    ITINERARY_ITEM_UNSCHEDULED = "itinerary_item_unscheduled"
    DATE_CONFLICT = "date_conflict"
    BUDGET_CONFLICT = "budget_conflict"
    STRONG_CANDIDATE_NOT_IN_ITINERARY = "strong_candidate_not_in_itinerary"
    LIMITED_VOTE_SIGNAL = "limited_vote_signal"
    UNRESOLVED_SUGGESTION = "unresolved_suggestion"
    READY_TO_FINALIZE = "ready_to_finalize"


class PlanningActionType(StrEnum):
    ADD_TO_ITINERARY = "add_to_itinerary"
    SCHEDULE = "schedule"
    REVIEW_DATES = "review_dates"
    REVIEW_BUDGET = "review_budget"
    REVIEW_VOTES = "review_votes"
    REVIEW_SUGGESTIONS = "review_suggestions"
    FINALIZE_PLAN = "finalize_plan"


class PlanningIssue(BaseModel):
    reason_code: PlanningReasonCode
    entity_ids: list[UUID]
    label: str


class PlanningAction(BaseModel):
    action_type: PlanningActionType
    reason_code: PlanningReasonCode
    entity_ids: list[UUID]
    label: str


class PlanningStatusResponse(BaseModel):
    """Read-only guidance derived from an authoritative plan snapshot."""

    overall_status: PlanningOverallStatus
    readiness_state: PlanningReadinessState
    plan_version: int
    planning_version: int
    blockers: list[PlanningIssue]
    warnings: list[PlanningIssue]
    suggested_actions: list[PlanningAction]


class DraftStatus(StrEnum):
    FRESH = "fresh"
    STALE = "stale"
    INVALID = "invalid"


class PlanningRunStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class DraftItineraryItem(BaseModel):
    activity_id: UUID
    title: str
    proposed_start_at: datetime | None = None
    duration_minutes: int | None = None
    estimated_cost_cents: int | None = None
    recommendation_rank: int
    reason_codes: list[str]


class DraftItineraryDay(BaseModel):
    # ``None`` explicitly means an item is unscheduled within the trip, not midnight.
    date: Date | None = None
    items: list[DraftItineraryItem]


class PlanDraft(BaseModel):
    plan_id: UUID
    base_planning_version: int
    days: list[DraftItineraryDay]
    warnings: list[str]
    generated_at: datetime


class PlanningRunResponse(BaseModel):
    id: UUID
    plan_id: UUID
    triggered_by_user_id: UUID
    run_type: str
    status: PlanningRunStatus
    draft_status: DraftStatus
    base_plan_version: int
    base_planning_version: int
    current_planning_version: int
    draft: PlanDraft | None = None
    validation_errors: list[str]
    created_at: datetime
    completed_at: datetime | None = None
    expires_at: datetime | None = None


class ApplyPlanningRunResponse(BaseModel):
    run_id: UUID
    applied_item_ids: list[UUID]
    planning_version: int
