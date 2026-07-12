import { describe, expect, it } from "vitest";

import { sortMembers } from "@/lib/member-directory";

describe("Trip Members directory", () => {
  it("sorts the owner, co-owners, and members by name then stable user ID", () => {
    const members = sortMembers([
      { id: "4", plan_id: "plan", user_id: "member-b", role: "member", display_name: "Zed", created_at: "now" },
      { id: "3", plan_id: "plan", user_id: "co-owner", role: "co_owner", display_name: "Bee", created_at: "now" },
      { id: "2", plan_id: "plan", user_id: "member-a", role: "member", display_name: "Alex", created_at: "now" },
      { id: "1", plan_id: "plan", user_id: "owner", role: "owner", display_name: "Owner", created_at: "now" }
    ]);

    expect(members.map((member) => member.user_id)).toEqual(["owner", "co-owner", "member-a", "member-b"]);
  });
});
