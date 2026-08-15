"use client";

import { signIn, signOut, useSession } from "next-auth/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import React from "react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  ApiError,
  archiveDateSuggestion,
  archivePlanSuggestion,
  createActivity,
  createActivitySuggestion,
  createComment,
  createPlanningRun,
  createDateSuggestion,
  createExpense,
  createInvite,
  createPlanSuggestion,
  createItineraryItem as createItineraryItemRequest,
  deleteActivity,
  deleteExpense,
  deleteItineraryItem,
  changeMemberRole,
  createCoOwnerRequest,
  decideCoOwnerRequest,
  decideActivitySuggestion,
  decideDateSuggestion,
  decidePlanSuggestion,
  getPlanBalances,
  getPlanningStatus,
  getPlanningRun,
  getRecommendations,
  isAuthenticationError,
  isPlanMembershipError,
  patchActivity,
  patchExpense,
  patchItineraryItem,
  patchPlan,
  applyPlanningRun,
  regeneratePlanningRun,
  reorderItineraryItem,
  resyncPlan,
  setPlanLifecycle,
  syncUser,
  removeMember,
  updateVoteVisibility,
  upsertDateAvailability,
  voteActivity,
  voteDateSuggestion,
  withdrawCoOwnerRequest
} from "@/lib/api-client";
import { formatCents, parseDollarCents } from "@/lib/money";
import { connectionLabel } from "@/hooks/useConnectionStatus";
import { usePlanSocket } from "@/hooks/usePlanSocket";
import type { PresenceContext, PresenceUser } from "@/hooks/usePlanSocket";
import { snapshotToPlanDetail } from "@/hooks/useResyncPlan";
import { AvailabilityCalendar } from "@/components/plans/availability-calendar";
import { AdventureBackground } from "@/components/plans/adventure-background";
import { NotificationBell } from "@/components/plans/notification-bell";
import { avatarEmoji } from "@/lib/avatar";
import { sortMembers } from "@/lib/member-directory";
import type { ActivityRecommendation, ActivitySummary, Expense, PlanBalance, PlanDetail, PlanningAction, PlanningRun, PlanningStatus, ResyncSnapshot } from "@/types/api";

type TravelMode = "car" | "plane" | "train" | "bus";

const travelModes: Array<{ value: TravelMode; label: string; emoji: string }> = [
  { value: "car", label: "Car", emoji: "🚗" },
  { value: "plane", label: "Plane", emoji: "✈️" },
  { value: "train", label: "Train", emoji: "🚆" },
  { value: "bus", label: "Bus", emoji: "🚌" }
];

function durationParts(totalMinutes: number | null | undefined) {
  if (totalMinutes == null) return { hours: "", minutes: "" };
  return { hours: String(Math.floor(totalMinutes / 60)), minutes: String(totalMinutes % 60) };
}

function parseDuration(hoursValue: string, minutesValue: string): number | null | undefined {
  const hours = hoursValue.trim();
  const minutes = minutesValue.trim();
  if (!hours && !minutes) return undefined;
  if (!/^\d+$/.test(hours || "0") || !/^\d+$/.test(minutes || "0")) return null;
  const total = Number(hours || "0") * 60 + Number(minutes || "0");
  if (!Number.isSafeInteger(total) || Number(minutes || "0") > 59 || total <= 0) return null;
  return total;
}

function displayMember(snapshot: ResyncSnapshot, userId: string) {
  return snapshot.members.find((member) => member.user_id === userId)?.display_name ?? userId;
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function PresenceAvatarStack({ users, compact = false, label }: { users: PresenceUser[]; compact?: boolean; label?: string }) {
  const visible = users.slice(0, compact ? 3 : 4);
  const overflow = users.length - visible.length;
  const accessibleLabel = label ?? `${users.length} ${users.length === 1 ? "person" : "people"} here`;
  return <span className={`presence-stack ${compact ? "presence-stack-compact" : ""}`} aria-label={accessibleLabel} role="status">
    <span className="presence-avatars" aria-hidden="true">{visible.map((user) => <span className="presence-avatar" key={user.user_id} title={user.display_name}>{avatarEmoji(user.avatar_emoji)}</span>)}{overflow > 0 && <span className="presence-avatar presence-overflow">+{overflow}</span>}</span>
    {!compact && <span className="presence-label">{users.length === 0 ? "No one else here" : `${users.length} here`}</span>}
  </span>;
}

function EditingPresence({ users }: { users: PresenceUser[] }) {
  if (!users.length) return null;
  const names = users.map((user) => user.display_name).join(", ");
  return <span className="editing-presence" aria-label={`${names} ${users.length === 1 ? "is" : "are"} editing`}><PresenceAvatarStack users={users} compact label={`${names} editing`} /><span>{users.length === 1 ? "editing" : "editing"}</span></span>;
}

function TripMembersCard({
  members, currentUserId, role, requests = [], disabled, onChangeRole, onRemove, onRequest, onWithdraw, onDecision
}: {
  members: ResyncSnapshot["members"]; currentUserId: string; role: PlanDetail["role"];
  requests?: NonNullable<ResyncSnapshot["co_owner_requests"]>; disabled: boolean;
  onChangeRole: (userId: string, nextRole: "co_owner" | "member") => void;
  onRemove: (userId: string) => void; onRequest: () => void; onWithdraw: (requestId: string, version: number) => void;
  onDecision: (requestId: string, decision: "approve" | "deny", version: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const sortedMembers = sortMembers(members);
  const ownRequest = requests.find((request) => request.requester_user_id === currentUserId);
  const pendingRequests = requests.filter((request) => request.status === "pending");
  const close = () => { setExpanded(false); requestAnimationFrame(() => triggerRef.current?.focus()); };
  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab" || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]')];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [expanded]);
  return <div className="card stat trip-members-stat" onKeyDown={(event) => { if (event.key === "Escape" && expanded) { event.preventDefault(); close(); } }}>
    <button ref={triggerRef} aria-controls="trip-members-directory" aria-expanded={expanded} className="trip-members-trigger" onClick={() => setExpanded((open) => !open)} type="button">
      <span><i aria-hidden="true">◉</i> Trip members</span>
      <span className="trip-member-preview" aria-label={`${sortedMembers.length} trip members`}>
        {sortedMembers.slice(0, 3).map((member) => <span className="member-preview" key={member.user_id}><span aria-hidden="true">{avatarEmoji(member.avatar_emoji)}</span><span>{member.display_name}</span></span>)}
        {sortedMembers.length > 3 && <span className="member-overflow" aria-label={`${sortedMembers.length - 3} more members`}>+{sortedMembers.length - 3} more</span>}
      </span>
    </button>
    {expanded && createPortal(<div className="trip-members-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><div ref={panelRef} className="trip-members-popover" id="trip-members-directory" role="dialog" aria-modal="true" aria-label="Trip Members">
      <div className="split"><strong>Trip Members</strong><button aria-label="Close trip members" className="member-panel-close" onClick={close} type="button">×</button></div>
      <div className="trip-members-list">{sortedMembers.map((member) => <article className="member-panel-row" key={member.user_id}><span className="member-plain-emoji" aria-hidden="true">{avatarEmoji(member.avatar_emoji)}</span><span className="member-directory-name"><strong>{member.display_name}</strong>{member.user_id === currentUserId && <small>You</small>}</span><span className={`badge badge-${member.role}`}>{member.role.replace("_", "-")}</span>{role === "owner" && member.role !== "owner" && member.user_id !== currentUserId && <span className="member-actions"><button className="btn btn-secondary" disabled={disabled} onClick={() => onChangeRole(member.user_id, member.role === "co_owner" ? "member" : "co_owner")}>{member.role === "co_owner" ? "Demote to member" : "Promote to co-owner"}</button><button className="btn btn-danger" disabled={disabled} onClick={() => setRemoveTarget(member.user_id)}>Remove from trip</button></span>}{role === "co_owner" && member.role === "member" && member.user_id !== currentUserId && <span className="member-actions"><button className="btn btn-danger" disabled={disabled} onClick={() => setRemoveTarget(member.user_id)}>Remove from trip</button></span>}</article>)}</div>
      {removeTarget && <div className="remove-confirmation" role="alertdialog" aria-label="Confirm member removal"><p>Remove {sortedMembers.find((member) => member.user_id === removeTarget)?.display_name} from this trip?</p><div className="cluster"><button className="btn btn-danger" disabled={disabled} onClick={() => { onRemove(removeTarget); setRemoveTarget(null); }}>Confirm removal</button><button className="btn btn-secondary" onClick={() => setRemoveTarget(null)}>Cancel</button></div></div>}
      {role === "member" && <div className="co-owner-request-panel"><strong>Co-owner access</strong>{ownRequest?.status === "pending" ? <div className="cluster"><span className="muted small">Request pending</span><button className="btn btn-secondary" disabled={disabled} onClick={() => onWithdraw(ownRequest.id, ownRequest.version)}>Withdraw request</button></div> : <><p className="muted small">Ask the primary owner for help managing this trip.</p><button className="btn btn-secondary" disabled={disabled} onClick={onRequest}>Request co-owner access</button>{ownRequest && <p className="muted small">Latest request: {ownRequest.status}</p>}</>}</div>}
      {role === "owner" && <div className="co-owner-request-panel"><strong>Co-owner requests</strong>{pendingRequests.length === 0 ? <p className="muted small">No pending requests.</p> : pendingRequests.map((request) => <div className="co-owner-request-row" key={request.id}><span className="member-plain-emoji" aria-hidden="true">{avatarEmoji(request.requester_avatar_emoji)}</span><span className="member-directory-name"><strong>{request.requester_display_name}</strong><small>{new Date(request.created_at).toLocaleDateString()} {request.note ? `· ${request.note}` : ""}</small></span><span className="member-actions"><button className="btn" disabled={disabled} onClick={() => onDecision(request.id, "approve", request.version)}>Approve</button><button className="btn btn-secondary" disabled={disabled} onClick={() => onDecision(request.id, "deny", request.version)}>Deny</button></span></div>)}</div>}
    </div></div>, document.body)}
  </div>;
}

function DashboardTile({ label, icon, value, onClick }: { label: string; icon: string; value: React.ReactNode; onClick: () => void }) {
  return <button className="card stat dashboard-tile" type="button" onClick={onClick}><span><i aria-hidden="true">{icon}</i> {label}</span><strong>{value}</strong><small>Open editor</small></button>;
}

const recommendationReasonLabels: Record<string, string> = {
  "Strong group support": "Strong group support",
  "Mixed group support": "Mixed group support",
  "Group concerns": "Group concerns",
  "Fits the current budget": "Fits budget",
  "Over the current budget": "Does not fit budget",
  "Matches available dates": "Fits schedule",
  "Date availability is limited": "Schedule availability is limited",
  "Schedule availability is mixed": "Schedule availability is mixed",
  "Scheduled outside the current date window": "Outside plan dates"
};

function displayRecommendationReasons(recommendation: ActivityRecommendation): string[] {
  const reasons = recommendation.reasons.flatMap((reason) => {
    const label = recommendationReasonLabels[reason];
    return label ? [label] : [];
  });
  return reasons.length > 0 ? reasons : ["Limited planning signals"];
}

function RecommendationCard({ recommendations }: { recommendations: ActivityRecommendation[] }) {
  return <section className="card section-card recommendations" aria-labelledby="recommendations-heading">
    <div className="section-heading"><div><h2 id="recommendations-heading">Recommended activities</h2><p className="muted small">Ranked from your group’s votes, budget, and schedule.</p></div></div>
    {recommendations.length === 0 ? <p className="muted small">Add activities to see ranked recommendations.</p> : <>
      <div className="recommendation-list">{recommendations.map((item) => <article key={item.activity_id}><div><strong className="recommendation-title"><span className="recommendation-rank">#{item.rank}</span><span>{item.activity_name}</span></strong><p className="muted small">{displayRecommendationReasons(item).join(" · ")}</p></div><strong className="recommendation-score" aria-label={`${Math.round(item.total_score / 10)} out of 100`}><span>{Math.round(item.total_score / 10)}</span><small>/100</small></strong></article>)}</div>
    </>}
  </section>;
}

function DashboardModal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.querySelector<HTMLElement>("button, input, select, textarea")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab" || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex=\"0\"]")];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", onKeyDown); triggerRef.current?.focus(); };
  }, [onClose]);
  return createPortal(<div className="trip-members-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="trip-members-popover dashboard-modal" ref={panelRef} role="dialog" aria-modal="true" aria-label={title}><div className="split"><strong>{title}</strong><button aria-label={`Close ${title}`} className="member-panel-close" onClick={onClose} type="button">×</button></div><div className="dashboard-modal-content">{children}</div></div></div>, document.body);
}

type ItineraryScheduleTarget =
  | { kind: "new"; activityId: string; title: string }
  | { kind: "existing"; itemId: string; title: string; version: number };

function readableDate(value: string | null | undefined) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(value));
}

