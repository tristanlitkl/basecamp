"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const refresh = async () => {
    if (!token) return;
    const inbox = await getNotifications(token, planId);
    setItems(inbox.notifications);
    setUnread(inbox.unread_count);
  };
  useEffect(() => { void refresh().catch(() => undefined); }, [token, planId, refreshKey]);

  useEffect(() => {
    if (!open) return;
    const positionPanel = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 12;
      const panelWidth = Math.min(400, window.innerWidth - margin * 2);
      const next = {
        left: Math.max(margin, Math.min(rect.right - panelWidth, window.innerWidth - panelWidth - margin)),
        top: Math.max(margin, Math.min(rect.bottom + 10, window.innerHeight - 120))
      };
      setPosition((current) => current.left === next.left && current.top === next.top ? current : next);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (triggerRef.current?.contains(target) || panelRef.current?.contains(target))) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    };
    positionPanel();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("scroll", positionPanel, true);
    };
  }, [open]);

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

  const panel = open && typeof document !== "undefined" ? createPortal(<section className="notification-panel" id={panelId} ref={panelRef} role="dialog" aria-label="Notifications" style={{ "--notification-panel-left": `${position.left}px`, "--notification-panel-top": `${position.top}px` } as React.CSSProperties}>
    <div className="split notification-panel-heading"><strong>Notifications</strong><button className="btn btn-quiet" disabled={unread === 0} onClick={() => void readAll()}>Mark all read</button></div>
    {items.length === 0 ? <p className="muted small">You’re all caught up.</p> : <div className="notification-list">{items.map((item) => <button className={`notification-row${item.is_read ? "" : " unread"}`} key={item.id} onClick={() => void readOne(item)} type="button">
      <span><strong>{item.title}</strong>{item.body && <small>{item.body}</small>}</span><time dateTime={item.created_at}>{timestamp(item.created_at)}</time>
    </button>)}</div>}
  </section>, document.body) : null;

  return <div className="notification-entry">
    <button ref={triggerRef} aria-expanded={open} aria-controls={panelId} aria-haspopup="dialog" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} className="notification-bell" onClick={() => setOpen((value) => !value)} type="button">
      <svg aria-hidden="true" className="notification-icon" viewBox="0 0 24 24"><path d="M18 10a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg>{unread > 0 && <span aria-label={`${unread} unread notifications`} className="notification-count">{unread > 9 ? "9+" : unread}</span>}
    </button>
    {panel}
  </div>;
}
