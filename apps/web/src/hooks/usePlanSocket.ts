"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { isAuthenticationError, isPlanMembershipError, resyncPlan } from "@/lib/api-client";
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

type UsePlanSocketOptions = {
  planId: string;
  token?: string;
  onSnapshot: (snapshot: ResyncSnapshot) => void;
  onAuthFailure: () => void;
  onAuthorizationFailure?: () => void;
};

export function usePlanSocket({
  planId,
  token,
  onSnapshot,
  onAuthFailure,
  onAuthorizationFailure
}: UsePlanSocketOptions) {
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [nextRetryMs, setNextRetryMs] = useState<number | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handshakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const disposedRef = useRef(false);
  const generationRef = useRef(0);
  const terminalRef = useRef(false);
  const callbacksRef = useRef({ onSnapshot, onAuthFailure, onAuthorizationFailure });
  callbacksRef.current = { onSnapshot, onAuthFailure, onAuthorizationFailure };

  const clearTimers = useCallback(() => {
    for (const timer of [retryTimerRef, wakeTimerRef, handshakeTimerRef]) {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    }
  }, []);

  const connectRef = useRef<(manual?: boolean) => void>(() => undefined);
  const enterAuthenticationFailedRef = useRef<() => void>(() => undefined);
  enterAuthenticationFailedRef.current = () => {
    if (terminalRef.current) return;
    terminalRef.current = true;
    ++generationRef.current;
    clearTimers();
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

  connectRef.current = (manual = false) => {
    if (disposedRef.current || terminalRef.current) return;
    clearTimers();

    if (!token) {
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

    const socket = new WebSocket(planWebSocketUrl(planId, token));
    socketRef.current = socket;

    handshakeTimerRef.current = setTimeout(() => {
      handshakeTimerRef.current = null;
      if (isCurrent()) socket.close(4000, "initial_connection_timeout");
    }, INITIAL_HANDSHAKE_TIMEOUT_MS);

    socket.onmessage = async (event) => {
      if (!isCurrent()) return;
      let message: { type?: string };
      try {
        message = JSON.parse(String(event.data)) as { type?: string };
      } catch {
        return;
      }
      if (message.type !== "connected") return;

      clearTimers();
      setConnectionState("syncing");
      try {
        const snapshot = await resyncPlan(token, planId);
        if (!isCurrent()) return;
        callbacksRef.current.onSnapshot(snapshot);
        attemptRef.current = 0;
        setConnectionState("restored");
      } catch (error) {
        if (!isCurrent()) return;
        if (isAuthenticationError(error)) {
          enterAuthenticationFailedRef.current();
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

      if (isAuthenticationFailureClose(event)) {
        enterAuthenticationFailedRef.current();
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
        await resyncPlan(token, planId);
      } catch (error) {
        if (!isCurrent()) return;
        if (isAuthenticationError(error)) {
          enterAuthenticationFailedRef.current();
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
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      }
    };
  }, [clearTimers, planId, token]);

  const retry = useCallback(() => connectRef.current(true), []);
  const denyAuthentication = useCallback(() => enterAuthenticationFailedRef.current(), []);
  const denyAuthorization = useCallback(() => enterAuthorizationDeniedRef.current(), []);
  return { connectionState, nextRetryMs, retry, denyAuthentication, denyAuthorization };
}
