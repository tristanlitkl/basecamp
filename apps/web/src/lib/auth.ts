import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

import { ensureAppJwt, exposeAppJwt } from "@/lib/app-session-token";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          scope: "openid email profile"
        }
      }
    })
  ],
  session: {
    strategy: "jwt"
  },
  secret: process.env.NEXTAUTH_SECRET,
  callbacks: {
    async jwt({ token, account, profile }) {
      return ensureAppJwt(token, {
        subject: account?.providerAccountId,
        email: typeof profile?.email === "string" ? profile.email : undefined,
        name: typeof profile?.name === "string" ? profile.name : undefined
      });
    },
    async session({ session, token }) {
      return exposeAppJwt(session, token);
    }
  }
});
