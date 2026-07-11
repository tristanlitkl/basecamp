"use client";

import { signIn, useSession } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { getMe, joinInvite, syncUser, updateDisplayName } from "@/lib/api-client";

export default function InvitePage() {
  const { data: session, status } = useSession();
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");

  useEffect(() => { if (session?.appJwt) void getMe(session.appJwt).then((user) => setDisplayName(user.display_name)); }, [session?.appJwt]);

  async function join() {
    if (!session?.appJwt) {
      return;
    }
    try {
      await syncUser(session.appJwt);
      await updateDisplayName(session.appJwt, displayName);
      const result = await joinInvite(session.appJwt, params.token, displayName);
      router.push(`/plans/${result.plan_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join invite");
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: "64px auto", padding: 24, fontFamily: "system-ui" }}>
      <h1>Join Basecamp plan</h1>
      {status === "authenticated" ? (
        <><label>Your name in Basecamp <input value={displayName} maxLength={50} onChange={(event) => setDisplayName(event.target.value)} /></label><button type="button" onClick={join}>Join plan</button></>
      ) : (
        <button type="button" onClick={() => signIn("google")}>
          Sign in with Google
        </button>
      )}
      {error && <p style={{ color: "crimson" }}>{error}</p>}
    </main>
  );
}
