export type User = { id: string; email: string; display_name: string };

export type PlanSummary = {
  id: string;
  title: string;
  description: string | null;
  budget_cents: number | null;
  role: "owner" | "co_owner" | "member";
  version: number;
  planning_version: number;
  status: "draft" | "finalized";
  starts_on?: string | null;
  ends_on?: string | null;
  max_drive_minutes?: number | null;
  vote_visibility: "public" | "anonymous";
  travel_mode?: "car" | "plane" | "train" | "bus" | null;
  travel_duration_minutes?: number | null;
  travel_notes?: string | null;
};

export type ActivitySummary = {
  id: string;
  version: number;
  name: string;
  description: string | null;
  address: string | null;
  location_name: string | null;
  lat: string | null;
  lng: string | null;
  estimated_cost_cents: number | null;
  estimated_duration_minutes: number | null;
  travel_mode: "car" | "plane" | "train" | "bus" | null;
  creator_display_name?: string;
  tags: string[];
  notes: string | null;
  vote: string | null;
  yes_votes: number;
  no_votes: number;
  maybe_votes: number;
};

export type ItineraryItem = {
  id: string;
  plan_id: string;
  activity_id: string | null;
  title: string;
  position_key: string;
  starts_at: string | null;
  ends_at: string | null;
  version: number;
};

export type Expense = {
  id: string;
  plan_id: string;
  paid_by_user_id: string;
  description: string;
  amount_cents: number;
  status: "active" | "reversed";
  version: number;
};

export type ExpenseMutationResponse = Expense & {
  splits: Array<{ user_id: string; amount_cents: number }>;
};

export type ItineraryMutationResponse = Pick<
  ItineraryItem,
  "id" | "plan_id" | "title" | "position_key" | "version"
>;

export type ExpenseSplit = {
  id: string;
  expense_id: string;
  user_id: string;
  amount_cents: number;
  status: string;
  created_at?: string;
  updated_at?: string;
};

export type LedgerEntry = {
  id: string;
  plan_id: string;
  expense_id: string | null;
  from_user_id: string | null;
  to_user_id: string | null;
  amount_cents: number;
  memo: string | null;
  reversed_by_entry_id: string | null;
  created_at?: string;
};

export type PlanBalance = {
  user_id: string;
  balance_cents: number;
};

export type PlanDetail = PlanSummary & { activities: ActivitySummary[] };
export type PlanMember = {
  id: string;
  plan_id: string;
  user_id: string;
  role: "owner" | "co_owner" | "member";
  email?: string;
  display_name: string;
  created_at: string;
};
export type ActivityComment = { id: string; activity_id: string; author_id: string; author_display_name: string; body: string; version: number; deleted_at: string | null; created_at: string; updated_at: string };
export type ActivitySuggestion = { id: string; activity_id: string; author_id: string; author_display_name: string; suggestion_type: string; proposed_changes_json: Record<string, unknown>; message: string | null; status: "open" | "accepted" | "dismissed"; created_at: string };
export type DateAvailability = { date: string; status: "available" | "maybe" | "unavailable"; is_current_user: boolean };
export type DateSuggestion = { id: string; starts_on: string; ends_on: string; message: string | null; status: "open" | "accepted" | "dismissed"; author_id: string; author_display_name: string; yes_votes: number; maybe_votes: number; no_votes: number; vote: "yes" | "maybe" | "no" | null };
export type PlanSuggestion = { id: string; title: string; description: string | null; starts_on: string | null; ends_on: string | null; budget_cents: number | null; max_drive_minutes: number | null; travel_mode: "car" | "plane" | "train" | "bus" | null; travel_duration_minutes: number | null; status: "open" | "accepted" | "dismissed"; author_id: string; author_display_name: string; created_at: string };
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
  current_user_id: string;
  plan: PlanSummary;
  members: PlanMember[];
  activities: ActivitySummary[];
  activity_scores: Record<string, { yes: number; maybe: number; no: number }>;
  itinerary_items: ItineraryItem[];
  votes: Record<string, unknown>[];
  expenses: Expense[];
  expense_splits: ExpenseSplit[];
  ledger_entries: LedgerEntry[];
  latest_plan_events: PlanEvent[];
  activity_comments: ActivityComment[];
  activity_suggestions: ActivitySuggestion[];
  date_availability: DateAvailability[];
  date_suggestions: DateSuggestion[];
  plan_suggestions?: PlanSuggestion[];
  server_version: number;
};

export type CreateActivityInput = {
  name: string;
  description?: string;
  address?: string;
  estimated_cost_cents?: number;
  estimated_duration_minutes?: number;
  travel_mode?: "car" | "plane" | "train" | "bus";
  tags?: string[];
  notes?: string;
  client_operation_id?: string;
};
