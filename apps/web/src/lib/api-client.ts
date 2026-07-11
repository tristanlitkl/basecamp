import { getSession } from "next-auth/react";

import { apiBaseUrl } from "@/lib/env";
import type {
  ActivitySummary,
  CreateActivityInput,
  Expense,
  ExpenseMutationResponse,
  ItineraryItem,
  ItineraryMutationResponse,
  PlanDetail,
  PlanBalance,
  PlanSummary,
  ResyncSnapshot,
  User
} from "@/types/api";

type RequestOptions = {
  method?: string;
  body?: unknown;
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(`${status} ${JSON.stringify(body)}`);
    this.name = "ApiError";
  }
}

export function isAuthenticationError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function isPlanMembershipError(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 403) return false;
  const body = error.body as { detail?: { error?: unknown } } | null;
  return body?.detail?.error === "plan_membership_required";
}

async function sendApiRequest<T>(token: string, path: string, options: RequestOptions): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ error: "request_failed" }));
    throw new ApiError(response.status, errorBody);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

/** Refetches Auth.js session state; its server-side JWT callback mints a fresh app JWT if needed. */
export async function refreshAppJwt(): Promise<string | undefined> {
  const session = await getSession();
  return session?.appJwt;
}

async function apiFetch<T>(token: string, path: string, options: RequestOptions = {}): Promise<T> {
  try {
    return await sendApiRequest<T>(token, path, options);
  } catch (error) {
    if (!isAuthenticationError(error)) throw error;
    const refreshedToken = await refreshAppJwt();
    if (!refreshedToken || refreshedToken === token) throw error;
    return sendApiRequest<T>(refreshedToken, path, options);
  }
}

export function syncUser(token: string): Promise<User> {
  return apiFetch<User>(token, "/auth/sync-user", { method: "POST" });
}

export function getMe(token: string): Promise<User> {
  return apiFetch<User>(token, "/auth/me");
}

export function updateDisplayName(token: string, display_name: string): Promise<User> {
  return apiFetch<User>(token, "/auth/me", { method: "PATCH", body: { display_name } });
}

export function listPlans(token: string): Promise<PlanSummary[]> {
  return apiFetch<PlanSummary[]>(token, "/plans");
}

export function createPlan(
  token: string,
  input: { title: string; description?: string; budget_cents?: number }
): Promise<PlanSummary> {
  return apiFetch<PlanSummary>(token, "/plans", { method: "POST", body: input });
}

export function getPlan(token: string, planId: string): Promise<PlanDetail> {
  return apiFetch<PlanDetail>(token, `/plans/${planId}`);
}

export function resyncPlan(token: string, planId: string): Promise<ResyncSnapshot> {
  return apiFetch<ResyncSnapshot>(token, `/plans/${planId}/resync`);
}

export function getPlanBalances(token: string, planId: string): Promise<PlanBalance[]> {
  return apiFetch<PlanBalance[]>(token, `/plans/${planId}/balances`);
}

export function createInvite(token: string, planId: string): Promise<{ token: string; plan_id: string }> {
  return apiFetch<{ token: string; plan_id: string }>(token, `/plans/${planId}/invites`, {
    method: "POST"
  });
}

export function joinInvite(token: string, inviteToken: string, display_name?: string): Promise<{ plan_id: string; role: string }> {
  return apiFetch<{ plan_id: string; role: string }>(token, `/invites/${inviteToken}/join`, {
    method: "POST", body: display_name ? { display_name } : undefined
  });
}

