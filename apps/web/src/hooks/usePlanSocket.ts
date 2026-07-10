"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { resyncPlan } from "@/lib/api-client";
import {
  calculateReconnectDelay,
  COLD_START_NOTICE_MS,
  ConnectionState,
  INITIAL_HANDSHAKE_TIMEOUT_MS,
  isAuthFailureClose,
  MAX_AUTO_RECONNECT_ATTEMPTS,
  planWebSocketUrl
} from "@/lib/websocket-client";
import type { ResyncSnapshot } from "@/types/api";

type UsePlanSocketOptions = {
  planId: string;
  token?: string;
  onSnapshot: (snapshot: ResyncSnapshot) => void;
  onAuthFailure: () => void;
};

export function usePlanSocket({ planId, token, onSnapshot, onAuthFailure }: UsePlanSocketOptions) {
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [nextRetryMs, setNextRetryMs] = useState<number | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handshakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);

  const clearTimers = useCallback(() => {
    for (const timer of [retryTimerRef, wakeTimerRef, handshakeTimerRef]) {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    }
  }, []);

  const closeSocket = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
  }, []);

  const connect = useCallback(
    (manual = false) => {
      if (!token) {
        setConnectionState("auth_failed");
        onAuthFailure();
        return;
      }

      stoppedRef.current = false;
      clearTimers();
      closeSocket();
      if (manual) {
        attemptRef.current = 0;
      }

      const attempt = attemptRef.current;
      setNextRetryMs(null);
      setConnectionState(attempt === 0 ? "connecting" : "reconnecting");

      wakeTimerRef.current = setTimeout(() => {
        if (attempt === 0) {
          setConnectionState("waking");
        }
      }, COLD_START_NOTICE_MS);

      const socket = new WebSocket(planWebSocketUrl(planId, token));
      socketRef.current = socket;

      handshakeTimerRef.current = setTimeout(() => {
        socket.close(4000, "initial_connection_timeout");
      }, INITIAL_HANDSHAKE_TIMEOUT_MS);

      socket.onmessage = async (event) => {
        const message = JSON.parse(event.data) as { type?: string };
        if (message.type !== "connected") {
          return;
        }

        clearTimers();
        setConnectionState("syncing");
        try {
          const snapshot = await resyncPlan(token, planId);
          onSnapshot(snapshot);
          attemptRef.current = 0;
          setConnectionState("restored");
        } catch (error) {
          if (error instanceof Error && error.message.includes("401")) {
            stoppedRef.current = true;
            setConnectionState("auth_failed");
            onAuthFailure();
            socket.close();
            return;
          }
          socket.close(4001, "resync_failed");
        }
      };

      socket.onclose = (event) => {
        clearTimers();
        if (stoppedRef.current) {
          return;
        }

        if (isAuthFailureClose(event)) {
          stoppedRef.current = true;
          setConnectionState("auth_failed");
          onAuthFailure();
          return;
        }

        if (attemptRef.current >= MAX_AUTO_RECONNECT_ATTEMPTS) {
          setConnectionState("unavailable");
          setNextRetryMs(null);
          return;
        }

        const delay = calculateReconnectDelay(attemptRef.current);
        attemptRef.current += 1;
        setConnectionState("reconnecting");
        setNextRetryMs(delay);
        retryTimerRef.current = setTimeout(() => connect(false), delay);
      };

      socket.onerror = () => {
        socket.close();
      };
    },
    [clearTimers, closeSocket, onAuthFailure, onSnapshot, planId, token]
  );

  useEffect(() => {
    connect(false);
    return () => {
      stoppedRef.current = true;
      clearTimers();
      closeSocket();
    };
  }, [connect, clearTimers, closeSocket]);

  return {
    connectionState,
    nextRetryMs,
    retry: () => connect(true)
  };
}
