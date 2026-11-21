import type { ChannelStatus, DeadLetter } from "../../../../shared/src/types/notification";

export type { ChannelStatus, DeadLetter };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function errorMessage(status: number, body: string): string {
  const detail = body.trim().slice(0, 200);
  if (status === 503) return "Delivery is not configured on the server.";
  if (status === 404) return "Dead letter not found (it may already have been retried).";
  return detail ? `Request failed (${status}): ${detail}` : `Request failed (${status})`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(errorMessage(res.status, text), res.status);
  }
  return (await res.json()) as T;
}

export const fetchChannels = () => request<ChannelStatus[]>("/api/channels");
export const fetchDeadLetters = () => request<DeadLetter[]>("/api/dead-letters");
export const retryDeadLetter = (id: string) =>
  request<unknown>(`/api/dead-letters/${encodeURIComponent(id)}/retry`, { method: "POST" });
