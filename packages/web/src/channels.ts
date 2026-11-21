/** Display names for channel ids. Ids (ui, ntfy, ...) stay as they are in the API and config. */
const LABELS: Record<string, string> = {
  ui: "Dashboard",
  ntfy: "Phone",
  email: "Email",
  sms: "SMS",
};

export const channelLabel = (id: string): string => LABELS[id] ?? id;