/** Keep itinerary scheduling in the same UTC calendar convention as plan date windows. */
function itineraryTimestamp(date: string, time: string) { return `${date}T${time}:00.000Z`; }
function itineraryDateAndTime(value: string | null) {
  if (!value) return { date: "", time: "" };
  const instant = new Date(value).toISOString();
  return { date: instant.slice(0, 10), time: instant.slice(11, 16) };
}

/** Presentation is UTC too, so it mirrors the existing itinerary calendar convention. */
function readableItinerarySchedule(value: string) {
  const date = new Date(value);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC"
  }).format(date);
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC"
  }).format(date);
  return { time, dateTime: `${day} · ${time}` };
}

function readableItineraryDay(dateKey: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "UTC"
  }).format(new Date(`${dateKey}T00:00:00.000Z`));
}

function readableDuration(totalMinutes: number | null | undefined) {
  if (totalMinutes == null) return "Not set";
  const { hours, minutes } = durationParts(totalMinutes);
  return `${hours}h ${minutes}m`;
}

function travelModeLabel(mode: TravelMode | null | undefined) {
  return travelModes.find((candidate) => candidate.value === mode)?.label ?? "Not set";
}

type DisclosureSectionProps = {
  id: string;
  title: string;
  summary: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  actions?: React.ReactNode;
};

