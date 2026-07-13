"use client";

import { signIn, signOut, useSession } from "next-auth/react";
import Link from "next/link";

import { AdventureBackground } from "@/components/plans/adventure-background";

export default function HomePage() {
  const { data: session, status } = useSession();
  const signedIn = status === "authenticated";

  return (
    <main className="app-shell auth-shell">
      <AdventureBackground />
      <section className="card card-pad auth-card stack">
        <div className="brand"><span className="brand-mark">B</span> Basecamp</div>
        <div><p className="eyebrow">Shared outing planner</p><h1>One clear place to plan together.</h1><p className="muted">Coordinate private invites, activities, dates, and shared expenses.</p></div>
        {signedIn ? (
          <div className="cluster">
            <Link className="btn" href="/dashboard">Open dashboard</Link>
            <button className="btn btn-secondary" type="button" onClick={() => signOut()}>
              Sign out
            </button>
          </div>
        ) : (
          <button className="btn" type="button" onClick={() => signIn("google")}>
            Sign in with Google
          </button>
        )}
      </section>
    </main>
  );
}
