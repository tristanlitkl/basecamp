import { getSession } from "next-auth/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getMe } from "@/lib/api-client";

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
});
