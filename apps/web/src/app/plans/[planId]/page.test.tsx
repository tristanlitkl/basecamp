import React from "react";
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import PlanPage from "@/app/plans/[planId]/page";
import {
  ApiError,
  changeMemberRole,
  createActivity,
  createActivitySuggestion,
  createComment,
  createPlanningRun,
  archiveDateSuggestion, createDateSuggestion, createPlanSuggestion,
  createCoOwnerRequest, decideCoOwnerRequest,
  createExpense,
  createInvite,
  createItineraryItem,
  deleteActivity,
  deleteExpense,
  deleteItineraryItem,
  decideActivitySuggestion, decidePlanSuggestion,
  decideDateSuggestion,
  getNotifications,
  getPlanBalances,
  getPlanningStatus,
  getPlanningRun,
  getRecommendations,
  patchActivity,
  patchExpense,
  patchItineraryItem,
  patchPlan,
  applyPlanningRun,
  regeneratePlanningRun,
  reorderItineraryItem,
  removeMember,
  resyncPlan,
  setPlanLifecycle,
  syncUser, withdrawCoOwnerRequest,
  upsertDateAvailability, voteActivity, voteDateSuggestion
} from "@/lib/api-client";
import { usePlanSocket } from "@/hooks/usePlanSocket";
import type { PlanningStatus, ResyncSnapshot } from "@/types/api";

vi.mock("next-auth/react", () => ({
  signIn: vi.fn(),
  useSession: () => ({ data: { appJwt: "app-jwt", user: { email: "owner@example.com" } }, status: "authenticated" })
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ planId: "plan-1" }) }));
vi.mock("@/hooks/usePlanSocket", () => ({ usePlanSocket: vi.fn() }));
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    syncUser: vi.fn(), resyncPlan: vi.fn(), getNotifications: vi.fn(), getPlanBalances: vi.fn(), getRecommendations: vi.fn(), getPlanningStatus: vi.fn(), createPlanningRun: vi.fn(), getPlanningRun: vi.fn(), regeneratePlanningRun: vi.fn(), applyPlanningRun: vi.fn(),
    createActivity: vi.fn(), patchActivity: vi.fn(), deleteActivity: vi.fn(), voteActivity: vi.fn(),
    createItineraryItem: vi.fn(), patchItineraryItem: vi.fn(), reorderItineraryItem: vi.fn(), deleteItineraryItem: vi.fn(),
    createExpense: vi.fn(), patchExpense: vi.fn(), deleteExpense: vi.fn(),
    patchPlan: vi.fn(), setPlanLifecycle: vi.fn(), createInvite: vi.fn(),
    changeMemberRole: vi.fn(), removeMember: vi.fn(), createCoOwnerRequest: vi.fn(), withdrawCoOwnerRequest: vi.fn(), decideCoOwnerRequest: vi.fn(), createComment: vi.fn(), createActivitySuggestion: vi.fn(), decideActivitySuggestion: vi.fn(), upsertDateAvailability: vi.fn(), createDateSuggestion: vi.fn(), archiveDateSuggestion: vi.fn(), decideDateSuggestion: vi.fn(), voteDateSuggestion: vi.fn(), createPlanSuggestion: vi.fn(), decidePlanSuggestion: vi.fn()
  };
});

function snapshot(role: "owner" | "co_owner" | "member" = "owner", status: "draft" | "finalized" = "draft"): ResyncSnapshot {
  return {
    current_user_id: "user-1",
    plan: { id: "plan-1", title: "Beach day", description: null, budget_cents: 5000, role, version: 4, planning_version: 8, status, starts_on: "2026-08-01T00:00:00Z", ends_on: null, max_drive_minutes: 45, vote_visibility: "public" },
    members: [
      { id: "pm-1", plan_id: "plan-1", user_id: "user-1", role: "owner", email: "owner@example.com", display_name: "Owner", created_at: "2026-01-01" },
      { id: "pm-2", plan_id: "plan-1", user_id: "user-2", role: "member", email: "member@example.com", display_name: "Member", created_at: "2026-01-01" }
    ],
    activities: [{ id: "activity-1", version: 3, name: "Kayaking", description: "On the bay", address: "Pier 1", location_name: "Pier 1", lat: null, lng: null, estimated_cost_cents: 2500, estimated_duration_minutes: 90, travel_mode: "car", tags: ["water"], notes: "Bring sunscreen", vote: null, yes_votes: 0, no_votes: 0, maybe_votes: 0 }],
    activity_scores: { "activity-1": { yes: 1, maybe: 0, no: 0 } }, votes: [],
    itinerary_items: [
      { id: "item-2", plan_id: "plan-1", activity_id: null, title: "Second", position_key: "2000", starts_at: null, ends_at: null, version: 2 },
      { id: "item-1", plan_id: "plan-1", activity_id: null, title: "First", position_key: "1000", starts_at: null, ends_at: null, version: 5 }
    ],
    expenses: [{ id: "expense-1", plan_id: "plan-1", paid_by_user_id: "user-1", description: "Lunch", amount_cents: 1001, status: "active", version: 6 }],
    expense_splits: [{ id: "split-1", expense_id: "expense-1", user_id: "user-1", amount_cents: 501, status: "active" }, { id: "split-2", expense_id: "expense-1", user_id: "user-2", amount_cents: 500, status: "active" }],
    ledger_entries: [], latest_plan_events: [], activity_comments: [], activity_suggestions: [], date_availability: [], date_suggestions: [], server_version: 4
  };
}

const defaultPlanningStatus: PlanningStatus = { overall_status: "needs_attention", readiness_state: "not_ready", plan_version: 4, planning_version: 8, blockers: [{ reason_code: "itinerary_item_unscheduled", entity_ids: ["item-1"], label: "Schedule First" }], warnings: [{ reason_code: "strong_candidate_not_in_itinerary", entity_ids: ["activity-1"], label: "Add Kayaking to itinerary" }], suggested_actions: [{ action_type: "schedule", reason_code: "itinerary_item_unscheduled", entity_ids: ["item-1"], label: "Schedule First" }, { action_type: "add_to_itinerary", reason_code: "strong_candidate_not_in_itinerary", entity_ids: ["activity-1"], label: "Add Kayaking to itinerary" }] };

async function renderPlan(next = snapshot(), recommendationRows: Awaited<ReturnType<typeof getRecommendations>> = [{ activity_id: "activity-1", activity_name: "Kayaking", rank: 1, total_score: 875, vote_score: 1000, budget_score: 1000, preference_score: 500, schedule_fit_score: 500, reasons: ["Strong group support", "Fits the current budget", "Schedule details unavailable", "No stored preferences yet"], score_version: 1, is_neutral: false }], status: PlanningStatus = defaultPlanningStatus) {
  vi.mocked(resyncPlan).mockResolvedValue(next);
  vi.mocked(getPlanBalances).mockResolvedValue([{ user_id: "user-1", balance_cents: 500 }, { user_id: "user-2", balance_cents: -500 }]);
  vi.mocked(getRecommendations).mockResolvedValue(recommendationRows);
  vi.mocked(getPlanningStatus).mockResolvedValue(status);
  render(<PlanPage />);
  await screen.findByRole("heading", { name: "Beach day" });
}

