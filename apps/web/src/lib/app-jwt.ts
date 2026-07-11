import { SignJWT } from "jose";

const issuer = "basecamp-web";
const audience = "basecamp-api";
export const DEFAULT_APP_JWT_TTL_SECONDS = 60 * 60;

export function appJwtTtlSeconds(value = process.env.APP_JWT_TTL_SECONDS): number {
  if (!value || !/^[1-9]\d*$/.test(value)) return DEFAULT_APP_JWT_TTL_SECONDS;

  const ttl = Number(value);
  return Number.isSafeInteger(ttl) && ttl > 0 ? ttl : DEFAULT_APP_JWT_TTL_SECONDS;
}

export type AppJwtInput = {
  subject: string;
  email: string;
  name?: string | null;
};

export async function signAppJwt(input: AppJwtInput): Promise<string> {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is required");
  }

  return new SignJWT({
    email: input.email,
    name: input.name ?? input.email
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.subject)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${appJwtTtlSeconds()}s`)
    .sign(new TextEncoder().encode(secret));
}
