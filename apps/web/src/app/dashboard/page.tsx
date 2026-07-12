"use client";

import { signIn, signOut, useSession } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";

import { AdventureBackground } from "@/components/plans/adventure-background";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { avatarEmoji } from "@/lib/avatar";
import { createPlan, getMe, listPlans, syncUser, updateAvatarEmoji, updateDisplayName } from "@/lib/api-client";
import type { PlanSummary, User } from "@/types/api";

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [avatarDraft, setAvatarDraft] = useState("🧭");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);

  useEffect(() => {
    const appJwt = session?.appJwt;
    if (!appJwt) {
      return;
    }

    async function load(token: string) {
      try {
        await syncUser(token);
        const currentUser = await getMe(token);
        setUser(currentUser);
        setDisplayName(currentUser.display_name);
        setAvatarDraft(avatarEmoji(currentUser.avatar_emoji));
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
          <div><p className="eyebrow">Plan the next outing</p><h1>Your next great day starts here.</h1><p className="muted">Sign in to coordinate ideas, dates, and shared expenses with your group.</p></div>
        <button className="btn" type="button" onClick={() => signIn("google")}>
          Sign in with Google
        </button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell"><AdventureBackground />
      <header className="topbar app-header">
        <div className="header-context"><div className="brand"><span className="brand-mark">B</span> Basecamp</div><span className="header-divider" /><span className="muted small">Plans</span></div>
        <div className="user-area"><button className="avatar avatar-small avatar-profile-button" aria-expanded={pickerOpen} aria-label="Edit your avatar" onClick={() => setPickerOpen((open) => !open)} type="button">{avatarEmoji(user?.avatar_emoji)}</button><span className="user-copy"><strong>{displayName || "Your profile"}</strong><span>{session.user?.email}</span></span><button className="btn btn-quiet" type="button" onClick={() => signOut()}>Sign out</button></div>
      </header>
      <section className="dashboard-intro">
        <div>
          <p className="eyebrow">Your shared outings</p>
          <h1>Ready to chart the next plan{displayName ? `, ${displayName}` : ""}?</h1>
          <p className="muted">Bring the group together and turn ideas into a trip everyone can follow.</p>
        </div>
        <form onSubmit={submit} className="create-plan">
          <label className="field"><span className="muted">Start a shared plan</span><input aria-label="Plan title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Friday dinner" /></label>
          <button className="btn" type="submit"><span aria-hidden="true">↗</span> Create plan</button>
        </form>
      </section>

      <section className="card section-card profile-card compact-card">
        <div className="section-heading"><div><h2>Profile</h2><p className="muted small">Your name and avatar are shown to people you plan with.</p></div><span className="badge">{session.user?.email}</span></div>
        <button aria-expanded={pickerOpen} className="profile-avatar-control" onClick={() => setPickerOpen((open) => !open)} type="button"><span className="avatar" aria-hidden="true">{avatarEmoji(user?.avatar_emoji)}</span><span><strong>{displayName || "Your profile"}</strong><small>Change avatar</small></span></button>
        {pickerOpen && <div className="subcard stack"><EmojiPicker value={avatarDraft} onChange={setAvatarDraft} disabled={savingAvatar} /><div className="cluster"><button className="btn" disabled={savingAvatar || !session?.appJwt} onClick={async () => { if (!session?.appJwt) return; setSavingAvatar(true); setError(null); try { const nextUser = await updateAvatarEmoji(session.appJwt, avatarDraft); setUser(nextUser); setAvatarDraft(avatarEmoji(nextUser.avatar_emoji)); setPickerOpen(false); } catch { setError("Unable to save your Basecamp avatar."); } finally { setSavingAvatar(false); } }} type="button">{savingAvatar ? "Saving…" : "Save avatar"}</button><button className="btn btn-secondary" disabled={savingAvatar} onClick={() => { setAvatarDraft(avatarEmoji(user?.avatar_emoji)); setPickerOpen(false); }} type="button">Cancel</button></div></div>}
        <form onSubmit={async (event) => { event.preventDefault(); if (!session?.appJwt) return; try { const nextUser = await updateDisplayName(session.appJwt, displayName); setUser(nextUser); setDisplayName(nextUser.display_name); } catch { setError("Unable to save your Basecamp name."); } }} className="cluster">
          <label className="field" style={{ flex: 1 }}>Your name in Basecamp <input value={displayName} maxLength={50} onChange={(event) => setDisplayName(event.target.value)} /></label>
          <button className="btn btn-secondary" type="submit">Save name</button>
        </form>
      </section>

      {error && <p className="alert" role="alert">{error}</p>}

      <section className="dashboard-grid" aria-label="Your plans">
        {plans.map((plan) => (
          <Link className="card plan-card" key={plan.id} href={`/plans/${plan.id}`}>
            <div className="split"><strong>{plan.title}</strong><span className={`badge badge-${plan.role}`}>{plan.role.replace("_", "-")}</span></div>
            <span className="plan-route" aria-hidden="true"><i /><i /><i /></span>
            <span className="plan-card-meta"><span className={`badge badge-${plan.status}`}>{plan.status}</span>{plan.starts_on && <span className="chip"><span aria-hidden="true">◷</span> {new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(plan.starts_on))}</span>}</span>
            <span className="cluster plan-card-link">Open trip plan <span aria-hidden="true">→</span></span>
          </Link>
        ))}
        {plans.length === 0 && <div className="empty" style={{ gridColumn: "1 / -1" }}><span className="empty-mark" aria-hidden="true">↗</span><strong>No shared plans yet</strong><p>Create a plan above, then bring the group into one clear workspace.</p></div>}
      </section>
    </main>
  );
}
