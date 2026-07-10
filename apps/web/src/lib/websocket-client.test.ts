import { describe, expect, it } from "vitest";

import {
  calculateReconnectDelay,
  MAX_RECONNECT_DELAY_MS,
  planWebSocketUrl
} from "@/lib/websocket-client";
import { snapshotToPlanDetail } from "@/hooks/useResyncPlan";
import type { ResyncSnapshot } from "@/types/api";

describe("calculateReconnectDelay", () => {
  it("uses exponential backoff with jitter", () => {
    expect(calculateReconnectDelay(0, () => 0)).toBe(2000);
    expect(calculateReconnectDelay(1, () => 0.5)).toBe(4500);
    expect(calculateReconnectDelay(2, () => 0.999)).toBe(8999);
  });

  it("caps delays at 30 seconds including jitter", () => {
    expect(calculateReconnectDelay(8, () => 0.999)).toBe(MAX_RECONNECT_DELAY_MS);
  });
});

describe("planWebSocketUrl", () => {
  it("places the application JWT in the token query parameter", () => {
    const url = planWebSocketUrl("plan-1", "jwt-value");
    expect(url).toContain("/ws/plans/plan-1");
    expect(url).toContain("token=jwt-value");
  });
});

describe("snapshotToPlanDetail", () => {
  it("fully derives local plan state from the resync snapshot", () => {
    const snapshot: ResyncSnapshot = {
      plan: {
        id: "plan-1",
        title: "Server title",
        description: null,
        budget_cents: null,
        role: "owner",
        version: 7,
        planning_version: 1
      },
      members: [],
      activities: [
        {
          id: "activity-1",
          name: "Server activity",
          description: null,
          address: null,
          location_name: null,
          lat: null,
          lng: null,
          estimated_cost_cents: null,
          estimated_duration_minutes: null,
          tags: [],
          notes: null,
          vote: null,
          yes_votes: 0,
          maybe_votes: 0,
          no_votes: 0
        }
      ],
      activity_scores: { "activity-1": { yes: 2, maybe: 1, no: 0 } },
      itinerary_items: [],
      votes: [{ activity_id: "activity-1", vote: "yes" }],
      expenses: [],
      expense_splits: [],
      ledger_entries: [],
      latest_plan_events: [],
      server_version: 7
    };

    const plan = snapshotToPlanDetail(snapshot);
    expect(plan.title).toBe("Server title");
    expect(plan.activities).toHaveLength(1);
    expect(plan.activities[0].yes_votes).toBe(2);
    expect(plan.activities[0].vote).toBe("yes");
  });
});
