"use client";

import { signIn, signOut, useSession } from "next-auth/react";
import Link from "next/link";

export default function HomePage() {
  const { data: session, status } = useSession();
  const signedIn = status === "authenticated";

  return (
    <main style={{ maxWidth: 760, margin: "80px auto", padding: 24, fontFamily: "system-ui" }}>
      <h1>Basecamp</h1>
      <p>Plan a group outing with private invites, shared activities, and simple voting.</p>
      {signedIn ? (
        <div style={{ display: "flex", gap: 12 }}>
          <Link href="/dashboard">Open dashboard</Link>
          <button type="button" onClick={() => signOut()}>
            Sign out
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => signIn("google")}>
          Sign in with Google
        </button>
      )}
    </main>
  );
}
