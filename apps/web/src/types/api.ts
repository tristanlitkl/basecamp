export type User = { id: string; email: string; display_name: string; avatar_emoji?: string };

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
  creator_avatar_emoji?: string | null;
  tags: string[];
  notes: string | null;
  vote: string | null;
  yes_votes: number;
  no_votes: number;
  maybe_votes: number;
  current_user_vote?: "yes" | "maybe" | "no" | null;
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

export type CollaborationNotification = {
  id: string;
  plan_id: string;
  actor_user_id: string | null;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  title: string;
  body: string | null;
  metadata: Record<string, unknown>;
  is_read: boolean;
  created_at: string;
  read_at: string | null;
};

export type NotificationInbox = {
  notifications: CollaborationNotification[];
  unread_count: number;
  offset: number;
  limit: number;
  has_more: boolean;
};

export type ActivityRecommendation = {
  activity_id: string;
  activity_name: string;
  rank: number;
  total_score: number;
  vote_score: number;
  budget_score: number;
  preference_score: number;
  schedule_fit_score: number;
  reasons: string[];
  score_version: number;
  is_neutral: boolean;
};

export type PlanningReasonCode =
  | "itinerary_empty"
  | "itinerary_item_unscheduled"
  | "date_conflict"
  | "budget_conflict"
  | "strong_candidate_not_in_itinerary"
  | "limited_vote_signal"
  | "unresolved_suggestion"
  | "ready_to_finalize";

export type PlanningIssue = {
  reason_code: PlanningReasonCode;
  entity_ids: string[];
  label: string;
};

export type PlanningAction = PlanningIssue & {
  action_type: "add_to_itinerary" | "schedule" | "review_dates" | "review_budget" | "review_votes" | "review_suggestions" | "finalize_plan";
};

export type PlanningStatus = {
  overall_status: "needs_attention" | "ready" | "finalized";
  readiness_state: "not_ready" | "ready" | "finalized";
  plan_version: number;
  planning_version: number;
  blockers: PlanningIssue[];
  warnings: PlanningIssue[];
  suggested_actions: PlanningAction[];
};

export type ItineraryDraftItem = {
  activity_id: string;
  title: string;
  proposed_start_at: string | null;
  duration_minutes: number | null;
  estimated_cost_cents: number | null;
  recommendation_rank: number;
  reason_codes: string[];
};

export type ItineraryDraft = {
  plan_id: string;
  base_planning_version: number;
  days: Array<{ date: string | null; items: ItineraryDraftItem[] }>;
  warnings: string[];
  generated_at: string;
};

export type PlanningRun = {
  id: string;
  plan_id: string;
  triggered_by_user_id: string;
  run_type: string;
  status: "pending" | "running" | "completed" | "failed";
  draft_status: "fresh" | "stale" | "invalid";
  base_plan_version: number;
  base_planning_version: number;
  current_planning_version: number;
  draft: ItineraryDraft | null;
  validation_errors: string[];
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
};

export type ApplyPlanningRunResult = {
  run_id: string;
  applied_item_ids: string[];
  planning_version: number;
};

export type PlanDetail = PlanSummary & { activities: ActivitySummary[] };
export type PlanMember = {
  id: string;
  plan_id: string;
  user_id: string;
  role: "owner" | "co_owner" | "member";
  email?: string;
  display_name: string;
  avatar_emoji?: string;
  created_at: string;
};
export type ActivityComment = { id: string; activity_id: string; author_id: string; author_display_name: string; author_avatar_emoji?: string; body: string; version: number; deleted_at: string | null; created_at: string; updated_at: string };
export type ActivitySuggestion = { id: string; activity_id: string; author_id: string; author_display_name: string; author_avatar_emoji?: string; suggestion_type: string; proposed_changes_json: Record<string, unknown>; message: string | null; status: "open" | "accepted" | "dismissed"; created_at: string };
export type DateAvailability = {
  date: string;
  status: "available" | "maybe" | "unavailable";
  user_id: string;
  member_display_name: string;
  member_avatar_emoji?: string;
  is_current_user: boolean;
};
export type DateSuggestion = { id: string; starts_on: string; ends_on: string; message: string | null; status: "open" | "accepted" | "dismissed" | "archived"; author_id: string; author_display_name: string; author_avatar_emoji?: string; yes_votes: number; maybe_votes: number; no_votes: number; current_user_vote: "yes" | "maybe" | "no" | null; created_at?: string };
export type CoOwnerRequest = { id: string; plan_id: string; requester_user_id: string; requester_display_name: string; requester_avatar_emoji?: string; status: "pending" | "approved" | "denied" | "withdrawn"; note: string | null; version: number; decided_by_user_id: string | null; decided_at: string | null; created_at: string; updated_at: string };
export type PlanSuggestion = { id: string; title: string; description: string | null; starts_on: string | null; ends_on: string | null; budget_cents: number | null; max_drive_minutes: number | null; travel_mode: "car" | "plane" | "train" | "bus" | null; travel_duration_minutes: number | null; status: "open" | "accepted" | "dismissed" | "archived"; author_id: string; author_display_name: string; author_avatar_emoji?: string; created_at: string };
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
  co_owner_requests?: CoOwnerRequest[];
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
  lat?: string;
  lng?: string;
  client_operation_id?: string;
};
