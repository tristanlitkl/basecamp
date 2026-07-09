"use client";

import { signIn, useSession } from "next-auth/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";

import {
  createActivity,
  createInvite,
  deleteActivity,
  getPlan,
  syncUser,
  voteActivity
} from "@/lib/api-client";
import type { PlanDetail } from "@/types/api";

export default function PlanPage() {
  const { data: session, status } = useSession();
  const params = useParams<{ planId: string }>();
  const planId = params.planId;
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const appJwt = session?.appJwt;
    if (!appJwt || !planId) {
      return;
    }
    await syncUser(appJwt);
    setPlan(await getPlan(appJwt, planId));
  }

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load plan"));
  }, [session?.appJwt, planId]);

  async function submitActivity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session?.appJwt || !name.trim()) {
      return;
    }
    try {
      await createActivity(session.appJwt, planId, {
        name: name.trim(),
        address: address.trim() || undefined
      });
      setName("");
      setAddress("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add activity");
    }
  }

  if (status === "loading") {
    return <main style={{ padding: 24 }}>Loading...</main>;
  }

  if (status !== "authenticated") {
    return (
      <main style={{ maxWidth: 720, margin: "64px auto", padding: 24, fontFamily: "system-ui" }}>
        <h1>Plan</h1>
        <button type="button" onClick={() => signIn("google")}>
          Sign in with Google
        </button>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 960, margin: "40px auto", padding: 24, fontFamily: "system-ui" }}>
      <Link href="/dashboard">Dashboard</Link>
      <h1>{plan?.title ?? "Plan"}</h1>
      {plan && <p>Role: {plan.role}</p>}
      {error && <p style={{ color: "crimson" }}>{error}</p>}

      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <button
          type="button"
          onClick={async () => {
            if (!session.appJwt) return;
            const invite = await createInvite(session.appJwt, planId);
            setInviteToken(invite.token);
          }}
        >
          Create invite
        </button>
        {inviteToken && <code>{`${window.location.origin}/invites/${inviteToken}`}</code>}
      </div>

      <form onSubmit={submitActivity} style={{ display: "grid", gap: 8, marginBottom: 24 }}>
        <input
          aria-label="Activity name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Activity name"
          style={{ padding: 10 }}
        />
        <input
          aria-label="Address"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="Optional address"
          style={{ padding: 10 }}
        />
        <button type="submit">Add activity</button>
      </form>

      <section style={{ display: "grid", gap: 12 }}>
        {plan?.activities.map((activity) => (
          <article key={activity.id} style={{ border: "1px solid #ddd", padding: 16 }}>
            <h2 style={{ marginTop: 0 }}>{activity.name}</h2>
            {activity.address && <p>{activity.address}</p>}
            <p>
              Yes {activity.yes_votes} | Maybe {activity.maybe_votes} | No {activity.no_votes}
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              {(["yes", "maybe", "no"] as const).map((vote) => (
                <button
                  key={vote}
                  type="button"
                  onClick={async () => {
                    if (!session.appJwt) return;
                    await voteActivity(session.appJwt, planId, activity.id, vote);
                    await load();
                  }}
                >
                  {activity.vote === vote ? `${vote} selected` : vote}
                </button>
              ))}
              {plan.role === "owner" && (
                <button
                  type="button"
                  onClick={async () => {
                    if (!session.appJwt) return;
                    await deleteActivity(session.appJwt, planId, activity.id);
                    await load();
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
