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
  createDateSuggestion, createPlanSuggestion,
  createCoOwnerRequest, decideCoOwnerRequest,
  createExpense,
  createInvite,
  createItineraryItem,
  deleteActivity,
  deleteExpense,
  deleteItineraryItem,
  decideActivitySuggestion, decidePlanSuggestion,
  decideDateSuggestion,
  getPlanBalances,
  patchActivity,
  patchExpense,
  patchItineraryItem,
  patchPlan,
  reorderItineraryItem,
  removeMember,
  resyncPlan,
  searchPlaces,
  setPlanLifecycle,
  syncUser, withdrawCoOwnerRequest,
  upsertDateAvailability, voteActivity, voteDateSuggestion
} from "@/lib/api-client";
import { usePlanSocket } from "@/hooks/usePlanSocket";
import type { ResyncSnapshot } from "@/types/api";

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
    syncUser: vi.fn(), resyncPlan: vi.fn(), getPlanBalances: vi.fn(),
    createActivity: vi.fn(), patchActivity: vi.fn(), deleteActivity: vi.fn(), voteActivity: vi.fn(),
    createItineraryItem: vi.fn(), patchItineraryItem: vi.fn(), reorderItineraryItem: vi.fn(), deleteItineraryItem: vi.fn(),
    createExpense: vi.fn(), patchExpense: vi.fn(), deleteExpense: vi.fn(),
    patchPlan: vi.fn(), setPlanLifecycle: vi.fn(), createInvite: vi.fn(),
    changeMemberRole: vi.fn(), removeMember: vi.fn(), createCoOwnerRequest: vi.fn(), withdrawCoOwnerRequest: vi.fn(), decideCoOwnerRequest: vi.fn(), createComment: vi.fn(), createActivitySuggestion: vi.fn(), decideActivitySuggestion: vi.fn(), upsertDateAvailability: vi.fn(), createDateSuggestion: vi.fn(), decideDateSuggestion: vi.fn(), voteDateSuggestion: vi.fn(), createPlanSuggestion: vi.fn(), decidePlanSuggestion: vi.fn(), searchPlaces: vi.fn()
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

