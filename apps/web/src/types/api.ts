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

export type CreateActivityInput = {
  name: string;
  description?: string;
  address?: string;
  estimated_cost_cents?: number;
  estimated_duration_minutes?: number;
  tags?: string[];
  notes?: string;
};
