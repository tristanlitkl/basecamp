import { apiBaseUrl } from "@/lib/env";
import type { CreateActivityInput, PlanDetail, PlanSummary, ResyncSnapshot, User } from "@/types/api";

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

async function apiFetch<T>(token: string, path: string, options: RequestOptions = {}): Promise<T> {
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

export function syncUser(token: string): Promise<User> {
  return apiFetch<User>(token, "/auth/sync-user", { method: "POST" });
}

export function getMe(token: string): Promise<User> {
  return apiFetch<User>(token, "/auth/me");
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

export function createInvite(token: string, planId: string): Promise<{ token: string; plan_id: string }> {
  return apiFetch<{ token: string; plan_id: string }>(token, `/plans/${planId}/invites`, {
    method: "POST"
  });
}

export function joinInvite(token: string, inviteToken: string): Promise<{ plan_id: string; role: string }> {
  return apiFetch<{ plan_id: string; role: string }>(token, `/invites/${inviteToken}/join`, {
    method: "POST"
  });
}

export function createActivity(
  token: string,
  planId: string,
  input: CreateActivityInput
): Promise<{ id: string; plan_id: string; name: string }> {
  return apiFetch<{ id: string; plan_id: string; name: string }>(token, `/plans/${planId}/activities`, {
    method: "POST",
    body: input
  });
}

export function deleteActivity(token: string, planId: string, activityId: string): Promise<void> {
  return apiFetch<void>(token, `/plans/${planId}/activities/${activityId}`, { method: "DELETE" });
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
