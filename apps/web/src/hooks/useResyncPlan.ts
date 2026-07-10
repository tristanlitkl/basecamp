import type { PlanDetail, ResyncSnapshot } from "@/types/api";

export function snapshotToPlanDetail(snapshot: ResyncSnapshot): PlanDetail {
  return {
    ...snapshot.plan,
    activities: snapshot.activities.map((activity) => ({
      ...activity,
      vote:
        (snapshot.votes.find((vote) => vote.activity_id === activity.id) as { vote?: string } | undefined)
          ?.vote ?? null,
      yes_votes: snapshot.activity_scores[activity.id]?.yes ?? 0,
      maybe_votes: snapshot.activity_scores[activity.id]?.maybe ?? 0,
      no_votes: snapshot.activity_scores[activity.id]?.no ?? 0
    }))
  };
}
