"use client";

import { signIn, useSession } from "next-auth/react";
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
  createItineraryItem,
  deleteActivity,
  deleteExpense,
  deleteItineraryItem,
  changeMemberRole,
  decideActivitySuggestion,
  decideDateSuggestion,
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
  voteActivity
} from "@/lib/api-client";
import { formatCents, parseDollarCents } from "@/lib/money";
import { connectionLabel } from "@/hooks/useConnectionStatus";
import { usePlanSocket } from "@/hooks/usePlanSocket";
import { snapshotToPlanDetail } from "@/hooks/useResyncPlan";
import type { ActivitySummary, Expense, PlanBalance, PlanDetail, ResyncSnapshot } from "@/types/api";

function displayMember(snapshot: ResyncSnapshot, userId: string) {
  return snapshot.members.find((member) => member.user_id === userId)?.display_name ?? userId;
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
  const [activityDuration, setActivityDuration] = useState("");
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

  if (status === "loading") return <main style={{ padding: 24 }}>Loading plan…</main>;
  if (status !== "authenticated") return <main style={{ padding: 24 }}><button onClick={() => signIn("google")}>Sign in with Google</button></main>;
  if (authFailed) return <main style={{ padding: 24 }}><p>Authentication required — sign in again.</p><button onClick={() => signIn("google")}>Sign in again</button></main>;
  if (authorizationFailed) return <main style={{ padding: 24 }}><p>You do not have access to this plan.</p></main>;
  if (!plan || !snapshot) return <main style={{ padding: 24 }}>Loading plan…</main>;

  const finalized = plan.status === "finalized";
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

  return <main style={{ maxWidth: 960, margin: "32px auto", padding: 24, fontFamily: "system-ui" }}>
    <Link href="/dashboard">Dashboard</Link>
    <h1>{plan.title}</h1>
    <p>Role: {plan.role} · Status: <strong>{plan.status}</strong>{plan.budget_cents !== null && ` · Budget ${formatCents(plan.budget_cents)}`}</p>
    <p>{plan.starts_on && `Start: ${plan.starts_on.slice(0, 10)} · `}{plan.ends_on && `End: ${plan.ends_on.slice(0, 10)} · `}{plan.max_drive_minutes !== null && plan.max_drive_minutes !== undefined && `Maximum drive: ${plan.max_drive_minutes} minutes`}</p>
    {finalized && <p role="status">This plan is finalized. Unfinalize it to make changes.</p>}
    <section style={{ border: "1px solid #ccc", padding: 12, margin: "16px 0" }}>
      <strong>{connectionLabel(socket.connectionState)}</strong>
      {socket.nextRetryMs !== null && <span> Next retry in {Math.ceil(socket.nextRetryMs / 1000)}s.</span>}
      {socket.connectionState === "unavailable" && <button type="button" onClick={socket.retry} style={{ marginLeft: 12 }}>Retry</button>}
    </section>
    {error && <p role="alert" style={{ color: "crimson" }}>{error}</p>}
    {pending && <p role="status">Saving and syncing latest state…</p>}
    {canManage && <button disabled={pending} onClick={() => void mutate(() => setPlanLifecycle(session.appJwt!, planId, finalized ? "unfinalize" : "finalize", plan.version), true)}>{finalized ? "Unfinalize plan" : "Finalize plan"}</button>}
    {canManage && <label>Vote visibility <select value={plan.vote_visibility} disabled={disabled} onChange={(event) => void mutate(() => updateVoteVisibility(session.appJwt!, planId, event.target.value as "public" | "anonymous", plan.version))}><option value="public">Public votes</option><option value="anonymous">Anonymous votes</option></select></label>}

    <section><h2>Members</h2>{snapshot.members.map((member) => <article key={member.user_id}><strong>{member.display_name}</strong> · {member.role} · joined {member.created_at.slice(0, 10)}{member.user_id === snapshot.current_user_id && " · you"}{plan.role === "owner" && member.role !== "owner" && member.user_id !== snapshot.current_user_id && <><button disabled={disabled} onClick={() => void mutate(() => changeMemberRole(session.appJwt!, planId, member.user_id, member.role === "co_owner" ? "member" : "co_owner", crypto.randomUUID()))}>{member.role === "co_owner" ? "Demote" : "Promote"}</button><button disabled={disabled} onClick={() => { if (window.confirm(`Remove ${member.display_name}?`)) void mutate(() => removeMember(session.appJwt!, planId, member.user_id, crypto.randomUUID())); }}>Remove</button></>}{plan.role === "co_owner" && member.role === "member" && member.user_id !== snapshot.current_user_id && <button disabled={disabled} onClick={() => { if (window.confirm(`Remove ${member.display_name}?`)) void mutate(() => removeMember(session.appJwt!, planId, member.user_id, crypto.randomUUID())); }}>Remove</button>}</article>)}</section>

    <section>
      <h2>Plan constraints</h2>
      {canManage ? <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault(); const form = new FormData(event.currentTarget); const budget = String(form.get("budget") ?? "").trim();
        const cents = budget === "" ? null : parseDollarCents(budget);
        if (cents === null) { setError("Enter a valid budget with at most two decimal places."); return; }
        const startsOn = String(form.get("starts_on") ?? ""); const endsOn = String(form.get("ends_on") ?? ""); const maxDrive = String(form.get("max_drive_minutes") ?? "").trim();
        if (maxDrive && (!/^\d+$/.test(maxDrive) || Number(maxDrive) > Number.MAX_SAFE_INTEGER)) { setError("Maximum drive must be a whole number of minutes."); return; }
        void mutate(() => patchPlan(session.appJwt!, planId, { expected_version: plan.version, budget_cents: cents, starts_on: startsOn ? new Date(`${startsOn}T00:00:00.000Z`).toISOString() : null, ends_on: endsOn ? new Date(`${endsOn}T00:00:00.000Z`).toISOString() : null, max_drive_minutes: maxDrive ? Number(maxDrive) : null }));
      }}>
        <label>Budget <input name="budget" inputMode="decimal" defaultValue={plan.budget_cents === null ? "" : (plan.budget_cents / 100).toFixed(2)} disabled={disabled} /></label>
        <label>Start date <input name="starts_on" type="date" defaultValue={plan.starts_on?.slice(0, 10) ?? ""} disabled={disabled} /></label>
        <label>End date <input name="ends_on" type="date" defaultValue={plan.ends_on?.slice(0, 10) ?? ""} disabled={disabled} /></label>
        <label>Maximum drive minutes <input name="max_drive_minutes" inputMode="numeric" defaultValue={plan.max_drive_minutes ?? ""} disabled={disabled} /></label>
        <button disabled={disabled}>Save constraints</button>
      </form> : <p>Only the plan owner can edit constraints.</p>}
    </section>

    <section>
      <h2>Activities</h2>
      <form onSubmit={(event: FormEvent) => {
        event.preventDefault(); const cents = activityCost ? parseDollarCents(activityCost) : undefined;
        if (!activityName.trim() || cents === null || (activityDuration && !/^\d+$/.test(activityDuration))) { setError("Enter an activity name, a valid cost, and a whole-number duration."); return; }
        void mutate(() => createActivity(session.appJwt!, planId, { name: activityName.trim(), description: activityDescription || undefined, address: activityAddress || undefined, estimated_cost_cents: cents, estimated_duration_minutes: activityDuration ? Number(activityDuration) : undefined, tags: activityTags.split(",").map((tag) => tag.trim()).filter(Boolean), notes: activityNotes || undefined, client_operation_id: crypto.randomUUID() }));
        setActivityName(""); setActivityDescription(""); setActivityAddress(""); setActivityCost(""); setActivityDuration(""); setActivityTags(""); setActivityNotes("");
      }}>
        <label>Name <input value={activityName} onChange={(event) => setActivityName(event.target.value)} disabled={disabled} /></label>
        <label>Description <input value={activityDescription} onChange={(event) => setActivityDescription(event.target.value)} disabled={disabled} /></label>
        <label>Address <input value={activityAddress} onChange={(event) => setActivityAddress(event.target.value)} disabled={disabled} /></label>
        <label>Estimated cost <input value={activityCost} inputMode="decimal" onChange={(event) => setActivityCost(event.target.value)} disabled={disabled} /></label>
        <label>Duration minutes <input value={activityDuration} inputMode="numeric" onChange={(event) => setActivityDuration(event.target.value)} disabled={disabled} /></label>
        <label>Tags (comma-separated) <input value={activityTags} onChange={(event) => setActivityTags(event.target.value)} disabled={disabled} /></label>
        <label>Notes <input value={activityNotes} onChange={(event) => setActivityNotes(event.target.value)} disabled={disabled} /></label>
        <button disabled={disabled}>Add activity</button>
      </form>
      {plan.activities.map((activity) => <article key={activity.id}><h3>{activity.name}</h3><p>{activity.description}</p><p>{activity.address}{activity.estimated_cost_cents !== null && ` · ${formatCents(activity.estimated_cost_cents)}`}{activity.estimated_duration_minutes !== null && ` · ${activity.estimated_duration_minutes} min`}{activity.tags.length > 0 && ` · ${activity.tags.join(", ")}`}{activity.notes && ` · ${activity.notes}`}</p><p>Yes {activity.yes_votes} · Maybe {activity.maybe_votes} · No {activity.no_votes}</p>{plan.vote_visibility === "public" && <p>Votes: {snapshot.votes.filter((vote) => (vote as { activity_id?: string }).activity_id === activity.id).map((vote) => { const record = vote as { user_id?: string; vote?: string }; return `${displayMember(snapshot, String(record.user_id))} (${String(record.vote)})`; }).join(", ") || "No votes yet"}</p>}{plan.vote_visibility === "anonymous" && <p>Votes are anonymous; only totals and your own choice are shown.</p>}
        <div>{(["yes", "maybe", "no"] as const).map((vote) => <button key={vote} disabled={disabled} onClick={() => void mutate(() => voteActivity(session.appJwt!, planId, activity.id, vote))}>{activity.vote === vote ? `${vote} selected` : vote}</button>)} <button disabled={disabled} onClick={() => setEditingActivity(activity)}>Edit</button>{canManage && <button disabled={disabled} onClick={() => { if (window.confirm(`Delete ${activity.name}?`)) void mutate(() => deleteActivity(session.appJwt!, planId, activity.id, activity.version)); }}>Delete</button>}</div>
        {editingActivity?.id === activity.id && <form onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const cost = String(form.get("cost") ?? "").trim(); const cents = cost === "" ? null : parseDollarCents(cost); const duration = String(form.get("duration") ?? "").trim(); if (cents === null || (duration && !/^\d+$/.test(duration))) { setError("Use a valid cost and a whole-number duration."); return; } void mutate(() => patchActivity(session.appJwt!, planId, activity.id, { expected_version: activity.version, name: String(form.get("name") ?? "").trim(), description: String(form.get("description") ?? "") || null, address: String(form.get("address") ?? "") || null, estimated_cost_cents: cents, estimated_duration_minutes: duration ? Number(duration) : null, tags: String(form.get("tags") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean), notes: String(form.get("notes") ?? "") || null })); setEditingActivity(null); }}>
          <label>Name <input name="name" defaultValue={activity.name} disabled={disabled} /></label><label>Description <input name="description" defaultValue={activity.description ?? ""} disabled={disabled} /></label><label>Address <input name="address" defaultValue={activity.address ?? ""} disabled={disabled} /></label><label>Cost <input name="cost" defaultValue={activity.estimated_cost_cents === null ? "" : (activity.estimated_cost_cents / 100).toFixed(2)} disabled={disabled} /></label><label>Duration <input name="duration" defaultValue={activity.estimated_duration_minutes ?? ""} disabled={disabled} /></label><label>Tags <input name="tags" defaultValue={activity.tags.join(", ")} disabled={disabled} /></label><label>Notes <input name="notes" defaultValue={activity.notes ?? ""} disabled={disabled} /></label><button disabled={disabled}>Save activity</button><button type="button" onClick={() => setEditingActivity(null)}>Cancel</button>
        </form>}<details><summary>Discussion ({snapshot.activity_comments.filter((comment) => comment.activity_id === activity.id && !comment.deleted_at).length})</summary>{snapshot.activity_comments.filter((comment) => comment.activity_id === activity.id).map((comment) => <p key={comment.id}>{comment.deleted_at ? "Comment deleted" : `${comment.author_display_name}: ${comment.body}`}</p>)}<form onSubmit={(event) => { event.preventDefault(); const body = commentBodies[activity.id]?.trim(); if (body) { void mutate(() => createComment(session.appJwt!, planId, activity.id, body, crypto.randomUUID())); setCommentBodies((current) => ({ ...current, [activity.id]: "" })); } }}><label>Comment <input value={commentBodies[activity.id] ?? ""} onChange={(event) => setCommentBodies((current) => ({ ...current, [activity.id]: event.target.value }))} /></label><button disabled={pending}>Post comment</button></form><form onSubmit={(event) => { event.preventDefault(); const message = String(new FormData(event.currentTarget).get("suggestion") ?? ""); if (message.trim()) void mutate(() => createActivitySuggestion(session.appJwt!, planId, activity.id, { suggestion_type: "general_modification", proposed_changes_json: { notes: message.trim() }, message, client_operation_id: crypto.randomUUID() })); }}><label>Suggest a change <input name="suggestion" /></label><button disabled={pending}>Submit suggestion</button></form>{snapshot.activity_suggestions.filter((suggestion) => suggestion.activity_id === activity.id).map((suggestion) => <p key={suggestion.id}>{suggestion.author_display_name}: {suggestion.message} · {suggestion.status}{canManage && suggestion.status === "open" && <><button disabled={disabled} onClick={() => void mutate(() => decideActivitySuggestion(session.appJwt!, planId, activity.id, suggestion.id, "accept", activity.version, crypto.randomUUID()))}>Accept</button><button disabled={pending} onClick={() => void mutate(() => decideActivitySuggestion(session.appJwt!, planId, activity.id, suggestion.id, "dismiss", activity.version, crypto.randomUUID()))}>Dismiss</button></>}</p>)}</details></article>)}
    </section>

    <section><h2>Itinerary</h2><form onSubmit={(event: FormEvent) => { event.preventDefault(); if (!itineraryTitle.trim()) { setError("Enter an itinerary title."); return; } void mutate(() => createItineraryItem(session.appJwt!, planId, { title: itineraryTitle.trim(), client_operation_id: crypto.randomUUID() })); setItineraryTitle(""); }}><label>Item <input value={itineraryTitle} onChange={(event) => setItineraryTitle(event.target.value)} disabled={disabled} /></label><button disabled={disabled}>Add item</button></form>
      {itinerary.map((item, index) => <article key={item.id}><strong>{item.title}</strong> <small>position {item.position_key}</small><button disabled={disabled} onClick={() => setEditingItineraryId(item.id)}>Edit</button><button disabled={disabled || index === 0} onClick={() => void mutate(() => reorderItineraryItem(session.appJwt!, planId, item.id, { expected_version: item.version, previous_item_id: index > 1 ? itinerary[index - 2].id : undefined, next_item_id: itinerary[index - 1].id }))}>Move up</button><button disabled={disabled || index === itinerary.length - 1} onClick={() => void mutate(() => reorderItineraryItem(session.appJwt!, planId, item.id, { expected_version: item.version, previous_item_id: itinerary[index + 1].id, next_item_id: itinerary[index + 2]?.id }))}>Move down</button><button disabled={disabled} onClick={() => { if (window.confirm(`Delete ${item.title}?`)) void mutate(() => deleteItineraryItem(session.appJwt!, planId, item.id, item.version)); }}>Delete</button>{editingItineraryId === item.id && <form onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const title = String(new FormData(event.currentTarget).get("title") ?? "").trim(); if (!title) { setError("Enter an itinerary title."); return; } void mutate(() => patchItineraryItem(session.appJwt!, planId, item.id, { title, expected_version: item.version })); setEditingItineraryId(null); }}><label>Title <input name="title" defaultValue={item.title} disabled={disabled} /></label><button disabled={disabled}>Save item</button><button type="button" onClick={() => setEditingItineraryId(null)}>Cancel</button></form>}</article>)}</section>

    <section><h2>Expenses</h2><form onSubmit={(event) => { event.preventDefault(); const cents = parseDollarCents(expenseAmount); if (!expenseDescription.trim() || cents === null || cents <= 0 || !expensePayer || expenseParticipants.length === 0) { setError("Enter a description, a valid positive amount, payer, and at least one participant."); return; } void mutate(() => createExpense(session.appJwt!, planId, { description: expenseDescription.trim(), amount_cents: cents, paid_by_user_id: expensePayer, participant_user_ids: expenseParticipants, client_operation_id: crypto.randomUUID() })); setExpenseDescription(""); setExpenseAmount(""); }}><label>Description <input value={expenseDescription} onChange={(event) => setExpenseDescription(event.target.value)} disabled={disabled} /></label><label>Amount <input value={expenseAmount} inputMode="decimal" onChange={(event) => setExpenseAmount(event.target.value)} disabled={disabled} /></label><label>Payer <select value={expensePayer} onChange={(event) => setExpensePayer(event.target.value)} disabled={disabled}>{snapshot.members.map((member) => <option key={member.user_id} value={member.user_id}>{member.display_name}</option>)}</select></label><fieldset disabled={disabled}><legend>Split among</legend>{snapshot.members.map((member) => <label key={member.user_id}><input type="checkbox" checked={expenseParticipants.includes(member.user_id)} onChange={() => toggleParticipants(member.user_id, expenseParticipants, setExpenseParticipants)} />{member.display_name}</label>)}</fieldset><button disabled={disabled}>Add expense</button></form>
      {snapshot.expenses.map((expense) => <article key={expense.id}><h3>{expense.description} · {formatCents(expense.amount_cents)} · {expense.status}</h3><p>Paid by {displayMember(snapshot, expense.paid_by_user_id)}</p><p>{snapshot.expense_splits.filter((split) => split.expense_id === expense.id).map((split) => `${displayMember(snapshot, split.user_id)}: ${formatCents(split.amount_cents)}`).join(" · ")}</p>{expense.status === "active" && <><button disabled={disabled} onClick={() => startExpenseEdit(expense)}>Edit</button><button disabled={disabled} onClick={() => { if (window.confirm(`Reverse ${expense.description}?`)) void mutate(() => deleteExpense(session.appJwt!, planId, expense.id, expense.version, crypto.randomUUID())); }}>Delete</button></>}
        {editingExpense?.id === expense.id && <form onSubmit={(event) => { event.preventDefault(); const cents = parseDollarCents(editExpenseAmount); if (!editExpenseDescription.trim() || cents === null || cents <= 0 || !editExpensePayer || editExpenseParticipants.length === 0) { setError("Enter a description, valid positive amount, payer, and participant list."); return; } void mutate(() => patchExpense(session.appJwt!, planId, expense.id, { description: editExpenseDescription.trim(), amount_cents: cents, paid_by_user_id: editExpensePayer, participant_user_ids: editExpenseParticipants, expected_version: expense.version, client_operation_id: crypto.randomUUID() })); setEditingExpense(null); }}><label>Edit description <input value={editExpenseDescription} onChange={(event) => setEditExpenseDescription(event.target.value)} disabled={disabled} /></label><label>Amount <input value={editExpenseAmount} onChange={(event) => setEditExpenseAmount(event.target.value)} disabled={disabled} /></label><label>Payer <select value={editExpensePayer} onChange={(event) => setEditExpensePayer(event.target.value)} disabled={disabled}>{snapshot.members.map((member) => <option key={member.user_id} value={member.user_id}>{member.display_name}</option>)}</select></label><fieldset disabled={disabled}><legend>Split among</legend>{snapshot.members.map((member) => <label key={member.user_id}><input type="checkbox" checked={editExpenseParticipants.includes(member.user_id)} onChange={() => toggleParticipants(member.user_id, editExpenseParticipants, setEditExpenseParticipants)} />{member.display_name}</label>)}</fieldset><button disabled={disabled}>Save expense</button><button type="button" onClick={() => setEditingExpense(null)}>Cancel</button></form>}</article>)}</section>

    <section><h2>Balances</h2>{balances.map((balance) => <p key={balance.user_id}>{displayMember(snapshot, balance.user_id)}: {formatCents(balance.balance_cents)}</p>)}</section>
    <section><h2>Date coordination</h2><p>Authoritative dates: {plan.starts_on?.slice(0, 10) ?? "not set"} – {plan.ends_on?.slice(0, 10) ?? "not set"}</p><form onSubmit={(event) => { event.preventDefault(); if (availabilityDate) void mutate(() => upsertDateAvailability(session.appJwt!, planId, availabilityDate, availabilityStatus)); }}><label>Date <input type="date" value={availabilityDate} onChange={(event) => setAvailabilityDate(event.target.value)} /></label><label>Availability <select value={availabilityStatus} onChange={(event) => setAvailabilityStatus(event.target.value as typeof availabilityStatus)}><option value="available">Available</option><option value="maybe">Maybe</option><option value="unavailable">Unavailable</option></select></label><button disabled={pending}>Save availability</button></form><p>{snapshot.date_availability.map((entry) => `${entry.date}: ${entry.status}${entry.is_current_user ? " (you)" : ""}`).join(" · ") || "No availability yet."}</p><form onSubmit={(event) => { event.preventDefault(); if (dateSuggestionStart && dateSuggestionEnd) void mutate(() => createDateSuggestion(session.appJwt!, planId, dateSuggestionStart, dateSuggestionEnd, crypto.randomUUID())); }}><label>Suggested start <input type="date" value={dateSuggestionStart} onChange={(event) => setDateSuggestionStart(event.target.value)} /></label><label>Suggested end <input type="date" value={dateSuggestionEnd} onChange={(event) => setDateSuggestionEnd(event.target.value)} /></label><button disabled={pending}>Suggest dates</button></form>{snapshot.date_suggestions.map((suggestion) => <p key={suggestion.id}>{suggestion.author_display_name} suggested {suggestion.starts_on}–{suggestion.ends_on} · {suggestion.status}{canManage && suggestion.status === "open" && <><button disabled={disabled} onClick={() => void mutate(() => decideDateSuggestion(session.appJwt!, planId, suggestion.id, "accept", plan.version, crypto.randomUUID()))}>Accept</button><button disabled={pending} onClick={() => void mutate(() => decideDateSuggestion(session.appJwt!, planId, suggestion.id, "dismiss", plan.version, crypto.randomUUID()))}>Dismiss</button></>}</p>)}</section>
    <details><summary>Developer ledger ({snapshot.ledger_entries.length} entries)</summary><p>The immutable ledger is read-only.</p></details>
    <section>{canManage && <button disabled={disabled} onClick={() => void mutate(async () => { const invite = await createInvite(session.appJwt!, planId); setInviteToken(invite.token); })}>Create invite</button>}{inviteToken && <code>{typeof window === "undefined" ? inviteToken : `${window.location.origin}/invites/${inviteToken}`}</code>}</section>
  </main>;
}
