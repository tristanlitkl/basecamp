import { getSession } from "next-auth/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createExpense,
  createDateSuggestion,
  createItineraryItem,
  deleteActivityAndResync,
  deleteExpense,
  deleteItineraryItem,
  discoverNearbyPlaces,
  getRouteEstimate,
  getWeather,
  getMe,
  patchActivity,
  patchExpense,
  patchItineraryItem,
  patchPlan,
  reorderItineraryItem,
  searchPlaces,
  setPlanLifecycle
} from "@/lib/api-client";

vi.mock("next-auth/react", () => ({ getSession: vi.fn() }));

describe("API app JWT refresh", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refreshes once after an expired-token 401 and retries with the fresh app JWT", async () => {
    vi.mocked(getSession).mockResolvedValue({ appJwt: "fresh-token" } as never);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: { error: "token_expired" } }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "user" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getMe("expired-token")).resolves.toEqual({ id: "user" });
    expect(getSession).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ Authorization: "Bearer fresh-token" });
  });

  it("does not loop when the NextAuth session is invalid", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: { error: "token_expired" } }), { status: 401 }))
    );

    await expect(getMe("expired-token")).rejects.toMatchObject({ status: 401 });
    expect(getSession).toHaveBeenCalledOnce();
  });

  it("sends the current activity version and replaces state from authoritative resync after delete", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ activities: [], plan: { id: "plan-1" } }), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await deleteActivityAndResync("token", "plan-1", {
      id: "activity-1",
      version: 7
    });

    expect(fetchMock.mock.calls[0][0]).toContain("/activities/activity-1?expected_version=7");
    expect(result).toMatchObject({ conflict: false, snapshot: { activities: [] } });
  });

  it("resyncs once and reports a stale activity conflict without retrying delete", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: { error: "version_conflict" } }), { status: 409 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ activities: [{ id: "activity-1", version: 2 }] }), {
          status: 200
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await deleteActivityAndResync("token", "plan-1", {
      id: "activity-1",
      version: 1
    });

    expect(result).toMatchObject({ conflict: true, snapshot: { activities: [{ version: 2 }] } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends plan lifecycle, constraint, and activity expected versions in backend contract bodies", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await patchPlan("token", "plan-1", { expected_version: 4, budget_cents: 1005 });
    await setPlanLifecycle("token", "plan-1", "finalize", 5);
    await patchActivity("token", "plan-1", "activity-1", { expected_version: 3, name: "Edited" });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ expected_version: 4, budget_cents: 1005 });
    expect(fetchMock.mock.calls[1][0]).toContain("/plans/plan-1/finalize");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ expected_version: 5 });
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ expected_version: 3, name: "Edited" });
  });

  it("matches every Phase 2 FastAPI query contract exactly", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ status: "ok", results: [] }), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    await searchPlaces("token", "plan-1", "Golden Gate Park");
    await discoverNearbyPlaces("token", "plan-1", { south: 37.7, west: -122.5, north: 37.8, east: -122.4, placeType: "cafe" });
    await getRouteEstimate("token", "plan-1", { lat: 37.7, lng: -122.5 }, { lat: 37.8, lng: -122.4 });
    await getWeather("token", "plan-1", 37.7, -122.5);
    expect(fetchMock.mock.calls[0][0]).toContain("/plans/plan-1/place-search?query=Golden%20Gate%20Park");
    expect(fetchMock.mock.calls[1][0]).toContain("south=37.7&west=-122.5&north=37.8&east=-122.4&place_type=cafe");
    expect(fetchMock.mock.calls[2][0]).toContain("origin_lat=37.7&origin_lng=-122.5&destination_lat=37.8&destination_lng=-122.4");
    expect(fetchMock.mock.calls[3][0]).toContain("/plans/plan-1/weather?latitude=37.7&longitude=-122.5");
  });

  it("sends itinerary create, edit, reorder, and delete contracts exactly", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await createItineraryItem("token", "plan-1", { title: "First", client_operation_id: "op-create" });
    await patchItineraryItem("token", "plan-1", "item-1", { title: "Edited", expected_version: 2 });
    await reorderItineraryItem("token", "plan-1", "item-1", { expected_version: 3, previous_item_id: "previous", next_item_id: "next" });
    await deleteItineraryItem("token", "plan-1", "item-1", 4);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ client_operation_id: "op-create" });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ expected_version: 2 });
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ expected_version: 3, previous_item_id: "previous", next_item_id: "next" });
    expect(fetchMock.mock.calls[3][0]).toContain("expected_version=4");
  });

  it("sends integer-cent expense participants, expected versions, and operation IDs", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await createExpense("token", "plan-1", { description: "Meal", amount_cents: 1005, paid_by_user_id: "u1", participant_user_ids: ["u1", "u2"], client_operation_id: "create-op" });
    await patchExpense("token", "plan-1", "expense-1", { description: "Dinner", amount_cents: 1234, paid_by_user_id: "u1", participant_user_ids: ["u1", "u2"], expected_version: 6, client_operation_id: "edit-op" });
    await deleteExpense("token", "plan-1", "expense-1", 7, "delete-op");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ amount_cents: 1005, participant_user_ids: ["u1", "u2"], client_operation_id: "create-op" });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ amount_cents: 1234, expected_version: 6, client_operation_id: "edit-op" });
    expect(fetchMock.mock.calls[2][0]).toContain("expected_version=7&client_operation_id=delete-op");
  });

  it("serializes cross-month and cross-year date ranges without transforming either endpoint", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({}), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await createDateSuggestion("token", "plan-1", "2026-07-29", "2026-08-03", "month-op");
    await createDateSuggestion("token", "plan-1", "2026-12-30", "2027-01-04", "year-op");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ starts_on: "2026-07-29", ends_on: "2026-08-03", client_operation_id: "month-op" });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ starts_on: "2026-12-30", ends_on: "2027-01-04", client_operation_id: "year-op" });
  });
});
