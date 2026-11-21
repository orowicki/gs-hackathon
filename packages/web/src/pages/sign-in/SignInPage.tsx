import { Siren, UserPlus } from "lucide-react";
import { useState } from "react";
import { useAccount } from "../../account";
import { Icon } from "../../components/Icon";
import "./sign-in.css";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1]![0] : "")).toUpperCase();
}

/** Signed out: pick your account (no password) or create one. */
export function SignInPage() {
  const { state, people, signIn, signUp } = useAccount();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const mock = state.status !== "loading" && state.mock;

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(null);
    }
  };

  return (
    <main className="signin">
      <div className="signin-card">
        <div className="signin-brand">
          <Icon as={Siren} />
          <span>Alerting</span>
        </div>
        <h1>Sign in</h1>
        <p className="muted">Pick your account. There are no passwords.</p>
        {mock ? (
          <p className="signin-note">Demo mode: no server is connected, so accounts are kept in this browser.</p>
        ) : null}

        {people.length === 0 ? (
          <p className="muted">No accounts yet. Create the first one below.</p>
        ) : (
          <ul className="signin-list" aria-label="Accounts">
            {people.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="signin-person"
                  disabled={busy !== null}
                  onClick={() => run(p.id, () => signIn(p.id))}
                >
                  <span className="signin-avatar" aria-hidden="true">
                    {initials(p.name)}
                  </span>
                  <span className="signin-text">
                    <span className="signin-name">{p.name}</span>
                    <span className="muted">{p.role || "No role"}</span>
                  </span>
                  {p.canCreateRules ? <span className="signin-tag">creates rules</span> : null}
                  <span className="signin-go">{busy === p.id ? "Signing in…" : "Sign in"}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {creating ? (
          <form
            className="signin-create"
            onSubmit={(e) => {
              e.preventDefault();
              void run("create", () => signUp(name, role));
            }}
          >
            <h2>Create account</h2>
            <label>
              <span>Name</span>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" />
            </label>
            <label>
              <span>Role (optional)</span>
              <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Settlements on-call" />
            </label>
            <p className="muted small">New accounts can't create rules; an admin can change that under People &amp; groups.</p>
            <div className="signin-actions">
              <button type="submit" className="btn primary solid" disabled={busy !== null || name.trim() === ""}>
                {busy === "create" ? "Creating…" : "Create and sign in"}
              </button>
              <button type="button" className="btn" disabled={busy !== null} onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="signin-new" onClick={() => setCreating(true)}>
            <Icon as={UserPlus} /> Create account
          </button>
        )}
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </main>
  );
}
