"use client";

import { signIn, useSession } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";

import { joinInvite, syncUser } from "@/lib/api-client";

export default function InvitePage() {
  const { data: session, status } = useSession();
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function join() {
    if (!session?.appJwt) {
      return;
    }
    try {
      await syncUser(session.appJwt);
      const result = await joinInvite(session.appJwt, params.token);
      router.push(`/plans/${result.plan_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join invite");
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: "64px auto", padding: 24, fontFamily: "system-ui" }}>
      <h1>Join Basecamp plan</h1>
      {status === "authenticated" ? (
        <button type="button" onClick={join}>
          Join plan
        </button>
      ) : (
        <button type="button" onClick={() => signIn("google")}>
          Sign in with Google
        </button>
      )}
      {error && <p style={{ color: "crimson" }}>{error}</p>}
    </main>
  );
}