export function changeMemberRole(token: string, planId: string, userId: string, role: "co_owner" | "member", client_operation_id: string) {
  return apiFetch(token, `/plans/${planId}/members/${userId}/role`, { method: "PATCH", body: { role, client_operation_id } });
}
export function removeMember(token: string, planId: string, userId: string, client_operation_id: string): Promise<void> {
  return apiFetch(token, `/plans/${planId}/members/${userId}?client_operation_id=${encodeURIComponent(client_operation_id)}`, { method: "DELETE" });
}
export function updateVoteVisibility(token: string, planId: string, vote_visibility: "public" | "anonymous", expected_version: number) {
  return apiFetch(token, `/plans/${planId}/vote-visibility`, { method: "PATCH", body: { vote_visibility, expected_version } });
}
export function createComment(token: string, planId: string, activityId: string, body: string, client_operation_id: string) { return apiFetch(token, `/plans/${planId}/activities/${activityId}/comments`, { method: "POST", body: { body, client_operation_id } }); }
export function patchComment(token: string, planId: string, activityId: string, commentId: string, body: string, expected_version: number) { return apiFetch(token, `/plans/${planId}/activities/${activityId}/comments/${commentId}`, { method: "PATCH", body: { body, expected_version } }); }
export function deleteComment(token: string, planId: string, activityId: string, commentId: string): Promise<void> { return apiFetch(token, `/plans/${planId}/activities/${activityId}/comments/${commentId}`, { method: "DELETE" }); }
export function createActivitySuggestion(token: string, planId: string, activityId: string, input: { suggestion_type: string; proposed_changes_json: Record<string, unknown>; message?: string; client_operation_id: string }) { return apiFetch(token, `/plans/${planId}/activities/${activityId}/suggestions`, { method: "POST", body: input }); }
export function decideActivitySuggestion(token: string, planId: string, activityId: string, suggestionId: string, decision: "accept" | "dismiss", expected_activity_version: number, client_operation_id: string) { return apiFetch(token, `/plans/${planId}/activities/${activityId}/suggestions/${suggestionId}/${decision}`, { method: "POST", body: { expected_activity_version, client_operation_id } }); }
export function upsertDateAvailability(token: string, planId: string, date: string, status: "available" | "maybe" | "unavailable") { return apiFetch(token, `/plans/${planId}/date-availability`, { method: "PUT", body: { date, status } }); }
export function createDateSuggestion(token: string, planId: string, starts_on: string, ends_on: string, client_operation_id: string, message?: string) { return apiFetch(token, `/plans/${planId}/date-suggestions`, { method: "POST", body: { starts_on, ends_on, message, client_operation_id } }); }
export function decideDateSuggestion(token: string, planId: string, suggestionId: string, decision: "accept" | "dismiss", expected_plan_version: number, client_operation_id: string) { return apiFetch(token, `/plans/${planId}/date-suggestions/${suggestionId}/${decision}`, { method: "POST", body: { expected_plan_version, client_operation_id } }); }

export function createActivity(
  token: string,
  planId: string,
  input: CreateActivityInput
): Promise<{ id: string; plan_id: string; name: string; version: number; travel_mode: "car" | "plane" | "train" | "bus" | null }> {
  return apiFetch<{ id: string; plan_id: string; name: string; version: number; travel_mode: "car" | "plane" | "train" | "bus" | null }>(token, `/plans/${planId}/activities`, {
    method: "POST",
    body: input
  });
}

export function patchActivity(
  token: string,
  planId: string,
  activityId: string,
  input: {
    expected_version: number;
    name?: string;
    description?: string | null;
    address?: string | null;
    estimated_cost_cents?: number | null;
    estimated_duration_minutes?: number | null;
    travel_mode?: "car" | "plane" | "train" | "bus" | null;
    tags?: string[] | null;
    notes?: string | null;
  }
): Promise<{ id: string; plan_id: string; name: string; version: number; travel_mode: "car" | "plane" | "train" | "bus" | null }> {
  return apiFetch(token, `/plans/${planId}/activities/${activityId}`, { method: "PATCH", body: input });
}

export function deleteActivity(
  token: string,
  planId: string,
  activityId: string,
  expectedVersion: number
): Promise<void> {
  return apiFetch<void>(
    token,
    `/plans/${planId}/activities/${activityId}?expected_version=${encodeURIComponent(expectedVersion)}`,
    { method: "DELETE" }
  );
}