function DisclosureSection({ id, title, summary, children, defaultOpen = true, className = "", actions }: DisclosureSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = () => setOpen((current) => !current);

  return <section className={`section-card disclosure-section ${className}`}>
    <div className="section-heading disclosure-heading">
      <div>
        <h2 id={`${id}-heading`}>{title}</h2>
        <p className="muted small disclosure-summary">{summary}</p>
      </div>
      <div className="section-controls">
        {open && actions}
        <button
          aria-controls={`${id}-content`}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${title}`}
          className="disclosure-toggle"
          onClick={toggle}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggle();
            }
          }}
          type="button"
        ><span aria-hidden="true" className="disclosure-chevron">⌄</span><span>{open ? "Collapse" : "Expand"}</span></button>
      </div>
    </div>
    <div aria-labelledby={`${id}-heading`} className="disclosure-content" hidden={!open} id={`${id}-content`}>{children}</div>
  </section>;
}

/** Decimal strings from Postgres are compared without converting them to imprecise JS numbers. */
function comparePositionKeys(left: string, right: string) {
  const [leftWhole, leftFraction = ""] = left.split(".");
  const [rightWhole, rightFraction = ""] = right.split(".");
  const wholeDifference = BigInt(leftWhole) - BigInt(rightWhole);
  if (wholeDifference !== 0n) return wholeDifference < 0n ? -1 : 1;
  const length = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeft = leftFraction.padEnd(length, "0");
  const normalizedRight = rightFraction.padEnd(length, "0");
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft < normalizedRight ? -1 : 1;
}

function PlanningStatusCard({ status, onAction }: { status: PlanningStatus; onAction: (action: PlanningAction) => void }) {
  const attentionCount = status.blockers.length + status.warnings.length;
  const summary = status.overall_status === "finalized"
    ? "This plan is finalized."
    : status.readiness_state === "ready"
      ? "Plan is ready to finalize."
      : `${attentionCount} ${attentionCount === 1 ? "thing needs" : "things need"} attention.`;
  return <section className="card section-card planning-status" aria-labelledby="planning-status-heading">
    <div className="section-heading"><div><h2 id="planning-status-heading">Planning status</h2><p className="muted small">{summary}</p></div><span className={`badge badge-${status.overall_status}`}>{status.overall_status.replaceAll("_", " ")}</span></div>
    {status.blockers.length > 0 && <div className="planning-status-group"><strong>Blockers</strong><ul>{status.blockers.map((issue) => <li key={`${issue.reason_code}-${issue.entity_ids.join("-")}`}>{issue.label}</li>)}</ul></div>}
    {status.warnings.length > 0 && <div className="planning-status-group"><strong>Warnings</strong><ul>{status.warnings.map((issue) => <li key={`${issue.reason_code}-${issue.entity_ids.join("-")}`}>{issue.label}</li>)}</ul></div>}
    {status.suggested_actions.length > 0 && <div className="planning-status-group"><strong>Next steps</strong><div className="planning-actions">{status.suggested_actions.map((action) => <button className="btn btn-secondary" key={`${action.action_type}-${action.entity_ids.join("-")}`} onClick={() => onAction(action)} type="button">{action.label}</button>)}</div></div>}
    {status.overall_status !== "finalized" && attentionCount === 0 && <p className="muted small">No unresolved planning signals.</p>}
  </section>;
}

function ItineraryDraftCard({ token, planId, planningVersion, canManage, finalized, onApplied, onError }: {
  token: string; planId: string; planningVersion: number; canManage: boolean; finalized: boolean;
  onApplied: () => Promise<void>; onError: (error: unknown) => void;
}) {
  const [run, setRun] = useState<PlanningRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [reviewingStale, setReviewingStale] = useState(false);
  const stale = run?.draft_status === "stale" || (run?.draft_status === "fresh" && run.base_planning_version !== planningVersion);
  const request = async (operation: () => Promise<PlanningRun>) => {
    setLoading(true);
    try { setRun(await operation()); setReviewingStale(false); }
    catch (error) { onError(error); }
    finally { setLoading(false); }
  };
  const apply = async () => {
    if (!run) return;
    setLoading(true);
    try {
      await applyPlanningRun(token, planId, run.id);
      await onApplied();
      setRun(await getPlanningRun(token, planId, run.id));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        try { setRun(await getPlanningRun(token, planId, run.id)); } catch { /* Preserve conflict feedback. */ }
      }
      onError(error);
    } finally { setLoading(false); }
  };
  return <section className="card section-card itinerary-draft" aria-labelledby="itinerary-draft-heading">
    <div className="section-heading"><div><p className="eyebrow">Optional proposal</p><h2 id="itinerary-draft-heading">Suggested itinerary</h2><p className="muted small">A proposed day-by-day arrangement based on your group’s current choices.</p></div></div>
    {!canManage && <p className="muted small">An owner or co-owner can generate a suggested itinerary.</p>}
    {canManage && !run && <button className="btn" disabled={loading || finalized} onClick={() => void request(() => createPlanningRun(token, planId))} type="button">{loading ? "Generating suggestion…" : "Generate suggested itinerary"}</button>}
    {stale && <div className="notice" role="status"><p>This suggestion is out of date because the plan changed.</p><div className="cluster"><button className="btn" disabled={loading || finalized} onClick={() => void request(() => regeneratePlanningRun(token, planId, run!.id))} type="button">Generate a new suggestion</button><button className="btn btn-secondary" disabled={loading} onClick={() => setReviewingStale(true)} type="button">Review old suggestion</button></div></div>}
    {run?.draft_status === "invalid" && <div className="alert" role="alert"><p>This suggestion could not be validated.</p>{run.validation_errors.map((error) => <p className="small" key={error}>{error}</p>)}<button className="btn btn-secondary" disabled={loading || finalized} onClick={() => void request(() => regeneratePlanningRun(token, planId, run.id))} type="button">Try another suggestion</button></div>}
    {run?.draft && (!stale || reviewingStale) && <div className="stack itinerary-draft-preview">
      {run.draft.days.map((day, dayIndex) => <article className="subcard" key={day.date ?? `unscheduled-${dayIndex}`}><strong>{day.date ?? "Unscheduled within the trip"}</strong><div className="stack">{day.items.map((item) => <div className="split small" key={item.activity_id}><span><strong>{item.title}</strong><br /><span className="muted">Unscheduled time · rank #{item.recommendation_rank}</span></span><span className="muted">{item.reason_codes.join(", ")}</span></div>)}</div></article>)}
      {run.draft.warnings.map((warning) => <p className="muted small" key={warning}>{warning}</p>)}
      {!stale && run.draft_status === "fresh" && <div className="cluster"><button className="btn" disabled={loading || finalized || !canManage} onClick={() => void apply()} type="button">Apply suggestion</button><button className="btn btn-secondary" disabled={loading || finalized || !canManage} onClick={() => void request(() => regeneratePlanningRun(token, planId, run.id))} type="button">Try another suggestion</button></div>}
      {stale && <p className="muted small">Review only — stale suggestions cannot be applied.</p>}
    </div>}
  </section>;
}

function readableError(value: unknown) {
  if (!(value instanceof ApiError)) return value instanceof Error ? value.message : "Request failed.";
  if (value.status === 403) return "Only the plan owner can do that, or this plan is finalized.";
  if (value.status !== 422) return `Request failed (HTTP ${value.status}).`;
  const body = value.body as { detail?: { error?: string } | string } | null;
  const detail = typeof body?.detail === "object" ? body.detail.error : body?.detail;
  const messages: Record<string, string> = {
    expense_participants_invalid: "Choose at least one unique expense participant.",
    expense_participant_not_member: "Every expense participant must be a plan member.",
    expense_payer_not_participant: "The expense payer must be included in the split.",
    "starts_on must be on or before ends_on": "The end date must be on or after the start date.",
    no_changes: "Make a change before saving.",
    invalid_reorder_neighbors: "That itinerary position is not valid. The latest state has been restored."
  };
  return messages[String(detail)] ?? "Please check the values and try again.";
}

export default function PlanPage() {
  const { data: session, status } = useSession();
  const planId = useParams<{ planId: string }>().planId;
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [snapshot, setSnapshot] = useState<ResyncSnapshot | null>(null);
  const [balances, setBalances] = useState<PlanBalance[]>([]);
  const [recommendations, setRecommendations] = useState<ActivityRecommendation[]>([]);
  const [planningStatus, setPlanningStatus] = useState<PlanningStatus | null>(null);
  const [activityName, setActivityName] = useState("");
  const [activityDescription, setActivityDescription] = useState("");
  const [activityAddress, setActivityAddress] = useState("");
  const [activityCost, setActivityCost] = useState("");
  const [activityHours, setActivityHours] = useState("");
  const [activityMinutes, setActivityMinutes] = useState("");
  const [activityTags, setActivityTags] = useState("");
  const [activityNotes, setActivityNotes] = useState("");
  const [editingActivity, setEditingActivity] = useState<ActivitySummary | null>(null);
  const [itineraryTitle, setItineraryTitle] = useState("");
  const [itineraryDate, setItineraryDate] = useState("");
  const [itineraryTime, setItineraryTime] = useState("");
  const [scheduleTarget, setScheduleTarget] = useState<ItineraryScheduleTarget | null>(null);
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleTime, setScheduleTime] = useState("");
  const [editingItineraryId, setEditingItineraryId] = useState<string | null>(null);
  const [expenseDescription, setExpenseDescription] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expensePayer, setExpensePayer] = useState("");
  const [expenseParticipants, setExpenseParticipants] = useState<string[]>([]);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [editExpenseDescription, setEditExpenseDescription] = useState("");
  const [editExpenseAmount, setEditExpenseAmount] = useState("");
  const [editExpensePayer, setEditExpensePayer] = useState("");
  const [editExpenseParticipants, setEditExpenseParticipants] = useState<string[]>([]);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mutationInFlight = useRef(false);
  const [commentBodies, setCommentBodies] = useState<Record<string, string>>({});
  const [availabilityDate, setAvailabilityDate] = useState("");
  const [availabilityStatus, setAvailabilityStatus] = useState<"available" | "maybe" | "unavailable">("available");
  const [dateSuggestionStart, setDateSuggestionStart] = useState("");
  const [dateSuggestionEnd, setDateSuggestionEnd] = useState("");
  const [authFailed, setAuthFailed] = useState(false);
  const [authorizationFailed, setAuthorizationFailed] = useState(false);
  const [showActivityForm, setShowActivityForm] = useState(false);
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [dashboardEditor, setDashboardEditor] = useState<"date" | "transportation" | "duration" | "budget" | "notes" | null>(null);
  const [discussionOpen, setDiscussionOpen] = useState<Record<string, boolean>>({});
  const [planSuggestionTitle, setPlanSuggestionTitle] = useState("");
  const [planSuggestionDescription, setPlanSuggestionDescription] = useState("");
  const [notificationRefreshKey, setNotificationRefreshKey] = useState(0);
  const [presence, setPresence] = useState<PresenceUser[]>([]);

  const closeScheduleModal = () => {
    setScheduleTarget(null);
    setScheduleDate("");
    setScheduleTime("");
  };
  const openActivitySchedule = (activityId: string, title: string) => {
    const existing = snapshot?.itinerary_items.find((item) => item.activity_id === activityId);
    setScheduleTarget(existing
      ? { kind: "existing", itemId: existing.id, title: existing.title, version: existing.version }
      : { kind: "new", activityId, title });
    setScheduleDate("");
    setScheduleTime("");
  };

  const applySnapshot = (next: ResyncSnapshot) => {
    setSnapshot(next);
    setPlan(snapshotToPlanDetail(next));
    setAuthFailed(false);
    setAuthorizationFailed(false);
    setExpensePayer((current) => current || next.members[0]?.user_id || "");
    setExpenseParticipants((current) => current.length ? current : next.members.map((member) => member.user_id));
    setNotificationRefreshKey((current) => current + 1);
  };
  const socket = usePlanSocket({
    planId,
    token: session?.appJwt,
    onSnapshot: (next) => {
      applySnapshot(next);
      if (session?.appJwt) void getPlanBalances(session.appJwt, planId).then(setBalances).catch(() => undefined);
      if (session?.appJwt) void getRecommendations(session.appJwt, planId).then(setRecommendations).catch(() => undefined);
      if (session?.appJwt) void getPlanningStatus(session.appJwt, planId).then(setPlanningStatus).catch(() => undefined);
    },
    onPlanEvent: async () => {
      // Realtime packets only invalidate local state; REST resync remains authoritative.
      try {
        await load();
      } catch (value) {
        if (isPlanMembershipError(value)) socket.denyAuthorization();
        else if (isAuthenticationError(value)) socket.denyAuthentication();
      }
    },
    onAuthFailure: () => {
      setPlan(null);
      setAuthFailed(true);
      setAuthorizationFailed(false);
    },
    onAuthorizationFailure: () => {
      setPlan(null);
      setAuthFailed(false);
      setAuthorizationFailed(true);
      setPresence([]);
    },
    onPresence: setPresence
  });

  useEffect(() => {
    const context: PresenceContext | null = editingActivity
      ? { active_context: "activity edit", editing_entity_type: "activity", editing_entity_id: editingActivity.id }
      : editingItineraryId
        ? { active_context: "itinerary edit", editing_entity_type: "itinerary_item", editing_entity_id: editingItineraryId }
        : scheduleTarget?.kind === "existing"
          ? { active_context: "schedule activity", editing_entity_type: "itinerary_item", editing_entity_id: scheduleTarget.itemId }
          : dashboardEditor
            ? { active_context: "plan settings" }
            : null;
    socket.setPresenceContext(context);
  }, [dashboardEditor, editingActivity, editingItineraryId, scheduleTarget, socket.setPresenceContext]);

  async function load() {
    if (!session?.appJwt) return;
    await syncUser(session.appJwt);
    const [nextSnapshot, nextBalances, nextRecommendations, nextPlanningStatus] = await Promise.all([
      resyncPlan(session.appJwt, planId),
      getPlanBalances(session.appJwt, planId),
      getRecommendations(session.appJwt, planId),
      getPlanningStatus(session.appJwt, planId)
    ]);
    applySnapshot(nextSnapshot);
    setBalances(nextBalances);
    setRecommendations(nextRecommendations);
    setPlanningStatus(nextPlanningStatus);
  }

  useEffect(() => {
    load().catch((value) => {
      if (isPlanMembershipError(value)) socket.denyAuthorization();
      else if (isAuthenticationError(value)) socket.denyAuthentication();
      else setError(readableError(value));
    });
  }, [session?.appJwt, planId]);

  async function mutate(action: () => Promise<unknown>, allowFinalized = false): Promise<boolean> {
    if (!plan || !session?.appJwt || mutationInFlight.current || (plan.status === "finalized" && !allowFinalized)) return false;
    mutationInFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await action();
      await load();
      return true;
    } catch (value) {
      if (isAuthenticationError(value)) {
        socket.denyAuthentication();
        return false;
      }
      if (isPlanMembershipError(value)) {
        socket.denyAuthorization();
        return false;
      }
      const code = value instanceof ApiError ? value.status : undefined;
      if (code === 409) {
        await load();
        const body = value instanceof ApiError ? value.body as { detail?: { error?: string } } : null;
        setError(body?.detail?.error === "plan_finalized"
          ? "This plan is finalized and cannot be edited."
          : "This plan changed since you loaded it. The latest state has been restored.");
      } else setError(readableError(value));
      return false;
    } finally {
      mutationInFlight.current = false;
      setPending(false);
    }
  }

  if (status === "loading") return <main className="auth-shell"><p className="muted">Loading plan…</p></main>;
  if (status !== "authenticated") return <main className="auth-shell"><section className="card card-pad auth-card stack"><h1>Welcome to Basecamp</h1><button className="btn" onClick={() => signIn("google")}>Sign in with Google</button></section></main>;
  if (authFailed) return <main className="auth-shell"><section className="card card-pad auth-card stack"><p>Authentication required — sign in again.</p><button className="btn" onClick={() => signIn("google")}>Sign in again</button></section></main>;
  if (authorizationFailed) return <main className="auth-shell"><section className="card card-pad auth-card"><p className="eyebrow">Access denied</p><h1>You do not have access to this plan.</h1><Link className="btn btn-secondary" href="/dashboard">Return to dashboard</Link></section></main>;
  if (!plan || !snapshot) return <main className="auth-shell"><p className="muted">Loading plan…</p></main>;

  const finalized = plan.status === "finalized";
  // Older cached/test snapshots predate whole-plan suggestions.
  snapshot.plan_suggestions ??= [];
  snapshot.date_suggestions ??= [];
  snapshot.date_availability ??= [];
  snapshot.co_owner_requests ??= [];
  const disabled = finalized || pending;
  const canManage = plan.role === "owner" || plan.role === "co_owner";
  const itinerary = [...snapshot.itinerary_items].sort((left, right) => comparePositionKeys(left.position_key, right.position_key));
  const toggleParticipants = (userId: string, selected: string[], setSelected: (next: string[]) => void) =>
    setSelected(selected.includes(userId) ? selected.filter((id) => id !== userId) : [...selected, userId]);
  const startExpenseEdit = (expense: Expense) => {
    setEditingExpense(expense);
    setEditExpenseDescription(expense.description);
    setEditExpenseAmount((expense.amount_cents / 100).toFixed(2));
    setEditExpensePayer(expense.paid_by_user_id);
    setEditExpenseParticipants(snapshot.expense_splits.filter((split) => split.expense_id === expense.id).map((split) => split.user_id));
  };
  const handlePlanningAction = (action: PlanningAction) => {
    const entityId = action.entity_ids[0];
    if (action.action_type === "schedule") {
      const item = snapshot.itinerary_items.find((candidate) => candidate.id === entityId);
      if (item) {
        setScheduleTarget({ kind: "existing", itemId: item.id, title: item.title, version: item.version });
        setScheduleDate("");
        setScheduleTime("");
      }
      return;
    }
    if (action.action_type === "add_to_itinerary") {
      const activity = plan.activities.find((candidate) => candidate.id === entityId);
      if (activity) openActivitySchedule(activity.id, activity.name);
      else document.getElementById("itinerary-day-view")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (action.action_type === "review_dates") { setDashboardEditor("date"); return; }
    if (action.action_type === "review_budget") { setDashboardEditor("budget"); return; }
    if (action.action_type === "review_votes") {
      document.getElementById("trip-ideas-not-in-itinerary")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (action.action_type === "review_suggestions") {
      document.getElementById("plan-ideas")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (action.action_type === "finalize_plan" && canManage && !finalized) {
      void mutate(() => setPlanLifecycle(session.appJwt!, planId, "finalize", plan.version), true);
    }
  };

  const scheduledDayMap = new Map<string, typeof itinerary>();
  const unscheduledItinerary = itinerary.filter((item) => !item.starts_at);
  itinerary.filter((item) => item.starts_at).forEach((item) => {
    const dayKey = new Date(item.starts_at!).toISOString().slice(0, 10);
    scheduledDayMap.set(dayKey, [...(scheduledDayMap.get(dayKey) ?? []), item]);
  });
  const scheduledDayGroups = [...scheduledDayMap.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, items]) => ({
      date,
      items: [...items].sort((left, right) =>
        left.starts_at!.localeCompare(right.starts_at!)
        || comparePositionKeys(left.position_key, right.position_key)
        || left.id.localeCompare(right.id)
      )
    }));
  const renderItineraryStop = (item: typeof itinerary[number]) => {
    const index = itinerary.findIndex((candidate) => candidate.id === item.id);
    const activity = item.activity_id ? plan.activities.find((candidate) => candidate.id === item.activity_id) : undefined;
    const schedule = item.starts_at ? readableItinerarySchedule(item.starts_at) : null;
    const itineraryEditors = presence.filter((user) => user.editing_entity_type === "itinerary_item" && user.editing_entity_id === item.id);
    return <article className={`itinerary-row ${schedule ? "is-scheduled" : "is-unscheduled"}`} key={item.id}>
      <div className="itinerary-time"><span>{schedule?.time ?? "Time TBD"}</span>{schedule && <small>{schedule.dateTime}</small>}</div>
      <span className="step" aria-hidden="true" />
      <div className="itinerary-stop">
        <div className="split">
          <div>
            <div className="itinerary-title-with-presence"><strong>{item.title}</strong><EditingPresence users={itineraryEditors} /></div>
            <p className="itinerary-description">{activity?.description?.trim() || "No description"}</p>
            {activity && <div className="metadata itinerary-metadata">{activity.estimated_cost_cents !== null && <span>{formatCents(activity.estimated_cost_cents)}</span>}{activity.estimated_duration_minutes !== null && <span>{readableDuration(activity.estimated_duration_minutes)}</span>}{activity.address && <span>{activity.address}</span>}</div>}
            {!schedule && <div className="itinerary-unscheduled"><span>Not scheduled</span><button className="btn btn-quiet" disabled={disabled} onClick={() => { setScheduleTarget({ kind: "existing", itemId: item.id, title: item.title, version: item.version }); setScheduleDate(""); setScheduleTime(""); }} type="button">Schedule</button></div>}
          </div>
          <div className="itinerary-actions"><button className="btn btn-secondary" disabled={disabled} onClick={() => setEditingItineraryId(item.id)}>Edit</button><button className="btn btn-quiet itinerary-icon-button" aria-label="Move up" disabled={disabled || index === 0} onClick={() => void mutate(() => reorderItineraryItem(session.appJwt!, planId, item.id, { expected_version: item.version, previous_item_id: index > 1 ? itinerary[index - 2].id : undefined, next_item_id: itinerary[index - 1].id }))}>↑</button><button className="btn btn-quiet itinerary-icon-button" aria-label="Move down" disabled={disabled || index === itinerary.length - 1} onClick={() => void mutate(() => reorderItineraryItem(session.appJwt!, planId, item.id, { expected_version: item.version, previous_item_id: itinerary[index + 1].id, next_item_id: itinerary[index + 2]?.id }))}>↓</button><button className="btn btn-danger itinerary-delete" disabled={disabled} onClick={() => { if (window.confirm(`Delete ${item.title}?`)) void mutate(() => deleteItineraryItem(session.appJwt!, planId, item.id, item.version)); }}>Delete</button></div>
        </div>
        {editingItineraryId === item.id && <form className="cluster itinerary-edit-form" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const title = String(form.get("title") ?? "").trim(); const date = String(form.get("starts_on") ?? ""); const time = String(form.get("starts_at") ?? ""); if (!title) { setError("Enter an itinerary title."); return; } if (date && !time) { setError("Choose a start time or leave the item unscheduled."); return; } void mutate(() => patchItineraryItem(session.appJwt!, planId, item.id, { title, starts_at: date ? itineraryTimestamp(date, time) : null, expected_version: item.version })); setEditingItineraryId(null); }}><label className="field" style={{ flex: 1 }}>Title <input name="title" defaultValue={item.title} disabled={disabled} /></label><label className="field">Date <input name="starts_on" defaultValue={itineraryDateAndTime(item.starts_at).date} min={plan.starts_on?.slice(0, 10) ?? undefined} max={plan.ends_on?.slice(0, 10) ?? undefined} type="date" disabled={disabled} /></label><label className="field">Start time <input name="starts_at" defaultValue={itineraryDateAndTime(item.starts_at).time} type="time" disabled={disabled} /></label><button className="btn" disabled={disabled}>Save item</button><button className="btn btn-secondary" type="button" onClick={() => setEditingItineraryId(null)}>Cancel</button></form>}
      </div>
    </article>;
  };

  return <main className="app-shell"><AdventureBackground />
    <header className="topbar app-header" aria-label="Plan workspace header">
      <div className="header-context"><Link className="brand" href="/dashboard"><span className="brand-mark">B</span> Basecamp</Link><span className="header-divider" /><span className="header-plan-name" title={plan.title}>{plan.title}</span></div>
      <div className="header-actions"><div className="header-notification-area"><NotificationBell token={session.appJwt} planId={planId} refreshKey={notificationRefreshKey} /></div><div className="user-area"><span className="avatar avatar-small" aria-hidden="true">{avatarEmoji(snapshot.members.find((member) => member.user_id === snapshot.current_user_id)?.avatar_emoji)}</span><span className="user-copy"><strong>{displayMember(snapshot, snapshot.current_user_id)}</strong><span>{plan.role.replace("_", "-")}</span></span><button className="btn btn-quiet" type="button" onClick={() => signOut()}>Sign out</button></div></div>
    </header>
    <header className="plan-header trip-hero">
      <Link className="breadcrumb" href="/dashboard">← Back to dashboard</Link>
      <div className="plan-title-row">
        <div><p className="eyebrow">Trip overview</p><h1>{plan.title}</h1><div className="cluster"><span className={`badge badge-${plan.status}`}>{plan.status}</span><span className={`badge badge-${plan.role}`}>{plan.role.replace("_", "-")}</span><span className={`badge badge-${socket.connectionState}`}><span className="status-dot" />{connectionLabel(socket.connectionState)}</span><PresenceAvatarStack users={presence} label={`${presence.length} ${presence.length === 1 ? "person" : "people"} here`} /></div></div>
        <div className="plan-actions">
          {canManage && <button className="btn btn-secondary" disabled={pending} onClick={() => void mutate(async () => { const invite = await createInvite(session.appJwt!, planId); setInviteToken(invite.token); })}>Create invite</button>}
          {canManage && <button className="btn" disabled={pending} onClick={() => void mutate(() => setPlanLifecycle(session.appJwt!, planId, finalized ? "unfinalize" : "finalize", plan.version), true)}>{finalized ? "Unfinalize plan" : "Finalize plan"}</button>}
        </div>
      </div>
      <div className="vote-visibility-control"><span>Vote visibility: <strong>{plan.vote_visibility === "public" ? "Public" : "Anonymous"}</strong></span>{canManage && <button className="btn btn-quiet" disabled={disabled} type="button" onClick={() => void mutate(() => updateVoteVisibility(session.appJwt!, planId, plan.vote_visibility === "public" ? "anonymous" : "public", plan.version))}>Change</button>}</div>
    </header>
    {finalized && <p className="notice" role="status">This plan is finalized. Unfinalize it to make planning changes. Discussion remains available.</p>}
    <section className="cluster small muted" aria-label="Connection details">
      {socket.nextRetryMs !== null && <span> Next retry in {Math.ceil(socket.nextRetryMs / 1000)}s.</span>}
      {socket.connectionState === "unavailable" && <button className="btn btn-secondary" type="button" onClick={socket.retry}>Retry connection</button>}
    </section>
    {error && <p role="alert" className="alert">{error}</p>}
    {pending && <p role="status" className="notice">Saving and syncing latest state…</p>}
    {planningStatus && <PlanningStatusCard status={planningStatus} onAction={handlePlanningAction} />}
    <ItineraryDraftCard token={session.appJwt!} planId={planId} planningVersion={plan.planning_version} canManage={canManage} finalized={finalized} onApplied={load} onError={(value) => setError(readableError(value))} />
    <section className="summary-grid" aria-label="Plan overview">
      <DashboardTile label="Date window" icon="◷" value={plan.starts_on ? `${readableDate(plan.starts_on)} – ${readableDate(plan.ends_on)}` : "Not set"} onClick={() => setDashboardEditor("date")} />
      <DashboardTile label="Transportation" icon="↝" value={travelModeLabel(plan.travel_mode)} onClick={() => setDashboardEditor("transportation")} />
      <DashboardTile label="Travel duration" icon="◷" value={readableDuration(plan.travel_duration_minutes)} onClick={() => setDashboardEditor("duration")} />
      <DashboardTile label="Budget" icon="◇" value={plan.budget_cents === null ? "Not set" : formatCents(plan.budget_cents)} onClick={() => setDashboardEditor("budget")} />
      <DashboardTile label="Trip notes" icon="✎" value={plan.travel_notes ? "View notes" : "Add notes"} onClick={() => setDashboardEditor("notes")} />
      <TripMembersCard currentUserId={snapshot.current_user_id} members={snapshot.members} role={plan.role} requests={snapshot.co_owner_requests} disabled={disabled} onChangeRole={(userId, role) => void mutate(() => changeMemberRole(session.appJwt!, planId, userId, role, crypto.randomUUID()))} onRemove={(userId) => void mutate(() => removeMember(session.appJwt!, planId, userId, crypto.randomUUID()))} onRequest={() => void mutate(() => createCoOwnerRequest(session.appJwt!, planId, null, crypto.randomUUID()))} onWithdraw={(requestId, version) => void mutate(() => withdrawCoOwnerRequest(session.appJwt!, planId, requestId, version, crypto.randomUUID()))} onDecision={(requestId, decision, version) => void mutate(() => decideCoOwnerRequest(session.appJwt!, planId, requestId, decision, version, crypto.randomUUID()))} />
    </section>
    {dashboardEditor === "date" && <DashboardModal title="Date Window" onClose={() => setDashboardEditor(null)}><AvailabilityCalendar activities={plan.activities} availability={snapshot.date_availability} itineraryItems={snapshot.itinerary_items} members={snapshot.members} plan={plan} suggestions={snapshot.date_suggestions} /><div className="stack"><h3>Authoritative date window</h3>{canManage ? <form className="form-grid" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const startsOn = String(form.get("starts_on") ?? ""); const endsOn = String(form.get("ends_on") ?? ""); if (startsOn && endsOn && endsOn < startsOn) { setError("The end date must be on or after the start date."); return; } void mutate(() => patchPlan(session.appJwt!, planId, { expected_version: plan.version, starts_on: startsOn ? new Date(`${startsOn}T00:00:00.000Z`).toISOString() : null, ends_on: endsOn ? new Date(`${endsOn}T00:00:00.000Z`).toISOString() : null })); }}><label className="field">Start date <input name="starts_on" type="date" defaultValue={plan.starts_on?.slice(0, 10) ?? ""} disabled={disabled} /></label><label className="field">End date <input name="ends_on" type="date" defaultValue={plan.ends_on?.slice(0, 10) ?? ""} disabled={disabled} /></label><div className="form-span"><button className="btn" disabled={disabled}>Save date window</button></div></form> : <p className="muted small">Members can review this authoritative date window and submit availability or date options.</p>}<form className="stack subcard" onSubmit={(event) => { event.preventDefault(); if (availabilityDate) void mutate(() => upsertDateAvailability(session.appJwt!, planId, availabilityDate, availabilityStatus)); }}><label className="field">Date <input type="date" value={availabilityDate} onChange={(event) => setAvailabilityDate(event.target.value)} /></label><label className="field">Availability <select value={availabilityStatus} onChange={(event) => setAvailabilityStatus(event.target.value as typeof availabilityStatus)}><option value="available">Available</option><option value="maybe">Maybe</option><option value="unavailable">Unavailable</option></select></label><button className="btn btn-secondary" disabled={pending}>Save availability</button></form><form className="stack subcard" onSubmit={(event) => { event.preventDefault(); if (!dateSuggestionStart || !dateSuggestionEnd) { setError("Enter both a start and end date."); return; } if (dateSuggestionEnd < dateSuggestionStart) { setError("The end date must be on or after the start date."); return; } void mutate(() => createDateSuggestion(session.appJwt!, planId, dateSuggestionStart, dateSuggestionEnd, crypto.randomUUID())); }}><label className="field">Suggested start <input type="date" value={dateSuggestionStart} onChange={(event) => setDateSuggestionStart(event.target.value)} /></label><label className="field">Suggested end <input type="date" value={dateSuggestionEnd} onChange={(event) => setDateSuggestionEnd(event.target.value)} /></label><button className="btn btn-secondary" disabled={pending}>Suggest dates</button></form></div></DashboardModal>}
    {dashboardEditor === "transportation" && <DashboardModal title="Transportation" onClose={() => setDashboardEditor(null)}>{canManage ? <form className="stack" onSubmit={(event) => { event.preventDefault(); const value = String(new FormData(event.currentTarget).get("travel_mode") ?? "") as TravelMode | ""; void mutate(() => patchPlan(session.appJwt!, planId, { expected_version: plan.version, travel_mode: value || null })); }}><label className="field">Transportation <select name="travel_mode" defaultValue={plan.travel_mode ?? ""} disabled={disabled}><option value="">Not set</option>{travelModes.map((mode) => <option key={mode.value} value={mode.value}>{mode.emoji} {mode.label}</option>)}</select></label><button className="btn" disabled={disabled}>Save transportation</button></form> : <p className="muted small">Transportation: {travelModeLabel(plan.travel_mode)}. Only owners and co-owners can change it.</p>}</DashboardModal>}
    {dashboardEditor === "duration" && <DashboardModal title="Travel Duration" onClose={() => setDashboardEditor(null)}>{canManage ? <form className="stack" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const duration = parseDuration(String(form.get("travel_hours") ?? ""), String(form.get("travel_minutes") ?? "")); if (duration === null) { setError("Enter a positive travel duration with minutes from 0 to 59."); return; } void mutate(() => patchPlan(session.appJwt!, planId, { expected_version: plan.version, travel_duration_minutes: duration ?? null })); }}><fieldset className="duration-input"><legend>Travel duration</legend><label className="field">Hours <input name="travel_hours" aria-label="Travel hours" inputMode="numeric" defaultValue={durationParts(plan.travel_duration_minutes).hours} disabled={disabled} /></label><label className="field">Minutes <input name="travel_minutes" aria-label="Travel minutes" inputMode="numeric" defaultValue={durationParts(plan.travel_duration_minutes).minutes} disabled={disabled} /></label></fieldset><button className="btn" disabled={disabled}>Save duration</button></form> : <p className="muted small">Travel duration: {readableDuration(plan.travel_duration_minutes)}. Only owners and co-owners can change it.</p>}</DashboardModal>}
    {dashboardEditor === "budget" && <DashboardModal title="Budget" onClose={() => setDashboardEditor(null)}>{canManage ? <form className="stack" onSubmit={(event) => { event.preventDefault(); const cents = parseDollarCents(String(new FormData(event.currentTarget).get("budget") ?? "").trim()); if (cents === null) { setError("Enter a valid budget with at most two decimal places."); return; } void mutate(() => patchPlan(session.appJwt!, planId, { expected_version: plan.version, budget_cents: cents })); }}><label className="field">Budget (USD) <input name="budget" inputMode="decimal" defaultValue={plan.budget_cents === null ? "" : (plan.budget_cents / 100).toFixed(2)} disabled={disabled} /></label><p className="muted small">Dollars are converted to integer cents before saving.</p><button className="btn" disabled={disabled}>Save budget</button></form> : <p className="muted small">Budget: {plan.budget_cents === null ? "Not set" : formatCents(plan.budget_cents)}. Only owners and co-owners can change it.</p>}</DashboardModal>}
    {dashboardEditor === "notes" && <DashboardModal title="Trip Notes" onClose={() => setDashboardEditor(null)}>{canManage ? <form className="stack" onSubmit={(event) => { event.preventDefault(); const notes = String(new FormData(event.currentTarget).get("travel_notes") ?? ""); void mutate(() => patchPlan(session.appJwt!, planId, { expected_version: plan.version, travel_notes: notes || null })); }}><label className="field">Trip notes <textarea name="travel_notes" defaultValue={plan.travel_notes ?? ""} disabled={disabled} rows={9} maxLength={2000} /></label><button className="btn" disabled={disabled}>Save trip notes</button></form> : <p className="trip-notes-full">{plan.travel_notes || "No trip notes yet."}</p>}</DashboardModal>}
    {scheduleTarget && <DashboardModal title={scheduleTarget.kind === "new" ? "Add to itinerary" : "Schedule activity"} onClose={closeScheduleModal}><form className="stack" onSubmit={(event) => { event.preventDefault(); if (!scheduleDate || !scheduleTime) { setError("Choose both a schedule date and start time."); return; } const startsAt = itineraryTimestamp(scheduleDate, scheduleTime); const action = scheduleTarget.kind === "new" ? () => createItineraryItemRequest(session.appJwt!, planId, { title: scheduleTarget.title, activity_id: scheduleTarget.activityId, starts_at: startsAt, client_operation_id: crypto.randomUUID() }) : () => patchItineraryItem(session.appJwt!, planId, scheduleTarget.itemId, { starts_at: startsAt, expected_version: scheduleTarget.version }); void mutate(action).then((saved) => { if (saved) closeScheduleModal(); }); }}><p className="muted small">Choose both fields to schedule now, or add this activity without a schedule.</p><label className="field">Schedule date <input value={scheduleDate} min={plan.starts_on?.slice(0, 10) ?? undefined} max={plan.ends_on?.slice(0, 10) ?? undefined} onChange={(event) => setScheduleDate(event.target.value)} type="date" disabled={pending} /></label><label className="field">Start time <input value={scheduleTime} onChange={(event) => setScheduleTime(event.target.value)} type="time" disabled={pending} /></label><div className="cluster">{scheduleTarget.kind === "new" ? <><button className="btn" disabled={pending || !scheduleDate || !scheduleTime}>Add &amp; schedule</button><button className="btn btn-secondary" disabled={pending} onClick={() => { void mutate(() => createItineraryItemRequest(session.appJwt!, planId, { title: scheduleTarget.title, activity_id: scheduleTarget.activityId, client_operation_id: crypto.randomUUID() })).then((saved) => { if (saved) closeScheduleModal(); }); }} type="button">Schedule later</button></> : <button className="btn" disabled={pending || !scheduleDate || !scheduleTime}>Save schedule</button>}<button className="btn btn-secondary" disabled={pending} onClick={closeScheduleModal} type="button">Cancel</button></div></form></DashboardModal>}
    {inviteToken && <div className="notice cluster"><strong>Invite ready:</strong><code>{typeof window === "undefined" ? inviteToken : `${window.location.origin}/invites/${inviteToken}`}</code></div>}
    <div className="page-grid"><div>

    <AvailabilityCalendar activities={plan.activities} availability={snapshot.date_availability} itineraryItems={snapshot.itinerary_items} members={snapshot.members} plan={plan} suggestions={snapshot.date_suggestions} onOpenEditor={() => setDashboardEditor("date")} />


    <DisclosureSection id="trip-ideas" title="Trip ideas" summary={`${plan.activities.length} ${plan.activities.length === 1 ? "activity" : "activities"} to discuss and vote on.`} actions={<button className="btn" disabled={disabled} type="button" onClick={() => setShowActivityForm((value) => !value)}>{showActivityForm ? "Cancel" : "+ Add activity"}</button>}>
      {showActivityForm && <form className="form-grid subcard" onSubmit={(event: FormEvent) => {
        event.preventDefault(); const cents = activityCost ? parseDollarCents(activityCost) : undefined;
        const duration = parseDuration(activityHours, activityMinutes);
        if (!activityName.trim() || cents === null || duration === null) { setError("Enter an activity name, a valid cost, and a positive duration with minutes from 0 to 59."); return; }
        void mutate(() => createActivity(session.appJwt!, planId, { name: activityName.trim(), description: activityDescription || undefined, address: activityAddress || undefined, estimated_cost_cents: cents, estimated_duration_minutes: duration, tags: activityTags.split(",").map((tag) => tag.trim()).filter(Boolean), notes: activityNotes || undefined, client_operation_id: crypto.randomUUID() })); setShowActivityForm(false);
        setActivityName(""); setActivityDescription(""); setActivityAddress(""); setActivityCost(""); setActivityHours(""); setActivityMinutes(""); setActivityTags(""); setActivityNotes("");
      }}>
        <label className="field">Name <input value={activityName} onChange={(event) => setActivityName(event.target.value)} disabled={disabled} /></label>
        <label className="field">Description <span className="optional">Optional</span><input value={activityDescription} onChange={(event) => setActivityDescription(event.target.value)} disabled={disabled} /></label>
        <label className="field">Address <span className="optional">Optional</span><input value={activityAddress} onChange={(event) => setActivityAddress(event.target.value)} disabled={disabled} /></label>
        <label className="field">Estimated cost <span className="optional">Optional</span><input value={activityCost} inputMode="decimal" onChange={(event) => setActivityCost(event.target.value)} disabled={disabled} /></label>
        <fieldset className="duration-input"><legend>Duration <span className="optional">Optional</span></legend><label className="field">Hours <input aria-label="Hours" value={activityHours} min="0" inputMode="numeric" onChange={(event) => setActivityHours(event.target.value)} disabled={disabled} /></label><label className="field">Minutes <input aria-label="Minutes" value={activityMinutes} min="0" max="59" inputMode="numeric" onChange={(event) => setActivityMinutes(event.target.value)} disabled={disabled} /></label></fieldset>
        <label className="field">Tags (comma-separated) <span className="optional">Optional</span><input value={activityTags} onChange={(event) => setActivityTags(event.target.value)} disabled={disabled} /></label>
        <label className="field form-span">Notes <span className="optional">Optional</span><textarea value={activityNotes} onChange={(event) => setActivityNotes(event.target.value)} disabled={disabled} /></label>
        <div className="cluster form-span"><button className="btn" disabled={disabled}>Save activity</button><button className="btn btn-secondary" type="button" onClick={() => setShowActivityForm(false)}>Cancel</button></div>
      </form>}
      {(() => { const itineraryActivityIds = new Set(snapshot.itinerary_items.flatMap((item) => item.activity_id ? [item.activity_id] : [])); const activityCards = plan.activities.map((activity) => {
        const parts = durationParts(activity.estimated_duration_minutes);
        const itineraryItem = snapshot.itinerary_items.find((item) => item.activity_id === activity.id);
        const isInItinerary = Boolean(itineraryItem?.starts_at);
        const activityEditors = presence.filter((user) => user.editing_entity_type === "activity" && user.editing_entity_id === activity.id);
        return { activityId: activity.id, card: <article className={`activity-card ${itineraryItem ? "activity-card-in-itinerary" : "activity-card-not-in-itinerary"}`} key={activity.id}>
          <div className="split activity-card-header">
            <div className="activity-card-copy">
              <div className="activity-card-title"><h3>{activity.name}</h3>{!itineraryItem && <span className="activity-itinerary-state">Considering</span>}{itineraryItem && <span className={`activity-itinerary-state ${isInItinerary ? "is-scheduled" : ""}`}>{isInItinerary ? "Scheduled" : "Selected"}</span>}<EditingPresence users={activityEditors} /></div>
              <p className="muted small">{activity.description || "No description yet."}</p>
              <p className="activity-author">Suggested by {activity.creator_display_name || "a group member"}</p>
            </div>
            <div className="cluster activity-card-actions"><button className={isInItinerary ? "btn btn-secondary" : "btn"} type="button" disabled={disabled || isInItinerary} onClick={() => openActivitySchedule(activity.id, activity.name)}>{isInItinerary ? "Scheduled" : itineraryItem ? "Schedule" : "Add to itinerary"}</button><button className="btn btn-secondary" type="button" disabled={disabled} onClick={() => setEditingActivity(activity)}>Edit</button>{canManage && <button className="btn btn-danger" type="button" disabled={disabled} onClick={() => { if (window.confirm(`Delete ${activity.name}?`)) void mutate(() => deleteActivity(session.appJwt!, planId, activity.id, activity.version)); }}>Delete</button>}</div>
          </div>
          <div className="metadata activity-metadata">{activity.address && <span className="chip">{activity.address}</span>}{activity.estimated_cost_cents !== null && <span className="chip">{formatCents(activity.estimated_cost_cents)}</span>}{activity.estimated_duration_minutes !== null && <span className="chip">{parts.hours}h {parts.minutes}m</span>}{activity.tags.map((tag) => <span className="chip" key={tag}>#{tag}</span>)}</div>
          {activity.notes && <p className="small activity-notes">{activity.notes}</p>}
          <div className="split activity-voting"><div className="vote-summary"><strong className="small">{activity.yes_votes} yes · {activity.maybe_votes} maybe · {activity.no_votes} no</strong>{plan.vote_visibility === "public" && <p className="muted small">Votes: {snapshot.votes.filter((vote) => (vote as { activity_id?: string }).activity_id === activity.id).map((vote) => { const record = vote as { user_id?: string; vote?: string }; return `${displayMember(snapshot, String(record.user_id))} (${String(record.vote)})`; }).join(", ") || "No votes yet"}</p>}{plan.vote_visibility === "anonymous" && <p className="muted small">Votes are anonymous; only totals and your own choice are shown.</p>}</div><div className="vote-control" aria-label={`Vote on ${activity.name}`}>{(["yes", "maybe", "no"] as const).map((vote) => <button type="button" className={`vote-button ${vote} ${activity.vote === vote ? "selected" : ""}`} key={vote} aria-label={`Vote ${vote}`} aria-pressed={activity.vote === vote} disabled={disabled} onClick={() => void mutate(() => voteActivity(session.appJwt!, planId, activity.id, vote))}><span aria-hidden="true">{vote === "yes" ? "✓" : vote === "maybe" ? "?" : "×"}</span><span>{vote[0].toUpperCase() + vote.slice(1)}</span></button>)}</div></div>
        {editingActivity?.id === activity.id && <form className="form-grid subcard" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const cost = String(form.get("cost") ?? "").trim(); const cents = cost === "" ? null : parseDollarCents(cost); const duration = parseDuration(String(form.get("hours") ?? ""), String(form.get("minutes") ?? "")); const name = String(form.get("name") ?? "").trim(); if (!name || (cost !== "" && cents === null) || duration === null) { setError("Enter a name, valid cost, and a positive duration with minutes from 0 to 59."); return; } void mutate(() => patchActivity(session.appJwt!, planId, activity.id, { expected_version: activity.version, name, description: String(form.get("description") ?? "") || null, address: String(form.get("address") ?? "") || null, estimated_cost_cents: cents, estimated_duration_minutes: duration ?? null, tags: String(form.get("tags") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean), notes: String(form.get("notes") ?? "") || null })); setEditingActivity(null); }}>
          <label className="field">Name <input name="name" defaultValue={activity.name} disabled={disabled} /></label><label className="field">Description <input name="description" defaultValue={activity.description ?? ""} disabled={disabled} /></label><label className="field">Address <input name="address" defaultValue={activity.address ?? ""} disabled={disabled} /></label><label className="field">Cost <input name="cost" inputMode="decimal" defaultValue={activity.estimated_cost_cents === null ? "" : (activity.estimated_cost_cents / 100).toFixed(2)} disabled={disabled} /></label><fieldset className="duration-input"><legend>Duration</legend><label className="field">Hours <input name="hours" aria-label="Hours" min="0" inputMode="numeric" defaultValue={parts.hours} disabled={disabled} /></label><label className="field">Minutes <input name="minutes" aria-label="Minutes" min="0" max="59" inputMode="numeric" defaultValue={parts.minutes} disabled={disabled} /></label></fieldset><label className="field">Tags <input name="tags" defaultValue={activity.tags.join(", ")} disabled={disabled} /></label><label className="field">Notes <input name="notes" defaultValue={activity.notes ?? ""} disabled={disabled} /></label><div className="cluster form-span"><button className="btn" disabled={disabled}>Save activity</button><button className="btn btn-secondary" type="button" onClick={() => setEditingActivity(null)}>Cancel</button></div>
        </form>}<details><summary>Discussion ({snapshot.activity_comments.filter((comment) => comment.activity_id === activity.id && !comment.deleted_at).length})</summary>{snapshot.activity_comments.filter((comment) => comment.activity_id === activity.id).map((comment) => <div className="conversation" key={comment.id}><span className="avatar">{initials(comment.author_display_name)}</span><div><strong>{comment.author_display_name}</strong><p>{comment.deleted_at ? "Comment deleted" : comment.body}</p></div></div>)}<form className="cluster" onSubmit={(event) => { event.preventDefault(); const body = commentBodies[activity.id]?.trim(); if (body) { void mutate(() => createComment(session.appJwt!, planId, activity.id, body, crypto.randomUUID())); setCommentBodies((current) => ({ ...current, [activity.id]: "" })); } }}><label className="field" style={{ flex: 1 }}>Comment <input value={commentBodies[activity.id] ?? ""} onChange={(event) => setCommentBodies((current) => ({ ...current, [activity.id]: event.target.value }))} /></label><button className="btn" disabled={pending}>Post comment</button></form><form className="cluster" onSubmit={(event) => { event.preventDefault(); const message = String(new FormData(event.currentTarget).get("suggestion") ?? ""); if (message.trim()) void mutate(() => createActivitySuggestion(session.appJwt!, planId, activity.id, { suggestion_type: "general_modification", proposed_changes_json: { notes: message.trim() }, message, client_operation_id: crypto.randomUUID() })); }}><label className="field" style={{ flex: 1 }}>Suggest a change <input name="suggestion" /></label><button className="btn btn-secondary" disabled={pending}>Submit suggestion</button></form>{snapshot.activity_suggestions.filter((suggestion) => suggestion.activity_id === activity.id).map((suggestion) => <div className="suggestion" key={suggestion.id}><div className="split"><span><strong>{suggestion.author_display_name}</strong>: {suggestion.message}</span><span className="badge">{suggestion.status}</span></div>{canManage && suggestion.status === "open" && <div className="cluster"><button className="btn" disabled={disabled} onClick={() => void mutate(() => decideActivitySuggestion(session.appJwt!, planId, activity.id, suggestion.id, "accept", activity.version, crypto.randomUUID()))}>Accept</button><button className="btn btn-secondary" disabled={pending} onClick={() => void mutate(() => decideActivitySuggestion(session.appJwt!, planId, activity.id, suggestion.id, "dismiss", activity.version, crypto.randomUUID()))}>Dismiss</button></div>}</div>)}</details></article> };
      }); const notInItinerary = activityCards.filter(({ activityId }) => !itineraryActivityIds.has(activityId)); const inItinerary = activityCards.filter(({ activityId }) => itineraryActivityIds.has(activityId)); return <div className="activity-groups" style={{ marginTop: showActivityForm ? 16 : 0 }}><DisclosureSection id="trip-ideas-not-in-itinerary" title={`Ideas to decide (${notInItinerary.length})`} summary="Vote and discuss what should make the trip." defaultOpen={true} className="nested-disclosure"><div className="idea-card-grid">{notInItinerary.length ? notInItinerary.map(({ card }) => card) : <p className="muted small">Every trip idea is already in the itinerary.</p>}</div></DisclosureSection><DisclosureSection id="trip-ideas-in-itinerary" title={`Selected for this trip (${inItinerary.length})`} summary="Activities your group has committed to." defaultOpen={true} className="nested-disclosure"><div className="stack">{inItinerary.length ? inItinerary.map(({ card }) => card) : <p className="muted small">No trip ideas are in the itinerary yet.</p>}</div></DisclosureSection></div>; })()}
    </DisclosureSection>

    <RecommendationCard recommendations={recommendations} />

    <div aria-hidden="true">
    <section className="card section-card" id="itinerary"><div className="section-heading"><div><p className="eyebrow">Day / itinerary timeline</p><h2>Route &amp; itinerary</h2><p className="muted small">Shape the day into a clear running order.</p></div></div><form className="subcard itinerary-composer" onSubmit={(event: FormEvent) => { event.preventDefault(); if (!itineraryTitle.trim()) { setError("Enter an itinerary title."); return; } if (itineraryDate && !itineraryTime) { setError("Choose a start time or leave the item unscheduled."); return; } void mutate(() => createItineraryItemRequest(session.appJwt!, planId, { title: itineraryTitle.trim(), ...(itineraryDate ? { starts_at: itineraryTimestamp(itineraryDate, itineraryTime) } : {}), client_operation_id: crypto.randomUUID() })); setItineraryTitle(""); setItineraryDate(""); setItineraryTime(""); }}><span className="itinerary-composer-label" aria-hidden="true">+</span><label className="field">Item <input placeholder="Add itinerary stop" value={itineraryTitle} onChange={(event) => setItineraryTitle(event.target.value)} disabled={disabled} /></label><label className="field">Schedule date <input value={itineraryDate} min={plan.starts_on?.slice(0, 10) ?? undefined} max={plan.ends_on?.slice(0, 10) ?? undefined} onChange={(event) => setItineraryDate(event.target.value)} type="date" disabled={disabled} /></label><label className="field">Start time <input value={itineraryTime} onChange={(event) => setItineraryTime(event.target.value)} type="time" disabled={disabled || !itineraryDate} /></label><button className="btn" disabled={disabled}>Add item</button></form><p className="muted small itinerary-composer-note">Scheduling uses the plan’s UTC calendar date. Set both date and time; items without both remain unscheduled.</p>
      <div className="timeline">{itinerary.map((item, index) => { const activity = item.activity_id ? plan.activities.find((candidate) => candidate.id === item.activity_id) : undefined; const schedule = item.starts_at ? readableItinerarySchedule(item.starts_at) : null; return <article className={`itinerary-row ${schedule ? "is-scheduled" : "is-unscheduled"}`} key={item.id}><div className="itinerary-time"><span>{schedule?.time ?? "Time TBD"}</span>{schedule && <small>{schedule.dateTime}</small>}</div><span className="step" aria-hidden="true" /> <div className="itinerary-stop"><div className="split"><div><strong>{item.title}</strong><p className="itinerary-description">{activity?.description?.trim() || "No description"}</p>{activity && <div className="metadata itinerary-metadata">{activity.estimated_cost_cents !== null && <span>{formatCents(activity.estimated_cost_cents)}</span>}{activity.estimated_duration_minutes !== null && <span>{readableDuration(activity.estimated_duration_minutes)}</span>}{activity.address && <span>{activity.address}</span>}</div>}{!schedule && <div className="itinerary-unscheduled"><span>Not scheduled</span><button className="btn btn-quiet" disabled={disabled} onClick={() => { setScheduleTarget({ kind: "existing", itemId: item.id, title: item.title, version: item.version }); setScheduleDate(""); setScheduleTime(""); }} type="button">Schedule</button></div>}</div><div className="itinerary-actions"><button className="btn btn-secondary" disabled={disabled} onClick={() => setEditingItineraryId(item.id)}>Edit</button><button className="btn btn-quiet itinerary-icon-button" aria-label="Move up" disabled={disabled || index === 0} onClick={() => void mutate(() => reorderItineraryItem(session.appJwt!, planId, item.id, { expected_version: item.version, previous_item_id: index > 1 ? itinerary[index - 2].id : undefined, next_item_id: itinerary[index - 1].id }))}>↑</button><button className="btn btn-quiet itinerary-icon-button" aria-label="Move down" disabled={disabled || index === itinerary.length - 1} onClick={() => void mutate(() => reorderItineraryItem(session.appJwt!, planId, item.id, { expected_version: item.version, previous_item_id: itinerary[index + 1].id, next_item_id: itinerary[index + 2]?.id }))}>↓</button><button className="btn btn-danger itinerary-delete" disabled={disabled} onClick={() => { if (window.confirm(`Delete ${item.title}?`)) void mutate(() => deleteItineraryItem(session.appJwt!, planId, item.id, item.version)); }}>Delete</button></div></div>{editingItineraryId === item.id && <form className="cluster itinerary-edit-form" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const title = String(form.get("title") ?? "").trim(); const date = String(form.get("starts_on") ?? ""); const time = String(form.get("starts_at") ?? ""); if (!title) { setError("Enter an itinerary title."); return; } if (date && !time) { setError("Choose a start time or leave the item unscheduled."); return; } void mutate(() => patchItineraryItem(session.appJwt!, planId, item.id, { title, starts_at: date ? itineraryTimestamp(date, time) : null, expected_version: item.version })); setEditingItineraryId(null); }}><label className="field" style={{ flex: 1 }}>Title <input name="title" defaultValue={item.title} disabled={disabled} /></label><label className="field">Date <input name="starts_on" defaultValue={itineraryDateAndTime(item.starts_at).date} min={plan.starts_on?.slice(0, 10) ?? undefined} max={plan.ends_on?.slice(0, 10) ?? undefined} type="date" disabled={disabled} /></label><label className="field">Start time <input name="starts_at" defaultValue={itineraryDateAndTime(item.starts_at).time} type="time" disabled={disabled} /></label><button className="btn" disabled={disabled}>Save item</button><button className="btn btn-secondary" type="button" onClick={() => setEditingItineraryId(null)}>Cancel</button></form>}</div></article>; })}</div></section>

    </div>
    <section className="card section-card itinerary-day-view" id="itinerary-day-view" aria-labelledby="itinerary-day-view-heading">
      <div className="section-heading"><div><p className="eyebrow">Day / itinerary timeline</p><h2 id="itinerary-day-view-heading">Your itinerary</h2><p className="muted small">The day-by-day running order for the trip.</p></div></div>
      <form className="subcard itinerary-composer" onSubmit={(event: FormEvent) => { event.preventDefault(); if (!itineraryTitle.trim()) { setError("Enter an itinerary title."); return; } if (itineraryDate && !itineraryTime) { setError("Choose a start time or leave the item unscheduled."); return; } void mutate(() => createItineraryItemRequest(session.appJwt!, planId, { title: itineraryTitle.trim(), ...(itineraryDate ? { starts_at: itineraryTimestamp(itineraryDate, itineraryTime) } : {}), client_operation_id: crypto.randomUUID() })); setItineraryTitle(""); setItineraryDate(""); setItineraryTime(""); }}><span className="itinerary-composer-label" aria-hidden="true">+</span><label className="field">Itinerary item <input placeholder="Add itinerary stop" value={itineraryTitle} onChange={(event) => setItineraryTitle(event.target.value)} disabled={disabled} /></label><label className="field">Itinerary schedule date <input value={itineraryDate} min={plan.starts_on?.slice(0, 10) ?? undefined} max={plan.ends_on?.slice(0, 10) ?? undefined} onChange={(event) => setItineraryDate(event.target.value)} type="date" disabled={disabled} /></label><label className="field">Itinerary start time <input value={itineraryTime} onChange={(event) => setItineraryTime(event.target.value)} type="time" disabled={disabled || !itineraryDate} /></label><button className="btn" disabled={disabled}>Add stop</button></form>
      <p className="muted small itinerary-composer-note">Scheduling uses the plan’s UTC calendar date. Set both date and time; items without both remain unscheduled.</p>
      <div className="itinerary-day-groups">
        {scheduledDayGroups.map((day, dayIndex) => <section className="itinerary-day-group" key={day.date} aria-label={`Day ${dayIndex + 1}: ${readableItineraryDay(day.date)}`}><header className="itinerary-day-header"><span>Day {dayIndex + 1}</span><h3>{readableItineraryDay(day.date)}</h3></header><div className="timeline itinerary-day-timeline">{day.items.map(renderItineraryStop)}</div></section>)}
        {unscheduledItinerary.length > 0 && <section className="itinerary-day-group itinerary-unscheduled-group" aria-label="Unscheduled itinerary stops"><header className="itinerary-day-header"><span>Needs scheduling</span><h3>Unscheduled</h3></header><div className="timeline itinerary-day-timeline">{unscheduledItinerary.map(renderItineraryStop)}</div></section>}
      </div>
    </section>

    <DisclosureSection id="expenses" title="Expenses" summary={`${snapshot.expenses.filter((expense) => expense.status === "active").length} active ${snapshot.expenses.filter((expense) => expense.status === "active").length === 1 ? "expense" : "expenses"} · ${formatCents(snapshot.expenses.filter((expense) => expense.status === "active").reduce((total, expense) => total + expense.amount_cents, 0))}`} actions={<button className="btn" type="button" disabled={disabled} onClick={() => setShowExpenseForm((value) => !value)}>{showExpenseForm ? "Cancel" : "+ Add expense"}</button>}>
      {showExpenseForm && <form className="form-grid subcard" onSubmit={(event) => { event.preventDefault(); const cents = parseDollarCents(expenseAmount); if (!expenseDescription.trim() || cents === null || cents <= 0 || !expensePayer || expenseParticipants.length === 0) { setError("Enter a description, a valid positive amount, payer, and at least one participant."); return; } void mutate(() => createExpense(session.appJwt!, planId, { description: expenseDescription.trim(), amount_cents: cents, paid_by_user_id: expensePayer, participant_user_ids: expenseParticipants, client_operation_id: crypto.randomUUID() })); setExpenseDescription(""); setExpenseAmount(""); setShowExpenseForm(false); }}><label className="field">Description <input value={expenseDescription} onChange={(event) => setExpenseDescription(event.target.value)} disabled={disabled} /></label><label className="field">Amount <input value={expenseAmount} inputMode="decimal" onChange={(event) => setExpenseAmount(event.target.value)} disabled={disabled} /></label><label className="field">Payer <select value={expensePayer} onChange={(event) => setExpensePayer(event.target.value)} disabled={disabled}>{snapshot.members.map((member) => <option key={member.user_id} value={member.user_id}>{member.display_name}</option>)}</select></label><fieldset disabled={disabled}><legend>Split among</legend>{snapshot.members.map((member) => <label key={member.user_id}><input type="checkbox" checked={expenseParticipants.includes(member.user_id)} onChange={() => toggleParticipants(member.user_id, expenseParticipants, setExpenseParticipants)} />{member.display_name}</label>)}</fieldset><div className="cluster form-span"><button className="btn" disabled={disabled}>Save expense</button><button className="btn btn-secondary" type="button" onClick={() => setShowExpenseForm(false)}>Cancel</button></div></form>}
      <div className="stack" style={{ marginTop: 14 }}>{snapshot.expenses.filter((expense) => expense.status === "active").map((expense) => <article className="expense-row" key={expense.id}><div className="split"><div><h3>{expense.description}</h3><div className="cluster"><strong>{formatCents(expense.amount_cents)}</strong></div></div><div className="cluster"><button className="btn btn-secondary" disabled={disabled} onClick={() => startExpenseEdit(expense)}>Edit</button><button className="btn btn-danger" disabled={disabled} onClick={() => { if (window.confirm(`Reverse ${expense.description}?`)) void mutate(() => deleteExpense(session.appJwt!, planId, expense.id, expense.version, crypto.randomUUID())); }}>Delete</button></div></div><p className="muted small">Paid by {displayMember(snapshot, expense.paid_by_user_id)}</p><p className="small">{snapshot.expense_splits.filter((split) => split.expense_id === expense.id).map((split) => `${displayMember(snapshot, split.user_id)}: ${formatCents(split.amount_cents)}`).join(" · ")}</p>
        {editingExpense?.id === expense.id && <form onSubmit={(event) => { event.preventDefault(); const cents = parseDollarCents(editExpenseAmount); if (!editExpenseDescription.trim() || cents === null || cents <= 0 || !editExpensePayer || editExpenseParticipants.length === 0) { setError("Enter a description, valid positive amount, payer, and participant list."); return; } void mutate(() => patchExpense(session.appJwt!, planId, expense.id, { description: editExpenseDescription.trim(), amount_cents: cents, paid_by_user_id: editExpensePayer, participant_user_ids: editExpenseParticipants, expected_version: expense.version, client_operation_id: crypto.randomUUID() })); setEditingExpense(null); }}><label>Edit description <input value={editExpenseDescription} onChange={(event) => setEditExpenseDescription(event.target.value)} disabled={disabled} /></label><label>Amount <input value={editExpenseAmount} onChange={(event) => setEditExpenseAmount(event.target.value)} disabled={disabled} /></label><label>Payer <select value={editExpensePayer} onChange={(event) => setEditExpensePayer(event.target.value)} disabled={disabled}>{snapshot.members.map((member) => <option key={member.user_id} value={member.user_id}>{member.display_name}</option>)}</select></label><fieldset disabled={disabled}><legend>Split among</legend>{snapshot.members.map((member) => <label key={member.user_id}><input type="checkbox" checked={editExpenseParticipants.includes(member.user_id)} onChange={() => toggleParticipants(member.user_id, editExpenseParticipants, setEditExpenseParticipants)} />{member.display_name}</label>)}</fieldset><button disabled={disabled}>Save expense</button><button type="button" onClick={() => setEditingExpense(null)}>Cancel</button></form>}</article>)}</div>
    </DisclosureSection>

    </div><aside className="sticky-column journey-sidebar">
    <DisclosureSection id="balances" title="Balances" summary={`Balances · ${balances.length} ${balances.length === 1 ? "member" : "members"} · ${formatCents(balances.reduce((total, balance) => total + Math.max(0, -balance.balance_cents), 0))} outstanding`}><p className="muted small">Your group’s current ledger summary.</p>{balances.map((balance) => <div className="split small" key={balance.user_id}><span>{displayMember(snapshot, balance.user_id)}</span><strong className={balance.balance_cents >= 0 ? "balance-positive" : "balance-negative"}>{formatCents(balance.balance_cents)}</strong></div>)}</DisclosureSection>
    <DisclosureSection className="plan-ideas" id="travel-window-poll" title="Travel-window poll" summary={`${snapshot.date_suggestions.filter((suggestion) => suggestion.status === "open").length} open ${snapshot.date_suggestions.filter((suggestion) => suggestion.status === "open").length === 1 ? "option" : "options"}.`}>
      <div className="stack">{[...snapshot.date_suggestions].filter((suggestion) => suggestion.status === "open").sort((a, b) => b.yes_votes - a.yes_votes || b.maybe_votes - a.maybe_votes || a.no_votes - b.no_votes || a.starts_on.localeCompare(b.starts_on) || (a.created_at ?? "").localeCompare(b.created_at ?? "")).map((suggestion) => <article className="poll-option" key={`poll-${suggestion.id}`}><div className="split"><div><strong>{readableDate(suggestion.starts_on)} – {readableDate(suggestion.ends_on)}</strong><p className="muted small poll-suggester"><span aria-hidden="true">{avatarEmoji(suggestion.author_avatar_emoji)}</span> Suggested by {suggestion.author_display_name}</p></div>{canManage && <button className="btn btn-quiet" disabled={pending} onClick={() => void mutate(() => archiveDateSuggestion(session.appJwt!, planId, suggestion.id, crypto.randomUUID()), true)}>Remove option</button>}</div><div className="poll-votes">{(["yes", "maybe", "no"] as const).map((vote) => <button className={`vote-button ${vote} ${suggestion.current_user_vote === vote ? "selected" : ""}`} type="button" key={vote} aria-label={`Vote ${vote} for ${readableDate(suggestion.starts_on)}`} aria-pressed={suggestion.current_user_vote === vote} disabled={pending} onClick={() => void mutate(() => voteDateSuggestion(session.appJwt!, planId, suggestion.id, vote, crypto.randomUUID()))}><span aria-hidden="true">{vote === "yes" ? "✓" : vote === "maybe" ? "~" : "×"}</span><span>{vote === "yes" ? suggestion.yes_votes : vote === "maybe" ? suggestion.maybe_votes : suggestion.no_votes}</span></button>)}</div>{canManage && <div className="cluster"><button className="btn" disabled={disabled} onClick={() => void mutate(() => decideDateSuggestion(session.appJwt!, planId, suggestion.id, "accept", plan.version, crypto.randomUUID()))}>Accept</button><button className="btn btn-secondary" disabled={pending} onClick={() => void mutate(() => decideDateSuggestion(session.appJwt!, planId, suggestion.id, "dismiss", plan.version, crypto.randomUUID()))}>Dismiss</button></div>}</article>)}</div>
    </DisclosureSection>
    <DisclosureSection className="plan-ideas" defaultOpen={false} id="plan-ideas" title="Plan ideas" summary={`${snapshot.plan_suggestions.filter((suggestion) => suggestion.status === "open").length} open ${snapshot.plan_suggestions.filter((suggestion) => suggestion.status === "open").length === 1 ? "suggestion" : "suggestions"}.`}>
      <form className="stack subcard" onSubmit={(event) => { event.preventDefault(); if (!planSuggestionTitle.trim()) return; void mutate(() => createPlanSuggestion(session.appJwt!, planId, { title: planSuggestionTitle.trim(), description: planSuggestionDescription || null, client_operation_id: crypto.randomUUID() })); setPlanSuggestionTitle(""); setPlanSuggestionDescription(""); }}><label className="field">Proposed plan name <input value={planSuggestionTitle} onChange={(event) => setPlanSuggestionTitle(event.target.value)} required /></label><label className="field">Why this trip? <textarea value={planSuggestionDescription} onChange={(event) => setPlanSuggestionDescription(event.target.value)} /></label><button className="btn btn-secondary" disabled={pending}>Suggest a different trip</button></form><div className="stack" style={{ marginTop: 12 }}>{snapshot.plan_suggestions.filter((suggestion) => suggestion.status !== "archived").map((suggestion) => <article className="suggestion" key={suggestion.id}><div className="split"><div><strong>{suggestion.title}</strong><p className="muted small">Suggested by {suggestion.author_display_name}</p></div>{suggestion.status !== "open" && <span className="badge">{suggestion.status}</span>}</div>{suggestion.description && <p className="small">{suggestion.description}</p>}{canManage && suggestion.status === "open" && <div className="cluster"><button className="btn" disabled={disabled} onClick={() => { if (window.confirm("Adopt this plan idea? Only supported plan-level fields will change; activities and expenses are preserved.")) void mutate(() => decidePlanSuggestion(session.appJwt!, planId, suggestion.id, "accept", plan.version, crypto.randomUUID())); }}>Adopt this plan idea</button><button className="btn btn-secondary" disabled={pending} onClick={() => void mutate(() => decidePlanSuggestion(session.appJwt!, planId, suggestion.id, "dismiss", plan.version, crypto.randomUUID()))}>Dismiss</button></div>}{canManage && (suggestion.status === "accepted" || suggestion.status === "dismissed") && <button className="btn btn-quiet" disabled={pending} onClick={() => void mutate(() => archivePlanSuggestion(session.appJwt!, planId, suggestion.id, crypto.randomUUID()), true)}>Remove from history</button>}</article>)}</div>
    </DisclosureSection>
    <section className="card section-card"><details><summary>Developer details ({snapshot.ledger_entries.length} ledger entries)</summary><p className="muted small">The immutable ledger is read-only.</p></details></section>
    </aside></div>
  </main>;
}
