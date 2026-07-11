"use client";

import { signIn, signOut, useSession } from "next-auth/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import React from "react";
import { FormEvent, useEffect, useState } from "react";

import {
  ApiError,
  createActivity,
  createActivitySuggestion,
  createComment,
  createDateSuggestion,
  createExpense,
  createInvite,
  createPlanSuggestion,
  createItineraryItem,
  deleteActivity,
  deleteExpense,
  deleteItineraryItem,
  changeMemberRole,
  decideActivitySuggestion,
  decideDateSuggestion,
  decidePlanSuggestion,
  getPlanBalances,
  isAuthenticationError,
  isPlanMembershipError,
  patchActivity,
  patchExpense,
  patchItineraryItem,
  patchPlan,
  reorderItineraryItem,
  resyncPlan,
  setPlanLifecycle,
  syncUser,
  removeMember,
  updateVoteVisibility,
  upsertDateAvailability,
  voteActivity,
  voteDateSuggestion
} from "@/lib/api-client";
import { formatCents, parseDollarCents } from "@/lib/money";
import { connectionLabel } from "@/hooks/useConnectionStatus";
import { usePlanSocket } from "@/hooks/usePlanSocket";
import { snapshotToPlanDetail } from "@/hooks/useResyncPlan";
import type { ActivitySummary, Expense, PlanBalance, PlanDetail, ResyncSnapshot } from "@/types/api";

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

