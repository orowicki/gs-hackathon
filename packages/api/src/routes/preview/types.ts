import type { RawMessage, Source } from "@alerting/shared";

export interface PreviewDeps {
  getSource(id: string): Promise<Source | null>;
  /** Calls onMessage for each new raw message of the source until `signal` aborts, then resolves. */
  tail(sourceId: string, onMessage: (m: RawMessage) => void, signal: AbortSignal): Promise<void> | void;
}
