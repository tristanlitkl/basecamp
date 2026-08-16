import React from "react";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotificationBell } from "@/components/plans/notification-bell";

const api = vi.hoisted(() => ({
  getNotifications: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  markNotificationRead: vi.fn()
}));

vi.mock("@/lib/api-client", () => api);

describe("NotificationBell", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });
  it("renders the unread badge newest-first and supports individual and bulk read", async () => {
    api.getNotifications.mockResolvedValue({
      unread_count: 2,
      offset: 0,
      limit: 25,
      has_more: false,
      notifications: [
        { id: "new", plan_id: "plan", actor_user_id: null, event_type: "plan.finalized", entity_type: "plan", entity_id: "plan", title: "Newest", body: null, metadata: {}, is_read: false, created_at: "2026-08-10T12:00:00Z", read_at: null },
        { id: "old", plan_id: "plan", actor_user_id: null, event_type: "expense.created", entity_type: "expense", entity_id: null, title: "Older", body: "Deleted source is safe", metadata: {}, is_read: false, created_at: "2026-08-09T12:00:00Z", read_at: null }
      ]
    });
    api.markNotificationRead.mockImplementation(async (_token: string, id: string) => ({
      ...(await api.getNotifications.mock.results[0].value).notifications.find((item: { id: string }) => item.id === id),
      is_read: true,
      read_at: "2026-08-10T12:01:00Z"
    }));
    api.markAllNotificationsRead.mockResolvedValue({ marked_read: 1 });

    render(<NotificationBell token="jwt" planId="plan" refreshKey={0} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /2 unread/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /2 unread/ }));
    const panel = await screen.findByRole("dialog", { name: "Notifications" });
    expect(panel.parentElement).toBe(document.body);
    expect(document.querySelector(".notification-entry")?.contains(panel)).toBe(false);
    expect(screen.getAllByRole("dialog", { name: "Notifications" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /Newest|Older/ }).map((item) => item.textContent)).toEqual([
      expect.stringContaining("Newest"), expect.stringContaining("Older")
    ]);
    expect(screen.getByRole("button", { name: /Newest/ }).className).toContain("unread");
    fireEvent.click(screen.getByRole("button", { name: /Newest/ }));
    await waitFor(() => expect(api.markNotificationRead).toHaveBeenCalledWith("jwt", "new"));
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(api.markAllNotificationsRead).toHaveBeenCalledWith("jwt", "plan"));
    expect(screen.getByRole("button", { name: "Mark all read" }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps portaled panel interaction open, closes outside clicks, and returns focus after Escape", async () => {
    api.getNotifications.mockResolvedValue({ notifications: [], unread_count: 0, offset: 0, limit: 25, has_more: false });
    render(<NotificationBell token="jwt" planId="plan" refreshKey={0} />);
    const bell = screen.getByRole("button", { name: "Notifications" });
    fireEvent.click(bell);
    const panel = await screen.findByRole("dialog", { name: "Notifications" });
    fireEvent.pointerDown(panel);
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull());

    fireEvent.click(bell);
    await screen.findByRole("dialog", { name: "Notifications" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
      expect(document.activeElement).toBe(bell);
    });
  });

  it("renders the empty state without depending on a live source entity", async () => {
    api.getNotifications.mockResolvedValue({ notifications: [], unread_count: 0, offset: 0, limit: 25, has_more: false });
    render(<NotificationBell token="jwt" planId="plan" refreshKey={0} />);
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    await waitFor(() => expect(screen.getByText("You’re all caught up.")).toBeTruthy());
  });

  it("refreshes the authoritative unread count when its invalidation key changes", async () => {
    api.getNotifications
      .mockResolvedValueOnce({ notifications: [], unread_count: 0, offset: 0, limit: 25, has_more: false })
      .mockResolvedValueOnce({ notifications: [], unread_count: 4, offset: 0, limit: 25, has_more: false });
    const rendered = render(<NotificationBell token="jwt" planId="plan" refreshKey={0} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy());
    rendered.rerender(<NotificationBell token="jwt" planId="plan" refreshKey={1} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /4 unread/ })).toBeTruthy());
  });

  it("mounts the compact notification panel used by the mobile-safe layout", async () => {
    api.getNotifications.mockResolvedValue({ notifications: [], unread_count: 0, offset: 0, limit: 25, has_more: false });
    render(<NotificationBell token="jwt" planId="plan" refreshKey={0} />);
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    const panel = await screen.findByRole("dialog", { name: "Notifications" });
    expect(panel.parentElement).toBe(document.body);
    const styles = readFileSync("src/app/globals.css", "utf8");
    expect(styles).toContain("--z-header: 10;");
    expect(styles).toContain("--z-popover: 30;");
    expect(styles).toContain("--z-modal: 40;");
    expect(styles).toContain(".notification-panel { position: fixed; z-index: var(--z-popover);");
    expect(styles).toContain(".plan-header { position: relative;");
    expect(styles).toContain("overflow: hidden;");
    expect(styles).toContain("max-height: min(70dvh, 480px);");
  });

  it("caps large unread badges at 9+ while retaining the exact accessible count", async () => {
    api.getNotifications.mockResolvedValue({ notifications: [], unread_count: 12, offset: 0, limit: 25, has_more: false });
    render(<NotificationBell token="jwt" planId="plan" refreshKey={0} />);
    const bell = await screen.findByRole("button", { name: "Notifications, 12 unread" });
    expect(bell.textContent).toContain("9+");
    expect(screen.getByLabelText("12 unread notifications")).toBeTruthy();
  });
});