function readableDate(value: string | null | undefined) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(value));
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
  const [commentBodies, setCommentBodies] = useState<Record<string, string>>({});
  const [availabilityDate, setAvailabilityDate] = useState("");
  const [availabilityStatus, setAvailabilityStatus] = useState<"available" | "maybe" | "unavailable">("available");
  const [dateSuggestionStart, setDateSuggestionStart] = useState("");
  const [dateSuggestionEnd, setDateSuggestionEnd] = useState("");
  const [authFailed, setAuthFailed] = useState(false);
  const [authorizationFailed, setAuthorizationFailed] = useState(false);
  const [showActivityForm, setShowActivityForm] = useState(false);
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [showConstraints, setShowConstraints] = useState(false);
  const [discussionOpen, setDiscussionOpen] = useState<Record<string, boolean>>({});
  const [planSuggestionTitle, setPlanSuggestionTitle] = useState("");
  const [planSuggestionDescription, setPlanSuggestionDescription] = useState("");

  const applySnapshot = (next: ResyncSnapshot) => {
    setSnapshot(next);
    setPlan(snapshotToPlanDetail(next));
    setAuthFailed(false);
    setAuthorizationFailed(false);
    setExpensePayer((current) => current || next.members[0]?.user_id || "");
    setExpenseParticipants((current) => current.length ? current : next.members.map((member) => member.user_id));
  };
  const socket = usePlanSocket({
    planId,
    token: session?.appJwt,
    onSnapshot: (next) => {
      applySnapshot(next);
      if (session?.appJwt) void getPlanBalances(session.appJwt, planId).then(setBalances).catch(() => undefined);
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
    }
  });

  async function load() {
    if (!session?.appJwt) return;
    await syncUser(session.appJwt);
    const [nextSnapshot, nextBalances] = await Promise.all([
      resyncPlan(session.appJwt, planId),
      getPlanBalances(session.appJwt, planId)
    ]);
    applySnapshot(nextSnapshot);
    setBalances(nextBalances);
  }

  useEffect(() => {
    load().catch((value) => {
      if (isPlanMembershipError(value)) socket.denyAuthorization();
      else if (isAuthenticationError(value)) socket.denyAuthentication();
      else setError(readableError(value));
    });
  }, [session?.appJwt, planId]);

  async function mutate(action: () => Promise<unknown>, allowFinalized = false) {
    if (!plan || !session?.appJwt || (plan.status === "finalized" && !allowFinalized)) return;
    setPending(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (value) {
      if (isAuthenticationError(value)) {
        socket.denyAuthentication();
        return;
      }
      if (isPlanMembershipError(value)) {
        socket.denyAuthorization();
        return;
      }
      const code = value instanceof ApiError ? value.status : undefined;
      if (code === 409) {
        await load();
        const body = value instanceof ApiError ? value.body as { detail?: { error?: string } } : null;
        setError(body?.detail?.error === "plan_finalized"
          ? "This plan is finalized and cannot be edited."
          : "This plan changed since you loaded it. The latest state has been restored.");
      } else setError(readableError(value));
    } finally {
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

  return <main className="app-shell">
    <header className="topbar app-header">
      <div className="header-context"><Link className="brand" href="/dashboard"><span className="brand-mark">B</span> Basecamp</Link><span className="header-divider" /><span className="muted small">Plan workspace</span></div>
      <div className="user-area"><span className="avatar avatar-small" aria-hidden="true">{initials(displayMember(snapshot, snapshot.current_user_id))}</span><span className="user-copy"><strong>{displayMember(snapshot, snapshot.current_user_id)}</strong><span>{plan.role.replace("_", "-")}</span></span><button className="btn btn-quiet" type="button" onClick={() => signOut()}>Sign out</button></div>
    </header>
    <header className="plan-header">
      <Link className="breadcrumb" href="/dashboard">← Back to dashboard</Link>
      <div className="plan-title-row">
        <div><p className="eyebrow">Trip overview</p><h1>{plan.title}</h1><div className="cluster"><span className={`badge badge-${plan.status}`}>{plan.status}</span><span className={`badge badge-${plan.role}`}>{plan.role.replace("_", "-")}</span><span className={`badge badge-${socket.connectionState}`}><span className="status-dot" />{connectionLabel(socket.connectionState)}</span></div></div>
        <div className="plan-actions">
          {canManage && <button className="btn btn-secondary" disabled={pending} onClick={() => void mutate(async () => { const invite = await createInvite(session.appJwt!, planId); setInviteToken(invite.token); })}>Create invite</button>}
          {canManage && <button className="btn" disabled={pending} onClick={() => void mutate(() => setPlanLifecycle(session.appJwt!, planId, finalized ? "unfinalize" : "finalize", plan.version), true)}>{finalized ? "Unfinalize plan" : "Finalize plan"}</button>}
        </div>
      </div>
    </header>
    {finalized && <p className="notice" role="status">This plan is finalized. Unfinalize it to make planning changes. Discussion remains available.</p>}
    <section className="cluster small muted" aria-label="Connection details">
      {socket.nextRetryMs !== null && <span> Next retry in {Math.ceil(socket.nextRetryMs / 1000)}s.</span>}
      {socket.connectionState === "unavailable" && <button className="btn btn-secondary" type="button" onClick={socket.retry}>Retry connection</button>}
    </section>
    {error && <p role="alert" className="alert">{error}</p>}
    {pending && <p role="status" className="notice">Saving and syncing latest state…</p>}
    <section className="summary-grid" aria-label="Plan overview">
      <div className="card stat"><span><i aria-hidden="true">◷</i> Date window</span><strong>{plan.starts_on ? `${readableDate(plan.starts_on)} – ${readableDate(plan.ends_on)}` : "Not set"}</strong></div>
      <div className="card stat"><span><i aria-hidden="true">◇</i> Budget</span><strong>{plan.budget_cents === null ? "Not set" : formatCents(plan.budget_cents)}</strong></div>
      <div className="card stat"><span><i aria-hidden="true">◎</i> Travel group</span><strong>{snapshot.members.length}</strong></div>
      <div className="card stat"><span><i aria-hidden="true">⌖</i> Trip ideas</span><strong>{plan.activities.length}</strong></div>
      <div className="card stat"><span><i aria-hidden="true">↝</i> Route stops</span><strong>{itinerary.length} items</strong></div>
      <div className="card stat"><span><i aria-hidden="true">◉</i> Status</span><strong>{plan.status}</strong></div>
    </section>
    {inviteToken && <div className="notice cluster"><strong>Invite ready:</strong><code>{typeof window === "undefined" ? inviteToken : `${window.location.origin}/invites/${inviteToken}`}</code></div>}
    <div className="page-grid"><div>

    <section className="card section-card"><div className="section-heading"><div><h2>Travel group</h2><p className="muted small">Everyone coordinating this trip.</p></div><span className="badge">{snapshot.members.length} people</span></div>{snapshot.members.map((member) => <article className="member-row" key={member.user_id}><span className="avatar" aria-hidden="true">{initials(member.display_name)}</span><div><div className="member-meta"><strong>{member.display_name}</strong>{member.user_id === snapshot.current_user_id && <span className="badge">You</span>}<span className={`badge badge-${member.role}`}>{member.role.replace("_", "-")}</span></div><span className="muted small">Joined {readableDate(member.created_at)}</span></div>{plan.role === "owner" && member.role !== "owner" && member.user_id !== snapshot.current_user_id && <div className="member-actions"><button className="btn btn-secondary" disabled={disabled} onClick={() => void mutate(() => changeMemberRole(session.appJwt!, planId, member.user_id, member.role === "co_owner" ? "member" : "co_owner", crypto.randomUUID()))}>{member.role === "co_owner" ? "Demote" : "Promote"}</button><button className="btn btn-danger" disabled={disabled} onClick={() => { if (window.confirm(`Remove ${member.display_name}?`)) void mutate(() => removeMember(session.appJwt!, planId, member.user_id, crypto.randomUUID())); }}>Remove</button></div>}{plan.role === "co_owner" && member.role === "member" && member.user_id !== snapshot.current_user_id && <div className="member-actions"><button className="btn btn-danger" disabled={disabled} onClick={() => { if (window.confirm(`Remove ${member.display_name}?`)) void mutate(() => removeMember(session.appJwt!, planId, member.user_id, crypto.randomUUID())); }}>Remove</button></div>}</article>)}</section>

    <section className="card section-card">
      <div className="section-heading"><div><h2>Trip parameters</h2><p className="muted small">{plan.budget_cents === null ? "No budget" : formatCents(plan.budget_cents)} · {readableDate(plan.starts_on)} – {readableDate(plan.ends_on)} · {plan.max_drive_minutes ? `${plan.max_drive_minutes} min drive` : "No drive limit"}</p></div>{canManage && <button className="btn btn-secondary" type="button" onClick={() => setShowConstraints((value) => !value)}>{showConstraints ? "Close settings" : "Edit settings"}</button>}</div>
      {canManage && showConstraints ? <form className="form-grid" onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault(); const form = new FormData(event.currentTarget); const budget = String(form.get("budget") ?? "").trim();
        const cents = budget === "" ? null : parseDollarCents(budget);
        if (cents === null) { setError("Enter a valid budget with at most two decimal places."); return; }
        const startsOn = String(form.get("starts_on") ?? ""); const endsOn = String(form.get("ends_on") ?? ""); const maxDrive = String(form.get("max_drive_minutes") ?? "").trim();
        if (maxDrive && (!/^\d+$/.test(maxDrive) || Number(maxDrive) > Number.MAX_SAFE_INTEGER)) { setError("Maximum drive must be a whole number of minutes."); return; }
        const travelHours = String(form.get("travel_hours") ?? ""); const travelMinutes = String(form.get("travel_minutes") ?? ""); const travelDuration = parseDuration(travelHours, travelMinutes);
        const travelMode = String(form.get("travel_mode") ?? "") as TravelMode | "";
        if (travelDuration === null) { setError("Enter a positive travel duration with minutes from 0 to 59."); return; }
        void mutate(() => patchPlan(session.appJwt!, planId, { expected_version: plan.version, title: String(form.get("title") ?? "").trim(), budget_cents: cents, starts_on: startsOn ? new Date(`${startsOn}T00:00:00.000Z`).toISOString() : null, ends_on: endsOn ? new Date(`${endsOn}T00:00:00.000Z`).toISOString() : null, max_drive_minutes: maxDrive ? Number(maxDrive) : null, travel_mode: travelMode || null, travel_duration_minutes: travelDuration ?? null, travel_notes: String(form.get("travel_notes") || "") || null }));
      }}>
        <label className="field form-span">Plan name <input name="title" defaultValue={plan.title} disabled={disabled} required /></label>
        <label className="field">Budget <input name="budget" inputMode="decimal" defaultValue={plan.budget_cents === null ? "" : (plan.budget_cents / 100).toFixed(2)} disabled={disabled} /></label>
        <label className="field">Start date <input name="starts_on" type="date" defaultValue={plan.starts_on?.slice(0, 10) ?? ""} disabled={disabled} /></label>
        <label className="field">End date <input name="ends_on" type="date" defaultValue={plan.ends_on?.slice(0, 10) ?? ""} disabled={disabled} /></label>
        <label className="field">Maximum drive minutes <input name="max_drive_minutes" inputMode="numeric" defaultValue={plan.max_drive_minutes ?? ""} disabled={disabled} /></label>
        <label className="field">Travel mode <select name="travel_mode" defaultValue={plan.travel_mode ?? ""} disabled={disabled}><option value="">Not set</option>{travelModes.map((mode) => <option key={mode.value} value={mode.value}>{mode.emoji} {mode.label}</option>)}</select></label>
        <fieldset className="duration-input"><legend>Travel duration</legend><label className="field">Hours <input name="travel_hours" aria-label="Travel hours" inputMode="numeric" defaultValue={durationParts(plan.travel_duration_minutes).hours} /></label><label className="field">Minutes <input name="travel_minutes" aria-label="Travel minutes" inputMode="numeric" defaultValue={durationParts(plan.travel_duration_minutes).minutes} /></label></fieldset>
        <label className="field form-span">Travel notes <input name="travel_notes" defaultValue={plan.travel_notes ?? ""} disabled={disabled} /></label>
        <div className="cluster form-span"><button className="btn" disabled={disabled}>Save constraints</button><button className="btn btn-secondary" type="button" onClick={() => setShowConstraints(false)}>Cancel</button></div>
      </form> : !canManage ? <p className="muted small">Only an owner or co-owner can edit constraints.</p> : null}
      {canManage && <label className="field" style={{ marginTop: 14 }}>Vote visibility <select value={plan.vote_visibility} disabled={disabled} onChange={(event) => void mutate(() => updateVoteVisibility(session.appJwt!, planId, event.target.value as "public" | "anonymous", plan.version))}><option value="public">Public votes</option><option value="anonymous">Anonymous votes</option></select></label>}
    </section>

    <section className="card section-card">
      <div className="section-heading"><div><h2>Trip ideas</h2><p className="muted small">Collect possible stops, vote, and discuss the details.</p></div><button className="btn" disabled={disabled} type="button" onClick={() => setShowActivityForm((value) => !value)}>{showActivityForm ? "Cancel" : "+ Add activity"}</button></div>
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
      <div className="stack" style={{ marginTop: showActivityForm ? 16 : 0 }}>{plan.activities.map((activity) => {
        const parts = durationParts(activity.estimated_duration_minutes);
        return <article className="activity-card" key={activity.id}><div className="split"><div><h3>{activity.name}</h3><p className="muted small">{activity.description || "No description yet."}</p><p className="activity-author">Suggested by {activity.creator_display_name || "a group member"}</p></div><div className="cluster"><button className="btn btn-secondary" type="button" disabled={disabled} onClick={() => setEditingActivity(activity)}>Edit</button>{canManage && <button className="btn btn-danger" type="button" disabled={disabled} onClick={() => { if (window.confirm(`Delete ${activity.name}?`)) void mutate(() => deleteActivity(session.appJwt!, planId, activity.id, activity.version)); }}>Delete</button>}</div></div><div className="metadata">{activity.address && <span className="chip">{activity.address}</span>}{activity.estimated_cost_cents !== null && <span className="chip">{formatCents(activity.estimated_cost_cents)}</span>}{activity.estimated_duration_minutes !== null && <span className="chip">{parts.hours}h {parts.minutes}m</span>}{activity.tags.map((tag) => <span className="chip" key={tag}>#{tag}</span>)}</div>{activity.notes && <p className="small">{activity.notes}</p>}<div className="split"><div><strong className="small">Yes {activity.yes_votes} · Maybe {activity.maybe_votes} · No {activity.no_votes}</strong>{plan.vote_visibility === "public" && <p className="muted small">Votes: {snapshot.votes.filter((vote) => (vote as { activity_id?: string }).activity_id === activity.id).map((vote) => { const record = vote as { user_id?: string; vote?: string }; return `${displayMember(snapshot, String(record.user_id))} (${String(record.vote)})`; }).join(", ") || "No votes yet"}</p>}{plan.vote_visibility === "anonymous" && <p className="muted small">Votes are anonymous; only totals and your own choice are shown.</p>}</div><div className="vote-control" aria-label={`Vote on ${activity.name}`}>{(["yes", "maybe", "no"] as const).map((vote) => <button type="button" className={`vote-button ${vote} ${activity.vote === vote ? "selected" : ""}`} key={vote} aria-label={`Vote ${vote}`} aria-pressed={activity.vote === vote} disabled={disabled} onClick={() => void mutate(() => voteActivity(session.appJwt!, planId, activity.id, vote))}><span aria-hidden="true">{vote === "yes" ? "✅" : vote === "maybe" ? "😵‍💫" : "❌"}</span><span>{vote[0].toUpperCase() + vote.slice(1)}</span></button>)}</div></div>
        {editingActivity?.id === activity.id && <form className="form-grid subcard" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const cost = String(form.get("cost") ?? "").trim(); const cents = cost === "" ? null : parseDollarCents(cost); const duration = parseDuration(String(form.get("hours") ?? ""), String(form.get("minutes") ?? "")); const name = String(form.get("name") ?? "").trim(); if (!name || (cost !== "" && cents === null) || duration === null) { setError("Enter a name, valid cost, and a positive duration with minutes from 0 to 59."); return; } void mutate(() => patchActivity(session.appJwt!, planId, activity.id, { expected_version: activity.version, name, description: String(form.get("description") ?? "") || null, address: String(form.get("address") ?? "") || null, estimated_cost_cents: cents, estimated_duration_minutes: duration ?? null, tags: String(form.get("tags") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean), notes: String(form.get("notes") ?? "") || null })); setEditingActivity(null); }}>
          <label className="field">Name <input name="name" defaultValue={activity.name} disabled={disabled} /></label><label className="field">Description <input name="description" defaultValue={activity.description ?? ""} disabled={disabled} /></label><label className="field">Address <input name="address" defaultValue={activity.address ?? ""} disabled={disabled} /></label><label className="field">Cost <input name="cost" inputMode="decimal" defaultValue={activity.estimated_cost_cents === null ? "" : (activity.estimated_cost_cents / 100).toFixed(2)} disabled={disabled} /></label><fieldset className="duration-input"><legend>Duration</legend><label className="field">Hours <input name="hours" aria-label="Hours" min="0" inputMode="numeric" defaultValue={parts.hours} disabled={disabled} /></label><label className="field">Minutes <input name="minutes" aria-label="Minutes" min="0" max="59" inputMode="numeric" defaultValue={parts.minutes} disabled={disabled} /></label></fieldset><label className="field">Tags <input name="tags" defaultValue={activity.tags.join(", ")} disabled={disabled} /></label><label className="field">Notes <input name="notes" defaultValue={activity.notes ?? ""} disabled={disabled} /></label><div className="cluster form-span"><button className="btn" disabled={disabled}>Save activity</button><button className="btn btn-secondary" type="button" onClick={() => setEditingActivity(null)}>Cancel</button></div>
        </form>}<details><summary>Discussion ({snapshot.activity_comments.filter((comment) => comment.activity_id === activity.id && !comment.deleted_at).length})</summary>{snapshot.activity_comments.filter((comment) => comment.activity_id === activity.id).map((comment) => <div className="conversation" key={comment.id}><span className="avatar">{initials(comment.author_display_name)}</span><div><strong>{comment.author_display_name}</strong><p>{comment.deleted_at ? "Comment deleted" : comment.body}</p></div></div>)}<form className="cluster" onSubmit={(event) => { event.preventDefault(); const body = commentBodies[activity.id]?.trim(); if (body) { void mutate(() => createComment(session.appJwt!, planId, activity.id, body, crypto.randomUUID())); setCommentBodies((current) => ({ ...current, [activity.id]: "" })); } }}><label className="field" style={{ flex: 1 }}>Comment <input value={commentBodies[activity.id] ?? ""} onChange={(event) => setCommentBodies((current) => ({ ...current, [activity.id]: event.target.value }))} /></label><button className="btn" disabled={pending}>Post comment</button></form><form className="cluster" onSubmit={(event) => { event.preventDefault(); const message = String(new FormData(event.currentTarget).get("suggestion") ?? ""); if (message.trim()) void mutate(() => createActivitySuggestion(session.appJwt!, planId, activity.id, { suggestion_type: "general_modification", proposed_changes_json: { notes: message.trim() }, message, client_operation_id: crypto.randomUUID() })); }}><label className="field" style={{ flex: 1 }}>Suggest a change <input name="suggestion" /></label><button className="btn btn-secondary" disabled={pending}>Submit suggestion</button></form>{snapshot.activity_suggestions.filter((suggestion) => suggestion.activity_id === activity.id).map((suggestion) => <div className="suggestion" key={suggestion.id}><div className="split"><span><strong>{suggestion.author_display_name}</strong>: {suggestion.message}</span><span className="badge">{suggestion.status}</span></div>{canManage && suggestion.status === "open" && <div className="cluster"><button className="btn" disabled={disabled} onClick={() => void mutate(() => decideActivitySuggestion(session.appJwt!, planId, activity.id, suggestion.id, "accept", activity.version, crypto.randomUUID()))}>Accept</button><button className="btn btn-secondary" disabled={pending} onClick={() => void mutate(() => decideActivitySuggestion(session.appJwt!, planId, activity.id, suggestion.id, "dismiss", activity.version, crypto.randomUUID()))}>Dismiss</button></div>}</div>)}</details></article>;
      })}</div>
    </section>

    <section className="card section-card"><div className="section-heading"><div><h2>Route &amp; itinerary</h2><p className="muted small">Shape the day into a clear running order.</p></div></div><form className="cluster subcard" onSubmit={(event: FormEvent) => { event.preventDefault(); if (!itineraryTitle.trim()) { setError("Enter an itinerary title."); return; } void mutate(() => createItineraryItem(session.appJwt!, planId, { title: itineraryTitle.trim(), client_operation_id: crypto.randomUUID() })); setItineraryTitle(""); }}><label className="field" style={{ flex: 1 }}>Item <input value={itineraryTitle} onChange={(event) => setItineraryTitle(event.target.value)} disabled={disabled} /></label><button className="btn" disabled={disabled}>Add item</button></form>
      <div className="timeline">{itinerary.map((item, index) => <article className="itinerary-row" key={item.id}><span className="step">{index + 1}</span><div><div className="split"><strong>{item.title}</strong><div className="cluster"><button className="btn btn-secondary" disabled={disabled} onClick={() => setEditingItineraryId(item.id)}>Edit</button><button className="btn btn-quiet" disabled={disabled || index === 0} onClick={() => void mutate(() => reorderItineraryItem(session.appJwt!, planId, item.id, { expected_version: item.version, previous_item_id: index > 1 ? itinerary[index - 2].id : undefined, next_item_id: itinerary[index - 1].id }))}>Move up</button><button className="btn btn-quiet" disabled={disabled || index === itinerary.length - 1} onClick={() => void mutate(() => reorderItineraryItem(session.appJwt!, planId, item.id, { expected_version: item.version, previous_item_id: itinerary[index + 1].id, next_item_id: itinerary[index + 2]?.id }))}>Move down</button><button className="btn btn-danger" disabled={disabled} onClick={() => { if (window.confirm(`Delete ${item.title}?`)) void mutate(() => deleteItineraryItem(session.appJwt!, planId, item.id, item.version)); }}>Delete</button></div></div>{editingItineraryId === item.id && <form className="cluster" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const title = String(new FormData(event.currentTarget).get("title") ?? "").trim(); if (!title) { setError("Enter an itinerary title."); return; } void mutate(() => patchItineraryItem(session.appJwt!, planId, item.id, { title, expected_version: item.version })); setEditingItineraryId(null); }}><label className="field" style={{ flex: 1 }}>Title <input name="title" defaultValue={item.title} disabled={disabled} /></label><button className="btn" disabled={disabled}>Save item</button><button className="btn btn-secondary" type="button" onClick={() => setEditingItineraryId(null)}>Cancel</button></form>}</div></article>)}</div></section>

    <section className="card section-card"><div className="section-heading"><div><h2>Expenses</h2><p className="muted small">Keep shared costs clear and fair.</p></div><button className="btn" type="button" disabled={disabled} onClick={() => setShowExpenseForm((value) => !value)}>{showExpenseForm ? "Cancel" : "+ Add expense"}</button></div>{showExpenseForm && <form className="form-grid subcard" onSubmit={(event) => { event.preventDefault(); const cents = parseDollarCents(expenseAmount); if (!expenseDescription.trim() || cents === null || cents <= 0 || !expensePayer || expenseParticipants.length === 0) { setError("Enter a description, a valid positive amount, payer, and at least one participant."); return; } void mutate(() => createExpense(session.appJwt!, planId, { description: expenseDescription.trim(), amount_cents: cents, paid_by_user_id: expensePayer, participant_user_ids: expenseParticipants, client_operation_id: crypto.randomUUID() })); setExpenseDescription(""); setExpenseAmount(""); setShowExpenseForm(false); }}><label className="field">Description <input value={expenseDescription} onChange={(event) => setExpenseDescription(event.target.value)} disabled={disabled} /></label><label className="field">Amount <input value={expenseAmount} inputMode="decimal" onChange={(event) => setExpenseAmount(event.target.value)} disabled={disabled} /></label><label className="field">Payer <select value={expensePayer} onChange={(event) => setExpensePayer(event.target.value)} disabled={disabled}>{snapshot.members.map((member) => <option key={member.user_id} value={member.user_id}>{member.display_name}</option>)}</select></label><fieldset disabled={disabled}><legend>Split among</legend>{snapshot.members.map((member) => <label key={member.user_id}><input type="checkbox" checked={expenseParticipants.includes(member.user_id)} onChange={() => toggleParticipants(member.user_id, expenseParticipants, setExpenseParticipants)} />{member.display_name}</label>)}</fieldset><div className="cluster form-span"><button className="btn" disabled={disabled}>Save expense</button><button className="btn btn-secondary" type="button" onClick={() => setShowExpenseForm(false)}>Cancel</button></div></form>}
      <div className="stack" style={{ marginTop: 14 }}>{snapshot.expenses.map((expense) => <article className="expense-row" key={expense.id}><div className="split"><div><h3>{expense.description}</h3><div className="cluster"><strong>{formatCents(expense.amount_cents)}</strong><span className="badge">{expense.status}</span></div></div>{expense.status === "active" && <div className="cluster"><button className="btn btn-secondary" disabled={disabled} onClick={() => startExpenseEdit(expense)}>Edit</button><button className="btn btn-danger" disabled={disabled} onClick={() => { if (window.confirm(`Reverse ${expense.description}?`)) void mutate(() => deleteExpense(session.appJwt!, planId, expense.id, expense.version, crypto.randomUUID())); }}>Delete</button></div>}</div><p className="muted small">Paid by {displayMember(snapshot, expense.paid_by_user_id)}</p><p className="small">{snapshot.expense_splits.filter((split) => split.expense_id === expense.id).map((split) => `${displayMember(snapshot, split.user_id)}: ${formatCents(split.amount_cents)}`).join(" · ")}</p>
        {editingExpense?.id === expense.id && <form onSubmit={(event) => { event.preventDefault(); const cents = parseDollarCents(editExpenseAmount); if (!editExpenseDescription.trim() || cents === null || cents <= 0 || !editExpensePayer || editExpenseParticipants.length === 0) { setError("Enter a description, valid positive amount, payer, and participant list."); return; } void mutate(() => patchExpense(session.appJwt!, planId, expense.id, { description: editExpenseDescription.trim(), amount_cents: cents, paid_by_user_id: editExpensePayer, participant_user_ids: editExpenseParticipants, expected_version: expense.version, client_operation_id: crypto.randomUUID() })); setEditingExpense(null); }}><label>Edit description <input value={editExpenseDescription} onChange={(event) => setEditExpenseDescription(event.target.value)} disabled={disabled} /></label><label>Amount <input value={editExpenseAmount} onChange={(event) => setEditExpenseAmount(event.target.value)} disabled={disabled} /></label><label>Payer <select value={editExpensePayer} onChange={(event) => setEditExpensePayer(event.target.value)} disabled={disabled}>{snapshot.members.map((member) => <option key={member.user_id} value={member.user_id}>{member.display_name}</option>)}</select></label><fieldset disabled={disabled}><legend>Split among</legend>{snapshot.members.map((member) => <label key={member.user_id}><input type="checkbox" checked={editExpenseParticipants.includes(member.user_id)} onChange={() => toggleParticipants(member.user_id, editExpenseParticipants, setEditExpenseParticipants)} />{member.display_name}</label>)}</fieldset><button disabled={disabled}>Save expense</button><button type="button" onClick={() => setEditingExpense(null)}>Cancel</button></form>}</article>)}</div></section>

    </div><aside className="sticky-column">
    <section className="card section-card"><div className="section-heading"><div><h2>Balances</h2><p className="muted small">Your group’s current ledger summary.</p></div></div>{balances.map((balance) => <div className="split small" key={balance.user_id}><span>{displayMember(snapshot, balance.user_id)}</span><strong className={balance.balance_cents >= 0 ? "balance-positive" : "balance-negative"}>{formatCents(balance.balance_cents)}</strong></div>)}</section>
    <section className="card section-card"><div className="section-heading"><div><h2>Travel window</h2><p className="muted small">Trip dates: {readableDate(plan.starts_on)} – {readableDate(plan.ends_on)}</p></div></div><form className="stack subcard" onSubmit={(event) => { event.preventDefault(); if (availabilityDate) void mutate(() => upsertDateAvailability(session.appJwt!, planId, availabilityDate, availabilityStatus)); }}><label className="field">Date <input type="date" value={availabilityDate} onChange={(event) => setAvailabilityDate(event.target.value)} /></label><label className="field">Availability <select value={availabilityStatus} onChange={(event) => setAvailabilityStatus(event.target.value as typeof availabilityStatus)}><option value="available">Available</option><option value="maybe">Maybe</option><option value="unavailable">Unavailable</option></select></label><button className="btn" disabled={pending}>Save availability</button></form><div className="availability-list" style={{ margin: "12px 0" }}>{snapshot.date_availability.map((entry) => <span className="chip" key={`${entry.date}-${entry.status}-${entry.is_current_user}`}>{readableDate(entry.date)} · {entry.status}{entry.is_current_user ? " (you)" : ""}</span>)}{snapshot.date_availability.length === 0 && <span className="muted small">No availability yet.</span>}</div><form className="stack subcard" onSubmit={(event) => { event.preventDefault(); if (dateSuggestionStart && dateSuggestionEnd) void mutate(() => createDateSuggestion(session.appJwt!, planId, dateSuggestionStart, dateSuggestionEnd, crypto.randomUUID())); }}><label className="field">Suggested start <input type="date" value={dateSuggestionStart} onChange={(event) => setDateSuggestionStart(event.target.value)} /></label><label className="field">Suggested end <input type="date" value={dateSuggestionEnd} onChange={(event) => setDateSuggestionEnd(event.target.value)} /></label><button className="btn btn-secondary" disabled={pending}>Suggest dates</button></form><div className="stack" style={{ marginTop: 12 }}>{snapshot.date_suggestions.map((suggestion) => <div className="date-suggestion" key={suggestion.id}><div className="split"><strong>{suggestion.author_display_name}</strong><span className="badge">{suggestion.status}</span></div><p className="small">suggested {readableDate(suggestion.starts_on)}–{readableDate(suggestion.ends_on)}</p>{canManage && suggestion.status === "open" && <div className="cluster"><button className="btn" disabled={disabled} onClick={() => void mutate(() => decideDateSuggestion(session.appJwt!, planId, suggestion.id, "accept", plan.version, crypto.randomUUID()))}>Accept</button><button className="btn btn-secondary" disabled={pending} onClick={() => void mutate(() => decideDateSuggestion(session.appJwt!, planId, suggestion.id, "dismiss", plan.version, crypto.randomUUID()))}>Dismiss</button></div>}</div>)}</div></section>
    <section className="card section-card plan-ideas"><div className="section-heading"><div><h2>Travel-window poll</h2><p className="muted small">Vote on the group’s proposed date ranges.</p></div></div><div className="stack">{[...snapshot.date_suggestions].sort((a, b) => b.yes_votes - a.yes_votes || b.maybe_votes - a.maybe_votes || a.no_votes - b.no_votes || a.starts_on.localeCompare(b.starts_on)).map((suggestion) => <article className="poll-option" key={`poll-${suggestion.id}`}><div className="split"><div><strong>{readableDate(suggestion.starts_on)} – {readableDate(suggestion.ends_on)}</strong><p className="muted small">Suggested by {suggestion.author_display_name}</p></div><span className="badge">{suggestion.status}</span></div><div className="poll-votes">{(["yes", "maybe", "no"] as const).map((vote) => <button className={`vote-button ${vote} ${suggestion.vote === vote ? "selected" : ""}`} type="button" key={vote} aria-label={`Vote ${vote} for ${readableDate(suggestion.starts_on)}`} aria-pressed={suggestion.vote === vote} disabled={pending || suggestion.status !== "open"} onClick={() => void mutate(() => voteDateSuggestion(session.appJwt!, planId, suggestion.id, vote, crypto.randomUUID()))}><span aria-hidden="true">{vote === "yes" ? "✓" : vote === "maybe" ? "~" : "×"}</span><span>{vote === "yes" ? suggestion.yes_votes : vote === "maybe" ? suggestion.maybe_votes : suggestion.no_votes}</span></button>)}</div></article>)}</div></section>
    <section className="card section-card plan-ideas"><div className="section-heading"><div><h2>Plan ideas</h2><p className="muted small">Suggest a different trip concept without replacing activities, expenses, or history.</p></div></div><form className="stack subcard" onSubmit={(event) => { event.preventDefault(); if (!planSuggestionTitle.trim()) return; void mutate(() => createPlanSuggestion(session.appJwt!, planId, { title: planSuggestionTitle.trim(), description: planSuggestionDescription || null, client_operation_id: crypto.randomUUID() })); setPlanSuggestionTitle(""); setPlanSuggestionDescription(""); }}><label className="field">Proposed plan name <input value={planSuggestionTitle} onChange={(event) => setPlanSuggestionTitle(event.target.value)} required /></label><label className="field">Why this trip? <textarea value={planSuggestionDescription} onChange={(event) => setPlanSuggestionDescription(event.target.value)} /></label><button className="btn btn-secondary" disabled={pending}>Suggest a different trip</button></form><div className="stack" style={{ marginTop: 12 }}>{snapshot.plan_suggestions.map((suggestion) => <article className="suggestion" key={suggestion.id}><div className="split"><div><strong>{suggestion.title}</strong><p className="muted small">Suggested by {suggestion.author_display_name}</p></div><span className="badge">{suggestion.status}</span></div>{suggestion.description && <p className="small">{suggestion.description}</p>}{canManage && suggestion.status === "open" && <div className="cluster"><button className="btn" disabled={disabled} onClick={() => { if (window.confirm("Adopt this plan idea? Only supported plan-level fields will change; activities and expenses are preserved.")) void mutate(() => decidePlanSuggestion(session.appJwt!, planId, suggestion.id, "accept", plan.version, crypto.randomUUID())); }}>Adopt this plan idea</button><button className="btn btn-secondary" disabled={pending} onClick={() => void mutate(() => decidePlanSuggestion(session.appJwt!, planId, suggestion.id, "dismiss", plan.version, crypto.randomUUID()))}>Dismiss</button></div>}</article>)}</div></section>
    <section className="card section-card"><details><summary>Developer details ({snapshot.ledger_entries.length} ledger entries)</summary><p className="muted small">The immutable ledger is read-only.</p></details></section>
    </aside></div>
  </main>;
}
