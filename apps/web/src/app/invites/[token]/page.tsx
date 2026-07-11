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
  const [joining, setJoining] = useState(false);

  useEffect(() => { if (session?.appJwt) void getMe(session.appJwt).then((user) => setDisplayName(user.display_name)); }, [session?.appJwt]);

  async function join() {
    if (!session?.appJwt) {
      return;
    }
    setJoining(true);
    setError(null);
    try {
      await syncUser(session.appJwt);
      await updateDisplayName(session.appJwt, displayName);
      const result = await joinInvite(session.appJwt, params.token, displayName);
      router.push(`/plans/${result.plan_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join invite");
    } finally {
      setJoining(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="card card-pad auth-card stack">
      <div className="brand"><span className="brand-mark">B</span> Basecamp</div>
      <div><p className="eyebrow">You’re invited</p><h1>Join this Basecamp plan</h1><p className="muted">Coordinate the best activities, dates, and shared costs with the whole group.</p></div>
      {status === "authenticated" ? (
        <><label className="field">Your name in Basecamp <input value={displayName} maxLength={50} onChange={(event) => setDisplayName(event.target.value)} /></label><button className="btn" type="button" disabled={joining || !displayName.trim()} onClick={join}>{joining ? "Joining…" : "Join plan"}</button></>
      ) : (
        <button className="btn" type="button" onClick={() => signIn("google")}>
          Sign in with Google
        </button>
      )}
      {error && <p className="alert" role="alert">{error}</p>}
      </section>
    </main>
  );
}
