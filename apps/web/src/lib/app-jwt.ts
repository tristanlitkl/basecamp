import { SignJWT } from "jose";

const issuer = "basecamp-web";
const audience = "basecamp-api";
export const APP_JWT_TTL_SECONDS = 60 * 60;

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
    .setExpirationTime(`${APP_JWT_TTL_SECONDS}s`)
    .sign(new TextEncoder().encode(secret));
}
