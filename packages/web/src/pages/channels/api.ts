import type {
  ChannelStatus,
  DeadLetter,
} from "../../../../shared/src/types/notification";

export type { ChannelStatus, DeadLetter };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Pulls `{ error }` out of a JSON body; falls back to trimmed raw text. */
export function extractDetail(body: string): string {
  const raw = body.trim();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const e = (parsed as { error: unknown }).error;
      if (typeof e === "string") return e.slice(0, 200);
    }
  } catch {
    // not JSON
  }
  return raw.slice(0, 200);
}

export function errorMessage(status: number, body: string): string {
  const detail = extractDetail(body);
  if (status === 503) return "Delivery is not configured on the server.";
  if (status === 404)
    return "Dead letter not found (it may already have been retried).";
  return detail
    ? `Request failed (${status}): ${detail}`
    : `Request failed (${status})`;
}

export const UNEXPECTED_RESPONSE = "Unexpected response from server";

export function parseJsonBody<T>(text: string, status = 200): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(UNEXPECTED_RESPONSE, status);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(errorMessage(res.status, text), res.status);
  }
  return parseJsonBody<T>(await res.text().catch(() => ""), res.status);
}

export const fetchChannels = () => request<ChannelStatus[]>("/api/channels");
export const fetchDeadLetters = () =>
  request<DeadLetter[]>("/api/dead-letters");
export const retryDeadLetter = (id: string) =>
  request<unknown>(`/api/dead-letters/${encodeURIComponent(id)}/retry`, {
    method: "POST",
  });