async function renderPlan(next = snapshot()) {
  vi.mocked(resyncPlan).mockResolvedValue(next);
  vi.mocked(getPlanBalances).mockResolvedValue([{ user_id: "user-1", balance_cents: 500 }, { user_id: "user-2", balance_cents: -500 }]);
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
    vi.mocked(usePlanSocket).mockReturnValue({ connectionState: "restored", nextRetryMs: null, retry: vi.fn(), denyAuthentication: vi.fn(), denyAuthorization: vi.fn() });
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
    fireEvent.click(screen.getByRole("button", { name: "Edit settings" }));
    fireEvent.change(screen.getByLabelText("Budget"), { target: { value: "10.05" } });
    fireEvent.click(screen.getByRole("button", { name: "Save constraints" }));
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

  it("adds an activity to the itinerary through the existing idempotent item endpoint and resyncs", async () => {
    await renderPlan();
    const activity = screen.getByRole("heading", { name: "Kayaking" }).closest("article")!;
    fireEvent.click(within(activity).getByRole("button", { name: "Add to itinerary" }));
    await waitFor(() => expect(createItineraryItem).toHaveBeenCalledWith("app-jwt", "plan-1", {
      title: "Kayaking", activity_id: "activity-1", client_operation_id: "operation-id"
    }));
    await waitFor(() => expect(resyncPlan).toHaveBeenCalledTimes(2));

    cleanup();
    const alreadyAdded = snapshot();
    alreadyAdded.itinerary_items[0].activity_id = "activity-1";
    await renderPlan(alreadyAdded);
    expect(screen.getByRole("button", { name: "In itinerary" }).hasAttribute("disabled")).toBe(true);
  });

  it("orders itinerary items and sends current versions and neighbor contracts", async () => {
    await renderPlan();
    fireEvent.change(screen.getByLabelText("Item"), { target: { value: "Third" } });
    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    await waitFor(() => expect(createItineraryItem).toHaveBeenCalledWith("app-jwt", "plan-1", { title: "Third", client_operation_id: "operation-id" }));
    const first = screen.getByText("First"); const second = screen.getByText("Second");
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const secondArticle = second.closest("article")!;
    fireEvent.click(within(secondArticle).getByRole("button", { name: "Move up" }));
    await waitFor(() => expect(reorderItineraryItem).toHaveBeenCalledWith("app-jwt", "plan-1", "item-2", { expected_version: 2, previous_item_id: undefined, next_item_id: "item-1" }));
    const refreshedSecond = screen.getByText("Second").closest("article")!;
    fireEvent.click(within(refreshedSecond).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(refreshedSecond).getByLabelText("Title"), { target: { value: "Moved second" } });
    fireEvent.click(within(refreshedSecond).getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(patchItineraryItem).toHaveBeenCalledWith("app-jwt", "plan-1", "item-2", { title: "Moved second", expected_version: 2 }));
    fireEvent.click(within(screen.getByText("Second").closest("article")!).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteItineraryItem).toHaveBeenCalledWith("app-jwt", "plan-1", "item-2", 2));
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
    fireEvent.click(screen.getByRole("button", { name: "Edit settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Save constraints" }));
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

  it("keeps Phase 2 helpers visible on plan detail and uses successful place selections to assist manual activity entry", async () => {
    vi.mocked(searchPlaces).mockResolvedValue({ status: "ok", results: [{ name: "Gallery", latitude: 1, longitude: 2, address: "1 Main", type: "gallery" }] });
    await renderPlan();
    expect(screen.getByRole("heading", { name: "Explore places" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Nearby places" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Route estimate" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Weather" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Find a place/), { target: { value: "Gallery" } });
    fireEvent.click(screen.getByRole("button", { name: "Search places" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use Gallery" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Gallery");
    expect((screen.getByLabelText(/^Address/) as HTMLInputElement).value).toBe("1 Main");
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
    expect(screen.getByRole("heading", { name: "Kayaking" }).closest("article")?.textContent).toContain("Yes 2");
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
    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]);
    await waitFor(() => expect(decideActivitySuggestion).toHaveBeenCalledWith("app-jwt", "plan-1", "activity-1", "suggestion-1", "accept", 3, "operation-id"));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-07-18" } }); fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
    await waitFor(() => expect(upsertDateAvailability).toHaveBeenCalled());
    expect(screen.getByText(/Jul 18, 2026 – Jul 21, 2026/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" }).at(-1)!);
    await waitFor(() => expect(decideDateSuggestion).toHaveBeenCalledWith("app-jwt", "plan-1", "date-1", "dismiss", 4, "operation-id"));
    expect(vi.mocked(resyncPlan).mock.calls.length).toBeGreaterThan(1);
  });

  it("edits plan-level travel metadata in integer minutes and keeps members read-only", async () => {
    const owner = snapshot();
    owner.plan.travel_mode = "train";
    owner.plan.travel_duration_minutes = 125;
    owner.plan.travel_notes = "Meet at the station";
    await renderPlan(owner);
    fireEvent.click(screen.getByRole("button", { name: "Edit settings" }));
    expect((screen.getByLabelText("Travel hours") as HTMLInputElement).value).toBe("2");
    expect((screen.getByLabelText("Travel minutes") as HTMLInputElement).value).toBe("5");
    fireEvent.change(screen.getByLabelText("Travel hours"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Travel minutes"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save constraints" }));
    await waitFor(() => expect(patchPlan).toHaveBeenCalledWith("app-jwt", "plan-1", expect.objectContaining({ travel_mode: "train", travel_duration_minutes: 200, travel_notes: "Meet at the station" })));
    await waitFor(() => expect(resyncPlan).toHaveBeenCalledTimes(2));

    cleanup();
    await renderPlan(snapshot("member"));
    expect(screen.getByText("Only an owner or co-owner can edit constraints.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit settings" })).toBeNull();
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
    expect(screen.queryByRole("button", { name: "Edit settings" })).toBeNull();

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

    expect(screen.getByText(/Trip dates: Aug 1, 2026/)).toBeTruthy();
    expect(screen.getByText("1 open suggestion.")).toBeTruthy();
    for (const title of ["Travel window", "Travel-window poll", "Trip ideas", "Expenses"]) {
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

  it("uses the red question-mark Maybe icon without losing the accessible label", async () => {
    await renderPlan();
    const maybe = screen.getByRole("button", { name: "Vote maybe" });
    expect(maybe.textContent).toContain("❓");
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
    expect(screen.getByRole("button", { name: "Collapse Not in itinerary (1)" })).toBeTruthy();
    const inItinerary = screen.getByRole("button", { name: "Collapse In itinerary (1)" });
    const group = inItinerary.closest("section")!;
    expect(within(group).getByRole("heading", { name: "Museum" })).toBeTruthy();
    fireEvent.keyDown(inItinerary, { key: " " });
    expect(screen.getByRole("button", { name: "Expand In itinerary (1)" }).getAttribute("aria-expanded")).toBe("false");
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
    expect(screen.getByText("Yes 1 · Maybe 0 · No 1")).toBeTruthy();

    const member = structuredClone(owner);
    member.current_user_id = "user-2";
    member.plan.role = "member";
    member.activities[0].current_user_vote = "no";
    vi.mocked(resyncPlan).mockResolvedValue(member);
    await act(async () => { await vi.mocked(usePlanSocket).mock.calls[0][0].onPlanEvent?.(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Vote no" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByRole("button", { name: "Vote yes" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Yes 1 · Maybe 0 · No 1")).toBeTruthy();
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

  it("keeps a manually entered activity address when place search is unavailable", async () => {
    let resolve!: (value: { status: "unavailable"; results: [] }) => void;
    vi.mocked(searchPlaces).mockReturnValue(new Promise((done) => { resolve = done; }));
    await renderPlan();
    fireEvent.click(screen.getByRole("button", { name: "+ Add activity" }));
    const address = screen.getByLabelText(/^Address/) as HTMLInputElement;
    fireEvent.change(address, { target: { value: "Manual cabin address" } });
    fireEvent.change(screen.getByLabelText(/Find a place for this activity/), { target: { value: "Cabin" } });
    fireEvent.click(screen.getByRole("button", { name: "Search activity places" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Searching…" })).toBeTruthy());
    expect(address.disabled).toBe(false);
    expect(address.value).toBe("Manual cabin address");
    resolve({ status: "unavailable", results: [] });
    await screen.findByText(/Place search unavailable/);
    expect(address.value).toBe("Manual cabin address");
  });
});
