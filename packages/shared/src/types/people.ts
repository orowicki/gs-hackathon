import type { ChannelId, Id } from "./common.js";
import type { Filter } from "./filter.js";

export interface Person {
  id: Id;
  name: string;
  role: string;
  canCreateRules: boolean;
  ntfyTopic?: string;
}

export interface Group {
  id: Id;
  name: string;
  memberIds: Id[];
}

/** Reference to a person or a group. */
export interface RecipientRef {
  type: "person" | "group";
  id: Id;
}

export interface PreferenceRule {
  /** e.g. `alert.severity = critical`. */
  when: Filter;
  channels: ChannelId[];
}

export interface QuietHours {
  /** "HH:MM" 24h, local to `timezone`. */
  from: string;
  to: string;
  timezone: string;
  /** Channels still allowed during quiet hours (default: ["ui"]). */
  allowChannels?: ChannelId[];
}

/** Per person or group; first matching rule wins. */
export interface Preference {
  ownerType: "person" | "group";
  ownerId: Id;
  rules: PreferenceRule[];
  quietHours?: QuietHours;
}

/** A filter a person starred in the UI filter bar (per profile). */
export interface StarredFilter {
  id: Id;
  personId: Id;
  name: string;
  filter: Filter;
}
