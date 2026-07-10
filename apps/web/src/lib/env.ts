export const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

export const wsBaseUrl =
  process.env.NEXT_PUBLIC_WS_BASE_URL ??
  apiBaseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");

export function requireServerEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
