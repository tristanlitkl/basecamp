import type { PlanDetail, ResyncSnapshot } from "@/types/api";

export function snapshotToPlanDetail(snapshot: ResyncSnapshot): PlanDetail {
  return {
    ...snapshot.plan,
    activities: snapshot.activities.map((activity) => ({
      ...activity,
      // Activity votes are a viewer-specific projection; public `votes` is a
      // shared visibility list and must never drive selected-button state.
      vote: activity.current_user_vote ?? null,
      yes_votes: snapshot.activity_scores[activity.id]?.yes ?? 0,
      maybe_votes: snapshot.activity_scores[activity.id]?.maybe ?? 0,
      no_votes: snapshot.activity_scores[activity.id]?.no ?? 0
    }))
  };
}
