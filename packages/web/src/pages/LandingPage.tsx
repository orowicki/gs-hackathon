import { Plus, Star } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { SettingsMenu } from "../components/SettingsPanel";
import { withFilter } from "../filterUrl";

export function LandingPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const q = params.get("q") ?? "";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      input.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <header className="topbar">
        <SettingsMenu />
        <div className="filter">
          <input
            ref={input}
            type="text"
            aria-label="Filter"
            placeholder="alert.severity = critical"
            spellCheck={false}
            autoComplete="off"
            value={q}
            onChange={(e) => setParams(withFilter(params, e.target.value), { replace: true })}
          />
          <button type="button" className="icon-btn" aria-label="Star filter">
            <Icon as={Star} />
          </button>
        </div>
        <button
          type="button"
          className="icon-btn square"
          title="New rule"
          aria-label="New rule"
          onClick={() => navigate("/rules/new")}
        >
          <Icon as={Plus} />
        </button>
      </header>
      <main className="empty">
        {q === "" ? (
          <>
            <p className="muted">No alerts yet.</p>
            <Link to="/rules/new">Create a rule</Link>
          </>
        ) : (
          <>
            <p className="muted">No alerts match this filter.</p>
            <Link to={{ pathname: "/", search: withFilter(params, "").toString() }} replace>
              Clear filter
            </Link>
          </>
        )}
      </main>
    </>
  );
}
