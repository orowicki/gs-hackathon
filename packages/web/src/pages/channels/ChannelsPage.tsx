import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchChannels,
  fetchDeadLetters,
  retryDeadLetter,
  type ChannelStatus,
  type DeadLetter,
} from "./api";
import { relativeTime } from "./format";
import "./channels.css";
import { channelLabel } from "../../channels";
import { useAccount } from "../../account";
import { Icon } from "../../components/Icon";
import { LayoutDashboard, Mail, RefreshCw, Send, Smartphone, type LucideIcon } from "lucide-react";

const CHANNEL_ICONS: Record<string, LucideIcon> = { ui: LayoutDashboard, ntfy: Smartphone, email: Mail };

export function ChannelsPage() {
  const { nameOf } = useAccount();
  const [channels, setChannels] = useState<ChannelStatus[]>([]);
  const [letters, setLetters] = useState<DeadLetter[]>([]);
  const [loading, setLoading] = useState(true);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [lettersError, setLettersError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({});
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    const [c, d] = await Promise.allSettled([
      fetchChannels(),
      fetchDeadLetters(),
    ]);
    if (mine !== seq.current) return;
    if (c.status === "fulfilled") {
      setChannels(c.value);
      setChannelsError(null);
    } else {
      setChannelsError((c.reason as Error).message);
    }
    if (d.status === "fulfilled") {
      setLetters(d.value);
      setLettersError(null);
    } else {
      setLettersError((d.reason as Error).message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = async (id: string) => {
    setRetrying((s) => new Set(s).add(id));
    setRetryErrors((e) =>
      Object.fromEntries(Object.entries(e).filter(([k]) => k !== id)),
    );
    try {
      await retryDeadLetter(id);
      setLetters((l) => l.filter((x) => x.id !== id));
      void load();
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
    <main className="page ch-page">
      <header className="page-header">
        <div>
          <h1>Channels</h1>
          <p className="page-intro">
            Where notifications go. Failed deliveries are retried on their own; the ones that keep failing land in dead letters, where you can send
            them again.
          </p>
        </div>
        <div className="page-actions">
          {loading && <span className="muted ch-loading">Loading…</span>}
          <button type="button" className="btn" onClick={() => void load()} disabled={loading}>
            <Icon as={RefreshCw} /> Refresh
          </button>
        </div>
      </header>

      {channelsError && (
        <p className="callout error" role="alert">
          {channelsError}
        </p>
      )}
      {channels.length === 0 ? (
        channelsError ? null : <p className="muted">No channels.</p>
      ) : (
        <ul className="ch-cards" aria-label="Channel status">
          {channels.map((c) => (
            <li key={c.id} className={c.healthy ? "ch-card" : "ch-card down"}>
              <div className="ch-card-head">
                <span className="choice-icon">
                  <Icon as={CHANNEL_ICONS[c.id] ?? Send} />
                </span>
                <span className="ch-name">{channelLabel(c.id)}</span>
                <span className={c.healthy ? "tag ok" : "tag sev-critical"}>{c.healthy ? "Healthy" : "Unhealthy"}</span>
              </div>
              <dl className="ch-stats">
                <div>
                  <dt>Pending</dt>
                  <dd>{c.pending}</dd>
                </div>
                <div>
                  <dt>Dead letters</dt>
                  <dd className={c.deadLetters > 0 ? "bad" : undefined}>{c.deadLetters}</dd>
                </div>
              </dl>
              <p className="ch-error" title={c.lastError ?? undefined}>
                {c.lastError ? <>Last error: {c.lastError}</> : "No recent errors"}
              </p>
            </li>
          ))}
        </ul>
      )}

      <h2 className="ch-section">Dead letters</h2>
      {lettersError && (
        <p className="channels-error" role="alert">
          {lettersError}
        </p>
      )}
      {letters.length === 0 ? (
        lettersError ? null : (
          <div className="empty-state">
            <p>No dead letters</p>
          </div>
        )
      ) : (
        <table className="ch-table" aria-label="Dead letters">
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
                <td>{channelLabel(d.notification.channel)}</td>
                <td>{nameOf(d.notification.recipientId)}</td>
                <td>{d.notification.title || d.notification.id}</td>
                <td>{d.error}</td>
                <td>
                  <button
                    type="button"
                    className="btn primary"
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
