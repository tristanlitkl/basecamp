"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  isAuthenticationError,
  isPlanMembershipError,
  refreshAppJwt,
  resyncPlan
} from "@/lib/api-client";
import {
  calculateReconnectDelay,
  COLD_START_NOTICE_MS,
  ConnectionState,
  INITIAL_HANDSHAKE_TIMEOUT_MS,
  isAuthenticationFailureClose,
  isAuthorizationFailureClose,
  MAX_AUTO_RECONNECT_ATTEMPTS,
  planWebSocketUrl
} from "@/lib/websocket-client";
import type { ResyncSnapshot } from "@/types/api";

export type PresenceContext = {
  active_context: string;
  editing_entity_type?: "activity" | "itinerary_item";
  editing_entity_id?: string;
};

export type PresenceUser = {
  user_id: string;
  display_name: string;
  avatar_emoji?: string;
  active_context: string | null;
  editing_entity_type: "activity" | "itinerary_item" | null;
  editing_entity_id: string | null;
};

const PRESENCE_HEARTBEAT_MS = 25_000;

type UsePlanSocketOptions = {
  planId: string;
  token?: string;
  onSnapshot: (snapshot: ResyncSnapshot) => void;
  onPlanEvent?: () => Promise<void> | void;
  onAuthFailure: () => void;
  onAuthorizationFailure?: () => void;
  onPresence?: (users: PresenceUser[]) => void;
  refreshToken?: () => Promise<string | undefined>;
};

