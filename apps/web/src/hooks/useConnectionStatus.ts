import type { ConnectionState } from "@/lib/websocket-client";

export function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case "connecting":
      return "Connecting...";
    case "waking":
      return "Waking server...";
    case "reconnecting":
      return "Reconnecting...";
    case "syncing":
      return "Syncing latest plan state...";
    case "restored":
      return "Connection restored";
    case "unavailable":
      return "Connection unavailable — retry";
    case "auth_failed":
      return "Authentication required — sign in again";
    case "authorization_failed":
      return "You are not authorized to access this plan";
  }
}
