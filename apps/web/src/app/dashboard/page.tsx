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

  if (status === "loading") {
    return <main style={{ padding: 24 }}>Loading...</main>;
  }

  if (status !== "authenticated") {
    return (
      <main style={{ maxWidth: 720, margin: "64px auto", padding: 24, fontFamily: "system-ui" }}>
        <h1>Dashboard</h1>
        <button type="button" onClick={() => signIn("google")}>
          Sign in with Google
        </button>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 920, margin: "40px auto", padding: 24, fontFamily: "system-ui" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1>Dashboard</h1>
          <p>{session.user?.email}</p>
        </div>
        <button type="button" onClick={() => signOut()}>
          Sign out
        </button>
      </header>

      <form onSubmit={submit} style={{ display: "flex", gap: 8, margin: "24px 0" }}>
        <input
          aria-label="Plan title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Friday dinner"
          style={{ flex: 1, padding: 10 }}
        />
        <button type="submit">Create plan</button>
      </form>

      <form onSubmit={async (event) => { event.preventDefault(); if (!session?.appJwt) return; try { const user = await updateDisplayName(session.appJwt, displayName); setDisplayName(user.display_name); } catch { setError("Unable to save your Basecamp name."); } }} style={{ display: "flex", gap: 8, margin: "16px 0" }}>
        <label>Your name in Basecamp <input value={displayName} maxLength={50} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <button type="submit">Save name</button>
      </form>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      <section style={{ display: "grid", gap: 12 }}>
        {plans.map((plan) => (
          <Link key={plan.id} href={`/plans/${plan.id}`} style={{ border: "1px solid #ddd", padding: 16 }}>
            <strong>{plan.title}</strong>
            <span style={{ marginLeft: 12 }}>{plan.role}</span>
          </Link>
        ))}
      </section>
    </main>
  );
}
