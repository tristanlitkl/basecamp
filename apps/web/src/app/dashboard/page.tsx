"use client";

import { signIn, signOut, useSession } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";

import { createPlan, getMe, listPlans, syncUser, updateDisplayName } from "@/lib/api-client";
import type { PlanSummary } from "@/types/api";

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");

  useEffect(() => {
    const appJwt = session?.appJwt;
    if (!appJwt) {
      return;
    }

    async function load(token: string) {
      try {
        await syncUser(token);
        setDisplayName((await getMe(token)).display_name);
        setPlans(await listPlans(token));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load dashboard");
      }
    }

    load(appJwt);
  }, [session?.appJwt]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session?.appJwt || !title.trim()) {
      return;
    }

    try {
      const plan = await createPlan(session.appJwt, { title: title.trim() });
      router.push(`/plans/${plan.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create plan");
    }
  }

  if (status === "loading") return <main className="auth-shell"><p className="muted">Loading your Basecamp…</p></main>;

  if (status !== "authenticated") {
    return (
      <main className="auth-shell">
        <section className="card card-pad auth-card stack">
          <div className="brand"><span className="brand-mark">B</span> Basecamp</div>
          <div><p className="eyebrow">Plan together</p><h1>Your next great day starts here.</h1><p className="muted">Sign in to coordinate activities, dates, and shared expenses with your group.</p></div>
        <button className="btn" type="button" onClick={() => signIn("google")}>
          Sign in with Google
        </button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">B</span> Basecamp</div>
        <button className="btn btn-secondary" type="button" onClick={() => signOut()}>Sign out</button>
      </header>
      <section className="split" style={{ marginBottom: 24 }}>
        <div>
          <p className="eyebrow">Your plans</p>
          <h1>Welcome{displayName ? `, ${displayName}` : ""}.</h1>
          <p className="muted">Bring the group together and turn ideas into an actual plan.</p>
        </div>
        <form onSubmit={submit} className="cluster">
          <label className="field"><span className="muted">New plan title</span><input aria-label="Plan title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Friday dinner" /></label>
          <button className="btn" type="submit">Create plan</button>
        </form>
      </section>

      <section className="card section-card">
        <div className="section-heading"><div><h2>Profile</h2><p className="muted small">This name is shown to people you plan with.</p></div><span className="badge">{session.user?.email}</span></div>
        <form onSubmit={async (event) => { event.preventDefault(); if (!session?.appJwt) return; try { const user = await updateDisplayName(session.appJwt, displayName); setDisplayName(user.display_name); } catch { setError("Unable to save your Basecamp name."); } }} className="cluster">
          <label className="field" style={{ flex: 1 }}>Your name in Basecamp <input value={displayName} maxLength={50} onChange={(event) => setDisplayName(event.target.value)} /></label>
          <button className="btn btn-secondary" type="submit">Save name</button>
        </form>
      </section>

      {error && <p className="alert" role="alert">{error}</p>}

      <section className="dashboard-grid" aria-label="Your plans">
        {plans.map((plan) => (
          <Link className="card plan-card" key={plan.id} href={`/plans/${plan.id}`}>
            <div className="split"><strong>{plan.title}</strong><span className={`badge badge-${plan.role}`}>{plan.role.replace("_", "-")}</span></div>
            <span className="muted small">Open the shared workspace for activities, dates, and expenses.</span>
            <span className="cluster" style={{ color: "var(--brand)", fontWeight: 750 }}>Open plan <span aria-hidden="true">→</span></span>
          </Link>
        ))}
        {plans.length === 0 && <div className="empty" style={{ gridColumn: "1 / -1" }}><strong>No plans yet</strong><p>Create your first plan above and invite your group.</p></div>}
      </section>
    </main>
  );
}
