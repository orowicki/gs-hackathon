import type { ChannelId, CommonFieldName, Id, Severity } from "./common.js";
import type { Filter } from "./filter.js";
import type { RecipientRef } from "./people.js";

export interface WhoRow {
  /** Row applies when this matches the alert; omit for "everyone else". */
  condition?: Filter;
  recipients: RecipientRef[];
  /** Overrides recipients' preferences. */
  force?: ChannelId[];
}

export interface Looks {
  titleTemplate: string;
  bodyTemplate?: string;
  /** Field paths shown on the alert. */
  fields: string[];
  severityOverride?: Severity;
  /** CSS colour token or hex. */
  colour?: string;
}

export interface Rule {
  id: Id;
  name: string;
  enabled: boolean;
  when: Filter;
  who: WhoRow[];
  looks: Looks;
  /** Default dedupKey source when the event has none. */
  dedupFields?: CommonFieldName[];
  /** Notification grouping: fields (alert field or dotted event path) whose values bundle alerts. */
  groupBy?: string[];
  /** Grouping window, e.g. "30s", "5m", "1h" (also "ms"). Grouping needs groupBy and groupWindow. */
  groupWindow?: string;
  createdAt: string;
  updatedAt: string;
}
