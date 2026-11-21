import { useCallback, useEffect, useState } from "react";
import {
  fetchChannels,
  fetchDeadLetters,
  retryDeadLetter,
  type ChannelStatus,
  type DeadLetter,
} from "./api";
import { relativeTime, statusColor } from "./format";
import "./channels.css";

export function ChannelsPage() {
  const [channels, setChannels] = useState<ChannelStatus[]>([]);
  const [letters, setLetters] = useState<DeadLetter[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const [c, d] = await Promise.allSettled([fetchChannels(), fetchDeadLetters()]);
    if (c.status === "fulfilled") setChannels(c.value);
    if (d.status === "fulfilled") setLetters(d.value);
    const failed = [c, d].find((r) => r.status === "rejected");
    setLoadError(failed ? String((failed.reason as Error).message) : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = async (id: string) => {
    setRetrying((s) => new Set(s).add(id));
    setRetryErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== id)));
    try {
      await retryDeadLetter(id);
      setLetters((l) => l.filter((x) => x.id !== id));
      void fetchChannels().then(setChannels, () => undefined);
    } catch (err) {
      setRetryErrors((e) => ({ ...e, [id]: (err as Error).message }));
    } finally {
      setRetrying((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  };

  return (
    <main className="page">
      <h1>Channels</h1>
      <div className="channels-actions">
        <button type="button" className="channels-btn" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
        {loading && <span className="muted">Loading…</span>}
      </div>
      {loadError && (
        <p className="channels-error" role="alert">
          {loadError}
        </p>
      )}

      <h2>Status</h2>
      {channels.length === 0 ? (
        <p className="muted">No channels.</p>
      ) : (
        <table className="channels-table" aria-label="Channel status">
          <thead>
            <tr>
              <th>Channel</th>
              <th>Status</th>
              <th>Pending</th>
              <th>Dead letters</th>
              <th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.id}</td>
                <td className="channels-status" style={{ color: statusColor(c.healthy) }}>
                  {c.healthy ? "Healthy" : "Unhealthy"}
                </td>
                <td>{c.pending}</td>
                <td>{c.deadLetters}</td>
                <td>{c.lastError ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Dead letters</h2>
      {letters.length === 0 ? (
        <div className="empty">
          <p>No dead letters</p>
        </div>
      ) : (
        <table className="channels-table" aria-label="Dead letters">
          <thead>
            <tr>
              <th>Failed</th>
              <th>Channel</th>
              <th>Recipient</th>
              <th>Notification</th>
              <th>Error</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {letters.map((d) => (
              <tr key={d.id}>
                <td title={d.failedAt}>{relativeTime(d.failedAt)}</td>
                <td className="mono">{d.notification.channel}</td>
                <td className="mono">{d.notification.recipientId}</td>
                <td>{d.notification.title || d.notification.id}</td>
                <td>{d.error}</td>
                <td>
                  <button
                    type="button"
                    className="channels-btn"
                    aria-label={`Retry ${d.id}`}
                    disabled={retrying.has(d.id)}
                    onClick={() => void retry(d.id)}
                  >
                    Retry now
                  </button>
                  {retryErrors[d.id] && (
                    <p className="channels-error" role="alert">
                      {retryErrors[d.id]}
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
