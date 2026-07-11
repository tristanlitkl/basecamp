import { afterEach, describe, expect, it, vi } from "vitest";

import { appJwtTtlSeconds, DEFAULT_APP_JWT_TTL_SECONDS } from "@/lib/app-jwt";

describe("appJwtTtlSeconds", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses the normal one-hour lifetime when the override is absent or invalid", () => {
    expect(appJwtTtlSeconds(undefined)).toBe(DEFAULT_APP_JWT_TTL_SECONDS);
    expect(appJwtTtlSeconds("invalid")).toBe(DEFAULT_APP_JWT_TTL_SECONDS);
    expect(appJwtTtlSeconds("0")).toBe(DEFAULT_APP_JWT_TTL_SECONDS);
    expect(appJwtTtlSeconds("-30")).toBe(DEFAULT_APP_JWT_TTL_SECONDS);
    expect(appJwtTtlSeconds("30.5")).toBe(DEFAULT_APP_JWT_TTL_SECONDS);
  });

  it("accepts a positive integer override", () => {
    expect(appJwtTtlSeconds("30")).toBe(30);
  });
});
