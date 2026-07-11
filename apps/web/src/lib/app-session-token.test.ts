// @vitest-environment node

import { jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_JWT_REFRESH_BUFFER_MS,
  ensureAppJwt,
  exposeAppJwt
} from "@/lib/app-session-token";
import { APP_JWT_TTL_SECONDS } from "@/lib/app-jwt";

const secret = new TextEncoder().encode("test-jwt-secret");

describe("Basecamp app JWT session lifecycle", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-jwt-secret";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.JWT_SECRET;
  });

  it("creates a valid app JWT at initial sign-in with the required claims", async () => {
    const token = await ensureAppJwt({} as never, {
      subject: "google-subject",
      email: "person@example.com",
      name: "Person"
    });
    const verified = await jwtVerify(token.appJwt!, secret, {
      issuer: "basecamp-web",
      audience: "basecamp-api"
    });

    expect(verified.payload.sub).toBe("google-subject");
    expect(verified.payload.email).toBe("person@example.com");
    expect(verified.payload.name).toBe("Person");
    expect(verified.payload.iat).toBeTypeOf("number");
    expect(verified.payload.exp).toBeTypeOf("number");
    expect(token.appJwtExpiresAt).toBe(Date.now() + APP_JWT_TTL_SECONDS * 1000);
  });

  it("reuses an unexpired app JWT and refreshes near-expiry or expired tokens without OAuth", async () => {
    const token = await ensureAppJwt({} as never, {
      subject: "subject",
      email: "person@example.com",
      name: "Person"
    });
    const initialJwt = token.appJwt;
    const initialExpiry = token.appJwtExpiresAt!;
    const initialClaims = await jwtVerify(initialJwt!, secret, {
      issuer: "basecamp-web",
      audience: "basecamp-api"
    });

    vi.advanceTimersByTime(60_000);
    await ensureAppJwt(token);
    expect(token.appJwt).toBe(initialJwt);

    vi.setSystemTime(initialExpiry - APP_JWT_REFRESH_BUFFER_MS + 1);
    await ensureAppJwt(token);
    const nearExpiryJwt = token.appJwt;
    expect(nearExpiryJwt).not.toBe(initialJwt);

    const nearExpiryClaims = await jwtVerify(nearExpiryJwt!, secret, {
      issuer: "basecamp-web",
      audience: "basecamp-api"
    });
    expect(nearExpiryClaims.payload.sub).toBe("subject");
    expect(nearExpiryClaims.payload.iat).toBeGreaterThan(initialClaims.payload.iat!);
    expect(nearExpiryClaims.payload.exp).toBeGreaterThan(initialExpiry / 1000);

    vi.setSystemTime(token.appJwtExpiresAt! + 1);
    await ensureAppJwt(token);
    expect(token.appJwt).not.toBe(nearExpiryJwt);
  });

  it("exposes the refreshed app JWT through the session callback helper", async () => {
    const token = await ensureAppJwt({} as never, {
      subject: "subject",
      email: "person@example.com"
    });
    const session = exposeAppJwt({ user: { email: "person@example.com" }, expires: "" }, token);
    expect(session.appJwt).toBe(token.appJwt);
    expect(session.user?.id).toBe("subject");
  });
});
