import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import PlanPage from "@/app/plans/[planId]/page";
import {
  ApiError,
  changeMemberRole,
  createActivitySuggestion,
  createComment,
  createDateSuggestion,
  createExpense,
  createInvite,
  createItineraryItem,
  deleteActivity,
  deleteExpense,
  deleteItineraryItem,
  decideActivitySuggestion,
  decideDateSuggestion,
  getPlanBalances,
  patchActivity,
  patchExpense,
  patchItineraryItem,
  patchPlan,
  reorderItineraryItem,
  removeMember,
  resyncPlan,
  setPlanLifecycle,
  syncUser
  ,upsertDateAvailability
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
    patchPlan: vi.fn(), setPlanLifecycle: vi.fn(), createInvite: vi.fn()
    ,changeMemberRole: vi.fn(), removeMember: vi.fn(), createComment: vi.fn(), createActivitySuggestion: vi.fn(), decideActivitySuggestion: vi.fn(), upsertDateAvailability: vi.fn(), createDateSuggestion: vi.fn(), decideDateSuggestion: vi.fn()
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
    activities: [{ id: "activity-1", version: 3, name: "Kayaking", description: "On the bay", address: "Pier 1", location_name: "Pier 1", lat: null, lng: null, estimated_cost_cents: 2500, estimated_duration_minutes: 90, tags: ["water"], notes: "Bring sunscreen", vote: null, yes_votes: 0, no_votes: 0, maybe_votes: 0 }],
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
    expect(screen.getByText(/Role: owner/)).toBeTruthy();
    expect(screen.getByText(/Connection restored/)).toBeTruthy();
    expect(screen.getByText("Owner: $5.00")).toBeTruthy();
    expect(screen.getByText("Member: -$5.00")).toBeTruthy();
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
    expect(screen.getByText("This plan is finalized. Unfinalize it to make changes.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add activity" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Add expense" }).hasAttribute("disabled")).toBe(true);
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
    fireEvent.change(screen.getByLabelText("Budget"), { target: { value: "10.05" } });
    fireEvent.click(screen.getByRole("button", { name: "Save constraints" }));
    await waitFor(() => expect(patchPlan).toHaveBeenCalledWith("app-jwt", "plan-1", expect.objectContaining({ expected_version: 4, budget_cents: 1005, max_drive_minutes: 45 })));

    const activity = screen.getByRole("heading", { name: "Kayaking" }).closest("article")!;
    fireEvent.click(within(activity).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(activity).getByLabelText("Name"), { target: { value: "Sea kayaking" } });
    fireEvent.click(within(activity).getByRole("button", { name: "Save activity" }));
    await waitFor(() => expect(patchActivity).toHaveBeenCalledWith("app-jwt", "plan-1", "activity-1", expect.objectContaining({ expected_version: 3, name: "Sea kayaking", estimated_cost_cents: 2500 })));
  });

  it("deletes an activity with its current version and performs authoritative resync", async () => {
    await renderPlan();
    const activity = screen.getByRole("heading", { name: "Kayaking" }).closest("article")!;
    fireEvent.click(within(activity).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteActivity).toHaveBeenCalledWith("app-jwt", "plan-1", "activity-1", 3));
    await waitFor(() => expect(resyncPlan).toHaveBeenCalledTimes(2));
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
    const createForm = screen.getByRole("button", { name: "Add expense" }).closest("form")!;
    fireEvent.change(within(createForm).getByLabelText("Description"), { target: { value: "Dinner" } });
    fireEvent.change(within(createForm).getByLabelText("Amount"), { target: { value: "10.05" } });
    fireEvent.click(within(createForm).getByRole("button", { name: "Add expense" }));
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
    expect(screen.getAllByText("Co Owner")[0].closest("article")?.textContent).toContain("co_owner · joined 2026-02-03");
    expect(screen.getAllByRole("button", { name: "Demote" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Promote" }));
    await waitFor(() => expect(changeMemberRole).toHaveBeenCalledWith("app-jwt", "plan-1", "user-2", "co_owner", "operation-id"));
    expect(resyncPlan).toHaveBeenCalledTimes(2);

    cleanup();
    const coOwner = snapshot("co_owner"); coOwner.current_user_id = "user-3"; coOwner.members.push({ id: "pm-3", plan_id: "plan-1", user_id: "user-3", role: "co_owner", display_name: "Co Owner", created_at: "2026-02-03" });
    await renderPlan(coOwner);
    expect(screen.queryByRole("button", { name: "Promote" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);

    cleanup(); await renderPlan(snapshot("member"));
    expect(screen.queryByRole("button", { name: "Promote" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("Phase 1B.75 public and anonymous votes render privacy-safe identities and totals", async () => {
    const publicSnapshot = snapshot();
    publicSnapshot.votes = [{ activity_id: "activity-1", user_id: "user-2", vote: "yes" }];
    publicSnapshot.activities[0].yes_votes = 1;
    await renderPlan(publicSnapshot);
    expect(screen.getByText("Votes: Member (yes)")).toBeTruthy();
    cleanup();
    const anonymous = snapshot("member"); anonymous.plan.vote_visibility = "anonymous"; anonymous.activities[0].vote = "yes"; anonymous.activity_scores["activity-1"].yes = 2; anonymous.votes = [{ activity_id: "activity-1", user_id: "user-1", vote: "yes" }];
    await renderPlan(anonymous);
    expect(screen.getByRole("heading", { name: "Kayaking" }).closest("article")?.textContent).toContain("Yes 2");
    expect(screen.getByText(/Votes are anonymous/)).toBeTruthy();
    expect(screen.queryByText(/Member \(yes\)/)).toBeNull();
    expect(screen.getByRole("button", { name: "yes selected" })).toBeTruthy();
  });

  it("Phase 1B.75 comments suggestions and date coordination use operation IDs and resync", async () => {
    const next = snapshot();
    next.activity_comments = [{ id: "comment-1", activity_id: "activity-1", author_id: "user-2", author_display_name: "Member", body: "Great idea", version: 1, deleted_at: null, created_at: "2026-01-01", updated_at: "2026-01-01" }];
    next.activity_suggestions = [{ id: "suggestion-1", activity_id: "activity-1", author_id: "user-2", author_display_name: "Member", suggestion_type: "notes", proposed_changes_json: { notes: "New" }, message: "Change notes", status: "open", created_at: "2026-01-01" }];
    next.date_suggestions = [{ id: "date-1", starts_on: "2026-07-18", ends_on: "2026-07-21", message: null, status: "open", author_id: "user-2", author_display_name: "Tris" }];
    await renderPlan(next);
    fireEvent.click(screen.getByText(/Discussion/));
    expect(screen.getByText("Member: Great idea")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Another" } }); fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await waitFor(() => expect(createComment).toHaveBeenCalledWith("app-jwt", "plan-1", "activity-1", "Another", "operation-id"));
    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]);
    await waitFor(() => expect(decideActivitySuggestion).toHaveBeenCalledWith("app-jwt", "plan-1", "activity-1", "suggestion-1", "accept", 3, "operation-id"));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-07-18" } }); fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
    await waitFor(() => expect(upsertDateAvailability).toHaveBeenCalled());
    expect(screen.getByText(/Tris suggested 2026-07-18–2026-07-21/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" }).at(-1)!);
    await waitFor(() => expect(decideDateSuggestion).toHaveBeenCalledWith("app-jwt", "plan-1", "date-1", "dismiss", 4, "operation-id"));
    expect(vi.mocked(resyncPlan).mock.calls.length).toBeGreaterThan(1);
  });
});