describe("Phase 1B.5 planning UI", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "operation-id") });
    vi.mocked(syncUser).mockResolvedValue({ id: "user-1", email: "owner@example.com", display_name: "Owner" });
    vi.mocked(getNotifications).mockResolvedValue({ notifications: [], unread_count: 0, offset: 0, limit: 25, has_more: false });
    vi.mocked(usePlanSocket).mockReturnValue({ connectionState: "restored", nextRetryMs: null, retry: vi.fn(), denyAuthentication: vi.fn(), denyAuthorization: vi.fn(), setPresenceContext: vi.fn() });
    vi.mocked(createInvite).mockResolvedValue({ token: "invite-token", plan_id: "plan-1" });
  });

  it("preserves authoritative load, connection status, owner role, and invite creation", async () => {
    await renderPlan();
    expect(syncUser).toHaveBeenCalledWith("app-jwt");
    expect(resyncPlan).toHaveBeenCalledWith("app-jwt", "plan-1");
    expect(screen.getAllByText("owner").length).toBeGreaterThan(0);
    expect(screen.getByText(/Connection restored/)).toBeTruthy();
    const balances = screen.getByRole("heading", { name: "Balances" }).closest("section")!;
    expect(balances.textContent).toContain("Owner$5.00");
    expect(balances.textContent).toContain("Member-$5.00");
    fireEvent.click(screen.getByRole("button", { name: "Create invite" }));
    await waitFor(() => expect(createInvite).toHaveBeenCalledWith("app-jwt", "plan-1"));
    await waitFor(() => expect(resyncPlan).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/invite-token/)).toBeTruthy();
  });

  it("keeps the single notification bell in the top-level plan header, separate from owner actions", async () => {
    await renderPlan();
    const bell = screen.getByRole("button", { name: "Notifications" });
    const workspaceHeader = document.querySelector("header.app-header");

    expect(workspaceHeader?.contains(bell)).toBe(true);
    expect(bell.closest(".header-notification-area")).not.toBeNull();
    expect(bell.closest(".plan-actions")).toBeNull();
    expect(document.querySelectorAll(".notification-entry")).toHaveLength(1);
    expect(document.querySelector(".plan-header")?.contains(bell)).toBe(false);
    fireEvent.click(bell);
    const panel = await screen.findByRole("dialog", { name: "Notifications" });
    expect(panel.parentElement).toBe(document.body);
    expect(document.querySelector(".plan-header")?.contains(panel)).toBe(false);
  });

  it("renders compact member-scoped presence and contextual editing indicators", async () => {
    await renderPlan();
    const socketOptions = vi.mocked(usePlanSocket).mock.calls.at(-1)?.[0];
    await act(async () => socketOptions?.onPresence?.([
      { user_id: "user-1", display_name: "Owner", avatar_emoji: "🧭", active_context: null, editing_entity_type: null, editing_entity_id: null },
      { user_id: "user-2", display_name: "Member", avatar_emoji: "🌲", active_context: "activity edit", editing_entity_type: "activity", editing_entity_id: "activity-1" }
    ]));
    expect(screen.getByRole("status", { name: "2 people here" })).toBeTruthy();
    expect(screen.getByLabelText("Member is editing")).toBeTruthy();
    await act(async () => socketOptions?.onPresence?.([]));
    expect(screen.queryByLabelText("Member is editing")).toBeNull();
  });

  it("renders deterministic ranked recommendations and refreshes them with the authoritative load", async () => {
    await renderPlan();
    expect(screen.getByRole("heading", { name: "Recommended activities" })).toBeTruthy();
    expect(screen.getByText("Ranked from your group’s votes, budget, and schedule.")).toBeTruthy();
    expect(await screen.findByText(/Fits budget/)).toBeTruthy();
    expect(screen.getAllByText("Kayaking")).toHaveLength(2);
    expect(screen.getAllByText("#1")).toHaveLength(1);
    expect(screen.getByText("88")).toBeTruthy();
    expect(screen.queryByText("875")).toBeNull();
    expect(screen.getByText(/Strong group support/)).toBeTruthy();
    expect(screen.queryByText("No stored preferences yet")).toBeNull();
    expect(screen.queryByText("Budget details unavailable")).toBeNull();
    expect(screen.queryByText("Schedule details unavailable")).toBeNull();
    expect(getRecommendations).toHaveBeenCalledWith("app-jwt", "plan-1");
    fireEvent.click(screen.getByRole("button", { name: "Vote yes" }));
    await waitFor(() => expect(getRecommendations).toHaveBeenCalledTimes(2));
  });

  it("renders planning status and routes its schedule action into the existing scheduling flow", async () => {
    await renderPlan();
    expect(screen.getByRole("heading", { name: "Planning status" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Schedule First" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Kayaking to itinerary" })).toBeTruthy();
    expect(getPlanningStatus).toHaveBeenCalledWith("app-jwt", "plan-1");
    fireEvent.click(screen.getAllByRole("button", { name: "Schedule First" })[0]);
    expect(await screen.findByRole("dialog", { name: "Schedule activity" })).toBeTruthy();
  });

  it("generates a fresh itinerary draft and keeps a stale review read-only", async () => {
    const fresh = { id: "run-1", plan_id: "plan-1", triggered_by_user_id: "user-1", run_type: "itinerary_draft", status: "completed" as const, draft_status: "fresh" as const, base_plan_version: 4, base_planning_version: 8, current_planning_version: 8, draft: { plan_id: "plan-1", base_planning_version: 8, generated_at: "2026-08-01T00:00:00Z", warnings: [], days: [{ date: "2026-08-01", items: [{ activity_id: "activity-1", title: "Kayaking", proposed_start_at: null, duration_minutes: 90, estimated_cost_cents: 2500, recommendation_rank: 1, reason_codes: ["recommendation_ranked"] }] }] }, validation_errors: [], created_at: "2026-08-01T00:00:00Z", completed_at: "2026-08-01T00:00:00Z", expires_at: null };
    vi.mocked(createPlanningRun).mockResolvedValue(fresh);
    await renderPlan();
    fireEvent.click(screen.getByRole("button", { name: "Generate suggested itinerary" }));
    await waitFor(() => expect(createPlanningRun).toHaveBeenCalledWith("app-jwt", "plan-1"));
    await waitFor(() => expect(screen.getAllByText("Kayaking").length).toBeGreaterThan(2));
    expect(screen.getByRole("button", { name: "Apply suggestion" })).toBeTruthy();

    vi.mocked(regeneratePlanningRun).mockResolvedValue({ ...fresh, draft_status: "stale", current_planning_version: 9 });
    fireEvent.click(screen.getByRole("button", { name: "Try another suggestion" }));
    await waitFor(() => expect(regeneratePlanningRun).toHaveBeenCalledWith("app-jwt", "plan-1", "run-1"));
    expect(await screen.findByText(/out of date because the plan changed/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply suggestion" })).toBeNull();
    expect(screen.getByRole("button", { name: "Review old suggestion" })).toBeTruthy();
  });

  it("renders ready and finalized planning-status states without fabricated issues", async () => {
    await renderPlan(snapshot(), undefined, { overall_status: "ready", readiness_state: "ready", plan_version: 4, planning_version: 8, blockers: [], warnings: [], suggested_actions: [{ action_type: "finalize_plan", reason_code: "ready_to_finalize", entity_ids: ["plan-1"], label: "Plan appears ready to finalize" }] });
    expect(screen.getByText("Plan is ready to finalize.")).toBeTruthy();
    expect(screen.getByText("No unresolved planning signals.")).toBeTruthy();
    cleanup();
    await renderPlan(snapshot("owner", "finalized"), undefined, { overall_status: "finalized", readiness_state: "finalized", plan_version: 4, planning_version: 8, blockers: [], warnings: [], suggested_actions: [] });
    expect(screen.getByText("This plan is finalized.")).toBeTruthy();
    expect(screen.queryByText("Blockers")).toBeNull();
    expect(screen.queryByText("Warnings")).toBeNull();
  });

  it("formats recommendation scores and keeps the authoritative ranking order", async () => {
    await renderPlan(snapshot(), [
      { activity_id: "activity-1", activity_name: "Top choice", rank: 1, total_score: 875, vote_score: 1000, budget_score: 1000, preference_score: 500, schedule_fit_score: 500, reasons: ["Strong group support", "Budget details unavailable", "No stored preferences yet"], score_version: 1, is_neutral: false },
      { activity_id: "activity-2", activity_name: "Second choice", rank: 2, total_score: 562, vote_score: 500, budget_score: 0, preference_score: 500, schedule_fit_score: 250, reasons: ["Group concerns", "Over the current budget", "Date availability is limited", "Schedule details unavailable", "No stored preferences yet"], score_version: 1, is_neutral: false }
    ]);
    expect(await screen.findByText(/Group concerns/)).toBeTruthy();
    const list = screen.getByRole("heading", { name: "Recommended activities" }).closest("section")!.querySelector(".recommendation-list")!;

    expect(within(list as HTMLElement).getAllByText(/^#\d+$/)).toHaveLength(2);
    expect(list.querySelector("ol")).toBeNull();
    expect(list.children[0].textContent).toContain("#1Top choice");
    expect(list.children[0].querySelector(".recommendation-title")?.children).toHaveLength(2);
    expect(list.children[1].textContent).toContain("#2Second choice");
    expect(screen.getByText("56")).toBeTruthy();
    expect(screen.queryByText("562")).toBeNull();
    expect(screen.getByText(/Does not fit budget/)).toBeTruthy();
    expect(screen.getByText(/Schedule availability is limited/)).toBeTruthy();
  });

  it("shows empty and insufficient-signal recommendation states", async () => {
    await renderPlan(snapshot(), []);
    expect(screen.getByText("Add activities to see ranked recommendations.")).toBeTruthy();
    cleanup();
    await renderPlan(snapshot(), [{ activity_id: "activity-1", activity_name: "Kayaking", rank: 1, total_score: 500, vote_score: 500, budget_score: 500, preference_score: 500, schedule_fit_score: 500, reasons: ["Limited voting data", "Budget details unavailable", "Schedule details unavailable", "No stored preferences yet"], score_version: 1, is_neutral: true }]);
    expect(await screen.findByText("Limited planning signals")).toBeTruthy();
    expect(screen.queryByText("Limited voting data")).toBeNull();
    expect(screen.queryByText("Budget details unavailable")).toBeNull();
    expect(screen.queryByText("Schedule details unavailable")).toBeNull();
    expect(screen.queryByText("No stored preferences yet")).toBeNull();
  });

  it("finalizes and unfinalizes with the authoritative plan version and resyncs", async () => {
    await renderPlan();
    fireEvent.click(screen.getByRole("button", { name: "Finalize plan" }));
    await waitFor(() => expect(setPlanLifecycle).toHaveBeenCalledWith("app-jwt", "plan-1", "finalize", 4));
    await waitFor(() => expect(resyncPlan).toHaveBeenCalledTimes(2));

    cleanup();
    vi.clearAllMocks();
    await renderPlan(snapshot("owner", "finalized"));
    expect(screen.getByText(/This plan is finalized/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Add activity" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "+ Add expense" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Unfinalize plan" }));
    await waitFor(() => expect(setPlanLifecycle).toHaveBeenCalledWith("app-jwt", "plan-1", "unfinalize", 4));
  });

  it("hides owner-only lifecycle and activity deletion from members", async () => {
    await renderPlan(snapshot("member"));
    expect(screen.queryByRole("button", { name: "Finalize plan" })).toBeNull();
    const activity = screen.getByRole("heading", { name: "Kayaking" }).closest("article")!;
    expect(within(activity).queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("saves integer-cent constraints and activity edits with current versions", async () => {
    await renderPlan();
    fireEvent.click(screen.getByRole("button", { name: /Budget.*Open editor/ }));
    fireEvent.change(screen.getByLabelText("Budget (USD)"), { target: { value: "10.05" } });
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    await waitFor(() => expect(patchPlan).toHaveBeenCalledWith("app-jwt", "plan-1", expect.objectContaining({ expected_version: 4, budget_cents: 1005 })));
    expect(vi.mocked(patchPlan).mock.calls[0][2]).not.toHaveProperty("max_drive_minutes");

    const activity = screen.getByRole("heading", { name: "Kayaking" }).closest("article")!;
    fireEvent.click(within(activity).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(activity).getByLabelText("Name"), { target: { value: "Sea kayaking" } });
    fireEvent.click(within(activity).getByRole("button", { name: "Save activity" }));
    await waitFor(() => expect(patchActivity).toHaveBeenCalledWith("app-jwt", "plan-1", "activity-1", expect.objectContaining({ expected_version: 3, name: "Sea kayaking", estimated_cost_cents: 2500, estimated_duration_minutes: 90 })));
    expect(resyncPlan).toHaveBeenCalledTimes(3);
  });

  it("edits an activity with a blank optional cost, converts duration fields, and reports validation errors", async () => {
    const next = snapshot(); next.activities[0].estimated_cost_cents = null; next.activities[0].estimated_duration_minutes = 125;
    await renderPlan(next);
    const activity = screen.getByRole("heading", { name: "Kayaking" }).closest("article")!;
    fireEvent.click(within(activity).getByRole("button", { name: "Edit" }));
    const form = within(activity).getByRole("button", { name: "Save activity" }).closest("form")!;
    expect((within(form).getAllByLabelText("Hours")[0] as HTMLInputElement).value).toBe("2");
    expect((within(form).getAllByLabelText("Minutes")[0] as HTMLInputElement).value).toBe("5");
    fireEvent.change(within(form).getAllByLabelText("Hours")[0], { target: { value: "3" } });
    fireEvent.change(within(form).getAllByLabelText("Minutes")[0], { target: { value: "15" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save activity" }));
    await waitFor(() => expect(patchActivity).toHaveBeenCalledWith("app-jwt", "plan-1", "activity-1", expect.objectContaining({ estimated_cost_cents: null, estimated_duration_minutes: 195 })));

    fireEvent.click(within(activity).getByRole("button", { name: "Edit" }));
    const invalidForm = within(activity).getByRole("button", { name: "Save activity" }).closest("form")!;
    fireEvent.change(within(invalidForm).getAllByLabelText("Minutes")[0], { target: { value: "60" } });
    fireEvent.click(within(invalidForm).getByRole("button", { name: "Save activity" }));
    expect(await screen.findByText(/positive duration with minutes from 0 to 59/)).toBeTruthy();
  });

  it("deletes an activity with its current version and performs authoritative resync", async () => {
    await renderPlan();
    const activity = screen.getByRole("heading", { name: "Kayaking" }).closest("article")!;
    fireEvent.click(within(activity).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteActivity).toHaveBeenCalledWith("app-jwt", "plan-1", "activity-1", 3));
    await waitFor(() => expect(resyncPlan).toHaveBeenCalledTimes(2));
  });

  it("opens the add-to-itinerary scheduling modal and cancels without a mutation", async () => {
    await renderPlan();
    const activity = screen.getByRole("heading", { name: "Kayaking" }).closest("article")!;
    fireEvent.click(within(activity).getByRole("button", { name: "Add to itinerary" }));
    const dialog = screen.getByRole("dialog", { name: "Add to itinerary" });
    expect(within(dialog).getByLabelText("Schedule date")).toBeTruthy();
    expect(within(dialog).getByLabelText("Start time")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Add & schedule" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Schedule date"), { target: { value: "2026-08-01" } });
    expect(within(dialog).getByRole("button", { name: "Add & schedule" }).hasAttribute("disabled")).toBe(true);
    expect(createItineraryItem).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add to itinerary" })).toBeNull());
    expect(createItineraryItem).not.toHaveBeenCalled();
    expect(getRecommendations).toHaveBeenCalledTimes(1);
  });

  it("adds and schedules an activity through the existing itinerary mutation and authoritative refresh", async () => {
    const refreshed = snapshot();
    refreshed.itinerary_items[0] = { ...refreshed.itinerary_items[0], activity_id: "activity-1", title: "Kayaking", starts_at: "2026-08-01T18:30:00.000Z" };
    await renderPlan();
    const activity = screen.getByRole("heading", { name: "Kayaking" }).closest("article")!;
    fireEvent.click(within(activity).getByRole("button", { name: "Add to itinerary" }));
    const dialog = screen.getByRole("dialog", { name: "Add to itinerary" });
    fireEvent.change(within(dialog).getByLabelText("Schedule date"), { target: { value: "2026-08-01" } });
    fireEvent.change(within(dialog).getByLabelText("Start time"), { target: { value: "18:30" } });
    vi.mocked(resyncPlan).mockResolvedValue(refreshed);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add & schedule" }));
    await waitFor(() => expect(createItineraryItem).toHaveBeenCalledWith("app-jwt", "plan-1", {
      title: "Kayaking", activity_id: "activity-1", starts_at: "2026-08-01T18:30:00.000Z", client_operation_id: "operation-id"
    }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add to itinerary" })).toBeNull());
    expect(screen.getByLabelText(/Saturday, August 1, 2026:.*Scheduled: Kayaking/)).toBeTruthy();
  });

  it("adds an activity unscheduled when Schedule later is selected and keeps it off the calendar", async () => {
    const refreshed = snapshot();
    refreshed.itinerary_items[0] = { ...refreshed.itinerary_items[0], activity_id: "activity-1", title: "Kayaking", starts_at: null };
    await renderPlan();
    const activity = screen.getByRole("heading", { name: "Kayaking" }).closest("article")!;
    fireEvent.click(within(activity).getByRole("button", { name: "Add to itinerary" }));
    vi.mocked(resyncPlan).mockResolvedValue(refreshed);
    fireEvent.click(screen.getByRole("button", { name: "Schedule later" }));
    await waitFor(() => expect(createItineraryItem).toHaveBeenCalledWith("app-jwt", "plan-1", {
      title: "Kayaking", activity_id: "activity-1", client_operation_id: "operation-id"
    }));
    await waitFor(() => expect(within(screen.getByRole("heading", { name: "Kayaking" }).closest("article")!).getByRole("button", { name: "Schedule" })).toBeTruthy());
    expect(screen.queryByLabelText(/Scheduled: Kayaking/)).toBeNull();
  });

  it("uses the portal modal safely on a narrow viewport and ignores a duplicate schedule submit", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    const refreshed = snapshot();
    refreshed.itinerary_items[0] = { ...refreshed.itinerary_items[0], activity_id: "activity-1", title: "Kayaking", starts_at: "2026-08-01T18:30:00.000Z" };
    await renderPlan();
    const activity = screen.getByRole("heading", { name: "Kayaking" }).closest("article")!;
    fireEvent.click(within(activity).getByRole("button", { name: "Add to itinerary" }));
    const dialog = screen.getByRole("dialog", { name: "Add to itinerary" });
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    fireEvent.change(within(dialog).getByLabelText("Schedule date"), { target: { value: "2026-08-01" } });
    fireEvent.change(within(dialog).getByLabelText("Start time"), { target: { value: "18:30" } });
    vi.mocked(resyncPlan).mockResolvedValue(refreshed);
    const submit = within(dialog).getByRole("button", { name: "Add & schedule" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(createItineraryItem).toHaveBeenCalledTimes(1));
  });

  it("schedules an existing unscheduled itinerary item without creating a duplicate and labels scheduled items", async () => {
    const unscheduled = snapshot();
    unscheduled.itinerary_items[0] = { ...unscheduled.itinerary_items[0], activity_id: "activity-1", title: "Kayaking", starts_at: null, version: 2 };
    await renderPlan(unscheduled);
    const activity = screen.getByRole("heading", { name: "Kayaking" }).closest("article")!;
    fireEvent.click(within(activity).getByRole("button", { name: "Schedule" }));
    const dialog = screen.getByRole("dialog", { name: "Schedule activity" });
    fireEvent.change(within(dialog).getByLabelText("Schedule date"), { target: { value: "2026-08-01" } });
    fireEvent.change(within(dialog).getByLabelText("Start time"), { target: { value: "09:15" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save schedule" }));
    await waitFor(() => expect(patchItineraryItem).toHaveBeenCalledWith("app-jwt", "plan-1", "item-2", { starts_at: "2026-08-01T09:15:00.000Z", expected_version: 2 }));
    expect(createItineraryItem).not.toHaveBeenCalled();

    cleanup();
    const scheduled = snapshot();
    scheduled.itinerary_items[0] = { ...scheduled.itinerary_items[0], activity_id: "activity-1", title: "Kayaking", starts_at: "2026-08-01T09:15:00.000Z" };
    await renderPlan(scheduled);
    const scheduledActivity = screen.getByRole("heading", { name: "Kayaking" }).closest("article")!;
    expect(within(scheduledActivity).getByRole("button", { name: "Scheduled" }).hasAttribute("disabled")).toBe(true);
    expect(within(scheduledActivity).queryByRole("button", { name: "Schedule" })).toBeNull();
  });

  it("orders itinerary items and sends current versions and neighbor contracts", async () => {
    await renderPlan();
    fireEvent.click(screen.getByRole("button", { name: "+ Add itinerary stop" }));
    fireEvent.change(screen.getByLabelText("Itinerary item"), { target: { value: "Third" } });
    fireEvent.click(screen.getByRole("button", { name: "Add stop" }));
    await waitFor(() => expect(createItineraryItem).toHaveBeenCalledWith("app-jwt", "plan-1", { title: "Third", client_operation_id: "operation-id" }));
    const itineraryView = document.getElementById("itinerary-day-view")!;
    const first = within(itineraryView).getByText("First"); const second = within(itineraryView).getByText("Second");
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const secondArticle = second.closest("article")!;
    fireEvent.click(within(secondArticle).getByRole("button", { name: "Move up" }));
    await waitFor(() => expect(reorderItineraryItem).toHaveBeenCalledWith("app-jwt", "plan-1", "item-2", { expected_version: 2, previous_item_id: undefined, next_item_id: "item-1" }));
    const refreshedSecond = within(itineraryView).getByText("Second").closest("article")!;
    fireEvent.click(within(refreshedSecond).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(refreshedSecond).getByLabelText("Title"), { target: { value: "Moved second" } });
    fireEvent.click(within(refreshedSecond).getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(patchItineraryItem).toHaveBeenCalledWith("app-jwt", "plan-1", "item-2", { title: "Moved second", starts_at: null, expected_version: 2 }));
    fireEvent.click(within(within(itineraryView).getByText("Second").closest("article")!).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteItineraryItem).toHaveBeenCalledWith("app-jwt", "plan-1", "item-2", 2));
  });

  it("renders itinerary descriptions separately from human-readable UTC schedule metadata", async () => {
    const next = snapshot();
    next.itinerary_items = [
      { ...next.itinerary_items[1], activity_id: "activity-1", title: "Kayaking", starts_at: "2026-08-01T09:15:00.000Z" },
      { ...next.itinerary_items[0], title: "Open afternoon", starts_at: null }
    ];
    await renderPlan(next);

    const itinerarySection = screen.getByRole("heading", { name: "Your itinerary" }).closest("section")!;
    const scheduledStop = within(itinerarySection).getByText("Kayaking").closest("article")!;
    expect(within(scheduledStop).getByText("On the bay")).toBeTruthy();
    expect(within(scheduledStop).getByText("9:15 AM")).toBeTruthy();
    expect(within(scheduledStop).getByText("Sat, Aug 1 · 9:15 AM")).toBeTruthy();
    expect(within(scheduledStop).queryByText(/Scheduled 2026-08-01/)).toBeNull();

    const unscheduledStop = within(itinerarySection).getByText("Open afternoon").closest("article")!;
    expect(within(unscheduledStop).getByText("Time TBD")).toBeTruthy();
    expect(within(unscheduledStop).getByText("No description")).toBeTruthy();
    expect(within(unscheduledStop).getByRole("button", { name: "Schedule" })).toBeTruthy();
    expect(itinerarySection.querySelector(".itinerary-composer")).toBeNull();
    fireEvent.click(within(itinerarySection).getByRole("button", { name: "+ Add itinerary stop" }));
    expect(itinerarySection.querySelector(".itinerary-composer")).toBeTruthy();
    expect(itinerarySection.querySelector(".itinerary-row.is-scheduled")).toBeTruthy();
    expect(itinerarySection.querySelector(".itinerary-row.is-unscheduled")).toBeTruthy();
  });

  it("groups the itinerary by authoritative UTC day and keeps unscheduled stops separate", async () => {
    const next = snapshot();
    next.itinerary_items = [
      { ...next.itinerary_items[1], id: "same-day-late", title: "Late same day", starts_at: "2026-08-01T18:30:00.000Z", position_key: "1000" },
      { ...next.itinerary_items[0], id: "same-day-early", title: "Early same day", starts_at: "2026-08-01T09:15:00.000Z", position_key: "2000" },
      { ...next.itinerary_items[0], id: "next-day", title: "Next day", starts_at: "2026-08-02T00:15:00.000Z", position_key: "3000" },
      { ...next.itinerary_items[1], id: "tbd", title: "TBD stop", starts_at: null, position_key: "4000" }
    ];
    await renderPlan(next);

    const itinerary = document.getElementById("itinerary-day-view")!;
    const groups = itinerary.querySelectorAll(".itinerary-day-group");
    expect(groups).toHaveLength(3);
    expect(within(groups[0] as HTMLElement).getByText("Day 1")).toBeTruthy();
    expect(within(groups[0] as HTMLElement).getByText("Saturday, August 1")).toBeTruthy();
    expect(within(groups[0] as HTMLElement).getByText("Early same day").compareDocumentPosition(within(groups[0] as HTMLElement).getByText("Late same day")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(groups[1] as HTMLElement).getByText("Sunday, August 2")).toBeTruthy();
    expect(within(groups[2] as HTMLElement).getByText("Unscheduled")).toBeTruthy();
    expect(within(groups[2] as HTMLElement).getByText("Time TBD")).toBeTruthy();
    expect(itinerary.querySelector(".itinerary-day-timeline")).toBeTruthy();
  });

  it("keeps near-midnight starts in their exact UTC days across a year boundary", async () => {
    const next = snapshot();
    next.itinerary_items = [
      { ...next.itinerary_items[0], id: "dec-31", title: "New Year's Eve dinner", starts_at: "2026-12-31T23:55:00.000Z", position_key: "1000" },
      { ...next.itinerary_items[1], id: "jan-1", title: "New Year's Day walk", starts_at: "2027-01-01T00:05:00.000Z", position_key: "2000" }
    ];
    await renderPlan(next);

    const groups = document.getElementById("itinerary-day-view")!.querySelectorAll(".itinerary-day-group");
    expect(groups).toHaveLength(2);
    expect(within(groups[0] as HTMLElement).getByText("Thursday, December 31")).toBeTruthy();
    expect(within(groups[1] as HTMLElement).getByText("Friday, January 1")).toBeTruthy();
    expect(within(groups[0] as HTMLElement).getByText("New Year's Eve dinner")).toBeTruthy();
    expect(within(groups[1] as HTMLElement).getByText("New Year's Day walk")).toBeTruthy();
  });

  it("uses distinct candidate and committed trip-idea card states", async () => {
    const next = snapshot();
    next.activities.push({ ...next.activities[0], id: "activity-2", name: "Museum", version: 1 });
    next.itinerary_items[0] = { ...next.itinerary_items[0], activity_id: "activity-2", title: "Museum" };
    await renderPlan(next);
    const candidate = screen.getByRole("heading", { name: "Kayaking" }).closest("article")!;
    const committed = screen.getByRole("heading", { name: "Museum" }).closest("article")!;
    expect(candidate.classList.contains("activity-card-not-in-itinerary")).toBe(true);
    expect(committed.classList.contains("activity-card-in-itinerary")).toBe(true);
    expect(committed.querySelector(".activity-itinerary-state")).toBeTruthy();
    expect(within(candidate).getByRole("button", { name: "Add to itinerary" })).toBeTruthy();
    expect(within(committed).getByRole("button", { name: "Schedule" })).toBeTruthy();
  });

  it("creates, edits, and deletes expenses with cents, participants, versions, and idempotency", async () => {
    await renderPlan();
    fireEvent.click(screen.getByRole("button", { name: "+ Add expense" }));
    const createForm = screen.getByRole("button", { name: "Save expense" }).closest("form")!;
    fireEvent.change(within(createForm).getByLabelText("Description"), { target: { value: "Dinner" } });
    fireEvent.change(within(createForm).getByLabelText("Amount"), { target: { value: "10.05" } });
    fireEvent.click(within(createForm).getByRole("button", { name: "Save expense" }));
    await waitFor(() => expect(createExpense).toHaveBeenCalledWith("app-jwt", "plan-1", expect.objectContaining({ description: "Dinner", amount_cents: 1005, paid_by_user_id: "user-1", participant_user_ids: ["user-1", "user-2"], client_operation_id: "operation-id" })));

    const expense = screen.getByRole("heading", { name: /Lunch/ }).closest("article")!;
    fireEvent.click(within(expense).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(expense).getByLabelText("Amount"), { target: { value: "12.34" } });
    fireEvent.click(within(expense).getByRole("button", { name: "Save expense" }));
    await waitFor(() => expect(patchExpense).toHaveBeenCalledWith("app-jwt", "plan-1", "expense-1", expect.objectContaining({ amount_cents: 1234, expected_version: 6, client_operation_id: "operation-id" })));
    fireEvent.click(within(screen.getByRole("heading", { name: /Lunch/ }).closest("article")!).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteExpense).toHaveBeenCalledWith("app-jwt", "plan-1", "expense-1", 6, "operation-id"));
  });

  it("restores authoritative state and reports stale optimistic-concurrency conflicts", async () => {
    vi.mocked(patchPlan).mockRejectedValue(new ApiError(409, { detail: { error: "version_conflict" } }));
    await renderPlan();
    fireEvent.click(screen.getByRole("button", { name: /Budget.*Open editor/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    expect(await screen.findByText("This plan changed since you loaded it. The latest state has been restored.")).toBeTruthy();
    expect(resyncPlan).toHaveBeenCalledTimes(2);
  });

  it("preserves terminal authentication and authorization UI", async () => {
    await renderPlan();
    const callbacks = vi.mocked(usePlanSocket).mock.calls[0][0];
    act(() => callbacks.onAuthFailure());
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy();

    cleanup();
    await renderPlan();
    const authorizationCallbacks = vi.mocked(usePlanSocket).mock.calls.at(-1)![0];
    act(() => authorizationCallbacks.onAuthorizationFailure?.());
    expect(screen.getByText("You do not have access to this plan.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("Phase 1B.75 member directory enforces owner co-owner and member controls", async () => {
    const owner = snapshot();
    owner.members.push({ id: "pm-3", plan_id: "plan-1", user_id: "user-3", role: "co_owner", display_name: "Co Owner", created_at: "2026-02-03" });
    await renderPlan(owner);
    fireEvent.click(screen.getByRole("button", { name: /Trip members/ }));
    expect(within(screen.getByRole("dialog", { name: "Trip Members" })).getByText("Co Owner").closest("article")?.textContent).toContain("co-owner");
    expect(screen.queryByText(/Joined Feb 3, 2026/)).toBeNull();
    expect(screen.getAllByRole("button", { name: "Demote to member" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Remove from trip" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Promote to co-owner" }));
    await waitFor(() => expect(changeMemberRole).toHaveBeenCalledWith("app-jwt", "plan-1", "user-2", "co_owner", "operation-id"));
    expect(resyncPlan).toHaveBeenCalledTimes(2);

    cleanup();
    const coOwner = snapshot("co_owner"); coOwner.current_user_id = "user-3"; coOwner.members.push({ id: "pm-3", plan_id: "plan-1", user_id: "user-3", role: "co_owner", display_name: "Co Owner", created_at: "2026-02-03" });
    await renderPlan(coOwner);
    fireEvent.click(screen.getByRole("button", { name: /Trip members/ }));
    expect(screen.queryByRole("button", { name: "Promote to co-owner" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Remove from trip" })).toHaveLength(1);

    cleanup(); await renderPlan(snapshot("member"));
    fireEvent.click(screen.getByRole("button", { name: /Trip members/ }));
    expect(screen.queryByRole("button", { name: "Promote to co-owner" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove from trip" })).toBeNull();
  });

  it("renders the Trip Members dialog in document.body with a fixed overlay, internal scrolling, and usable close controls", async () => {
    const owner = snapshot();
    for (let index = 3; index < 36; index += 1) owner.members.push({ id: `pm-${index}`, plan_id: "plan-1", user_id: `user-${index}`, role: "member", display_name: `Member ${index}`, created_at: "2026-02-03" });
    await renderPlan(owner);
    const trigger = screen.getByRole("button", { name: /Trip members/ });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Trip Members" });
    const overlay = dialog.parentElement!;
    expect(overlay.parentElement).toBe(document.body);
    expect(overlay.className).toContain("trip-members-overlay");
    expect(dialog.className).toContain("trip-members-popover");
    expect(dialog.querySelector(".trip-members-list")?.textContent).toContain("Member 35");
    expect(document.body.style.overflow).toBe("hidden");
    const styles = readFileSync("src/app/globals.css", "utf8");
    expect(styles).toContain(".trip-members-overlay { position: fixed;");
    expect(styles).toContain("inset: 0;");
    expect(styles).toContain(".trip-members-list { display: grid; gap: 4px; min-height: 0; overflow: auto;");
    expect(styles).toContain("max-height: calc(100dvh - 24px)");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Trip Members" })).toBeNull());
    expect(document.body.style.overflow).toBe("");

    fireEvent.click(trigger);
    fireEvent.mouseDown(screen.getByRole("dialog", { name: "Trip Members" }).parentElement!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Trip Members" })).toBeNull());
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Close trip members" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Trip Members" })).toBeNull());
  });

  it("Phase 1B.75 public and anonymous votes render privacy-safe identities and totals", async () => {
    const publicSnapshot = snapshot();
    publicSnapshot.votes = [{ activity_id: "activity-1", user_id: "user-2", vote: "yes" }];
    publicSnapshot.activities[0].yes_votes = 1;
    await renderPlan(publicSnapshot);
    expect(screen.getByText("Votes: Member (yes)")).toBeTruthy();
    cleanup();
    const anonymous = snapshot("member"); anonymous.plan.vote_visibility = "anonymous"; anonymous.activities[0].current_user_vote = "yes"; anonymous.activity_scores["activity-1"].yes = 2; anonymous.votes = [];
    await renderPlan(anonymous);
    expect(screen.getByRole("heading", { name: "Kayaking" }).closest("article")?.textContent).toContain("2 yes");
    expect(screen.getByText(/Votes are anonymous/)).toBeTruthy();
    expect(screen.queryByText(/Member \(yes\)/)).toBeNull();
    expect(screen.getByRole("button", { name: "Vote yes" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("renders compact accessible vote controls and keeps travel mode out of activity mutations", async () => {
    await renderPlan();
    fireEvent.click(screen.getByRole("button", { name: "+ Add activity" }));
    const createForm = screen.getByRole("button", { name: "Save activity" }).closest("form")!;
    fireEvent.change(within(createForm).getByLabelText("Name"), { target: { value: "Gallery" } });
    fireEvent.change(within(createForm).getByLabelText("Hours"), { target: { value: "1" } });
    fireEvent.change(within(createForm).getByLabelText("Minutes"), { target: { value: "30" } });
    fireEvent.click(within(createForm).getByRole("button", { name: "Save activity" }));
    await waitFor(() => expect(createActivity).toHaveBeenCalledWith("app-jwt", "plan-1", expect.objectContaining({ name: "Gallery", estimated_duration_minutes: 90 })));
    expect(vi.mocked(createActivity).mock.calls[0][2]).not.toHaveProperty("travel_mode");
    expect(screen.getByRole("button", { name: "Vote yes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Vote maybe" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Vote no" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Vote maybe" }));
    await waitFor(() => expect(voteActivity).toHaveBeenCalledWith("app-jwt", "plan-1", "activity-1", "maybe"));
    const activity = screen.getByRole("heading", { name: "Kayaking" }).closest("article")!;
    fireEvent.click(within(activity).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(activity).getByRole("button", { name: "Save activity" }));
    await waitFor(() => expect(patchActivity).toHaveBeenCalled());
    expect(vi.mocked(patchActivity).mock.calls.at(-1)?.[3]).not.toHaveProperty("travel_mode");
  });

  it("Phase 1B.75 comments suggestions and date coordination use operation IDs and resync", async () => {
    const next = snapshot();
    next.activity_comments = [{ id: "comment-1", activity_id: "activity-1", author_id: "user-2", author_display_name: "Member", body: "Great idea", version: 1, deleted_at: null, created_at: "2026-01-01", updated_at: "2026-01-01" }];
    next.activity_suggestions = [{ id: "suggestion-1", activity_id: "activity-1", author_id: "user-2", author_display_name: "Member", suggestion_type: "notes", proposed_changes_json: { notes: "New" }, message: "Change notes", status: "open", created_at: "2026-01-01" }];
    next.date_suggestions = [{ id: "date-1", starts_on: "2026-07-18", ends_on: "2026-07-21", message: null, status: "open", author_id: "user-2", author_display_name: "Tris", yes_votes: 0, maybe_votes: 0, no_votes: 0, current_user_vote: null }];
    await renderPlan(next);
    fireEvent.click(screen.getByText(/Discussion/));
    expect(screen.getByText("Great idea")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Another" } }); fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await waitFor(() => expect(createComment).toHaveBeenCalledWith("app-jwt", "plan-1", "activity-1", "Another", "operation-id"));
    const activityCard = screen.getByRole("heading", { name: "Kayaking" }).closest("article")!;
    fireEvent.click(within(activityCard).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(decideActivitySuggestion).toHaveBeenCalledWith("app-jwt", "plan-1", "activity-1", "suggestion-1", "accept", 3, "operation-id"));
    fireEvent.click(screen.getByRole("button", { name: /Date window.*Open editor/ }));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-07-18" } }); fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
    await waitFor(() => expect(upsertDateAvailability).toHaveBeenCalled());
    expect(screen.getByText(/Jul 18, 2026 – Jul 21, 2026/)).toBeTruthy();
    const dateOption = screen.getByText(/Jul 18, 2026 – Jul 21, 2026/).closest("article")!;
    fireEvent.click(within(dateOption).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(decideDateSuggestion).toHaveBeenCalledWith("app-jwt", "plan-1", "date-1", "dismiss", 4, "operation-id"));
    expect(vi.mocked(resyncPlan).mock.calls.length).toBeGreaterThan(1);
  });

  it("renders one compact Travel-window poll in the support column while preserving every date action", async () => {
    const next = snapshot();
    next.date_suggestions = [{ id: "date-1", starts_on: "2026-07-18", ends_on: "2026-07-21", message: null, status: "open", author_id: "user-2", author_display_name: "Tris", yes_votes: 2, maybe_votes: 1, no_votes: 0, current_user_vote: null }];
    await renderPlan(next);

    const sidebar = document.querySelector("aside.journey-sidebar")!;
    const primary = document.querySelector(".planning-primary")!;
    const poll = document.getElementById("travel-window-poll")!;
    expect(sidebar.contains(poll)).toBe(true);
    expect(primary.contains(poll)).toBe(false);
    expect(document.querySelectorAll("#travel-window-poll")).toHaveLength(1);
    expect(sidebar.contains(screen.getByRole("heading", { name: "Planning status" }))).toBe(true);
    expect(sidebar.contains(screen.getByRole("heading", { name: "Recommended activities" }))).toBe(true);
    expect(within(poll).getByText("1 open option")).toBeTruthy();
    expect(within(poll).getByText("Jul 18, 2026 – Jul 21, 2026")).toBeTruthy();
    expect(within(poll).getByText("Suggested by Tris")).toBeTruthy();
    expect(poll.querySelector(".travel-window-option")?.classList.contains("travel-window-option")).toBe(true);
    expect(poll.querySelector(".poll-votes")?.querySelectorAll(".vote-button")).toHaveLength(3);

    fireEvent.click(within(poll).getByRole("button", { name: "+ Suggest new date" }));
    expect(await screen.findByRole("dialog", { name: "Date Window" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Date Window" }));

    fireEvent.click(within(poll).getByRole("button", { name: "Vote yes for Jul 18, 2026" }));
    await waitFor(() => expect(voteDateSuggestion).toHaveBeenCalledWith("app-jwt", "plan-1", "date-1", "yes", "operation-id"));
    fireEvent.click(within(poll).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(decideDateSuggestion).toHaveBeenCalledWith("app-jwt", "plan-1", "date-1", "accept", 4, "operation-id"));
    fireEvent.click(within(poll).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(decideDateSuggestion).toHaveBeenCalledWith("app-jwt", "plan-1", "date-1", "dismiss", 4, "operation-id"));
    fireEvent.click(within(poll).getByRole("button", { name: "Remove option" }));
    await waitFor(() => expect(archiveDateSuggestion).toHaveBeenCalledWith("app-jwt", "plan-1", "date-1", "operation-id"));

    const toggle = within(poll).getByRole("button", { name: "Collapse Travel-window poll" });
    fireEvent.click(toggle);
    expect(document.getElementById("travel-window-poll-content")?.hidden).toBe(true);
    expect(within(poll).getByRole("button", { name: "+ Suggest new date" })).toBeTruthy();
    fireEvent.click(within(poll).getByRole("button", { name: "Expand Travel-window poll" }));
    expect(document.getElementById("travel-window-poll-content")?.hidden).toBe(false);

    const css = readFileSync("src/app/plans/[planId]/page.module.css", "utf8");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) minmax(340px, .5fr)");
    expect(css).toContain(".poll-votes .vote-button) { display: inline-flex");
    expect(css).toContain("@media (max-width: 1160px)");
    expect(css).toContain(".journey-sidebar) { grid-template-columns: 1fr;");
    expect(css).toContain("@media (max-width: 420px)");
  });

  it("edits plan-level travel metadata in integer minutes and keeps members read-only", async () => {
    const owner = snapshot();
    owner.plan.travel_mode = "train";
    owner.plan.travel_duration_minutes = 125;
    owner.plan.travel_notes = "Meet at the station";
    await renderPlan(owner);
    fireEvent.click(screen.getByRole("button", { name: /Travel duration.*Open editor/ }));
    expect((screen.getByLabelText("Travel hours") as HTMLInputElement).value).toBe("2");
    expect((screen.getByLabelText("Travel minutes") as HTMLInputElement).value).toBe("5");
    fireEvent.change(screen.getByLabelText("Travel hours"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Travel minutes"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save duration" }));
    await waitFor(() => expect(patchPlan).toHaveBeenCalledWith("app-jwt", "plan-1", expect.objectContaining({ travel_duration_minutes: 200 })));
    await waitFor(() => expect(resyncPlan).toHaveBeenCalledTimes(2));

    cleanup();
    await renderPlan(snapshot("member"));
    fireEvent.click(screen.getByRole("button", { name: /Trip notes.*Open editor/ }));
    expect(screen.getByText("No trip notes yet.")).toBeTruthy();
  });

  it("keeps Trip Notes tiles compact and opens full long notes with role permissions", async () => {
    const longNotes = "Long trip note ".repeat(100);
    const css = readFileSync("src/app/globals.css", "utf8");
    expect(css).toContain("grid-auto-rows: 112px");
    expect(css).toContain("grid-auto-rows: 98px");
    expect(css).toContain(".stat { position: relative; height: 100%; min-height: 0;");
    const owner = snapshot();
    owner.plan.travel_notes = longNotes;
    await renderPlan(owner);
    const tile = screen.getByRole("button", { name: /Trip notes.*View notes.*Open editor/ });
    expect(tile.textContent).not.toContain(longNotes);
    expect(tile.textContent).toContain("View notes");
    fireEvent.click(tile);
    const editor = screen.getByRole("dialog", { name: "Trip Notes" });
    expect((within(editor).getByLabelText("Trip notes") as HTMLTextAreaElement).value).toBe(longNotes);
    expect(within(editor).getByRole("button", { name: "Save trip notes" })).toBeTruthy();

    cleanup();
    const member = snapshot("member");
    member.plan.travel_notes = longNotes;
    await renderPlan(member);
    fireEvent.click(screen.getByRole("button", { name: /Trip notes.*View notes.*Open editor/ }));
    const viewer = screen.getByRole("dialog", { name: "Trip Notes" });
    expect(viewer.querySelector(".trip-notes-full")?.textContent).toBe(longNotes);
    expect(within(viewer).queryByRole("button", { name: "Save trip notes" })).toBeNull();
  });

  it("shows Add notes for an empty compact Trip Notes tile", async () => {
    await renderPlan();
    expect(screen.getByRole("button", { name: /Trip notes.*Add notes.*Open editor/ })).toBeTruthy();
  });

  it("keeps native discussion disclosure accessible and resyncs travel-window votes", async () => {
    const next = snapshot();
    next.activity_comments = [{ id: "comment-1", activity_id: "activity-1", author_id: "user-2", author_display_name: "Member", body: "Great idea", version: 1, deleted_at: null, created_at: "2026-01-01", updated_at: "2026-01-01" }];
    next.date_suggestions = [
      { id: "date-later", starts_on: "2026-08-20", ends_on: "2026-08-22", message: null, status: "open", author_id: "user-2", author_display_name: "Member", yes_votes: 1, maybe_votes: 0, no_votes: 0, current_user_vote: null, created_at: "2026-01-02" },
      { id: "date-leading", starts_on: "2026-08-23", ends_on: "2026-08-25", message: null, status: "accepted", author_id: "user-2", author_display_name: "Member", yes_votes: 2, maybe_votes: 0, no_votes: 0, current_user_vote: "yes", created_at: "2026-01-03" }
    ];
    await renderPlan(next);
    const disclosure = screen.getByText(/Discussion \(1\)/).closest("details")!;
    expect(disclosure.open).toBe(false);
    fireEvent.click(screen.getByText(/Discussion \(1\)/));
    expect(disclosure.open).toBe(true);
    expect(screen.getByText("Great idea")).toBeTruthy();
    const open = screen.getAllByText(/Aug 20, 2026/).find((element) => element.tagName === "STRONG")!.closest("article")!;
    fireEvent.click(within(open).getByRole("button", { name: /Vote maybe/ }));
    await waitFor(() => expect(voteDateSuggestion).toHaveBeenCalledWith("app-jwt", "plan-1", "date-later", "maybe", "operation-id"));
    await waitFor(() => expect(resyncPlan).toHaveBeenCalledTimes(2));
  });

  it("restores the visible suggest-new-date entry point and submits through the existing date suggestion flow", async () => {
    await renderPlan();

    const poll = screen.getByRole("heading", { name: "Travel-window poll" }).closest("section")!;
    expect(poll.closest(".journey-sidebar")).not.toBeNull();
    expect(poll.closest(".planning-primary")).toBeNull();
    fireEvent.click(within(poll).getByRole("button", { name: "+ Suggest new date" }));

    const dialog = screen.getByRole("dialog", { name: "Date Window" });
    fireEvent.change(within(dialog).getByLabelText("Suggested start"), { target: { value: "2026-09-10" } });
    fireEvent.change(within(dialog).getByLabelText("Suggested end"), { target: { value: "2026-09-14" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Suggest new date" }));

    await waitFor(() => expect(createDateSuggestion).toHaveBeenCalledWith("app-jwt", "plan-1", "2026-09-10", "2026-09-14", "operation-id"));
  });

  it("reviews and adopts whole-plan ideas without hiding preserved plan surfaces", async () => {
    const next = snapshot();
    next.plan_suggestions = [{ id: "plan-idea", title: "Mountain weekend", description: "Cooler air", starts_on: null, ends_on: null, budget_cents: null, max_drive_minutes: null, travel_mode: "train", travel_duration_minutes: 95, status: "open", author_id: "user-2", author_display_name: "Member", created_at: "2026-01-01" }];
    await renderPlan(next);
    expect(screen.getByRole("heading", { name: "Kayaking" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Expenses" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand Plan ideas" }));
    fireEvent.change(screen.getByLabelText("Proposed plan name"), { target: { value: "Desert weekend" } });
    fireEvent.click(screen.getByRole("button", { name: "Suggest a different trip" }));
    await waitFor(() => expect(createPlanSuggestion).toHaveBeenCalledWith("app-jwt", "plan-1", expect.objectContaining({ title: "Desert weekend", client_operation_id: "operation-id" })));
    fireEvent.click(screen.getByRole("button", { name: "Adopt this plan idea" }));
    await waitFor(() => expect(decidePlanSuggestion).toHaveBeenCalledWith("app-jwt", "plan-1", "plan-idea", "accept", 4, "operation-id"));
    await waitFor(() => expect(resyncPlan).toHaveBeenCalledTimes(3));
  });

  it("renders authoritative transport facts read-only for members and updates them after resync", async () => {
    const member = snapshot("member");
    member.plan.travel_mode = "train";
    member.plan.travel_duration_minutes = 125;
    await renderPlan(member);
    const overview = screen.getByLabelText("Plan overview");
    expect(overview.textContent).toContain("TransportationTrain");
    expect(overview.textContent).toContain("Travel duration2h 5m");
    expect(screen.getByRole("button", { name: /Transportation.*Open editor/ })).toBeTruthy();

    const refreshed = snapshot("member");
    refreshed.plan.travel_mode = "plane";
    refreshed.plan.travel_duration_minutes = 200;
    const callbacks = vi.mocked(usePlanSocket).mock.calls[0][0];
    act(() => callbacks.onSnapshot(refreshed));
    expect(overview.textContent).toContain("TransportationPlane");
    expect(overview.textContent).toContain("Travel duration3h 20m");
  });

  it("collapses the major plan sections while preserving their summaries and disclosure semantics", async () => {
    const next = snapshot();
    next.date_suggestions = [{ id: "date-1", starts_on: "2026-08-02", ends_on: "2026-08-03", message: null, status: "accepted", author_id: "user-2", author_display_name: "Member", yes_votes: 1, maybe_votes: 0, no_votes: 0, current_user_vote: null }];
    next.plan_suggestions = [{ id: "plan-idea", title: "Mountain weekend", description: null, starts_on: null, ends_on: null, budget_cents: null, max_drive_minutes: null, travel_mode: null, travel_duration_minutes: null, status: "open", author_id: "user-2", author_display_name: "Member", created_at: "2026-01-01" }];
    await renderPlan(next);

    expect(screen.getByText("1 open suggestion.")).toBeTruthy();
    for (const title of ["Travel-window poll", "Trip ideas", "Expenses"]) {
      const button = screen.getByRole("button", { name: `Collapse ${title}` });
      expect(button.getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(button);
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(screen.getByRole("button", { name: `Expand ${title}` })).toBeTruthy();
    }
    const planIdeas = screen.getByRole("button", { name: "Expand Plan ideas" });
    fireEvent.click(planIdeas);
    expect(screen.getByRole("button", { name: "Collapse Plan ideas" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Collapse Plan ideas" }));
    const members = screen.getByRole("button", { name: /Trip members/ });
    fireEvent.click(members);
    expect(members.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Close trip members" })).toBeTruthy();
  });

  it("renders the availability map from authoritative dates, suggestions, and member responses", async () => {
    const next = snapshot();
    next.plan.starts_on = "2026-08-01T00:00:00Z";
    next.plan.ends_on = "2026-08-03T00:00:00Z";
    next.date_availability = [
      { date: "2026-08-01", status: "available", user_id: "user-1", member_display_name: "Owner", is_current_user: true },
      { date: "2026-08-01", status: "maybe", user_id: "user-2", member_display_name: "Member", is_current_user: false }
    ];
    next.date_suggestions = [
      { id: "accepted", starts_on: "2026-08-01", ends_on: "2026-08-02", message: null, status: "accepted", author_id: "user-2", author_display_name: "Member", yes_votes: 3, maybe_votes: 0, no_votes: 0, current_user_vote: null, created_at: "2026-01-01" },
      { id: "open", starts_on: "2026-08-04", ends_on: "2026-08-05", message: null, status: "open", author_id: "user-2", author_display_name: "Member", yes_votes: 2, maybe_votes: 1, no_votes: 0, current_user_vote: null, created_at: "2026-01-02" }
    ];
    await renderPlan(next);
    expect(screen.getByRole("heading", { name: "Group availability" })).toBeTruthy();
    expect(screen.getByText("Leading option").parentElement?.textContent).toContain("Aug 4 – Aug 5");
    expect(screen.getByLabelText(/Saturday, August 1, 2026: current trip date, 1 available, 1 maybe, 0 unavailable, 0 no response/)).toBeTruthy();
    expect(screen.getByText("Current trip date")).toBeTruthy();
    expect(screen.getByText("No response")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Saturday, August 1, 2026/));
    expect(screen.getByRole("heading", { name: "Availability for Saturday, August 1, 2026" })).toBeTruthy();
    expect(screen.getByText("✓ Available")).toBeTruthy();
    expect(screen.getByText("❓ Maybe")).toBeTruthy();
  });

  it("keeps the calendar useful for a single date, month boundary, and no responses", async () => {
    const next = snapshot();
    next.plan.starts_on = "2026-08-31T00:00:00Z";
    next.plan.ends_on = "2026-08-31T00:00:00Z";
    next.date_availability = [];
    next.date_suggestions = [{ id: "cross-month", starts_on: "2026-08-31", ends_on: "2026-09-02", message: null, status: "open", author_id: "user-2", author_display_name: "Member", yes_votes: 0, maybe_votes: 0, no_votes: 0, current_user_vote: null, created_at: "2026-01-01" }];
    await renderPlan(next);
    expect(screen.getByRole("region", { name: "August 2026" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "September 2026" })).toBeTruthy();
    expect(screen.getByLabelText(/Monday, August 31, 2026: current trip date, 0 available, 0 maybe, 0 unavailable, 2 no response/)).toBeTruthy();
  });

  it("renders an authoritative schedule ordered by start, position key, then ID with compact overflow and no unscheduled items", async () => {
    const next = snapshot();
    next.plan.ends_on = "2026-08-03T00:00:00Z";
    next.itinerary_items = [
      { id: "late", plan_id: "plan-1", activity_id: null, title: "Dinner", position_key: "4000", starts_at: "2026-08-01T18:00:00Z", ends_at: null, version: 1 },
      { id: "first", plan_id: "plan-1", activity_id: null, title: "Breakfast", position_key: "2000", starts_at: "2026-08-01T08:00:00Z", ends_at: null, version: 1 },
      { id: "same-time-a", plan_id: "plan-1", activity_id: null, title: "Kayaks", position_key: "1000", starts_at: "2026-08-01T12:00:00Z", ends_at: null, version: 1 },
      { id: "same-time-b", plan_id: "plan-1", activity_id: null, title: "Lunch", position_key: "3000", starts_at: "2026-08-01T12:00:00Z", ends_at: null, version: 1 },
      { id: "z-item", plan_id: "plan-1", activity_id: null, title: "Zulu stop", position_key: "5000", starts_at: "2026-08-01T13:00:00Z", ends_at: null, version: 1 },
      { id: "a-item", plan_id: "plan-1", activity_id: null, title: "Alpha stop", position_key: "5000", starts_at: "2026-08-01T13:00:00Z", ends_at: null, version: 1 },
      { id: "unscheduled", plan_id: "plan-1", activity_id: null, title: "Unscheduled idea", position_key: "5000", starts_at: null, ends_at: null, version: 1 }
    ];
    await renderPlan(next);
    const day = screen.getByLabelText(/Saturday, August 1, 2026:.*6 scheduled items.*Breakfast, Kayaks, Lunch, Alpha stop, Zulu stop, Dinner/);
    expect(day.textContent).toContain("+4 more");
    expect(day.textContent).not.toContain("Unscheduled idea");
    fireEvent.click(day);
    const schedule = screen.getByRole("heading", { name: "Schedule" }).parentElement!;
    expect(schedule.textContent).toContain("Breakfast");
    expect(schedule.textContent).toContain("8:00 AM");
    const scheduledTitles = [...schedule.querySelectorAll(".calendar-schedule-detail strong")].map((node) => node.textContent);
    expect(scheduledTitles).toEqual(["Breakfast", "Kayaks", "Lunch", "Alpha stop", "Zulu stop", "Dinner"]);
    expect(getRecommendations).toHaveBeenCalledTimes(1);
  });

  it("groups UTC midnight-boundary starts across December to January and refreshes from authoritative resync", async () => {
    const next = snapshot();
    next.plan.starts_on = "2026-12-31T00:00:00Z";
    next.plan.ends_on = "2027-01-01T00:00:00Z";
    next.itinerary_items = [
      { id: "late-december", plan_id: "plan-1", activity_id: null, title: "Late December", position_key: "1000", starts_at: "2026-12-31T23:30:00Z", ends_at: null, version: 1 },
      { id: "early-january", plan_id: "plan-1", activity_id: null, title: "Early January", position_key: "2000", starts_at: "2027-01-01T00:30:00Z", ends_at: null, version: 1 }
    ];
    await renderPlan(next);
    expect(screen.getByRole("region", { name: "December 2026" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "January 2027" })).toBeTruthy();
    expect(screen.getByLabelText(/Thursday, December 31, 2026:.*Scheduled: Late December/)).toBeTruthy();
    const newYear = screen.getByLabelText(/Friday, January 1, 2027:.*Scheduled: Early January/);
    fireEvent.click(newYear);
    expect(screen.getAllByText("Early January").length).toBeGreaterThan(0);
    const refreshed = structuredClone(next);
    refreshed.itinerary_items = [];
    act(() => vi.mocked(usePlanSocket).mock.calls[0][0].onSnapshot(refreshed));
    expect(screen.queryByText("Early January")).toBeNull();
  });

  it("removes a scheduled calendar item after the existing itinerary delete mutation resyncs", async () => {
    const next = snapshot();
    next.itinerary_items[0] = { ...next.itinerary_items[0], title: "Delete me", starts_at: "2026-08-01T12:00:00Z" };
    await renderPlan(next);
    expect(screen.getByLabelText(/Saturday, August 1, 2026:.*Scheduled: Delete me/)).toBeTruthy();
    const refreshed = structuredClone(next);
    refreshed.itinerary_items = refreshed.itinerary_items.filter((item) => item.id !== "item-2");
    vi.mocked(resyncPlan).mockResolvedValue(refreshed);
    const itinerarySection = screen.getByRole("heading", { name: "Your itinerary" }).closest("section")!;
    fireEvent.click(within(itinerarySection).getByText("Delete me").closest("article")!.querySelector("button.btn-danger")!);
    await waitFor(() => expect(deleteItineraryItem).toHaveBeenCalledWith("app-jwt", "plan-1", "item-2", 2));
    await waitFor(() => expect(screen.queryByLabelText(/Scheduled: Delete me/)).toBeNull());
  });

  it("uses compact scheduled counts in the mobile calendar rules", () => {
    const styles = readFileSync("src/app/globals.css", "utf8");
    expect(styles).toContain(".calendar-schedule-chip, .calendar-schedule-more { display: none; }");
    expect(styles).toContain(".calendar-schedule-count { display: block; }");
  });

  it("groups explicit near-midnight starts onto the correct cross-month UTC calendar day", async () => {
    const next = snapshot();
    next.plan.starts_on = "2026-08-31T00:00:00Z";
    next.plan.ends_on = "2026-09-01T00:00:00Z";
    next.itinerary_items = [
      { id: "august", plan_id: "plan-1", activity_id: null, title: "Late August", position_key: "1000", starts_at: "2026-08-31T23:59:00Z", ends_at: null, version: 1 },
      { id: "september", plan_id: "plan-1", activity_id: null, title: "Early September", position_key: "2000", starts_at: "2026-09-01T00:00:00Z", ends_at: null, version: 1 }
    ];
    await renderPlan(next);
    expect(screen.getByRole("region", { name: "August 2026" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "September 2026" })).toBeTruthy();
    expect(screen.getByLabelText(/Monday, August 31, 2026:.*Scheduled: Late August/)).toBeTruthy();
    expect(screen.getByLabelText(/Tuesday, September 1, 2026:.*Scheduled: Early September/)).toBeTruthy();
  });

  it("schedules an itinerary item through the existing idempotent mutation with an explicit UTC date and time", async () => {
    await renderPlan();
    fireEvent.click(screen.getByRole("button", { name: "+ Add itinerary stop" }));
    fireEvent.change(screen.getByLabelText("Itinerary item"), { target: { value: "Sunset walk" } });
    fireEvent.change(screen.getByLabelText("Itinerary schedule date"), { target: { value: "2026-08-01" } });
    fireEvent.change(screen.getByLabelText("Itinerary start time"), { target: { value: "18:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Add stop" }));
    await waitFor(() => expect(createItineraryItem).toHaveBeenCalledWith("app-jwt", "plan-1", { title: "Sunset walk", starts_at: "2026-08-01T18:30:00.000Z", client_operation_id: "operation-id" }));
  });

  it("uses the compact question-mark Maybe control without losing the accessible label", async () => {
    await renderPlan();
    const maybe = screen.getByRole("button", { name: "Vote maybe" });
    expect(maybe.textContent).toContain("?");
    expect(maybe.textContent).toContain("Maybe");
  });

  it("replaces calendar selection from an authoritative resync across a year boundary", async () => {
    const next = snapshot();
    next.plan.starts_on = "2026-07-29T00:00:00Z";
    next.plan.ends_on = "2026-08-03T00:00:00Z";
    await renderPlan(next);
    expect(screen.getByLabelText(/Wednesday, July 29, 2026: current trip date/)).toBeTruthy();
    const refreshed = snapshot();
    refreshed.plan.starts_on = "2026-12-30T00:00:00Z";
    refreshed.plan.ends_on = "2027-01-04T00:00:00Z";
    act(() => vi.mocked(usePlanSocket).mock.calls[0][0].onSnapshot(refreshed));
    expect(screen.queryByLabelText(/Wednesday, July 29, 2026: current trip date/)).toBeNull();
    expect(screen.getByRole("region", { name: "December 2026" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "January 2027" })).toBeTruthy();
    expect(screen.getByLabelText(/Thursday, December 31, 2026: current trip date/)).toBeTruthy();
  });

  it("does not give a historical accepted option the authoritative final-date calendar highlight", async () => {
    const next = snapshot();
    next.plan.starts_on = "2026-09-10T00:00:00Z";
    next.plan.ends_on = "2026-09-12T00:00:00Z";
    next.date_suggestions = [{ id: "historic", starts_on: "2026-08-01", ends_on: "2026-08-03", message: null, status: "accepted", author_id: "user-2", author_display_name: "Member", yes_votes: 2, maybe_votes: 0, no_votes: 0, current_user_vote: null, created_at: "2026-01-01" }];
    await renderPlan(next);
    expect(screen.getByLabelText(/Saturday, August 1, 2026: 0 available/)).toBeTruthy();
    expect(screen.queryByLabelText(/Saturday, August 1, 2026: current trip date/)).toBeNull();
    expect(screen.getByLabelText(/Thursday, September 10, 2026: current trip date/)).toBeTruthy();
  });

  it("groups trip ideas by the authoritative itinerary activity identifier and keeps disclosures accessible", async () => {
    const next = snapshot();
    next.activities.push({ ...next.activities[0], id: "activity-2", name: "Museum" });
    next.itinerary_items[0].activity_id = "activity-2";
    await renderPlan(next);
    expect(screen.getByRole("button", { name: "Collapse Ideas to decide (1)" })).toBeTruthy();
    const inItinerary = screen.getByRole("button", { name: "Collapse Selected for this trip (1)" });
    const group = inItinerary.closest("section")!;
    expect(within(group).getByRole("heading", { name: "Museum" })).toBeTruthy();
    fireEvent.keyDown(inItinerary, { key: " " });
    expect(screen.getByRole("button", { name: "Expand Selected for this trip (1)" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("collapses balances while retaining the authoritative outstanding summary", async () => {
    await renderPlan();
    const toggle = screen.getByRole("button", { name: "Collapse Balances" });
    expect(screen.getByText("Balances · 2 members · $5.00 outstanding")).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Expand Balances" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Balances · 2 members · $5.00 outstanding")).toBeTruthy();
  });

  it("keeps disclosure-state feedback when reduced motion is requested", () => {
    const styles = readFileSync("src/app/globals.css", "utf8");
    expect(styles).toContain(".disclosure-toggle[aria-expanded=\"false\"] .disclosure-chevron");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain("pointer-events: none");
    expect(styles).toContain(".adventure-background, .adventure-background i { position: fixed; inset: 0; z-index: 0; pointer-events: none; }");
    expect(styles).toContain(".app-shell { position: relative; z-index: 1;");
    expect(styles).not.toContain("overflow-x: hidden");
    expect(styles).not.toContain("adventure-orbit");
    expect(styles).not.toContain("hue-rotate");
  });

  it("keeps owner and member date-poll selections isolated through realtime resync while totals match", async () => {
    const owner = snapshot();
    owner.date_suggestions = [{ id: "date-1", starts_on: "2026-10-01", ends_on: "2026-10-03", message: null, status: "open", author_id: "user-2", author_display_name: "Member", author_avatar_emoji: "😎", yes_votes: 1, maybe_votes: 0, no_votes: 1, current_user_vote: "yes", created_at: "2026-01-01" }];
    await renderPlan(owner);
    const yes = screen.getByRole("button", { name: /Vote yes for Oct 1/ });
    const no = screen.getByRole("button", { name: /Vote no for Oct 1/ });
    expect(yes.getAttribute("aria-pressed")).toBe("true");
    expect(no.getAttribute("aria-pressed")).toBe("false");
    expect(yes.textContent).toContain("1");
    expect(no.textContent).toContain("1");

    const member = structuredClone(owner);
    member.current_user_id = "user-2";
    member.plan.role = "member";
    member.date_suggestions[0].current_user_vote = "no";
    vi.mocked(resyncPlan).mockResolvedValue(member);
    await act(async () => { await vi.mocked(usePlanSocket).mock.calls[0][0].onPlanEvent?.(); });
    await waitFor(() => expect(screen.getByRole("button", { name: /Vote no for Oct 1/ }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByRole("button", { name: /Vote yes for Oct 1/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: /Vote yes for Oct 1/ }).textContent).toContain("1");
    expect(screen.getByRole("button", { name: /Vote no for Oct 1/ }).textContent).toContain("1");
  });

  it("keeps activity vote selection viewer-specific through invalidation and authoritative resync", async () => {
    const owner = snapshot();
    owner.activities[0].yes_votes = 1;
    owner.activities[0].no_votes = 1;
    owner.activities[0].current_user_vote = "yes";
    owner.activity_scores["activity-1"] = { yes: 1, maybe: 0, no: 1 };
    await renderPlan(owner);
    expect(screen.getByRole("button", { name: "Vote yes" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Vote no" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("1 yes · 0 maybe · 1 no")).toBeTruthy();

    const member = structuredClone(owner);
    member.current_user_id = "user-2";
    member.plan.role = "member";
    member.activities[0].current_user_vote = "no";
    vi.mocked(resyncPlan).mockResolvedValue(member);
    await act(async () => { await vi.mocked(usePlanSocket).mock.calls[0][0].onPlanEvent?.(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Vote no" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByRole("button", { name: "Vote yes" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("1 yes · 0 maybe · 1 no")).toBeTruthy();
  });

  it("opens a focus-managed Trip Members modal with plain emoji, overflow, role actions, confirmation, and request workflows", async () => {
    const next = snapshot();
    next.members[0].avatar_emoji = "🧭";
    next.members.push(
      { id: "pm-3", plan_id: "plan-1", user_id: "user-3", role: "co_owner", display_name: "Alex", avatar_emoji: "😎", created_at: "2026-01-01" },
      { id: "pm-4", plan_id: "plan-1", user_id: "user-4", role: "member", display_name: "Mia", avatar_emoji: "🌲", created_at: "2026-01-01" },
      { id: "pm-5", plan_id: "plan-1", user_id: "user-5", role: "member", display_name: "One", created_at: "2026-01-01" },
      { id: "pm-6", plan_id: "plan-1", user_id: "user-6", role: "member", display_name: "Two", created_at: "2026-01-01" },
      { id: "pm-7", plan_id: "plan-1", user_id: "user-7", role: "member", display_name: "Three", created_at: "2026-01-01" },
    );
    await renderPlan(next);
    const trigger = screen.getByRole("button", { name: /Trip members/ });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Trip Members" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const ownerEmoji = within(dialog).getAllByText("🧭")[0];
    expect(ownerEmoji.className).toBe("member-plain-emoji");
    expect(ownerEmoji.parentElement?.className).not.toContain("avatar");
    expect(screen.getByText("+4 more")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Demote to member" }));
    await waitFor(() => expect(changeMemberRole).toHaveBeenCalledWith("app-jwt", "plan-1", "user-3", "member", "operation-id"));
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Remove from trip" })[0]);
    expect(screen.getByRole("alertdialog", { name: "Confirm member removal" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(removeMember).toHaveBeenCalled());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Trip Members" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    cleanup();
    const member = snapshot("member");
    await renderPlan(member);
    fireEvent.click(screen.getByRole("button", { name: /Trip members/ }));
    fireEvent.click(screen.getByRole("button", { name: "Request co-owner access" }));
    await waitFor(() => expect(createCoOwnerRequest).toHaveBeenCalledWith("app-jwt", "plan-1", null, "operation-id"));

    cleanup();
    const pending = snapshot("member"); pending.co_owner_requests = [{ id: "request-1", plan_id: "plan-1", requester_user_id: "user-1", requester_display_name: "Owner", requester_avatar_emoji: "😀", status: "pending", note: "Please help", version: 1, decided_by_user_id: null, decided_at: null, created_at: "2026-01-01", updated_at: "2026-01-01" }];
    await renderPlan(pending);
    fireEvent.click(screen.getByRole("button", { name: /Trip members/ }));
    fireEvent.click(screen.getByRole("button", { name: "Withdraw request" }));
    await waitFor(() => expect(withdrawCoOwnerRequest).toHaveBeenCalledWith("app-jwt", "plan-1", "request-1", 1, "operation-id"));

    cleanup();
    const queue = snapshot(); queue.co_owner_requests = [{ ...pending.co_owner_requests[0], requester_user_id: "user-2", requester_display_name: "Member" }];
    await renderPlan(queue);
    fireEvent.click(screen.getByRole("button", { name: /Trip members/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(decideCoOwnerRequest).toHaveBeenCalledWith("app-jwt", "plan-1", "request-1", "approve", 1, "operation-id"));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(decideCoOwnerRequest).toHaveBeenCalledWith("app-jwt", "plan-1", "request-1", "deny", 1, "operation-id"));
    expect(screen.queryByText("Member directory")).toBeNull();
  });

  it("opens each dashboard editor as a closable portal dialog and removes the old Trip parameters section", async () => {
    await renderPlan();
    expect(screen.queryByRole("heading", { name: /Trip parameters/i })).toBeNull();
    for (const [tile, dialog] of [["Date window", "Date Window"], ["Transportation", "Transportation"], ["Travel duration", "Travel Duration"], ["Budget", "Budget"], ["Trip notes", "Trip Notes"]] as const) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`${tile}.*Open editor`, "i") }));
      expect(screen.getByRole("dialog", { name: dialog })).toBeTruthy();
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: dialog })).toBeNull());
    }
    expect(document.querySelector(".vote-visibility-control")?.textContent).toContain("Vote visibility: Public");
  });
});