export function usePlanSocket({
  planId,
  token,
  onSnapshot,
  onPlanEvent,
  onAuthFailure,
  onAuthorizationFailure,
  onPresence,
  refreshToken = refreshAppJwt
}: UsePlanSocketOptions) {
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [nextRetryMs, setNextRetryMs] = useState<number | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handshakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const attemptRef = useRef(0);
  const disposedRef = useRef(false);
  const generationRef = useRef(0);
  const terminalRef = useRef(false);
  const tokenRef = useRef<string | undefined>(token);
  const propTokenRef = useRef<string | undefined>(token);
  const activeTokenRef = useRef<string | undefined>(undefined);
  const refreshGenerationRef = useRef<number | null>(null);
  const refreshTokenRef = useRef(refreshToken);
  refreshTokenRef.current = refreshToken;
  const callbacksRef = useRef({ onSnapshot, onPlanEvent, onAuthFailure, onAuthorizationFailure, onPresence });
  callbacksRef.current = { onSnapshot, onPlanEvent, onAuthFailure, onAuthorizationFailure, onPresence };
  const presenceContextRef = useRef<PresenceContext | null>(null);
  const seenEventIdsRef = useRef(new Set<string>());
  const highestEventSequenceRef = useRef(0);
  const eventSyncInFlightRef = useRef(false);
  const eventSyncQueuedRef = useRef(false);

  const clearTimers = useCallback(() => {
    for (const timer of [retryTimerRef, wakeTimerRef, handshakeTimerRef]) {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    }
  }, []);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current !== null) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  const sendPresence = useCallback((payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN && typeof socket.send === "function") {
      socket.send(JSON.stringify(payload));
    }
  }, []);

  const queuePlanEventResync = useCallback(() => {
    if (!callbacksRef.current.onPlanEvent || disposedRef.current || terminalRef.current) return;
    eventSyncQueuedRef.current = true;
    if (eventSyncInFlightRef.current) return;
    eventSyncInFlightRef.current = true;
    void (async () => {
      try {
        while (eventSyncQueuedRef.current && !disposedRef.current && !terminalRef.current) {
          eventSyncQueuedRef.current = false;
          await callbacksRef.current.onPlanEvent?.();
        }
      } finally {
        eventSyncInFlightRef.current = false;
      }
    })();
  }, []);

  const connectRef = useRef<(manual?: boolean) => void>(() => undefined);
  const enterAuthenticationFailedRef = useRef<() => void>(() => undefined);
  const refreshAuthenticationRef = useRef<(generation: number) => Promise<void>>(async () => undefined);
  enterAuthenticationFailedRef.current = () => {
    if (terminalRef.current) return;
    terminalRef.current = true;
    ++generationRef.current;
    clearTimers();
    clearHeartbeat();
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
    setNextRetryMs(null);
    setConnectionState("auth_failed");
    callbacksRef.current.onAuthFailure();
  };

  const enterAuthorizationDeniedRef = useRef<() => void>(() => undefined);
  enterAuthorizationDeniedRef.current = () => {
    if (terminalRef.current) return;
    terminalRef.current = true;
    ++generationRef.current;
    clearTimers();
    clearHeartbeat();
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
    setNextRetryMs(null);
    setConnectionState("authorization_failed");
    callbacksRef.current.onAuthorizationFailure?.();
  };

  refreshAuthenticationRef.current = async (generation: number) => {
    if (disposedRef.current || terminalRef.current || generation !== generationRef.current) return;
    if (refreshGenerationRef.current === generation) return;
    refreshGenerationRef.current = generation;
    try {
      const refreshedToken = await refreshTokenRef.current();
      if (
        !refreshedToken ||
        refreshedToken === tokenRef.current ||
        disposedRef.current ||
        terminalRef.current ||
        generation !== generationRef.current
      ) {
        enterAuthenticationFailedRef.current();
        return;
      }
      tokenRef.current = refreshedToken;
      activeTokenRef.current = undefined;
      attemptRef.current = 0;
      connectRef.current(true);
    } catch {
      enterAuthenticationFailedRef.current();
    }
  };

  connectRef.current = (manual = false) => {
    if (disposedRef.current || terminalRef.current) return;
    clearTimers();
    clearHeartbeat();

    const currentToken = tokenRef.current;
    if (!currentToken) {
      enterAuthenticationFailedRef.current();
      return;
    }

    if (manual) attemptRef.current = 0;
    const generation = ++generationRef.current;
    const previousSocket = socketRef.current;
    socketRef.current = null;
    if (previousSocket) {
      previousSocket.onclose = null;
      previousSocket.onerror = null;
      previousSocket.close();
    }

    const isCurrent = () => !disposedRef.current && generation === generationRef.current;
    setNextRetryMs(null);
    setConnectionState(attemptRef.current === 0 ? "connecting" : "reconnecting");

    wakeTimerRef.current = setTimeout(() => {
      wakeTimerRef.current = null;
      if (isCurrent() && attemptRef.current === 0) setConnectionState("waking");
    }, COLD_START_NOTICE_MS);

    const socket = new WebSocket(planWebSocketUrl(planId, currentToken));
    activeTokenRef.current = currentToken;
    socketRef.current = socket;

    handshakeTimerRef.current = setTimeout(() => {
      handshakeTimerRef.current = null;
      if (isCurrent()) socket.close(4000, "initial_connection_timeout");
    }, INITIAL_HANDSHAKE_TIMEOUT_MS);

    socket.onmessage = async (event) => {
      if (!isCurrent()) return;
      let message: { type?: string; plan_id?: string; event_id?: string; event_sequence?: number; users?: PresenceUser[] };
      try {
        message = JSON.parse(String(event.data)) as { type?: string };
      } catch {
        return;
      }
      if (message.type === "plan_event") {
        if (message.plan_id !== planId || !message.event_id) return;
        if (seenEventIdsRef.current.has(message.event_id)) return;
        if (
          typeof message.event_sequence === "number" &&
          message.event_sequence <= highestEventSequenceRef.current
        ) return;
        seenEventIdsRef.current.add(message.event_id);
        if (seenEventIdsRef.current.size > 200) {
          const oldest = seenEventIdsRef.current.values().next().value;
          if (oldest) seenEventIdsRef.current.delete(oldest);
        }
        if (typeof message.event_sequence === "number") {
          highestEventSequenceRef.current = message.event_sequence;
        }
        queuePlanEventResync();
        return;
      }
      if ((message.type === "presence.snapshot" || message.type === "presence.updated") && Array.isArray(message.users)) {
        callbacksRef.current.onPresence?.(message.users);
        return;
      }
      if (message.type !== "connected") {
        // Ephemeral packets are never authoritative invalidations.
        return;
      }

      clearTimers();
      seenEventIdsRef.current.clear();
      highestEventSequenceRef.current = 0;
      sendPresence({ type: "presence.heartbeat" });
      clearHeartbeat();
      heartbeatTimerRef.current = setInterval(
        () => sendPresence({ type: "presence.heartbeat" }),
        PRESENCE_HEARTBEAT_MS
      );
      if (presenceContextRef.current) sendPresence({ type: "presence.context", ...presenceContextRef.current });
      setConnectionState("syncing");
      try {
        const snapshot = await resyncPlan(currentToken, planId);
        if (!isCurrent()) return;
        callbacksRef.current.onSnapshot(snapshot);
        attemptRef.current = 0;
        setConnectionState("restored");
      } catch (error) {
        if (!isCurrent()) return;
        if (isAuthenticationError(error)) {
          await refreshAuthenticationRef.current(generation);
          return;
        }
        if (isPlanMembershipError(error)) {
          enterAuthorizationDeniedRef.current();
          return;
        }
        socket.close(4001, "resync_failed");
      }
    };

    socket.onclose = async (event) => {
      if (!isCurrent()) return;
      socketRef.current = null;
      clearTimers();
      clearHeartbeat();

      if (isAuthenticationFailureClose(event)) {
        await refreshAuthenticationRef.current(generation);
        return;
      }
      if (isAuthorizationFailureClose(event)) {
        enterAuthorizationDeniedRef.current();
        return;
      }
      // A rejected browser WebSocket upgrade often reports only code 1006, even
      // when the backend knows the app JWT is expired. Classify that close once
      // through the authoritative REST endpoint before applying network backoff.
      try {
        await resyncPlan(currentToken, planId);
      } catch (error) {
        if (!isCurrent()) return;
        if (isAuthenticationError(error)) {
          await refreshAuthenticationRef.current(generation);
          return;
        }
        if (isPlanMembershipError(error)) {
          enterAuthorizationDeniedRef.current();
          return;
        }
      }
      if (!isCurrent()) return;
      if (attemptRef.current >= MAX_AUTO_RECONNECT_ATTEMPTS) {
        setConnectionState("unavailable");
        setNextRetryMs(null);
        return;
      }

      const delay = calculateReconnectDelay(attemptRef.current);
      attemptRef.current += 1;
      setConnectionState("reconnecting");
      setNextRetryMs(delay);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        if (isCurrent()) connectRef.current(false);
      }, delay);
    };

    // Browsers report failed handshakes through error and then close. Only close
    // owns retry scheduling, preventing error+close from creating two timers.
    socket.onerror = () => undefined;
  };

  useEffect(() => {
    disposedRef.current = false;
    terminalRef.current = false;
    connectRef.current(false);
    return () => {
      disposedRef.current = true;
      ++generationRef.current;
      clearTimers();
      clearHeartbeat();
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      }
    };
  }, [clearHeartbeat, clearTimers, planId, queuePlanEventResync]);

  useEffect(() => {
    if (token === propTokenRef.current) return;
    propTokenRef.current = token;
    tokenRef.current = token;
    if (!token || token === activeTokenRef.current) return;
    terminalRef.current = false;
    attemptRef.current = 0;
    connectRef.current(true);
  }, [token]);

  const retry = useCallback(() => connectRef.current(true), []);
  const setPresenceContext = useCallback((context: PresenceContext | null) => {
    presenceContextRef.current = context;
    sendPresence(context
      ? { type: "presence.context", ...context }
      : { type: "presence.context", active_context: null });
  }, [sendPresence]);
  const denyAuthentication = useCallback(() => enterAuthenticationFailedRef.current(), []);
  const denyAuthorization = useCallback(() => enterAuthorizationDeniedRef.current(), []);
  return { connectionState, nextRetryMs, retry, denyAuthentication, denyAuthorization, setPresenceContext };
}
