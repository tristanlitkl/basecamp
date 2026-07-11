import type { JWT } from "next-auth/jwt";
import type { Session } from "next-auth";

import { APP_JWT_TTL_SECONDS, signAppJwt } from "@/lib/app-jwt";

export const APP_JWT_REFRESH_BUFFER_MS = 5 * 60 * 1000;

type Identity = {
  subject?: string;
  email?: string;
  name?: string | null;
};

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function needsAppJwtRefresh(
  appJwt: unknown,
  expiresAt: unknown,
  now = Date.now()
): boolean {
  return (
    typeof appJwt !== "string" ||
    typeof expiresAt !== "number" ||
    now >= expiresAt - APP_JWT_REFRESH_BUFFER_MS
  );
}

export async function ensureAppJwt(
  token: JWT,
  identity: Identity = {},
  now = Date.now()
): Promise<JWT> {
  const subject = identity.subject ?? stringClaim(token.sub);
  const email = identity.email ?? stringClaim(token.email);
  const name = identity.name ?? stringClaim(token.name) ?? null;

  if (!subject || !email) return token;

  token.sub = subject;
  token.email = email;
  token.name = name;

  if (needsAppJwtRefresh(token.appJwt, token.appJwtExpiresAt, now)) {
    token.appJwt = await signAppJwt({ subject, email, name });
    token.appJwtExpiresAt = now + APP_JWT_TTL_SECONDS * 1000;
  }

  return token;
}

export function exposeAppJwt(session: Session, token: JWT): Session {
  session.appJwt = typeof token.appJwt === "string" ? token.appJwt : undefined;
  if (session.user) session.user.id = stringClaim(token.sub) ?? "";
  return session;
}
