"use client";

import React, { useEffect, useState } from "react";

import { getNotifications, markAllNotificationsRead, markNotificationRead } from "@/lib/api-client";
import type { CollaborationNotification } from "@/types/api";

function timestamp(value: string) {
  const instant = new Date(value);
  const seconds = Math.max(0, Math.floor((Date.now() - instant.getTime()) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return instant.toLocaleDateString();
}

export function NotificationBell({ token, planId, refreshKey }: { token?: string; planId: string; refreshKey: number }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<CollaborationNotification[]>([]);
  const [unread, setUnread] = useState(0);

  const refresh = async () => {
    if (!token) return;
    const inbox = await getNotifications(token, planId);
    setItems(inbox.notifications);
    setUnread(inbox.unread_count);
  };
  useEffect(() => { void refresh().catch(() => undefined); }, [token, planId, refreshKey]);

  const readOne = async (item: CollaborationNotification) => {
    if (!token || item.is_read) return;
    const next = await markNotificationRead(token, item.id);
    setItems((current) => current.map((candidate) => candidate.id === item.id ? next : candidate));
    setUnread((count) => Math.max(0, count - 1));
  };
  const readAll = async () => {
    if (!token || unread === 0) return;
    await markAllNotificationsRead(token, planId);
    setItems((current) => current.map((item) => ({ ...item, is_read: true, read_at: item.read_at ?? new Date().toISOString() })));
    setUnread(0);
  };

  return <div className="notification-entry">
    <button aria-expanded={open} aria-controls="notification-panel" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} className="notification-bell" onClick={() => setOpen((value) => !value)} type="button">
      <span aria-hidden="true">♢</span>{unread > 0 && <span className="notification-count">{unread > 99 ? "99+" : unread}</span>}
    </button>
    {open && <section className="notification-panel" id="notification-panel" aria-label="Notifications">
      <div className="split"><strong>Notifications</strong><button className="btn btn-quiet" disabled={unread === 0} onClick={() => void readAll()}>Mark all read</button></div>
      {items.length === 0 ? <p className="muted small">You’re all caught up.</p> : <div className="notification-list">{items.map((item) => <button className={`notification-row${item.is_read ? "" : " unread"}`} key={item.id} onClick={() => void readOne(item)} type="button">
        <span><strong>{item.title}</strong>{item.body && <small>{item.body}</small>}</span><time dateTime={item.created_at}>{timestamp(item.created_at)}</time>
      </button>)}</div>}
    </section>}
  </div>;
}
