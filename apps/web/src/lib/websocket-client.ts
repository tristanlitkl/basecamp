import { wsBaseUrl } from "@/lib/env";

export const INITIAL_HANDSHAKE_TIMEOUT_MS = 55_000;
export const COLD_START_NOTICE_MS = 2_000;
export const BASE_RECONNECT_DELAY_MS = 2_000;
export const MAX_RECONNECT_DELAY_MS = 30_000;
export const MAX_AUTO_RECONNECT_ATTEMPTS = 5;

export type ConnectionState =
  | "connecting"
  | "waking"
  | "reconnecting"
  | "syncing"
  | "restored"
  | "unavailable"
  | "auth_failed"
  | "authorization_failed";

export function calculateReconnectDelay(
  attempt: number,
  random: () => number = Math.random
): number {
  const jitter = Math.floor(random() * 1000);
  return Math.min(BASE_RECONNECT_DELAY_MS * 2 ** attempt + jitter, MAX_RECONNECT_DELAY_MS);
}

export function planWebSocketUrl(planId: string, token: string): string {
  const url = new URL(`/ws/plans/${planId}`, wsBaseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

export function isAuthenticationFailureClose(event: CloseEvent): boolean {
  return event.code === 1008 && event.reason !== "plan_membership_required";
}

export function isAuthorizationFailureClose(event: CloseEvent): boolean {
  return event.code === 1008 && event.reason === "plan_membership_required";
}
