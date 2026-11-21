import { Clock } from "lucide-react";
import { Icon } from "../Icon";
import { TIME_RANGES, type TimeRange } from "../../timeRange";
import "./time-range.css";

/** Grafana-style time range picker; adds `alert.lastSeen >= now-<range>` to the feed filter. */
export function TimeRangePicker({ value, onChange }: { value: TimeRange; onChange: (r: TimeRange) => void }) {
  return (
    <label className={`time-range${value === "all" ? "" : " active"}`} title="Show alerts seen in this time range">
      <Icon as={Clock} />
      <select value={value} onChange={(e) => onChange(e.target.value as TimeRange)} aria-label="Time range">
        {TIME_RANGES.map((r) => (
          <option key={r.id} value={r.id}>
            {r.label}
          </option>
        ))}
      </select>
    </label>
  );
}
