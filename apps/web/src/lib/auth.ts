import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

import { signAppJwt } from "@/lib/app-jwt";

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
      const subject = account?.providerAccountId ?? token.sub;
      const email = profile?.email ?? token.email;
      const name = profile?.name ?? token.name;

      if (subject && email) {
        token.sub = subject;
        token.email = email;
        token.name = name;
        token.appJwt = await signAppJwt({
          subject,
          email,
          name
        });
      }

      return token;
    },
    async session({ session, token }) {
      session.appJwt = typeof token.appJwt === "string" ? token.appJwt : undefined;
      if (session.user) {
        session.user.id = token.sub ?? "";
      }
      return session;
    }
  }
});
