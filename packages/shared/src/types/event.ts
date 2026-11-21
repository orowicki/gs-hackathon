import type { CommonFields, Id, IsoTimestamp, JsonObject } from "./common.js";

/** A stored event. `common` is partial when no schema matched. */
export interface Event {
  id: Id;
  sourceId: Id;
  receivedAt: IsoTimestamp;
  /** Raw message exactly as received (string for lines, object for JSON). */
  raw: string | JsonObject;
  /** Output of the source's parser; `{ raw: "<text>" }` for the raw fallback. */
  parsed: JsonObject;
  schemaId: Id | null;
  common: Partial<CommonFields>;
}
