import type { ResyncSnapshot } from "@/types/api";

export function sortMembers(members: ResyncSnapshot["members"]) {
  const rank = { owner: 0, co_owner: 1, member: 2 } as const;
  return [...members].sort((left, right) => rank[left.role] - rank[right.role]
    || left.display_name.localeCompare(right.display_name, undefined, { sensitivity: "base" })
    || left.user_id.localeCompare(right.user_id));
}