export type DeleteActivityResult = {
  snapshot: ResyncSnapshot;
  conflict: boolean;
};

export async function deleteActivityAndResync(
  token: string,
  planId: string,
  activity: Pick<ActivitySummary, "id" | "version">
): Promise<DeleteActivityResult> {
  try {
    await deleteActivity(token, planId, activity.id, activity.version);
    return { snapshot: await resyncPlan(token, planId), conflict: false };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
    return { snapshot: await resyncPlan(token, planId), conflict: true };
  }
}

export function voteActivity(
  token: string,
  planId: string,
  activityId: string,
  vote: "yes" | "no" | "maybe"
): Promise<{ activity_id: string; vote: string }> {
  return apiFetch<{ activity_id: string; vote: string }>(
    token,
    `/plans/${planId}/activities/${activityId}/vote`,
    {
      method: "PUT",
      body: { vote }
    }
  );
}

export function patchPlan(
  token: string,
  planId: string,
  input: {
    expected_version: number;
    title?: string;
    description?: string | null;
    budget_cents?: number | null;
    starts_on?: string | null;
    ends_on?: string | null;
    max_drive_minutes?: number | null;
  }
): Promise<PlanSummary> {
  return apiFetch(token, `/plans/${planId}`, { method: "PATCH", body: input });
}

export function setPlanLifecycle(
  token: string,
  planId: string,
  action: "finalize" | "unfinalize",
  expectedVersion: number
): Promise<PlanSummary> {
  return apiFetch(token, `/plans/${planId}/${action}`, {
    method: "POST",
    body: { expected_version: expectedVersion }
  });
}

export function createItineraryItem(
  token: string,
  planId: string,
  input: { title: string; client_operation_id: string }
): Promise<ItineraryMutationResponse> {
  return apiFetch(token, `/plans/${planId}/itinerary-items`, { method: "POST", body: input });
}

export function patchItineraryItem(
  token: string,
  planId: string,
  itemId: string,
  input: { title?: string; expected_version: number }
): Promise<ItineraryMutationResponse> {
  return apiFetch(token, `/plans/${planId}/itinerary-items/${itemId}`, { method: "PATCH", body: input });
}

export function reorderItineraryItem(
  token: string,
  planId: string,
  itemId: string,
  input: { expected_version: number; previous_item_id?: string; next_item_id?: string }
): Promise<ItineraryMutationResponse> {
  return apiFetch(token, `/plans/${planId}/itinerary-items/${itemId}/reorder`, { method: "POST", body: input });
}

export function deleteItineraryItem(
  token: string,
  planId: string,
  itemId: string,
  expectedVersion: number
): Promise<void> {
  return apiFetch(token, `/plans/${planId}/itinerary-items/${itemId}?expected_version=${expectedVersion}`, { method: "DELETE" });
}

export function createExpense(
  token: string,
  planId: string,
  input: { description: string; amount_cents: number; paid_by_user_id?: string; participant_user_ids?: string[]; client_operation_id: string }
): Promise<ExpenseMutationResponse> {
  return apiFetch(token, `/plans/${planId}/expenses`, { method: "POST", body: input });
}

export function patchExpense(
  token: string,
  planId: string,
  expenseId: string,
  input: { description: string; amount_cents: number; paid_by_user_id?: string; participant_user_ids?: string[]; expected_version: number; client_operation_id: string }
): Promise<ExpenseMutationResponse> {
  return apiFetch(token, `/plans/${planId}/expenses/${expenseId}`, { method: "PATCH", body: input });
}

export function deleteExpense(
  token: string,
  planId: string,
  expenseId: string,
  expectedVersion: number,
  operationId: string
): Promise<void> {
  return apiFetch(token, `/plans/${planId}/expenses/${expenseId}?expected_version=${expectedVersion}&client_operation_id=${encodeURIComponent(operationId)}`, { method: "DELETE" });
}
