export type User = {
  id: string;
  email: string;
  display_name: string;
};

export type PlanSummary = {
  id: string;
  title: string;
  description: string | null;
  budget_cents: number | null;
  role: string;
  version: number;
  planning_version: number;
};

export type ActivitySummary = {
  id: string;
  name: string;
  description: string | null;
  address: string | null;
  location_name: string | null;
  lat: string | null;
  lng: string | null;
  estimated_cost_cents: number | null;
  estimated_duration_minutes: number | null;
  tags: string[];
  notes: string | null;
  vote: string | null;
  yes_votes: number;
  no_votes: number;
  maybe_votes: number;
};

export type PlanDetail = PlanSummary & {
  activities: ActivitySummary[];
};

export type PlanMember = {
  id: string;
  plan_id: string;
  user_id: string;
  role: string;
  email: string;
  display_name: string;
  created_at: string;
};

export type PlanEvent = {
  id: string;
  plan_id: string;
  actor_id: string | null;
  event_type: string;
  payload_json: Record<string, unknown>;
  resource_type: string;
  resource_id: string | null;
  resource_version_after: number | null;
  client_operation_id: string | null;
  created_at: string;
};

export type ResyncSnapshot = {
  plan: PlanSummary;
  members: PlanMember[];
  activities: ActivitySummary[];
  activity_scores: Record<string, { yes: number; maybe: number; no: number }>;
  itinerary_items: Record<string, unknown>[];
  votes: Record<string, unknown>[];
  expenses: Record<string, unknown>[];
  expense_splits: Record<string, unknown>[];
  ledger_entries: Record<string, unknown>[];
  latest_plan_events: PlanEvent[];
  server_version: number;
};

export type CreateActivityInput = {
  name: string;
  description?: string;
  address?: string;
  estimated_cost_cents?: number;
  estimated_duration_minutes?: number;
  tags?: string[];
  notes?: string;
};
