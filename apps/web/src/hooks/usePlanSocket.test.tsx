import React, { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resyncPlan } from "@/lib/api-client";
import { usePlanSocket } from "@/hooks/usePlanSocket";

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, resyncPlan: vi.fn() };
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(code = 1006, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  fail(code = 1006, reason = "") {
    this.onclose?.({ code, reason } as CloseEvent);
  }

  error() {
    this.onerror?.(new Event("error"));
  }

  connected() {
    this.onmessage?.({ data: JSON.stringify({ type: "connected" }) } as MessageEvent);
  }
}

const options = () => ({
  planId: "plan-1",
  token: "jwt-value",
  onSnapshot: vi.fn(),
  onAuthFailure: vi.fn(),
  onAuthorizationFailure: vi.fn()
});

async function closeAndAdvance(delay: number) {
  act(() => FakeWebSocket.instances.at(-1)!.fail());
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => vi.advanceTimersByTime(delay));
}

describe("usePlanSocket lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.mocked(resyncPlan).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps one socket when unchanged callback identities rerender", () => {
    const first = options();
    const { rerender } = renderHook((props) => usePlanSocket(props), { initialProps: first });
    expect(FakeWebSocket.instances).toHaveLength(1);
    rerender({ ...first, onSnapshot: vi.fn(), onAuthFailure: vi.fn() });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reconnects at 2s, 4s, 8s, 16s, and 30s without duplicate scheduling", async () => {
    renderHook(() => usePlanSocket(options()));
    for (const [index, delay] of [2000, 4000, 8000, 16000, 30000].entries()) {
      const socket = FakeWebSocket.instances.at(-1)!;
      act(() => {
        socket.error();
        socket.fail();
      });
      expect(vi.getTimerCount()).toBe(1);
      await act(async () => vi.advanceTimersByTime(delay - 1));
      expect(FakeWebSocket.instances).toHaveLength(index + 1);
      await act(async () => vi.advanceTimersByTime(1));
      expect(FakeWebSocket.instances).toHaveLength(index + 2);
    }
  });

  it("clears a pending reconnect on unmount", () => {
    const { unmount } = renderHook(() => usePlanSocket(options()));
    act(() => FakeWebSocket.instances[0].fail());
    unmount();
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("exhausts automatic retries and manual retry starts exactly once", async () => {
    const { result } = renderHook(() => usePlanSocket(options()));
    for (const delay of [2000, 4000, 8000, 16000, 30000]) await closeAndAdvance(delay);
    act(() => FakeWebSocket.instances.at(-1)!.fail());
    expect(result.current.connectionState).toBe("unavailable");
    expect(vi.getTimerCount()).toBe(0);
    act(() => result.current.retry());
    expect(FakeWebSocket.instances).toHaveLength(7);
    expect(result.current.connectionState).toBe("connecting");
  });

  it("shows syncing and restores only after resync succeeds", async () => {
    let resolve!: (value: never) => void;
    vi.mocked(resyncPlan).mockReturnValue(new Promise((done) => (resolve = done)));
    const callbacks = options();
    const { result } = renderHook(() => usePlanSocket(callbacks));
    act(() => FakeWebSocket.instances[0].connected());
    expect(result.current.connectionState).toBe("syncing");
    await act(async () => resolve({ plan: {} } as never));
    expect(callbacks.onSnapshot).toHaveBeenCalledOnce();
    expect(result.current.connectionState).toBe("restored");

    act(() => FakeWebSocket.instances[0].fail());
    expect(result.current.nextRetryMs).toBe(2000);
  });

  it("backs off after failed resync instead of recreating during render", async () => {
    vi.mocked(resyncPlan).mockRejectedValue(new Error("500 resync failed"));
    renderHook(() => usePlanSocket(options()));
    await act(async () => FakeWebSocket.instances[0].connected());
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => vi.advanceTimersByTime(1999));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("stops for authentication and authorization failures", () => {
    const auth = options();
    const first = renderHook(() => usePlanSocket(auth));
    act(() => FakeWebSocket.instances[0].fail(1008, "invalid_token"));
    expect(first.result.current.connectionState).toBe("auth_failed");
    expect(auth.onAuthFailure).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    first.unmount();

    const authorization = options();
    const second = renderHook(() => usePlanSocket(authorization));
    act(() => FakeWebSocket.instances.at(-1)!.fail(1008, "plan_membership_required"));
    expect(second.result.current.connectionState).toBe("authorization_failed");
    expect(authorization.onAuthorizationFailure).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats the nested membership resync error as terminal and ignores a stale close", async () => {
    const { ApiError } = await import("@/lib/api-client");
    vi.mocked(resyncPlan).mockRejectedValue(
      new ApiError(403, { detail: { error: "plan_membership_required" } })
    );
    const callbacks = options();
    const { result } = renderHook(() => usePlanSocket(callbacks));
    const socket = FakeWebSocket.instances[0];

    await act(async () => socket.connected());
    expect(result.current.connectionState).toBe("authorization_failed");
    expect(callbacks.onAuthorizationFailure).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    act(() => socket.fail());
    await act(async () => vi.advanceTimersByTime(120_000));
    expect(result.current.connectionState).toBe("authorization_failed");
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a scheduled reconnect when an independent request denies membership", async () => {
    const callbacks = options();
    const { result, rerender } = renderHook(() => usePlanSocket(callbacks));
    const staleClose = FakeWebSocket.instances[0].onclose;
    act(() => FakeWebSocket.instances[0].fail());
    expect(vi.getTimerCount()).toBe(1);

    act(() => result.current.denyAuthorization());
    expect(result.current.connectionState).toBe("authorization_failed");
    expect(vi.getTimerCount()).toBe(0);
    expect(callbacks.onAuthorizationFailure).toHaveBeenCalledOnce();

    act(() => staleClose?.({ code: 1006, reason: "" } as CloseEvent));
    act(() => result.current.retry());
    rerender();
    await act(async () => vi.advanceTimersByTime(120_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    act(() => result.current.denyAuthorization());
    expect(callbacks.onAuthorizationFailure).toHaveBeenCalledOnce();
  });

  it("keeps independent membership denial terminal under StrictMode", async () => {
    const { result, rerender } = renderHook(() => usePlanSocket(options()), { wrapper: StrictMode });
    const createdBeforeDenial = FakeWebSocket.instances.length;
    act(() => result.current.denyAuthorization());
    rerender();
    await act(async () => vi.advanceTimersByTime(120_000));
    expect(FakeWebSocket.instances).toHaveLength(createdBeforeDenial);
    expect(FakeWebSocket.instances.filter((socket) => !socket.closed)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves only one live socket and no duplicate timer under StrictMode", () => {
    renderHook(() => usePlanSocket(options()), { wrapper: StrictMode });
    expect(FakeWebSocket.instances.filter((socket) => !socket.closed)).toHaveLength(1);
    act(() => FakeWebSocket.instances.at(-1)!.fail());
    expect(vi.getTimerCount()).toBe(1);
  });
});
